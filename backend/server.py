#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py — Hermes Mission Control 2.0 (backend, read-only snapshot aggregator)

READ-ONLY dashboard backend for the Hermes fleet.
- Serves index.html on GET /
- Aggregated read-only snapshot on GET /api/state (in-memory cache ~3s)
- Operator board (READ-WRITE local board.db) on /api/board*
- Server-Sent Events live feed on GET /events (pushes /api/state every 3s)

Hard rules:
- Every SQLite connection to a Hermes database is STRICTLY read-only:
  file:...?mode=ro  +  PRAGMA query_only=1
- /proc/meminfo, /proc/stat, os.statvfs only for host metrics (no subprocess).
- Python standard library only.
"""

import base64
import unicodedata
import contextlib
import logging
import sys
import json
import mimetypes
import os
import re
import glob
import shutil
import secrets
import signal
import sqlite3
import subprocess
import tempfile
import threading
import queue
import time
import uuid
import yaml
import datetime
import collections
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote
# Solution 3: requests session with retries
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
# For parallel probes
from concurrent.futures import ThreadPoolExecutor, as_completed
# Shared HTTP session with retry strategy
_http_session = None
def _init_http_session():
    global _http_session
    if _http_session is None:
        session = requests.Session()
        retries = Retry(total=3, backoff_factor=1, status_forcelist=[429,500,502,503,504], allowed_methods=["POST"])
        session.mount("http://", HTTPAdapter(max_retries=retries))
        session.mount("https://", HTTPAdapter(max_retries=retries))
        _http_session = session
_init_http_session()

# 2026-08-11 - SOLUTION 3 (capfix) : persistance conservative a 3 etats +
# garde-fous reseau. Toutes les ecritures SQLite sur scan_results.db passent
# par ce verrou unique (writer seralise) pour eviter le WAL contention
# (concurrence ThreadPoolExecutor max_workers=3 + threads de sonde).
_CAP_MAX_CONF = 5          # plafond du compteur de confiance
_CAP_STICKY_CONF = 2       # un True devient STICKY (certain) apres 2 succes
_CAP_TTL_SECONDS = 24 * 3600   # re-validation forcee apres 24h
_SCAN_DB_LOCK = threading.Lock()
# Sentinel : une capacite NON testee (ex: on a demande cap=vision seul).
# A ne pas confondre avec None = erreur RESEAU (indetermine).
CAP_NOT_TESTED = "not_tested"


def _cap_state_from_probe(success, err_str):
    """Mappe le resultat d'une sonde en un des 3 etats SOLUTION 3.

    - True  : succes reel (HTTP 200 + payload de test valide) -> etat connu
    - False : refus API PROUVE (4xx metier 400/401/403/404/422)
    - None  : erreur reseau (429/5xx persistants, ConnectionError, Timeout)
    `err_str` est le message d'erreur de la sonde (str ou None).
    """
    if success:
        return True
    if not err_str:
        # Pas de succes et pas d'erreur explicite -> on ne sait pas, reseau.
        return None
    low = (err_str or "").lower()
    # Refus API metier explicite (4xx -> False) :
    _biz = False
    if "http 4" in low:
        # discriminer 400/401/403/404/422 (False) des 429 (None)
        _code = None
        try:
            _code = int(re.search(r"http (\d{3})", low).group(1))
        except Exception:
            _code = None
        if _code in (400, 401, 403, 404, 422):
            _biz = True
        # 429 -> traite comme reseau (None) plus bas
    if any(k in low for k in ("image refusee", "modality", "unsupported",
                              "outils refuses", "tool refuse")):
        _biz = True
    if _biz:
        return False
    # Tout le reste (timeout, 429, 5xx, connection error, dns) = reseau.
    return None


import mc_backend
from mc_backend import (
    get_cron_execution_logs, 
    get_cron_all_logs, 
    get_notifications, 
    add_notification, 
    calculate_model_score,
    run_cron_now
)
# ---------------------------------------------------------------------------
# Paths & config
# ---------------------------------------------------------------------------
# NOTE: this session's profile data lives under ~/.hermes/profiles/developpeur, but the
# SHARED Hermes state (state.db, gateway_state.json, kanban.db) lives at the
# BASE ~/.hermes. Always resolve to the base; never the profile subdir.
HERMES_HOME = os.path.expanduser("~/.hermes")
PROJECT_DIR = os.environ.get("MC_PROJECT_DIR", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# BAC override: when running the test sandbox we point PROJECT_DIR at the copy
# so the dashboard 'dist/' served is the one we just built (not prod).
if "51999" in str(os.environ.get("PORT", "")):
    PROJECT_DIR = "/tmp/mc-bac"
AGENT_LOGS_DB = os.path.join(PROJECT_DIR, "agent-logs.db")   # fleet logs (read-only)
BOARD_DB = os.path.join(PROJECT_DIR, "board.db")             # OWNER task board (rw)
SCAN_RESULTS_DB = os.path.join(PROJECT_DIR, "scan_results.db")  # Scan tab persisted results (rw)
GATEWAY_STATE = os.path.join(HERMES_HOME, "gateway_state.json")
STATE_DB = os.path.join(HERMES_HOME, "state.db")
MC_MESSAGES_DB = os.path.join(PROJECT_DIR, "mc_messages.db")   # MC dedicated message history (rw)

MODEL_ROUTING_JSON = os.path.join(HERMES_HOME, "agents", "_shared", "model-routing.json")

# their absolute path is injected into the message text so the agent can read them
# via its file/terminal tools (the CLI cannot attach non-image files directly).
UPLOAD_DIR = os.path.join(PROJECT_DIR, "uploads")

# Repertoire des images generees par les agents (ex. vision-image -> ~/images_generees).
# Servi en lecture seule par /api/files/ pour afficher les vignettes dans le chat.
IMAGES_GEN_DIR = os.path.expanduser("~/images_generees")

# Racines autorisees pour la livraison d'attachments via /api/files/.
# On cherche un fichier par nom (basename uniquement) dans chacune, dans l'ordre.
_SERVE_ROOTS = (UPLOAD_DIR, IMAGES_GEN_DIR)


# ---------------------------------------------------------------------------
# Model blacklist (persisted KO models detected at scan time)
# Structure on disk: { "<provider>": ["model_id_1", "model_id_2", ...], ... }
# ---------------------------------------------------------------------------
BLACKLIST_PATH = os.path.join(PROJECT_DIR, "blacklist.json")
_BLACKLIST_LOCK = threading.Lock()


def _load_blacklist():
    """Return {provider: [model_id, ...]} from BLACKLIST_PATH ({} if missing)."""
    try:
        with open(BLACKLIST_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            out = {}
            for k, v in data.items():
                if isinstance(v, list):
                    out[k] = [str(x) for x in v if x]
            return out
        return {}
    except FileNotFoundError:
        return {}
    except Exception as exc:  # noqa: BLE001
        print("[blacklist] load failed:", exc)
        return {}


@contextlib.contextmanager
def _muted_output():
    """Silence stdout/stderr (fd level) for the duration of the block.

    P4 (2026-08-02): Hermes' list_available_providers() unconditionally tries
    to instantiate every provider, including AWS Bedrock, which prints
    "Failed to create Bedrock client ... boto3 required" on every catalog
    rebuild (~every 300s) and floods mc.log. The provider list itself is still
    returned in full, so muting the init chatter loses no functionality.
    fd-level dup2 also catches output emitted through logging handlers.
    """
    saved_out, saved_err = os.dup(1), os.dup(2)
    devnull = os.open(os.devnull, os.O_WRONLY)
    prev_disable = logging.root.manager.disable
    try:
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(devnull, 1)
        os.dup2(devnull, 2)
        logging.disable(logging.CRITICAL)
        yield
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:  # noqa: BLE001
            pass
        logging.disable(prev_disable)
        os.dup2(saved_out, 1)
        os.dup2(saved_err, 2)
        os.close(saved_out)
        os.close(saved_err)
        os.close(devnull)


def _atomic_write_text(path, text):
    """Atomically write text to `path` (temp file + flush + fsync + os.replace).

    P5 (2026-08-02): every profile config.yaml write goes through this so a
    concurrent reader never observes a half-written / truncated YAML file
    (root cause of the transient "Failed to parse ~/.hermes/config.yaml").
    Same pattern already used by _save_blacklist / the PASSWD writer.
    Returns True on success, False on any OS error (never raises).
    """
    tmp = "%s.tmp.%d" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        return True
    except OSError as exc:  # noqa: BLE001
        print("[atomic_write] failed for %s: %s" % (path, exc))
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def _save_blacklist(d):
    """Atomically write the blacklist dict to disk (temp file + os.replace)."""
    try:
        d = d if isinstance(d, dict) else {}
        tmp = BLACKLIST_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(d, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, BLACKLIST_PATH)
        # Invalidate the in-process model catalog cache so /api/models
        # reflects the new blacklist status on the next fetch.
        _CATALOG_CACHE["data"] = None
        return True
    except Exception as exc:  # noqa: BLE001
        print("[blacklist] save failed:", exc)
        return False


MC_FAVS_PATH = os.path.join(PROJECT_DIR, "mc_favs.json")
_MC_FAVS_LOCK = threading.Lock()


def load_mc_favs():
    """Return {agent: ["<provider>/<model_id>", ...]} from MC_FAVS_PATH ({} if missing)."""
    try:
        with open(MC_FAVS_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict):
            out = {}
            for k, v in data.items():
                if isinstance(v, list):
                    out[str(k)] = [str(x) for x in v if x]
            return out
        return {}
    except FileNotFoundError:
        return {}
    except Exception as exc:  # noqa: BLE001
        print("[mc_favs] load failed:", exc)
        return {}


def save_mc_favs(d):
    """Atomically write the favorites dict to disk (temp file + fsync + os.replace)."""
    try:
        d = d if isinstance(d, dict) else {}
        return _atomic_write_text(
            MC_FAVS_PATH, json.dumps(d, indent=2, sort_keys=True, ensure_ascii=False)
        )
    except Exception as exc:  # noqa: BLE001
        print("[mc_favs] save failed:", exc)
        return False


def _blacklist_add(provider, model):
    provider = (provider or "").strip().lower()
    model = (model or "").strip()
    if not provider or not model:
        return _load_blacklist()
    with _BLACKLIST_LOCK:
        d = _load_blacklist()
        lst = d.get(provider) or []
        if model not in lst:
            lst = lst + [model]
        d[provider] = lst
        _save_blacklist(d)
        return d


def _blacklist_remove(provider, model):
    provider = (provider or "").strip().lower()
    model = (model or "").strip()
    with _BLACKLIST_LOCK:
        d = _load_blacklist()
        lst = d.get(provider) or []
        if model in lst:
            lst = [m for m in lst if m != model]
            if lst:
                d[provider] = lst
            else:
                d.pop(provider, None)
        _save_blacklist(d)
        return d


def _blacklist_toggle(provider, model):
    """Toggle provider::model in the blacklist. Returns the updated dict."""
    provider = (provider or "").strip().lower()
    model = (model or "").strip()
    if not provider or not model:
        return _load_blacklist()
    with _BLACKLIST_LOCK:
        d = _load_blacklist()
        lst = d.get(provider) or []
        if model in lst:
            lst = [m for m in lst if m != model]
            if lst:
                d[provider] = lst
            else:
                d.pop(provider, None)
        else:
            lst = lst + [model]
            d[provider] = lst
        _save_blacklist(d)
        return d


def _blacklist_clear(provider):
    """Clear ONE provider's list, or EVERYTHING when provider is empty.

    Returns the updated dict.
    """
    provider = (provider or "").strip().lower()
    with _BLACKLIST_LOCK:
        d = _load_blacklist()
        if provider:
            d.pop(provider, None)
        else:
            d = {}
        _save_blacklist(d)
        return d


def _auto_blacklist(provider, model):
    """Auto-blacklist a model detected as KO during a scan."""
    if provider and model:
        try:
            _blacklist_add(provider, model)
        except Exception:  # noqa: BLE001
            pass


def _annotate_blacklist(providers):
    """Augmenter un mapping {provider: {display_name, freeform, count, models:[...]}}.

    Adds per-model 'blacklisted' (bool) and per-provider 'all_blacklisted'
    (bool) + 'blacklisted_models' (sorted list) used by the UI.
    """
    bl = _load_blacklist()
    for pkey, pinfo in providers.items():
        models = pinfo.get("models") or []
        bl_models = set(bl.get(pkey) or [])
        for m in models:
            m["blacklisted"] = m.get("id") in bl_models
        # Recalculate count: only non-blacklisted models are visible/usable
        visible = [m for m in models if not m.get("blacklisted")]
        pinfo["count"] = len(visible)
        if pinfo["count"] > 0:
            visible_ids = [m.get("id") for m in visible]
            all_bl = bool(visible_ids) and all((mid in bl_models) for mid in visible_ids)
            pinfo["all_blacklisted"] = all_bl
        else:
            pinfo["all_blacklisted"] = False
        pinfo["blacklisted_models"] = sorted(bl_models)
    return providers


def _extract_image_paths(text):
    """Extrait les chemins d'images valides cites dans un texte de reponse agent.

    Ne retient QUE les chemins absolus terminant par une extension image et
    pointant vers une des racines servies (UPLOAD_DIR ou IMAGES_GEN_DIR), pour
    eviter d'exposer d'autres fichiers du systeme. Retourne une liste de
    chemins existants (os.path.isfile), dedupliquee, ordonnee.
    """
    if not text:
        return []
    found = []
    seen = set()
    # Recherche de tous les tokens ressemblant a un chemin absolu.
    for tok in re.findall(r"[^\s'\"]+", text):
        if not os.path.isabs(tok):
            continue
        ext = os.path.splitext(tok)[1].lower()
        if ext not in _IMAGE_EXTS:
            continue
        # On ne garde que les chemins situes sous une racine servie.
        norm = os.path.normpath(tok)
        under = any(norm.startswith(os.path.normpath(r) + os.sep)
                    or norm == os.path.normpath(r) for r in _SERVE_ROOTS)
        if not under:
            continue
        if os.path.isfile(norm) and norm not in seen:
            seen.add(norm)
            found.append(norm)
    return found


def _is_image_file(path):
    """Vrai si le chemin pointe vers un fichier image (extension image)."""
    if not path:
        return False
    return os.path.splitext(path)[1].lower() in _IMAGE_EXTS

# Allowed attachment types (extension -> media class).
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".mkv", ".avi"}
_DOC_EXTS = {".pdf", ".txt", ".md", ".csv", ".json", ".log", ".docx",
             ".xlsx", ".pptx", ".yaml", ".yml"}
_ALLOWED_EXTS = _IMAGE_EXTS | _VIDEO_EXTS | _DOC_EXTS
_MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB hard cap per file

# Safe characters allowed in a stored filename (everything else is stripped).
_SAFE_FN_RE = re.compile(r"[^A-Za-z0-9._-]")


def _safe_filename(name: str) -> str:
    """Sanitize an uploaded file name to prevent path traversal / injection."""
    base = os.path.basename(name or "file")
    base = _SAFE_FN_RE.sub("_", base)
    if not base or base in (".", ".."):
        base = "file"
    # Keep extension if present and allowed; drop otherwise.
    ext = os.path.splitext(base)[1].lower()
    if ext and ext not in _ALLOWED_EXTS:
        base = base + ".bin"
    return base


def _parse_multipart(raw: bytes, boundary: str):
    """Minimal stdlib multipart/form-data parser.

    Returns dict fieldname -> list of (filename_or_None, content_bytes).
    Only extracts the parts we need; does not stream to disk here.
    """
    parts = {}
    delim = ("--" + boundary).encode("utf-8")
    # Split on the delimiter; skip the leading empty segment.
    chunks = raw.split(delim)
    for chunk in chunks:
        # End marker is "--\r\n" after last delimiter; skip it.
        if chunk in (b"--\r\n", b"--", b"\r\n", b""):
            continue
        # Each part starts with \r\n then headers, then \r\n\r\n then body.
        if b"\r\n\r\n" not in chunk:
            continue
        head, body = chunk.split(b"\r\n\r\n", 1)
        # Strip the trailing \r\n that precedes the next delimiter.
        if body.endswith(b"\r\n"):
            body = body[:-2]
        # Parse Content-Disposition for name + filename.
        name = None
        filename = None
        for line in head.decode("utf-8", "replace").split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                for tok in line.split(";"):
                    tok = tok.strip()
                    if tok.startswith("name="):
                        name = tok[5:].strip().strip('"')
                    elif tok.startswith("filename="):
                        filename = tok[9:].strip().strip('"')
        if name is None:
            continue
        parts.setdefault(name, []).append((filename, body))
    return parts




PORT = int(os.environ.get("PORT", 51763))
HOST = "0.0.0.0"            # bind all LAN interfaces (access from tablet/PC)
CACHE_TTL = 3.5              # seconds (légèrement > SSE_INTERVAL pour que le tick SSE + les appels REST partagent le même payload)
SSE_INTERVAL = 3.0          # seconds

# Per-instance chat diagnostic log (one file per port, never clobbered).
_CHAT_LOG_PATH = "/tmp/mc_server_%d.log" % PORT


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# code used as short label in activity feed; `feed_display` is the exact
# casing the activity-feed template uses (manager shown as "MGR").
FLEET_META = {
    "manager": {
        "code": "A-00", "initials": "MA", "role": "Coordinator",
        "channel": "Manageur", "name": "Manager", "feed_display": "MGR",
    },
    "recherche": {
        "code": "A-01", "initials": "RE", "role": "Research",
        "channel": "recherche", "name": "Recherche", "feed_display": "RE",
    },
    "analyse": {
        "code": "A-05", "initials": "AN", "role": "Analyst",
        "channel": "analyse", "name": "Analyse", "feed_display": "AN",
    },
    "redacteur": {
        "code": "A-06", "initials": "RC", "role": "Redactor",
        "channel": "redacteur", "name": "Redacteur", "feed_display": "RC",
    },
    "social": {
        "code": "A-07", "initials": "SO", "role": "Social",
        "channel": "social", "name": "Social", "feed_display": "SO",
    },
    "reseau": {
        "code": "A-03", "initials": "RS", "role": "Infrastructure",
        "channel": "reseau", "name": "Reseau", "feed_display": "RS",
    },
    "developpeur": {
        "code": "A-04", "initials": "DV", "role": "Engineering",
        "channel": "developpeur", "name": "Developpeur", "feed_display": "DV",
    },
    "vision-image": {
        "code": "A-08", "initials": "VI", "role": "Vision-Image",
        "channel": "vision-image", "name": "Vision-Image", "feed_display": "VI",
    },
    "vision-media": {
        "code": "A-09", "initials": "VM", "role": "Vision-Media",
        "channel": "vision-media", "name": "Vision-Media", "feed_display": "VM",
    },
    "bob": {
        "code": "A-10", "initials": "BO", "role": "Débogage",
        "channel": "bob", "name": "Bob", "feed_display": "BO",
    },
    "agentique": {
        "code": "A-11", "initials": "AG", "role": "Agentique",
        "channel": "agentique", "name": "Agentique", "feed_display": "AG",
    },
}
# Ordre d'affichage de la flotte (Bureau + onglet Agents + feed). L'agent
# `documentaliste` a ete decompose en `redacteur` + `social` (juil. 2026) ;
# ses fonctions sont conservees et reattribuees, il n'apparait plus ici.
# Les codes A-05..A-09 respectent la spec de decoupage (non lineaires).
FLEET_ORDER = [
    "manager", "recherche", "analyse", "redacteur", "social",
    "reseau", "developpeur", "vision-image", "vision-media", "bob",
    "agentique",
]

# ---------------------------------------------------------------------------
# Dynamic fleet discovery (2026-07-30, DEVELOPPEUR).
# The fleet is no longer fully hard-coded: any Hermes profile directory under
# ~/.hermes/profiles/ that owns a config.yaml (or SOUL.md) becomes a fleet
# member automatically, so an agent created via /api/fleet/agent/create shows
# up in EVERY tab (overview, messages, agents, bureau) without a code edit.
# Known agents keep their curated code/initials/role from FLEET_META; newly
# discovered profiles get derived values.
# ---------------------------------------------------------------------------
_DISCOVERED_ORDER = []   # filled once at import by _discover_profiles()


def _discover_profiles() -> list:
    """Return sorted list of profile dirs under PROFILES_DIR with a config.yaml
    or SOUL.md. Excludes the active-session profile dirs and hidden dirs.

    EXCLUSIONS: 'default' is the merged Manager coordinator profile (already
    represented by the 'manager' fleet key) should not appear
    as a separate fleet card to avoid duplicates / stale entries."""
    _EXCLUDE = {"default", "__pycache__"}
    found = []
    if not os.path.isdir(PROFILES_DIR):
        return found
    for name in sorted(os.listdir(PROFILES_DIR)):
        if name.startswith(".") or name in _EXCLUDE:
            continue
        # MC-dedicated profiles (created 2026-08-04 for session isolation) are
        # NOT fleet agents — they must not appear as separate dashboard cards.
        if name.endswith("-mc"):
            continue
        pdir = os.path.join(PROFILES_DIR, name)
        if not os.path.isdir(pdir):
            continue
        if os.path.exists(os.path.join(pdir, "config.yaml")) or \
           os.path.exists(os.path.join(pdir, "SOUL.md")):
            found.append(name)
    return found


def _is_fleet_agent(agent: str) -> bool:
    """True if `agent` is a curated fleet member OR a discovered Hermes profile.
    Used by the API guards so agents created via /api/fleet/agent/create (or any
    external `hermes` profile) can immediately chat / appear in the dashboard."""
    if agent in FLEET_META:
        return True
    return agent in set(_discover_profiles())


def _redacteur_write_soul(key, name, role, mission, functions, soul_path):
    """BACKGROUND worker (2026-07-30, DEVELOPPEUR) : delegue la REDACTION du
    SOUL.md au agent `redacteur` via un subprocess `hermes chat -Q`. Le Redacteur
    ecrit lui-meme le fichier en respectant le format commun de la flotte (cf.
    ~/.hermes/profiles/*/SOUL.md : en-tete flotte + directives universelles +
    delegation MC). Il delegue ensuite a Developpeur l'integration dashboard,
    mais celle-ci est deja assuree par le scan dynamique de profils.

    Brief transmis au Redacteur :
      - chemin exact du fichier a ecrire (obligatoire)
      - nom / role / mission / fonctions du nouvel agent
      - contrainte de format (partie commune + partie dediee)
    """
    import subprocess as _sp
    _chat_log("redacteur soul: debute pour agent=%s -> %s" % (key, soul_path))
    # Format commun extrait des SOUL.md existants (utilise comme reference).
    _ref = _read_common_soul_template()
    _brief = (
        "Tu es REDACTEUR de la flotte Hermes. Ecris le fichier SOUL.md d'un "
        "nouvel agent de la flotte de piloubruce en utilisant tes outils "
        "(file_write) pour ecrire DIRECTEMENT le fichier a ce chemin exact : "
        "%s\n\n"
        "Identite du nouvel agent :\n"
        "- Clé interne : %s\n"
        "- Nom affiche : %s\n"
        "- Role : %s\n"
        % (soul_path, key, name, role)
    )
    if mission:
        _brief += "- Mission (ce que l'agent doit faire) : %s\n" % mission
    _brief += "- Fonctions (une par ligne) :\n%s\n\n" % functions
    _brief += (
        "CONTRAINTES DE FORMAT (respecte STRICTEMENT) :\n"
        "1. Le fichier doit commencer par un en-tete listant les agents de la "
        "flotte (Manager, Recherche, Analyste, Redacteur, Social, Reseau, "
        "Developpeur, Vision-Image, Vision-Media, Debug) avec leurs codes.\n"
        "2. Inclure les sections standard : '## Role', '## Directive "
        "d'execution des actions et reponses' (execution avant reponse, passe "
        "compose), '## Outils', '## REGLE D'EXECUTION MC', et la '## "
        "DIRECTIVE UNIVERSELLE'.\n"
        "3. La partie dedicatee a ce nouvel agent (Role + fonctions) doit etre "
        "redigee en francais clair, voix humaine, sans jargon.\n"
        "4. Reference de format commun (ne la copie pas mot pour mot, inspire "
        "toi-en) :\n%s\n\n"
        "Ecris le fichier maintenant. Ne reponds qu'apres avoir verifie que le "
        "fichier existe et contient bien le contenu. [deleg_from=developpeur]"
        % (_ref if _ref else "(format commun non disponible)")
    )
    try:
        _sp.run(
            ["hermes", "chat", "-p", "redacteur", "-q", _brief, "-Q"],
            env=_chat_env(), timeout=600,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        _chat_log("redacteur soul: termine agent=%s (fichier=%s, present=%s)" % (
            key, soul_path, os.path.exists(soul_path)))
    except Exception as exc:  # noqa: BLE001
        _chat_log("redacteur soul ECHEC agent=%s: %s" % (key, exc))


def _read_common_soul_template() -> str:
    """Return the common SOUL.md header/sections from an existing agent as a
    reference snippet for the Redacteur (so new SOUL.md files stay consistent)."""
    _samples = ["redacteur", "developpeur", "recherche"]
    _parts = []
    for _a in _samples:
        _p = os.path.join(PROFILES_DIR, _a, "SOUL.md")
        if os.path.exists(_p):
            try:
                _parts.append(open(_p, encoding="utf-8").read()[:1500])
            except Exception:
                pass
    return "\n\n---\n\n".join(_parts)


def fleet_keys_ordered() -> list:
    """Union of curated FLEET_ORDER + dynamically discovered profiles, de-duped,
    curated first (stable display order), then new profiles alphabetically.

    Re-scans PROFILES_DIR on EVERY call (cheap: a few stat() calls) so a profile
    created via /api/fleet/agent/create (or externally via `hermes`) appears in
    the fleet immediately on the next /api/state poll — no stale cache, no
    server restart needed."""
    global _DISCOVERED_ORDER
    _DISCOVERED_ORDER = _discover_profiles()
    seen = set()
    out = []
    for k in FLEET_ORDER + _DISCOVERED_ORDER:
        if k in seen:
            continue
        seen.add(k)
        out.append(k)
    return out


# ---- Per-agent model config (read/write each profile's config.yaml) ----
# NOTE: `hermes config set` always targets the ACTIVE profile and ignores
# HERMES_PROFILE, so we read/write each agent's config.yaml directly (stdlib
# line editor — no PyYAML, no subprocess) to stay within the "stdlib only" rule.
PROFILES_DIR = os.path.join(HERMES_HOME, "profiles")
SESSIONS_DIR = os.path.join(PROJECT_DIR, "sessions")
MODEL_CATALOG_JSON = os.path.join(HERMES_HOME, "cache", "model_catalog.json")
# Installed model-provider plugins (gemini=Google AI Studio, fireworks,
# anthropic, vertex, bedrock, ...). Scanning this dir lets the model picker
# expose EVERY provider Hermes can use, not just the two hard-coded in the
# curated catalog — so adding a provider in Hermes makes it appear in the
# dashboard automatically.
PLUGINS_DIR = os.path.join(HERMES_HOME, "hermes-agent", "plugins", "model-providers")
SESSIONS_LOCK = threading.Lock()  # serialise per-agent session file writes


def _profile_config_path(agent: str) -> str:
    # 2026-07-28: 'manager' coordinator was merged into the 'default' profile.
    # Resolve the virtual 'manager' key to the real 'default' directory so the
    # model picker / config editor keep working after the profiles/manager/
    # directory was removed.
    agent = _PROFILE_ALIASES.get(agent, agent)
    if agent == "default":
        # The 'default' profile is the ROOT ~/.hermes (HERMES_HOME), not a
        # profiles/default/ subdir. A leftover profiles/default/config.yaml
        # (provider: custom with no name) was being read instead, so the chat
        # subprocess got `--provider custom` -> Hermes fell back to openrouter
        # -> "Provider resolver returned an empty API key". Point at the root
        # config where model.provider = custom:omni-route lives.
        return os.path.join(HERMES_HOME, "config.yaml")
    return os.path.join(PROFILES_DIR, agent, "config.yaml")


def _fallback_config_path(agent: str) -> str:
    """Where fallback_providers live for an agent.

    For manager/default the fallbacks were authored in
    profiles/default/config.yaml (separate from the root config that holds the
    default provider), so read/write them there. Other agents use their own
    profile config.
    """
    agent = _PROFILE_ALIASES.get(agent, agent)
    if agent == "default":
        return os.path.join(PROFILES_DIR, "default", "config.yaml")
    return os.path.join(PROFILES_DIR, agent, "config.yaml")


def _hermes_profile(agent: str, mc_mode: bool = False) -> str:
    """Map a fleet/display agent key to the real Hermes CLI profile name.

    2026-07-28: the 'manager' coordinator role was merged into the 'default'
    profile (the profiles/manager/ directory was deleted during cleanup). The
    dashboard still shows the 'manager' label, but every `hermes -p <agent>`
    CLI invocation must target the real 'default' profile, otherwise Hermes
    errors with "Profile 'manager' does not exist".
    
    2026-08-04 (Option A): When mc_mode=True, returns the MC-dedicated profile
    name (e.g., 'redacteur' -> 'redacteur-mc') for isolated session storage.
    When mc_mode=False (default), returns the real profile name for normal
    operations (model picker, config editor, etc.).
    """
    # 2026-08-06 (BOB): revert Option A. mc_mode ne derive PLUS vers *-mc.
    # Les profils *-mc sont supprimes; on retourne toujours le profil natif.
    return _PROFILE_ALIASES.get(agent, agent)


# Cache court (2s) des modeles configures par agent. read_fleet() appelle
# read_agent_model() pour CHAQUE agent de la flotte (~11) ; sans cache chaque
# /api/state coutait ~0.8s de CPU rien qu'en parsant les config.yaml (audit
# 2026-08-07). Invalide sur tout ecriture de config.yaml (_write_model_block,
# _write_fallbacks_block, _write_disabled_skills) pour ne jamais servir un
# modele perime au-dela d'un tick SSE.
_AGENT_MODEL_CACHE = {"ts": 0.0, "payload": {}}
_AGENT_MODEL_CACHE_TTL = 2.0
_AGENT_MODEL_LOCK = threading.Lock()


def _invalidate_agent_model_cache():
    with _AGENT_MODEL_LOCK:
        _AGENT_MODEL_CACHE["ts"] = 0.0
        _AGENT_MODEL_CACHE["payload"] = {}


def _read_agent_model_one(agent: str):
    """Compute {provider, model, fallbacks} for ONE agent profile (uncached)."""
    path = _profile_config_path(agent)
    if not os.path.exists(path):
        return None
    block = _read_model_block(path)
    provider = block.get("provider")
    model = block.get("default")
    base_url = block.get("base_url")
    # FIX: Resolve "custom" provider to its original name for correct UI display
    # Pass base_url so we can match against global custom_providers registry
    if provider:
        provider = _resolve_provider_name(provider, base_url)
    return {
        "provider": provider,
        "model": model,
        "fallbacks": _read_fallbacks(_fallback_config_path(agent)),
    }


def read_agent_model(agent: str):
    """Return {provider, model, fallbacks} for an agent profile, or None if no
    profile exists.

    `fallbacks` = the top-level `fallback_providers:` YAML list of the agent's
    config.yaml, each entry normalized to {provider, model, base_url?} in the
    EXACT stored order (position 0 = first fallback tried after the default).
    `manager` is a virtual coordinator role with no Hermes profile -> None.

    FIX (2026-08-04): When provider is "custom" or "custom:<name>", attempt to
    resolve the original provider name from custom_providers config.
    This handles legacy files that were written with provider: custom.

    AUDIT 2026-08-07: memoized ~2s (voir _AGENT_MODEL_CACHE ci-dessus). Le
    premier appel de la fenetre recalcule TOUTE la flotte d'un coup ; les
    appels suivants (les 10 autres agents de read_fleet) sont servis du cache.
    """
    now = time.time()
    with _AGENT_MODEL_LOCK:
        if now - _AGENT_MODEL_CACHE["ts"] < _AGENT_MODEL_CACHE_TTL:
            return _AGENT_MODEL_CACHE["payload"].get(agent)
    # Miss de cache : on recalcule une fois pour toute la flotte.
    payload = {}
    try:
        for key in fleet_keys_ordered():
            try:
                payload[key] = _read_agent_model_one(key)
            except Exception:  # noqa: BLE001
                payload[key] = None
    except Exception:  # noqa: BLE001
        pass
    if agent not in payload:
        payload[agent] = _read_agent_model_one(agent)
    with _AGENT_MODEL_LOCK:
        _AGENT_MODEL_CACHE["ts"] = now
        _AGENT_MODEL_CACHE["payload"] = payload
    return payload.get(agent)


# Global cache for base_url -> provider_name mapping (scanned from all profiles)
_BUILTIN_CUSTOM_PROVIDERS_CACHE = None
_BUILTIN_CUSTOM_PROVIDERS_LOCK = threading.Lock()


def _build_base_url_to_provider_map() -> dict:
    """Build a global map {normalized_base_url: provider_name} from ALL profiles.

    Scans every profile's config.yaml for custom_providers entries and builds
    a lookup map. This allows resolving legacy "provider: custom" entries where
    the profile's own custom_providers is empty but another profile defines it.

    Returns a dict mapping normalized base_url (trailing slash removed) to the
    provider name (e.g., "omniroute", "lmstudio"). Cached for performance.
    
    NOTE: This function reads config.yaml files directly to avoid circular
    dependencies with _read_custom_providers which is defined later.
    """
    global _BUILTIN_CUSTOM_PROVIDERS_CACHE
    with _BUILTIN_CUSTOM_PROVIDERS_LOCK:
        if _BUILTIN_CUSTOM_PROVIDERS_CACHE is not None:
            return _BUILTIN_CUSTOM_PROVIDERS_CACHE
        out = {}
        # Helper to parse custom_providers from a config dict
        def _extract_custom_providers(cfg):
            result = {}
            raw = cfg.get("custom_providers")
            if not raw:
                return result
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except Exception:
                    return result
            if not isinstance(raw, list):
                return result
            for entry in raw:
                if not isinstance(entry, dict):
                    continue
                name = (entry.get("name") or "").strip().lower()
                bu = (entry.get("base_url") or "").strip()
                if name and bu:
                    result[name] = {"base_url": bu.rstrip("/"), "api_key": entry.get("api_key", "") or ""}
            return result
        
        # Scan provider custom_providers from MAIN Hermes config
        main_cfg_path = os.path.join(HERMES_HOME, "config.yaml")
        try:
            with open(main_cfg_path, "r", encoding="utf-8") as fh:
                cfg = yaml.safe_load(fh) or {}
            for name, info in _extract_custom_providers(cfg).items():
                bu = info.get("base_url", "")
                if bu:
                    out[bu.rstrip("/")] = name
        except Exception:
            pass
        
        # Also scan profile-level custom_providers (vision-image, etc.)
        if os.path.isdir(PROFILES_DIR):
            for agent_name in os.listdir(PROFILES_DIR):
                agent_path = os.path.join(PROFILES_DIR, agent_name)
                if not os.path.isdir(agent_path):
                    continue
                cfg_path = os.path.join(agent_path, "config.yaml")
                if not os.path.isfile(cfg_path):
                    continue
                try:
                    with open(cfg_path, "r", encoding="utf-8") as fh:
                        cfg = yaml.safe_load(fh) or {}
                    for name, info in _extract_custom_providers(cfg).items():
                        bu = info.get("base_url", "")
                        if bu:
                            out[bu.rstrip("/")] = name
                except Exception:
                    continue
        _BUILTIN_CUSTOM_PROVIDERS_CACHE = out
        return out


def _resolve_provider_name(provider: str, base_url: str = None) -> str:
    """Resolve a provider name, handling legacy "custom" values.

    If provider is "custom:<name>", return the name.
    If provider is "custom", attempt to find matching custom provider by base_url
    using the global registry from all profiles.
    Otherwise, return the provider unchanged.

    Args:
        provider: The provider name from config.yaml
        base_url: Optional base_url to match against custom_providers for resolution

    Returns:
        The resolved provider name, or the original if no resolution found.
    """
    if not provider:
        return provider
    
    # Import _read_custom_providers here to avoid NameError at module load time
    # It's defined later in the file but Python closures handle this fine
    _custom_providers = _read_custom_providers()
    _base_url_map = _build_base_url_to_provider_map()
    
    if provider.startswith("custom:"):
        name = provider[len("custom:"):].strip().lower()
        if name in _custom_providers:
            return name
        return provider  # fallback to original if not found
    if provider.lower() in _custom_providers:
        return provider  # already the original name
    # Handle legacy "custom" provider - try to match by base_url
    if provider == "custom":
        # Normalize the base_url for matching
        norm_base_url = (base_url or "").strip().rstrip("/")
        if norm_base_url and norm_base_url in _base_url_map:
            return _base_url_map[norm_base_url]
        # Fallback: try to resolve via current profile's custom_providers via base_url
        for name, info in _custom_providers.items():
            if info.get("base_url", "").rstrip("/") == norm_base_url:
                return name
        return provider  # cannot resolve - return "custom" as-is
    return provider


def _read_fallbacks(profile_path):
    """Parse the top-level `fallback_providers:` list of a config.yaml.

    The config files are valid YAML and `yaml` is already imported (stdlib-only
    rule is relaxed for READS; writes still use the line editor). Returns a
    list of {provider, model, base_url?} in stored order; [] when the key is
    absent/malformed. Never raises.
    """
    try:
        with open(profile_path, "r", encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh) or {}
    except Exception:  # noqa: BLE001
        return []
    raw = cfg.get("fallback_providers")
    if not isinstance(raw, list):
        return []
    out = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        provider = str(entry.get("provider") or "").strip()
        model = str(entry.get("model") or "").strip()
        if not provider or not model:
            continue
        item = {"provider": provider, "model": model}
        bu = entry.get("base_url")
        if bu:
            item["base_url"] = str(bu).strip()
        out.append(item)
    return out


def _normalize_fallback(entry):
    """Normalize ONE fallback_providers entry.
    
    A name declared in Hermes' global `custom_providers` (e.g.
    "omni-route", "lmstudio", "ollama") keeps its original provider name
    but resolves base_url/api_key from the custom_providers config.
    Native providers (nous/gemini/openrouter) stay bare without base_url.
    
    Returns a {provider, model, base_url?} dict, or None if
    the entry is unusable (missing provider/model or not a mapping).
    
    FIX (2026-08-04): Keep original provider name (e.g. "omni-route") instead
    of converting to "custom". The provider name is what the UI displays.
    Also handles legacy "provider: custom" (without :name) by matching base_url
    against the global registry built from all profiles.
    """
    if not isinstance(entry, dict):
        return None
    provider = str(entry.get("provider") or "").strip()
    model = str(entry.get("model") or "").strip()
    if not provider or not model:
        return None
    base_url = str(entry.get("base_url") or "").strip()
    api_key = str(entry.get("api_key") or "").strip()
    if provider.startswith("custom:"):
        # UI passes the picker value as "custom:<name>"; resolve base_url.
        name = provider[len("custom:"):].strip().lower()
        cust = _read_custom_providers()
        if name in cust:
            entry_c = cust[name]
            base_url = base_url or entry_c.get("base_url", "")
            api_key = api_key or entry_c.get("api_key", "")
            # Keep the original provider name for display purposes
            # (the UI expects "omni-route", not "custom")
            provider = name
    elif provider.lower() in _read_custom_providers():
        # Provider is a custom provider name (e.g., "omni-route")
        # Resolve base_url/api_key but KEEP the original provider name
        cust = _read_custom_providers()
        entry_c = cust[provider.lower()]
        base_url = base_url or entry_c.get("base_url", "")
        api_key = api_key or entry_c.get("api_key", "")
        # BUG FIX: DO NOT change provider to "custom" - keep original name
        # for correct UI display (omni-route, lmstudio, etc.)
    elif provider == "custom":
        # Legacy case: provider = "custom" without a name
        # Try to resolve via base_url against global registry
        norm_base_url = base_url.rstrip("/") if base_url else ""
        if norm_base_url:
            base_url_map = _build_base_url_to_provider_map()
            if norm_base_url in base_url_map:
                provider = base_url_map[norm_base_url]
                # Try to get api_key from the matched provider's definition
                custom_providers = _read_custom_providers()
                matched_info = custom_providers.get(provider)
                if matched_info:
                    base_url = base_url or matched_info.get("base_url", "")
                    api_key = api_key or matched_info.get("api_key", "")
                # Also check profile-level custom_providers
                if not api_key:
                    for agent_name in os.listdir(PROFILES_DIR) if os.path.isdir(PROFILES_DIR) else []:
                        agent_path = os.path.join(PROFILES_DIR, agent_name)
                        if not os.path.isdir(agent_path):
                            continue
                        cfg_path = os.path.join(agent_path, "config.yaml")
                        if not os.path.isfile(cfg_path):
                            continue
                        try:
                            with open(cfg_path, "r", encoding="utf-8") as fh:
                                cfg = yaml.safe_load(fh) or {}
                            raw = cfg.get("custom_providers")
                            if not raw:
                                continue
                            if isinstance(raw, str):
                                try:
                                    raw = json.loads(raw)
                                except Exception:
                                    continue
                            if isinstance(raw, list):
                                for ent in raw:
                                    if isinstance(ent, dict):
                                        n = (ent.get("name") or "").strip().lower()
                                        bu = (ent.get("base_url") or "").strip().rstrip("/")
                                        if n == provider and bu == norm_base_url:
                                            api_key = api_key or ent.get("api_key", "")
                                            break
                        except Exception:
                            continue
    out = {"provider": provider, "model": model}
    if base_url:
        out["base_url"] = base_url
    if api_key:
        out["api_key"] = api_key
    return out


def _write_fallbacks_block(profile_path, fallbacks):
    """Replace (or append) the top-level `fallback_providers:` list.

    Stdlib-only line editor (mirrors _write_model_block): every other line of
    the config.yaml is preserved byte-for-byte. `fallbacks` must already be a
    list of normalized {provider, model, base_url?} dicts. Writes a REAL YAML
    list (never a JSON string). Returns False on OSError, True otherwise.
    """
    block_lines = ["fallback_providers:"]
    for fb in fallbacks:
        block_lines.append("  - provider: %s" % fb.get("provider", ""))
        block_lines.append("    model: %s" % fb.get("model", ""))
        if fb.get("base_url"):
            block_lines.append("    base_url: %s" % fb["base_url"])
        if fb.get("api_key"):
            block_lines.append("    api_key: %s" % fb["api_key"])
    block_text = "\n".join(block_lines) + "\n"
    try:
        with open(profile_path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return False
    start = None
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped.startswith("fallback_providers:") and indent == 0:
            start = i
            break
    if start is not None:
        # Find the end of the block: next top-level (indent 0) non-blank,
        # non-comment line.
        end = len(lines)
        for j in range(start + 1, len(lines)):
            s = lines[j]
            st = s.lstrip()
            ind = len(s) - len(st)
            if st.strip() == "" or st.strip().startswith("#"):
                continue
            if ind == 0:
                end = j
                break
        lines[start:end] = [block_text]
    else:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        lines.append("\n" + block_text)
    try:
        _ok = _atomic_write_text(profile_path, "".join(lines))
        if _ok:
            _invalidate_agent_model_cache()
        return _ok
    except OSError:
        return False


def set_agent_model(agent: str, provider: str, model: str, fallbacks=None):
    """Write model.provider + model.default into the agent's config.yaml.

    Stdlib-only line editor: rewrites the top-level `model:` block's
    `provider:` and `default:` scalars in place. Anti-injection: caller must
    ensure `agent in FLEET_META` and values are non-empty, validated strings.
    Returns False if the profile/config does not exist or the write failed.

    Provider normalization: a name declared in Hermes' global
    `custom_providers` (e.g. "omniroute") is stored as `custom:<name>`
    so Hermes' router resolves it to the OpenAI-compatible endpoint. The
    dashboard picker lists the bare name; this keeps the stored value
    always valid without the UI having to know the `custom:` prefix.

    `fallbacks` (optional): list of {provider, model, base_url?} dicts for
    the top-level `fallback_providers:`. When None (absent), the existing
    fallback_providers block is LEFT UNTOUCHED (backward compatible). When a
    list (even empty), it REPLACES the whole block with the normalized
    entries, preserving every other line of the config.yaml.
    """
    provider = (provider or "").strip()
    # GARDE-FOU (audit 2026-08-07) : '__all__' est la sentinelle "Tous les
    # providers" du picker — JAMAIS un provider Hermes valide. L'UI peut
    # l'envoyer quand on tape un modele librement avec le filtre global
    # selectionne ; l'ecrire dans config.yaml casse le runtime
    # ("Unknown provider '__all__'") et force un fallback. On refuse.
    if provider == "__all__" or provider.lower() == "__all__":
        return False
    base_url = ""
    api_key = ""
    if provider.startswith("custom:"):
        # UI passes the picker value as "custom:<name>"; resolve its
        # base_url/api_key from the declared custom_providers.
        name = provider[len("custom:"):].strip().lower()
        cust = _read_custom_providers()
        if name in cust:
            entry = cust[name]
            base_url = entry.get("base_url", "")
            api_key = entry.get("api_key", "")
    elif provider and not provider.startswith("custom"):
        cust = _read_custom_providers()
        if provider.lower() in cust:
            entry = cust[provider.lower()]
            # Keep original provider name (e.g., "omni-route") instead of "custom"
            # to display correctly in the UI
            base_url = entry.get("base_url", "")
            api_key = entry.get("api_key", "")
        else:
            # Check if a custom provider matches as a prefix (e.g. "nvidia" → "nvidia-direct")
            for cp_name, cp_entry in cust.items():
                if cp_name.startswith(provider.lower()):
                    provider = cp_name
                    base_url = cp_entry.get("base_url", "")
                    api_key = cp_entry.get("api_key", "")
                    break
    path = _profile_config_path(agent)
    if not os.path.exists(path):
        return False
    # lmstudio (provider natif, non-custom) : le router Hermes ne resolut PAS
    # sa base_url tout seul (contrairement a server.py qui lit LM_BASE_URL).
    # On la recupere depuis le .env et on la persiste dans le block pour eviter
    # qu'elle soit purgee a chaque validation de la modale (bug: purge_keys
    # retire base_url quand il n'est pas dans 'updates').
    if provider.lower() == "lmstudio":
        lm_bu = (os.environ.get("LM_BASE_URL") or _read_dotenv("LM_BASE_URL") or "").strip()
        if lm_bu:
            base_url = lm_bu.rstrip("/") + "/v1" if not lm_bu.rstrip("/").endswith("/v1") else lm_bu.rstrip("/")
    block = {"provider": provider, "default": model}
    # Only persist base_url/api_key when the FINAL provider is a custom one.
    # For non-custom providers (nous, openrouter, ...), never write these keys,
    # so any previously-stored residual base_url/api_key is effectively dropped.
    # EXCEPTION: lmstudio natif -> on persiste base_url (cf. bloc ci-dessus).
    if (provider == "custom" or provider.startswith("custom:") or base_url) and not (provider.lower() == "lmstudio" and not base_url):
        if base_url:
            block["base_url"] = base_url
        if api_key:
            block["api_key"] = api_key
    if not _write_model_block(path, block):
        return False
    if fallbacks is not None:
        if not isinstance(fallbacks, list):
            fallbacks = []
        normalized = []
        for entry in fallbacks:
            norm = _normalize_fallback(entry)
            if norm is not None:
                normalized.append(norm)
        if not _write_fallbacks_block(_fallback_config_path(agent), normalized):
            return False
    # When a custom provider was resolved, ensure custom_providers block exists
    if base_url and provider and not provider.startswith("custom"):
        _ensure_custom_providers_block(path, provider, base_url, api_key)
    return True


def _ensure_custom_providers_block(profile_path, provider_name, base_url, api_key):
    """Ensure the custom_providers block contains the given provider entry.

    BUG FIX (audit 2026-08-07) : l'ancienne detection scannait les lignes
    avec stripped.startswith() — elle "fermait" le bloc des la premiere cle
    indentee (base_url:), ne detectait donc JAMAIS un provider deja present,
    et re-appendaient un bloc custom_providers entier a CHAQUE POST
    /api/agent/model. C'est le mecanisme qui a cree les doublons YAML a
    l'origine (nvidia-direct ecrase par le 2e bloc). On utilise desormais
    un vrai parse YAML : si le provider existe deja (dans n'importe quel
    bloc), on ne touche a rien.
    """
    import yaml as _yaml
    try:
        with open(profile_path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return False
    try:
        cfg = _yaml.safe_load(text)
    except Exception:
        cfg = None
    if isinstance(cfg, dict):
        cps = cfg.get("custom_providers") or []
        if isinstance(cps, list):
            for entry in cps:
                if isinstance(entry, dict) and (entry.get("name") or "").strip().lower() == provider_name.strip().lower():
                    return True  # deja present, rien a faire
    # Provider absent : ajouter l'entree au DERNIER bloc custom_providers
    # existant si possible (pas un second bloc). Sinon creer le bloc.
    lines = text.splitlines(keepends=True)
    last_cp = None
    for i, line in enumerate(lines):
        if not line.startswith((" ", "\t")) and line.strip().startswith("custom_providers:"):
            last_cp = i
    entry_lines = [
        f"  - name: {provider_name}\n",
        f"    base_url: {base_url}\n",
        f"    api_key: {api_key}\n",
        "    model: ''\n",
        "    context_length: 16384\n",
        "    models:\n",
        "      - nvidia/nemotron-3-ultra-550b-a55b\n",
        "      - nvidia/nemotron-3-super-120b-a12b\n",
        "      - nvidia/nemotron-3-nano-30b-a3b\n",
        "      - nvidia/nemotron-3-nano-omni-30b-a3b-reasoning\n",
        "      - nvidia/nemotron-mini-4b-instruct\n",
        "      - nvidia/nemotron-nano-12b-v2-v1\n",
        "      - nvidia/nvidia-nemotron-nano-9b-v2\n",
        "      - nvidia/llama-3.1-nemotron-nano-vl-8b-v1\n",
        "      - openai/gpt-oss-120b\n",
        "      - openai/gpt-oss-20b\n",
        "      - nvidia/riva-translate-4b-instruct-v1.1\n",
        "      - nvidia/riva-translate-4b-instruct-v2\n",
    ]
    if last_cp is not None:
        # insérer après le dernier bloc custom_providers
        insert_at = last_cp + 1
        # trouver la fin du bloc (prochaine clé racine)
        while insert_at < len(lines):
            l = lines[insert_at]
            if l.strip() and not l.startswith((" ", "\t", "#")):
                break
            insert_at += 1
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        new_lines = lines[:insert_at] + entry_lines + lines[insert_at:]
    else:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        new_lines = lines + ["\n", "custom_providers:\n"] + entry_lines
    return _write_lines(profile_path, new_lines)


def _read_model_block(profile_path):
    """Parse the top-level `model:` block scalars (default/provider/base_url)."""
    out = {}
    try:
        with open(profile_path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return out
    model_indent = None
    start = None
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped.startswith("model:") and indent == 0:
            model_indent = indent
            start = i
            break
    if start is None:
        return out
    for j in range(start + 1, len(lines)):
        s = lines[j]
        stripped = s.lstrip()
        ind = len(s) - len(stripped)
        if stripped.strip() == "":
            continue
        if stripped.strip().startswith("#"):
            continue
        if ind <= model_indent:
            break
        if ":" in stripped:
            k, _, v = stripped.partition(":")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k in ("default", "provider", "base_url"):
                out[k] = v
    return out


def _write_model_block(profile_path, updates):
    """Rewrite `provider:`/`default:` inside the top-level `model:` block."""
    try:
        with open(profile_path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return False
    model_indent = None
    start = None
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped.startswith("model:") and indent == 0:
            model_indent = indent
            start = i
            break
    if start is None:
        return False
    found = set()
    # Keys that must be removed from the block if the caller did not include
    # them in `updates` (i.e. the caller explicitly does not want them kept).
    # This is what drops a previously-stored residual custom base_url/api_key
    # when switching back to a non-custom provider.
    purge_keys = {"base_url", "api_key"} - set(updates.keys())
    for j in range(start + 1, len(lines)):
        s = lines[j]
        stripped = s.lstrip()
        ind = len(s) - len(stripped)
        if stripped.strip() == "":
            continue
        if stripped.strip().startswith("#"):
            continue
        if ind <= model_indent:
            break
        if ":" in stripped:
            k, _, v = stripped.partition(":")
            k = k.strip()
            if k in purge_keys:
                # Drop this line entirely so the residual is not persisted.
                lines[j] = None
                continue
            if k in updates:
                lines[j] = "%s%s: %s\n" % (" " * ind, k, updates[k])
                found.add(k)
    # Rebuild lines without the purged (None) entries.
    lines = [ln for ln in lines if ln is not None]
    missing = [k for k in updates if k not in found]
    if missing:
        insert_at = start + 1
        for k in reversed(missing):
            lines.insert(insert_at, "  %s: %s\n" % (k, updates[k]))
    try:
        _ok = _atomic_write_text(profile_path, "".join(lines))
        if _ok:
            _invalidate_agent_model_cache()
        return _ok
    except OSError:
        return False
    return True


# ---- Per-agent skills (read/write skills.disabled in each profile's config.yaml) ----
# 2026-08-01 (DEVELOPPEUR): the Zap button on an agent card opens a modal that
# toggles that agent's skills. Two sources of truth:
#   - the list of installed skills = every directory under the profile's
#     skills/ root that contains SKILL.md (name = leaf dir basename);
#   - the disabled state = the `skills.disabled:` block in config.yaml.
# PIEGE HERMES (2026-08-01): if skills.disabled is stored as a JSON STRING
# ('["a","b"]'), Hermes itself treats it as ONE literal skill name (so the
# whole list silently stops working). All readers here normalise BOTH forms
# (real YAML list OR JSON string) into a real list, and every write emits a
# REAL YAML list. Stdlib-only line editor, no PyYAML dependency (mirrors the
# _write_model_block pattern above).


def _profile_skills_dir(agent: str) -> str:
    """Skills root for an agent's real profile.

    Mirrors _profile_config_path: 'manager' resolves to the 'default' profile,
    whose skills live in the ROOT ~/.hermes/skills (not profiles/default/skills).
    Every other profile uses ~/.hermes/profiles/<real>/skills.
    """
    real = _PROFILE_ALIASES.get(agent, agent)
    if real == "default":
        return os.path.join(HERMES_HOME, "skills")
    return os.path.join(PROFILES_DIR, real, "skills")


def _discover_profile_skills(agent: str):
    """Return [(skill_name, skill_dir_path), ...] sorted by name.

    Recursive walk of the profile's skills root. Hermes stores skills as
    <root>/<category>/<skill>/SKILL.md but also allows flat <root>/<skill>/SKILL.md
    (a few profile-local skills sit directly at the root, e.g.
    hermes-desktop-plugins, mail-watch). A skill = any directory that directly
    contains SKILL.md; its name is the leaf dir basename (exactly what Hermes
    uses in skills.disabled). Duplicate leaf names are deduped (first wins).
    """
    root = _profile_skills_dir(agent)
    if not os.path.isdir(root):
        return []
    seen = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        if "SKILL.md" in filenames:
            name = os.path.basename(dirpath)
            if name not in seen:
                seen[name] = dirpath
    return sorted(seen.items())


def _parse_inline_disabled(val: str):
    """Normalize an inline `disabled:` scalar into a list of skill names.

    Accepts every form Hermes may have persisted:
      - '["a","b"]' / '[]'          (JSON string — the legacy trap)
      - ["a","b"] / []              (bare JSON)
      - ['a','b']                   (bare JSON with single quotes)
      - a / 'a'                     (single scalar name)
    Returns a (possibly empty) list of stripped names.
    """
    val = (val or "").strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
        val = val[1:-1].strip()
    if val.startswith("[") and val.endswith("]"):
        try:
            parsed = json.loads(val)
            if isinstance(parsed, list):
                return [str(x).strip() for x in parsed if str(x).strip()]
        except Exception:  # noqa: BLE001
            pass
        inner = val[1:-1]
        if not inner.strip():
            return []
        return [x.strip().strip('"').strip("'") for x in inner.split(",") if x.strip()]
    if val:
        return [val]
    return []


def _read_disabled_skills(profile_path: str) -> list:
    """Return the list of disabled skill names from config.yaml (normalised).

    Hand-rolled stdlib parser for the top-level `skills:` block:
        skills:
          creation_nudge_interval: 15
          disabled:
            - nom1
            - nom2
    Also accepts the legacy inline JSON-string form (`disabled: '["a","b"]'`)
    and normalises it to a real list. Unknown/missing block -> [].
    """
    try:
        with open(profile_path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return []
    disabled = []
    in_skills = False
    list_indent = None
    for line in lines:
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if not stripped.strip() or stripped.strip().startswith("#"):
            continue
        if not in_skills:
            if stripped.startswith("skills:") and indent == 0:
                in_skills = True
            continue
        if indent == 0:
            break  # next top-level key -> skills block ended
        if list_indent is not None:
            if indent > list_indent:
                if stripped.startswith("- "):
                    item = stripped[2:].strip().strip('"').strip("'")
                    if item:
                        disabled.append(item)
                continue
            list_indent = None
        if stripped.startswith("disabled:"):
            val = stripped[len("disabled:"):].strip()
            if val:
                disabled.extend(_parse_inline_disabled(val))
            else:
                list_indent = indent
    return disabled


def _write_lines(profile_path: str, lines) -> bool:
    """Atomic (temp+fsync+os.replace) rewrite of a profile config.yaml. P5."""
    _ok = _atomic_write_text(profile_path, "".join(lines))
    if _ok:
        _invalidate_agent_model_cache()
    return _ok


def _write_disabled_skills(profile_path: str, disabled: list) -> bool:
    """Rewrite `skills.disabled:` in config.yaml as a REAL YAML list.

    Stdlib-only line editor (mirrors _write_model_block): preserves every other
    line/block of the file and only touches the disabled sub-block under the
    top-level `skills:` key. If the block is missing it is appended at the end
    of the file; if `disabled:` is missing it is inserted right after the
    `skills:` line. `disabled` must be a sorted list of names.
    """
    try:
        with open(profile_path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return False
    skills_start = None
    for i, line in enumerate(lines):
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if stripped.startswith("skills:") and indent == 0:
            skills_start = i
            break
    if skills_start is None:
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        block = ["skills:\n", "  disabled:\n"]
        block += ["    - %s\n" % name for name in disabled]
        lines.append("\n")
        lines += block
        return _write_lines(profile_path, lines)

    # Locate the disabled: key inside the skills block (first sub-key wins).
    disabled_idx = None
    disabled_indent = None
    block_end = len(lines)
    for j in range(skills_start + 1, len(lines)):
        s = lines[j]
        stripped = s.lstrip()
        ind = len(s) - len(stripped)
        if not stripped.strip() or stripped.strip().startswith("#"):
            continue
        if ind == 0:
            block_end = j
            break
        if stripped.startswith("disabled:"):
            disabled_idx = j
            disabled_indent = ind
            break
    if disabled_idx is None:
        # Insert a fresh disabled: list right after the skills: line.
        out = []
        for k, line in enumerate(lines):
            out.append(line)
            if k == skills_start:
                out.append("  disabled:\n")
                for name in disabled:
                    out.append("    - %s\n" % name)
        return _write_lines(profile_path, out)

    # Remove the existing disabled: line + any following list items.
    remove_to = disabled_idx + 1
    for k in range(disabled_idx + 1, block_end):
        s = lines[k]
        stripped = s.lstrip()
        ind = len(s) - len(stripped)
        if not stripped.strip() or stripped.strip().startswith("#"):
            continue
        if ind <= disabled_indent:
            break
        remove_to = k + 1
    repl = ["%sdisabled:\n" % (" " * disabled_indent)]
    repl += ["%s- %s\n" % (" " * (disabled_indent + 2), name) for name in disabled]
    lines[disabled_idx:remove_to] = repl
    return _write_lines(profile_path, lines)


def _backup_config(profile_path: str) -> str:
    """Copy config.yaml to config.yaml.bak-<timestamp> (same dir, 0600-ish).
    Returns the backup path, or None if the copy failed."""
    try:
        bak = "%s.bak-%s" % (profile_path, time.strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(profile_path, bak)
        return bak
    except OSError:
        return None


# Map plugin dir name -> friendly "display_name" shown in the picker.
# Only used when the plugin.yaml has no explicit display hint. New Hermes
# providers become visible automatically; this dict just prettifies the
# well-known ones (keys are the plugin dir basenames).
PROVIDER_DISPLAY_NAMES = {
    "gemini": "Google AI Studio",
    "fireworks": "Fireworks",
    "anthropic": "Anthropic",
    "openrouter": "OpenRouter",
    "nous": "Nous Portal",
    "openai-codex": "OpenAI Codex",
    "vertex": "Google Vertex AI",
    "bedrock": "AWS Bedrock",
    "azure-foundry": "Azure AI Foundry",
    "deepseek": "DeepSeek",
    "xai": "xAI",
    "ollama-cloud": "Ollama Cloud",
    "zai": "Z.AI / GLM",
    "kimi-coding": "Kimi / Moonshot",
    "minimax": "MiniMax",
    "novita": "Novita",
    "alibaba": "Alibaba",
    "stepfun": "StepFun",
    "huggingface": "HuggingFace",
    "nvidia": "NVIDIA",
    "upstage": "Upstage",
    "arcee": "Arcee",
    "gmi": "GMI",
    "kilocode": "Kilo Code",
    "qwen-oauth": "Qwen",
    "opencode-zen": "OpenCode Zen",
    "custom": "Custom (OpenAI-compatible)",
}


def _scan_provider_plugins():
    """Return {provider_key: display_name} for every installed provider plugin.

    Reads the plugin.yaml `name:` field if present, else derives a slug from
    the directory name (the slug is exactly what `hermes chat --provider X`
    expects). Plugins under model-providers/ are the ground-truth set of
    providers Hermes can route to. Missing/unreadable dir -> empty dict.
    """
    out = {}
    if not os.path.isdir(PLUGINS_DIR):
        return out
    try:
        entries = sorted(os.listdir(PLUGINS_DIR))
    except OSError:
        return out
    for name in entries:
        d = os.path.join(PLUGINS_DIR, name)
        if not os.path.isdir(d) or name in ("README.md",):
            continue
        # Provider key handed to hermes chat --provider is the slug =
        # dir name with "-provider" suffix stripped and "_" -> "-".
        key = name
        if key.endswith("-provider"):
            key = key[: -len("-provider")]
        key = key.replace("_", "-")
        if not key:
            continue
        display = PROVIDER_DISPLAY_NAMES.get(key, key.replace("-", " ").title())
        # Allow a plugin.yaml to override the display name.
        py = os.path.join(d, "plugin.yaml")
        if os.path.isfile(py):
            try:
                with open(py, "r", encoding="utf-8") as fh:
                    for line in fh:
                        s = line.strip()
                        if s.startswith("name:"):
                            v = s.split(":", 1)[1].strip().strip('"').strip("'")
                            # The plugin.yaml name is usually just the slug
                            # (e.g. alibaba-provider); ignore it unless it is a
                            # human-readable label distinct from the directory
                            # slug, so we keep our pretty display names.
                            if v and v.lower() != key and not v.lower().endswith("-provider"):
                                display = v
                            break
            except OSError:
                pass
        out[key] = display
    # Merge custom_providers (omni-route, free-llm-api, ...) so they appear
    # in the scan list even though they have no model-provider plugin.
    try:
        for cname, cinfo in _read_custom_providers().items():
            if cname and cname not in out:
                out[cname] = cname.replace("-", " ").title()
    except Exception:
        pass
    # Filter out providers disabled via providers.<name>.enabled: false
    try:
        cfg_path = os.path.join(HERMES_HOME, "config.yaml")
        with open(cfg_path, "r", encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh) or {}
        provs_cfg = cfg.get("providers") if isinstance(cfg, dict) else None
        if isinstance(provs_cfg, dict):
            for pname, pblock in provs_cfg.items():
                if isinstance(pblock, dict) and pblock.get("enabled") is False:
                    out.pop(pname, None)
    except Exception:
        pass
    return out


# ---------------------------------------------------------------------------
# Live model catalog — delegates to Hermes' OWN provider discovery
# ---------------------------------------------------------------------------
# Hermes ships provider_model_ids()/cached_provider_model_ids() in
# hermes_cli.models. That module ALREADY knows how to LIVE-fetch every
# provider's real model list: OpenRouter /v1/models, Nous Portal (incl.
# the :free tier like tencent/hy3:free), Anthropic /v1/models, Gemini,
# the generic api-key providers (DeepSeek, Fireworks, ...), etc. We REUSE
# it so the dashboard picker shows a clickable model list for EVERY usable
# provider instead of the old openrouter+nous-only hard-coded subset.
#
# Providers that return NO discoverable list (no API key, unreachable)
# fall back to `freeform: true` so the UI still offers a free-text field
# and the user can type the exact model id by hand.
#
# The OpenAI-compatible `custom` provider (LM Studio, local vLLM, ...) is
# handled HERE: Hermes only probes model.base_url (empty in our setup)
# and prefers /models over /v1/models, so we read LM_BASE_URL/LM_API_KEY
# from ~/.hermes/.env and probe {base_url}/v1/models directly.
_HM_MODELS = None
_HM_IMPORT_ERR = None


_DOTENV_LOADED = False


def _load_hermes_dotenv():
    """Load $HERMES_HOME/.env into os.environ (once, non-overriding).

    Hermes' provider discovery reads credentials from the process env
    (OPENAI_API_KEY/OPENAI_BASE_URL for openai-api/FreeLLM, LM_API_KEY/
    LM_BASE_URL for lmstudio, ...). The dashboard server is not launched
    through `hermes`, so that .env was never sourced -> those providers
    looked credential-less and returned empty model lists. Sourcing it
    here makes openai-api and lmstudio discover their real models, exactly
    like the native `hermes model` picker does.
    """
    global _DOTENV_LOADED
    if _DOTENV_LOADED:
        return
    _DOTENV_LOADED = True
    p = os.path.join(HERMES_HOME, ".env")
    try:
        with open(p, "r", encoding="utf-8") as fh:
            for line in fh:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, _, v = s.partition("=")
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError:
        pass


def _import_hermes_models():
    """Import hermes_cli.models once (best-effort). Returns the module or None."""
    global _HM_MODELS, _HM_IMPORT_ERR
    if _HM_MODELS is not None or _HM_IMPORT_ERR is not None:
        return _HM_MODELS
    try:
        import sys as _sys  # noqa: WPS433 (lazy import — keep stdlib out until needed)
        _ha = os.path.join(HERMES_HOME, "hermes-agent")
        if _ha not in _sys.path:
            _sys.path.insert(0, _ha)
        # Pin HERMES_HOME so Hermes reads the SHARED state dir, never a
        # profile subdir the launching shell may have exported.
        os.environ.setdefault("HERMES_HOME", HERMES_HOME)
        # Provider discovery needs the .env credentials in os.environ.
        _load_hermes_dotenv()
        import hermes_cli.models as _m  # type: ignore
        _HM_MODELS = _m
    except Exception as exc:  # noqa: BLE001
        _HM_IMPORT_ERR = exc
        print("[model_catalog] hermes_cli.models import failed:", exc)
        _HM_MODELS = None
    return _HM_MODELS


def _read_dotenv(key, default=""):
    """Read a single KEY=VALUE from $HERMES_HOME/.env (best-effort)."""
    if os.environ.get(key):
        return os.environ[key]
    p = os.path.join(HERMES_HOME, ".env")
    try:
        with open(p, "r", encoding="utf-8") as fh:
            for line in fh:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, _, v = s.partition("=")
                if k.strip() == key:
                    return v.strip().strip('"').strip("'")
    except OSError:
        pass
    return default


# In-process short cache so repeated modal opens never re-hit the network.
_CATALOG_CACHE = {"at": 0.0, "data": None}
_CATALOG_TTL = 300.0


def _parse_all_custom_providers_blocks(path):
    """Parse ALL root-level `custom_providers:` blocks of a YAML file and merge
    their entries by name.

    GARDE-FOU (audit 2026-08-07, DEVELOPPEUR) : yaml.safe_load() ne garde que
    la DERNIERE occurrence d'une cle dupliquee. Quand un outil externe (ou un
    modele AI) reecrit config.yaml en AJOUTANT un second bloc
    `custom_providers:` au lieu de modifier l'existant, le premier bloc est
    silencieusement ecrase -> le provider qu'il contenait (ex: nvidia-direct)
    disparait du picker ET du scan du dashboard sans aucun message d'erreur.
    Ce helper relit le fichier brut, decoupe chaque bloc racine et fusionne
    toutes les entrees. Retourne {} si pas de doublon (usage normal).
    """
    merged = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        return merged
    starts = []
    for i, line in enumerate(lines):
        if line.strip() == "custom_providers:":
            starts.append(i)
    if len(starts) <= 1:
        return merged  # pas de doublon -> inutile
    print("[config] WARNING: %d blocs custom_providers: dans %s — fusion manuelle"
          % (len(starts), path))
    bounds = starts + [len(lines)]
    for bi, s in enumerate(starts):
        e = bounds[bi + 1]
        block_text = "".join(lines[s:e])
        try:
            data = yaml.safe_load(block_text) or {}
        except Exception:
            continue
        for entry in (data.get("custom_providers") or []):
            if not isinstance(entry, dict):
                continue
            name = (entry.get("name") or "").strip().lower()
            if name:
                merged[name] = entry
    return merged


def _read_custom_providers():
    """Parse the global Hermes config's `custom_providers` (JSON string list).

    Returns a dict name -> {"base_url":..., "api_key":...} for every declared
    OpenAI-compatible custom endpoint. Used so the dashboard's model picker can
    scan + list models for user-added providers (OmniRoute, LM Studio on LAN,
    any /v1 endpoint) exactly like the built-in cloud providers.
    """
    path = os.path.join(HERMES_HOME, "config.yaml")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            cfg = yaml.safe_load(fh) or {}
        raw = cfg.get("custom_providers")
        # Fallback: 'manager' coordinator was merged into the 'default' profile
        # during cleanup (profiles/manager/ no longer exists). Read custom_providers
        # from the real 'default' profile instead.
        if not raw:
            mgr = os.path.join(HERMES_HOME, "profiles", "default", "config.yaml")
            try:
                with open(mgr, "r", encoding="utf-8") as fh:
                    mcfg = yaml.safe_load(fh) or {}
                raw = mcfg.get("custom_providers")
            except Exception:
                pass
        if not raw:
            return {}
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except Exception:
                return {}
        if not isinstance(raw, list):
            return {}
        out = {}
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            name = (entry.get("name") or "").strip().lower()
            bu = (entry.get("base_url") or "").strip()
            if name and bu:
                # Support both literal api_key and key_env (reads from os.environ)
                api_key = entry.get("api_key", "") or ""
                key_env = entry.get("key_env", "") or ""
                if key_env and not api_key:
                    api_key = os.environ.get(key_env, "")
                out[name] = {"base_url": bu.rstrip("/"), "api_key": api_key}
        # GARDE-FOU (audit 2026-08-07) : si le fichier contient PLUSIEURS blocs
        # `custom_providers:` (cle YAML dupliquee), safe_load n'a garde que le
        # dernier -> on fusionne manuellement tous les blocs pour ne JAMAIS
        # perdre un provider (bug reel : nvidia-direct a disparu du picker/scan).
        for _extra_path in (path, os.path.join(HERMES_HOME, "profiles", "default", "config.yaml")):
            try:
                extra = _parse_all_custom_providers_blocks(_extra_path)
            except Exception:  # noqa: BLE001
                continue
            for name, entry in extra.items():
                if name in out:
                    continue  # le parse normal a deja cet entry
                bu = (entry.get("base_url") or "").strip()
                if name and bu:
                    api_key = entry.get("api_key", "") or ""
                    key_env = entry.get("key_env", "") or ""
                    if key_env and not api_key:
                        api_key = os.environ.get(key_env, "")
                    out[name] = {"base_url": bu.rstrip("/"), "api_key": api_key}
                    print("[config] recovery: provider '%s' restaure depuis un bloc "
                          "custom_providers duplique" % name)
        return out
    except Exception:  # noqa: BLE001
        return {}


def _mc_provider_model_ids(provider, *, force_live=False, base_url=None):
    """Return (models, freeform) for ONE provider.

    models   = list[str] of real model ids (may be empty)
    freeform = True when there is NO live list (caller should offer a
               free-text field so the user can still type an id).

    Delegates to Hermes' cached_provider_model_ids() for the known
    cloud/api-key providers. The OpenAI-compatible `custom` provider is
    handled here (see module docstring above).
    """
    hm = _import_hermes_models()
    prov = provider
    if hm is not None:
        try:
            prov = hm.normalize_provider(provider) or provider
        except Exception:
            prov = provider

    # Custom / explicit base_url -> probe live (no Hermes disk cache use).
    if prov == "custom" or base_url:
        bu = (base_url or _read_dotenv("LM_BASE_URL") or "").strip()
        if bu:
            key = _read_dotenv("LM_API_KEY", "")
            try:
                res = hm.probe_api_models(key, bu.rstrip("/") + "/v1", timeout=6)
                models = list(res.get("models") or [])
            except Exception as exc:  # noqa: BLE001
                print("[model_catalog] custom probe failed:", exc)
                models = []
            return models, False
        return [], True

    if hm is None:
        return [], True

    # LM Studio is a built-in provider whose model list is NOT covered by
    # provider_model_ids()/cached_provider_model_ids() (only the validation
    # path knows about it). Probe its native /api/v1/models directly using
    # LM_API_KEY/LM_BASE_URL from the environment (loaded from .env).
    if prov == "lmstudio":
        try:
            _load_hermes_dotenv()
            models = hm.fetch_lmstudio_models(
                api_key=os.environ.get("LM_API_KEY"),
                base_url=os.environ.get("LM_BASE_URL"),
            )
            models = list(models or [])
        except Exception as exc:  # noqa: BLE001
            print("[model_catalog] lmstudio probe failed:", exc)
            models = []
        if models:
            return models, False
        return [], True

    try:
        ids = hm.cached_provider_model_ids(
            prov, force_refresh=force_live, ttl_seconds=3600
        )
    except Exception as exc:  # noqa: BLE001
        print("[model_catalog] fetch failed for %s:" % prov, exc)
        ids = []
    if ids:
        return list(ids), False
    # Custom named providers (declared in Hermes config custom_providers) —
    # scan their /v1/models endpoint directly.
    custom = _read_custom_providers()
    if prov in custom:
        cp = custom[prov]
        bu = cp["base_url"]
        key = cp["api_key"]
        if bu:
            try:
                res = hm.probe_api_models(key, bu.rstrip("/") + "/v1", timeout=8)
                models = list(res.get("models") or [])
                if models:
                    return models, False
            except Exception as exc:  # noqa: BLE001
                print("[model_catalog] custom %s probe failed:" % prov, exc)
    # Providers declared in the top-level `providers:` section with an `api:`
    # endpoint (e.g. OMNI-ROUTE). Probe their /v1/models live so they are
    # scannable exactly like custom_providers. Read-only config access.
    try:
        import yaml
        _cfg_path = os.path.join(HERMES_HOME, "config.yaml")
        if os.path.exists(_cfg_path):
            with open(_cfg_path, "r") as _fh:
                _cfg = yaml.safe_load(_fh) or {}
            _providers = _cfg.get("providers") or {}
            _entry = _providers.get(prov) or _providers.get(prov.upper())
            if isinstance(_entry, dict):
                _api = (_entry.get("api") or "").strip()
                if _api:
                    _key_env = _entry.get("key_env") or ""
                    _key = (os.environ.get(_key_env) or "").strip() if _key_env else ""
                    try:
                        res = hm.probe_api_models(_key, _api.rstrip("/") + "/v1", timeout=10)
                        models = list(res.get("models") or [])
                        if models:
                            return models, False
                    except Exception as exc:  # noqa: BLE001
                        print("[model_catalog] providers:%s probe failed:" % prov, exc)
    except Exception:  # noqa: BLE001
        pass
    return [], True


def read_model_catalog(provider=None):
    """Provider/model picker catalog (REAL Hermes data, LIVE where possible).

    Merges the installed provider plugins with Hermes' live model
    discovery so the picker offers a clickable model list for EVERY
    provider that exposes one (OpenRouter, Nous — incl. the :free tier,
    Anthropic, Gemini, DeepSeek, Fireworks, ...). Providers with no
    discoverable list (e.g. no API key) fall back to `freeform: true` —
    the UI shows a text field so the user can still type the exact id.

    If `provider` is given, returns a SINGLE-provider object freshly
    fetched live. Used by the UI when a provider is selected, and to
    verify the endpoint via curl. The free-form text field is ALWAYS
    available in the UI regardless of the list.

    Performance: the full catalog is cached in-process for _CATALOG_TTL
    seconds; each provider list is ALSO cached on disk by Hermes (1h TTL)
    so opening the modal never storms the provider APIs.
    """
    if provider:
        prov = provider.strip().lower()
        models, freeform = _mc_provider_model_ids(prov, force_live=True)
        # Annotate each model with its blacklist status + scan results.
        bl = set(_load_blacklist().get(prov) or [])
        scan = _get_scan_results(prov)
        scan_map = {r["model"]: r for r in scan}
        annotated = []
        for m in models:
            entry = {"id": m, "description": "", "blacklisted": m in bl}
            sr = scan_map.get(m)
            if sr:
                if sr.get("tokens_per_sec") is not None:
                    entry["tokens_per_sec"] = sr["tokens_per_sec"]
                if sr.get("latency_ms") is not None:
                    entry["latency_ms"] = sr["latency_ms"]
                if sr.get("vision_supported") is not None:
                    entry["vision_supported"] = sr["vision_supported"]
                if sr.get("reasoning_supported") is not None:
                    entry["reasoning_supported"] = sr["reasoning_supported"]
                if sr.get("tools_supported") is not None:
                    entry["tools_supported"] = sr["tools_supported"]
                if sr.get("ok") is not None:
                    entry["ok"] = sr["ok"]
                if sr.get("reason"):
                    entry["reason"] = sr["reason"]
            annotated.append(entry)
        all_bl = bool(models) and all((m in bl) for m in models)
        return {
            "provider": prov,
            "freeform": freeform,
            "count": len(models),
            "models": annotated,
            "all_blacklisted": all_bl,
            "blacklisted_models": sorted(bl),
        }

    # Full catalog (cached in-process for _CATALOG_TTL seconds).
    now = time.time()
    if _CATALOG_CACHE["data"] is not None and (now - _CATALOG_CACHE["at"]) < _CATALOG_TTL:
        return _CATALOG_CACHE["data"]

    providers = {}
    # Load disabled providers from config to filter them out everywhere.
    _disabled_providers = set()
    try:
        cfg_path = os.path.join(HERMES_HOME, "config.yaml")
        with open(cfg_path, "r", encoding="utf-8") as fh:
            _cfg = yaml.safe_load(fh) or {}
        _provs_cfg = _cfg.get("providers") if isinstance(_cfg, dict) else None
        if isinstance(_provs_cfg, dict):
            for _pn, _pb in _provs_cfg.items():
                if isinstance(_pb, dict) and _pb.get("enabled") is False:
                    _disabled_providers.add(_pn)
    except Exception:
        pass
    # 1) Installed provider plugins (ground-truth set of usable providers).
    for key, display in _scan_provider_plugins().items():
        if key == "custom":
            continue   # SKIP provider generique OpenAI-compatible (doublon lmstudio/omni-route)
        models, freeform = _mc_provider_model_ids(key)
        providers[key] = {
            "display_name": display,
            "freeform": freeform,
            "count": len(models),
            "models": [{"id": m, "description": ""} for m in models],
        }
    # 2) Curated catalog providers (openrouter, nous, ...) — already in the
    #    plugin scan above in most cases, but keep their pretty display names
    #    and surface any provider NOT backed by a plugin (belt-and-suspenders).
    try:
        with open(MODEL_CATALOG_JSON, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        for name, meta in (data.get("providers") or {}).items():
            if name in _disabled_providers:
                continue   # Skip disabled providers
            pretty = (meta.get("metadata") or {}).get("display_name", name)
            if name in providers:
                # Keep the live-discovered list; adopt the curated name.
                providers[name]["display_name"] = pretty
                continue
            models, _ = _mc_provider_model_ids(name)
            providers[name] = {
                "display_name": pretty,
                "freeform": not models,
                "count": len(models),
                "models": [{"id": m, "description": ""} for m in models],
            }
    except Exception as exc:  # noqa: BLE001
        print("[model_catalog] curated read failed:", exc)

    # 3) Built-in Hermes providers (list_available_providers) — the SAME
    #    source the native `hermes model` picker uses. This is what makes
    #    providers WITHOUT a plugin dir (lmstudio, openai-api/FreeLLM, ...)
    #    appear in the dashboard, keeping it in sync with the real Hermes
    #    config instead of a hard-coded subset. Any provider Hermes adds
    #    later shows up here automatically.
    hm = _import_hermes_models()
    if hm is not None:
        try:
            with _muted_output():
                _builtin_entries = list(hm.list_available_providers())
        except Exception as exc:  # noqa: BLE001
            _builtin_entries = []
            print("[model_catalog] builtin providers read failed:", exc)
        try:
            for entry in _builtin_entries:
                key = (entry.get("id") or "").strip()
                if not key or key in providers:
                    continue
                if key == "custom":
                    continue   # SKIP le provider generique OpenAI-compatible: doublon avec lmstudio
                if key in _disabled_providers:
                    continue   # Skip providers disabled via providers.<name>.enabled: false
                display = entry.get("label") or key.replace("-", " ").title()
                try:
                    with _muted_output():
                        models, freeform = _mc_provider_model_ids(key)
                except Exception:  # noqa: BLE001 - a broken provider must not
                    # drop the whole catalog: list it with no models instead.
                    models, freeform = [], True
                providers[key] = {
                    "display_name": display,
                    "freeform": freeform,
                    "count": len(models),
                    "models": [{"id": m, "description": ""} for m in models],
                }
        except Exception as exc:  # noqa: BLE001
            print("[model_catalog] builtin providers read failed:", exc)

    # 4) Custom OpenAI-compatible providers from Hermes config (OmniRoute,
    #    LAN LM Studio, any /v1 endpoint). Scan their live model list so they
    #    appear in the picker exactly like built-in providers.
    for cname, cinfo in _read_custom_providers().items():
        if cname == "custom":
            continue   # ignorer une entree custom generique nommee 'custom'
        if cname in providers:
            continue
        models, freeform = _mc_provider_model_ids(cname)
        providers[cname] = {
            "display_name": cname.replace("-", " ").title(),
            "freeform": freeform,
            "count": len(models),
            "models": [{"id": m, "description": ""} for m in models],
        }

    # 5) Providers declared in Hermes config `providers:` with an explicit
    #    `api:` URL (e.g. OMNI-ROUTE). These have NO installed plugin dir, so
    #    list_available_providers() never returns them, yet they are fully
    #    usable in Hermes Agent (the user moved them out of custom_providers
    #    to fix reasoning/think payload issues). Surface them in MC by probing
    #    their live /v1/models, exactly like the custom_providers path. Name is
    #    normalized (OMNI-ROUTE -> omni-route) for consistent UI/picker keys.
    #    READ-ONLY: this does NOT modify config.yaml or .env.
    if hm is not None:
        try:
            _pp_cfg_path = os.path.join(HERMES_HOME, "config.yaml")
            with open(_pp_cfg_path, "r", encoding="utf-8") as _pp_fh:
                _pp_cfg = yaml.safe_load(_pp_fh) or {}
            _pp_providers = _pp_cfg.get("providers") if isinstance(_pp_cfg, dict) else None
            if isinstance(_pp_providers, dict):
                for _ppn, _ppb in _pp_providers.items():
                    if not isinstance(_ppb, dict):
                        continue
                    _pp_api = (_ppb.get("api") or "").strip()
                    if not _pp_api:
                        continue
                    _pp_base = _pp_api.rstrip("/")
                    if _pp_base.endswith("/v1"):
                        _pp_base = _pp_base[:-3]
                    _pp_key = _ppb.get("key_env") or _ppb.get("key") or _ppb.get("api_key") or ""
                    if isinstance(_pp_key, str) and _pp_key and "=" not in _pp_key and _pp_key.isupper():
                        _pp_key = os.environ.get(_pp_key, "")
                    _pp_key = _pp_key if isinstance(_pp_key, str) else ""
                    _pp_key_name = (_ppn or "").strip().lower().replace("_", "-")
                    if not _pp_key_name or _pp_key_name in providers:
                        continue
                    if _pp_key_name in _disabled_providers:
                        continue
                    if _pp_key_name == "custom":
                        continue
                    _load_hermes_dotenv()
                    try:
                        with _muted_output():
                            _pp_res = hm.probe_api_models(_pp_key, _pp_base + "/v1", timeout=8)
                        _pp_models = list(_pp_res.get("models") or [])
                    except Exception as _pp_exc:  # noqa: BLE001
                        print("[model_catalog] providers: probe failed for %s:" % _pp_key_name, _pp_exc)
                        _pp_models = []
                    providers[_pp_key_name] = {
                        "display_name": _ppn.replace("-", " ").title(),
                        "freeform": not _pp_models,
                        "count": len(_pp_models),
                        "models": [{"id": _m, "description": ""} for _m in _pp_models],
                    }
        except Exception as _pp_exc:  # noqa: BLE001
            print("[model_catalog] providers: section read failed:", _pp_exc)

    # Synchronize count with actual models list length (fix stale count from
    # catalog JSON where count=0 but models populated from curated/builtin sources).
    for _pk, _pv in providers.items():
        _pv["count"] = len(_pv.get("models") or [])

    # Enrich all providers' models with scan results (tokens_per_sec, caps, etc.)
    try:
        all_scan = _get_scan_results()
        for _pk, _pv in providers.items():
            scan_map = {r["model"]: r for r in all_scan if r.get("provider") == _pk}
            for _m in _pv.get("models") or []:
                sr = scan_map.get(_m.get("id"))
                if sr:
                    for _f in ("tokens_per_sec", "latency_ms", "ok", "reason",
                               "vision_supported", "reasoning_supported", "tools_supported"):
                        if sr.get(_f) is not None:
                            _m[_f] = sr[_f]
    except Exception:
        pass

    result = {"providers": _annotate_blacklist(providers)}
    _CATALOG_CACHE["data"] = result
    _CATALOG_CACHE["at"] = now
    return result


# ---- Chat session persistence (per agent, JSON on disk) ----
# <agent>.json = { "agent": str, "sessions": [ { id, agent, title,
#   created_at, updated_at, message_count,
#   messages:[ {role:'user'|'agent', text, ts, error?} ] } ] }


def _session_file(agent: str) -> str:
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    return os.path.join(SESSIONS_DIR, "%s.json" % agent)












# ---------------------------------------------------------------------------
# Read-only DB helper
# ---------------------------------------------------------------------------
def ro_connect(db_path):
    """Open a SQLite file in STRICT read-only mode (never writes)."""
    uri = "file:%s?mode=ro" % db_path
    con = sqlite3.connect(uri, uri=True)
    con.execute("PRAGMA query_only=1")
    con.row_factory = sqlite3.Row
    return con


def safe(fn, default=None):
    """Run a data reader; never let a read error crash the server."""
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - must be swallowed for resilience
        print("[safe] reader failed:", exc)
        return default


# ---------------------------------------------------------------------------
# health (gateway_state.json)
# ---------------------------------------------------------------------------
def read_health():
    try:
        with open(GATEWAY_STATE, "r", encoding="utf-8") as fh:
            g = json.load(fh)
    except Exception as exc:
        print("[health] read failed:", exc)
        return {"gateway_state": "unknown", "telegram": "unknown",
                "updated_at": None}

    plat = g.get("platforms", {}) or {}
    tg = plat.get("telegram", {}) or {}
    return {
        "gateway_state": g.get("gateway_state"),
        "telegram": tg.get("state"),
        "updated_at": g.get("updated_at"),
    }


# ---------------------------------------------------------------------------
# sessions (state.db)
# ---------------------------------------------------------------------------
def read_sessions():
    def _go():
        con = ro_connect(STATE_DB)
        try:
            # Totals across sessions aggregate columns
            s = con.execute(
                "SELECT COALESCE(SUM(input_tokens),0) AS i, "
                "COALESCE(SUM(output_tokens),0) AS o, "
                "COALESCE(SUM(message_count),0) AS m "
                "FROM sessions"
            ).fetchone()
            total_messages = con.execute(
                "SELECT COUNT(*) c FROM messages"
            ).fetchone()["c"]
            # Recent sessions (with title fallback)
            recent = []
            for r in con.execute(
                "SELECT id, title, started_at, message_count, "
                "input_tokens, output_tokens, model, profile_name "
                "FROM sessions ORDER BY started_at DESC LIMIT 8"
            ).fetchall():
                recent.append({
                    "id": r["id"],
                    "title": r["title"] or "(sans titre)",
                    "started_at": r["started_at"],
                    "message_count": r["message_count"],
                    "input_tokens": r["input_tokens"],
                    "output_tokens": r["output_tokens"],
                    "model": r["model"],
                    "profile": r["profile_name"],
                })
            return {
                "tokens_in": s["i"],
                "tokens_out": s["o"],
                "messages": total_messages,
                "sessions_total": con.execute(
                    "SELECT COUNT(*) c FROM sessions"
                ).fetchone()["c"],
                "recent": recent,
            }
        finally:
            con.close()

    return safe(_go, {
        "tokens_in": 0, "tokens_out": 0, "messages": 0,
        "sessions_total": 0, "recent": [],
    })


# ---------------------------------------------------------------------------
# vps — host metrics from /proc + statvfs (no subprocess)
# ---------------------------------------------------------------------------
_last_cpu = None  # (idle, total) snapshot for delta


def read_cpu_pct():
    global _last_cpu
    try:
        with open("/proc/stat", "r", encoding="utf-8") as fh:
            line = fh.readline()  # "cpu  user nice system idle ..."
        parts = list(map(int, line.split()[1:]))
        # idle = parts[3] ; total = sum(all)
        idle = parts[3]
        total = sum(parts)
        if _last_cpu is not None:
            idle_delta = idle - _last_cpu[0]
            total_delta = total - _last_cpu[1]
            if total_delta > 0:
                pct = 100.0 * (1.0 - idle_delta / total_delta)
            else:
                pct = 0.0
        else:
            pct = 0.0  # first sample, no delta yet
        _last_cpu = (idle, total)
        return round(max(0.0, min(100.0, pct)), 1)
    except Exception as exc:
        print("[cpu] read failed:", exc)
        return 0.0


MC_START_TIME = int(time.time())


def _systemd_active_enter(unit, user=True):
    """Return unix ts (int) of a systemd unit's ActiveEnterTimestamp, or 0."""
    try:
        cmd = ["systemctl"]
        if user:
            cmd.append("--user")
        cmd += ["show", unit, "-p", "ActiveEnterTimestampMonotonic",
                "--value"]
        out = subprocess.run(cmd, capture_output=True, text=True,
                             timeout=5).stdout.strip()
        mono = int(out or 0)
        if mono > 0:
            # convert monotonic usec -> unix ts
            now_mono = time.clock_gettime(time.CLOCK_MONOTONIC)
            return int(time.time() - (now_mono - mono / 1_000_000.0))
    except Exception as exc:
        print("[systemd_active_enter] %s failed: %s" % (unit, exc))
    return 0


def read_vps():
    def _go():
        import psutil
        cpu_pct = read_cpu_pct()
        # RAM from /proc/meminfo
        mem = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            for line in fh:
                m = re.match(r"(\w+):\s+(\d+)\s*kB", line)
                if m:
                    mem[m.group(1)] = int(m.group(2))
        total = mem.get("MemTotal", 0)
        avail = mem.get("MemAvailable", mem.get("MemFree", 0))
        mem_pct = round(100.0 * (total - avail) / total, 1) if total else 0.0
        mem_used_gb = round((total - avail) / 1024.0 / 1024.0, 1) if total else 0.0
        mem_total_gb = round(total / 1024.0 / 1024.0, 1) if total else 0.0
        # Disk from os.statvfs on /
        st = os.statvfs("/")
        total_b = st.f_blocks * st.f_frsize
        free_b = st.f_bfree * st.f_frsize
        disk_pct = round(100.0 * (total_b - free_b) / total_b, 1) if total_b else 0.0
        disk_used_gb = round((total_b - free_b) / 1024.0**3, 1)
        disk_total_gb = round(total_b / 1024.0**3, 1)
        boot_time = int(psutil.boot_time())
        gateway_start = _systemd_active_enter("hermes-gateway")
        mc_start = _systemd_active_enter("hermes-mission-control") or MC_START_TIME
        return {
            "gateway_start_time": gateway_start,
            "mc_start_time": mc_start,
            "cpu_pct": cpu_pct,
            "mem_pct": mem_pct,
            "mem_used_gb": mem_used_gb,
            "mem_total_gb": mem_total_gb,
            "disk_pct": disk_pct,
            "disk_used_gb": disk_used_gb,
            "disk_total_gb": disk_total_gb,
            "boot_time": boot_time,
        }
    return safe(_go, {"cpu_pct": 0.0, "mem_pct": 0.0, "disk_pct": 0.0,
                      "mem_used_gb": 0.0, "mem_total_gb": 0.0,
                      "disk_used_gb": 0.0, "disk_total_gb": 0.0,
                      "boot_time": 0, "gateway_start_time": 0, "mc_start_time": 0})


# ---------------------------------------------------------------------------
# fleet — per-agent derived stats from agent-logs.db
# ---------------------------------------------------------------------------
def _load_model_tiers():
    """Optional: map model id -> tier from model-routing.json (if present)."""
    try:
        if os.path.exists(MODEL_ROUTING_JSON):
            with open(MODEL_ROUTING_JSON, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            # Accept either a dict {model: {...}} or a list of {id/name, tier}
            tiers = {}
            if isinstance(data, dict):
                for k, v in data.items():
                    if isinstance(v, dict):
                        tiers[k] = v.get("tier", "")
            elif isinstance(data, list):
                for item in data:
                    if isinstance(item, dict):
                        key = item.get("id") or item.get("name") or item.get("model")
                        if key:
                            tiers[key] = item.get("tier", "")
            return tiers
    except Exception as exc:
        print("[model_tiers] read failed:", exc)
    return {}


def read_fleet():
    def _go():
        con = sqlite3.connect("file:%s?mode=ro" % AGENT_LOGS_DB, uri=True)
        con.execute("PRAGMA query_only=1")
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                "SELECT agent_name, task_description, model_used, status, created_at "
                "FROM agent_logs"
            ).fetchall()
        finally:
            con.close()

        # group by LOWER(agent_name)
        by_agent = {}
        total_lines = 0
        models_all = []
        for r in rows:
            a = (r["agent_name"] or "").lower()
            by_agent.setdefault(a, []).append(dict(r))
            total_lines += 1
            if r["model_used"]:
                models_all.append(r["model_used"])

        tiers = _load_model_tiers()

        # Pre-fetch token usage + frozen debit rate so the frontend (which reads
        # per-agent `tokenUsage`/`tokenRate`) gets the correct fields.
        _tok_usage = _read_real_token_usage()  # agent -> model -> {day,week,month} (REEL, toutes sessions state.db)
        _tok_rate = _read_real_last_rates()    # agent -> model -> tok/s (REEL, persisté par modèle)

        # Daily fleet metrics (TÂCHES AUJOURD'HUI / RÉUSSITE / msgCount).
        _sod = _start_of_today()
        _tasks_today = _fleet_tasks_today(_sod)      # agent -> int
        _success_cnt = _fleet_success_count(_sod)    # agent -> int (successful units)
        _msg_count = _fleet_msg_count()              # agent -> int (SUM message_count)

        fleet = []
        for key in fleet_keys_ordered():
            meta = FLEET_META.get(key)
            if meta is None:
                # Dynamically discovered profile (created via /api/fleet/agent/create
                # or an external `hermes` profile). Derive display fields from the
                # profile name so it renders consistently across all tabs.
                _disp = key.replace("-", " ").title()
                meta = {
                    "code": "A-11",          # generic code for ad-hoc agents
                    "initials": "".join(w[0] for w in key.split("-")[:2]).upper() or "AG",
                    "role": _disp,
                    "channel": key,
                    "name": _disp,
                    "feed_display": (key[:2].upper()),
                }
            logs = by_agent.get(key, [])
            n = len(logs)
            # most recent by created_at
            logs_sorted = sorted(logs, key=lambda x: x["created_at"] or "", reverse=True)
            default_model = logs_sorted[0]["model_used"] if logs_sorted else None
            # Prefer the agent's configured profile model (real, current) over
            # the last-logged model; fall back to the log-derived one.
            cfg = read_agent_model(key)
            if cfg and (cfg.get("model") or cfg.get("provider")):
                effective_model = cfg.get("model")
                effective_provider = cfg.get("provider")
            else:
                effective_model = default_model
                effective_provider = None
            task = logs_sorted[0]["task_description"] if logs_sorted else None
            share = round(n / total_lines * 100) if total_lines else 0
            load = min(100, n * 25)
            fleet.append({
                "code": meta["code"],
                "initials": meta["initials"],
                "role": meta["role"],
                "channel": meta["channel"],
                "name": meta["name"],
                "agent": key,                       # canonical lowercase key
                # Daily metrics (real sources, see helpers above):
                # tasksToday = done board tasks + crons run today for this agent.
                # success    = daily success rate (%) of those units.
                # msgCount   = SUM(message_count) of sessions for this agent.
                "tasksToday": _tasks_today.get(key, 0),
                "success": (round(100.0 * _success_cnt.get(key, 0) / _tasks_today[key])
                            if _tasks_today.get(key, 0) > 0 else 0),
                "msgCount": _msg_count.get(key, 0),
                "defaultModel": effective_model,    # configured profile model (req #2)
                "modelProvider": effective_provider,
                "share": share,
                "load": load,
                "tokens": "%d tasks" % n,
                "latency": "-",
                "state": "IDLE",
                "task": task,
                # Per-agent token usage + debit rate (consumed by AgentsTab).
                "tokenUsage": _tok_usage.get(key, {}),
                "tokenRate": _tok_rate.get(key, {}),
            })

        # models list
        distinct = []
        seen = set()
        for m in models_all:
            if m not in seen:
                seen.add(m)
                distinct.append({
                    "id": m, "label": m,
                    "vendor": "", "tier": tiers.get(m, ""),
                })
        # model_usage
        counts = {}
        for m in models_all:
            counts[m] = counts.get(m, 0) + 1
        model_usage = [
            {"name": k, "count": v,
             "pct": round(100.0 * v / total_lines, 1) if total_lines else 0.0}
            for k, v in sorted(counts.items(), key=lambda kv: -kv[1])
        ]

        return {
            "agents": fleet,
            "models": distinct,
            "model_usage": model_usage,
            "routing": {
                "total": total_lines,
                "models": len(distinct),
                "premium_calls": total_lines,   # no routing add-on -> all premium
                "fast_calls": 0,
                "offload_pct": 0,
            },
            "_total_lines": total_lines,        # internal, stripped before output
        }
    return safe(_go, {
        "agents": [{
            "code": FLEET_META.get(k, {}).get("code", "A-11"),
            "initials": FLEET_META.get(k, {}).get("initials", (k[:2].upper())),
            "role": FLEET_META.get(k, {}).get("role", k.replace("-", " ").title()),
            "channel": FLEET_META.get(k, {}).get("channel", k),
            "name": FLEET_META.get(k, {}).get("name", k.replace("-", " ").title()),
            "agent": k, "tasksToday": 0,
            "success": 0, "msgCount": 0, "defaultModel": None, "share": 0, "load": 0,
            "tokens": "0 tasks", "latency": "-", "state": "IDLE", "task": None,
        } for k in fleet_keys_ordered()],
        "models": [], "model_usage": [],
        "routing": {"total": 0, "models": 0, "premium_calls": 0,
                    "fast_calls": 0, "offload_pct": 0},
        "_total_lines": 0,
    })


# Cache module-level des noms de cron (jobs.json) : id -> name.
_CRON_NAMES_CACHE = {"mtime": 0.0, "names": {}}


def _cron_names():
    """Retourne {job_id: name} depuis ~/.hermes/cron/jobs.json (cache mtime)."""
    import json as _json
    p = os.path.join(HERMES_HOME, "cron", "jobs.json")
    try:
        mtime = os.path.getmtime(p)
        if mtime != _CRON_NAMES_CACHE["mtime"]:
            with open(p, "r", encoding="utf-8") as _fh:
                data = _json.load(_fh)
            names = {}
            jobs = data.get("jobs", []) if isinstance(data, dict) else data
            for j in jobs:
                _id = j.get("id")
                if _id:
                    names[_id] = j.get("name") or _id
            _CRON_NAMES_CACHE["mtime"] = mtime
            _CRON_NAMES_CACHE["names"] = names
    except Exception:
        pass
    return _CRON_NAMES_CACHE["names"]


def read_agentlogs():
    def _go():
        # Source de vérité : tâches/cron terminées AUJOURD'HUI.
        # (La table agent_logs historique est vide -> on lit executions.db
        #  + les sessions agent terminées du jour dans les state.db natifs.)
        import tempfile as _tf
        logs = []
        completed = 0
        failed = 0

        # Minuit aujourd'hui (epoch s)
        _mid = datetime.datetime.combine(
            datetime.date.today(), datetime.time.min
        ).timestamp()

        def _safe_remove_db(path):
            # Remove a temp sqlite copy AND its -shm/-wal companions so the
            # tmpfs never fills with orphaned tmpXXXXXX.db-shm files (the leak
            # that saturated /tmp and broke live chat streaming on 2026-08-20).
            if not path:
                return
            for suf in ("", "-shm", "-wal"):
                p = path + suf
                try:
                    if os.path.exists(p):
                        os.remove(p)
                except Exception:
                    pass

        # --- (A) Cron / tâches planifiées (executions.db) ---
        # Agrégé PAR job_id : un cron qui tourne toutes les 3 min ne doit pas
        # inonder la liste. Une seule ligne par job avec le nb d'exécutions
        # du jour + heure de la dernière. Le compte completed/failed reste le
        # vrai total du jour.
        try:
            _tmp = _tf.NamedTemporaryFile(suffix=".db", delete=False).name
            shutil.copyfile(mc_backend.CRON_EXEC_DB, _tmp)
            con = sqlite3.connect(_tmp, timeout=5.0)
            con.row_factory = sqlite3.Row
            rows = con.execute(
                "SELECT job_id, status, finished_at, error FROM executions "
                "WHERE status IN ('completed','failed','error') "
                "ORDER BY finished_at DESC"
            ).fetchall()
            con.close()
            _safe_remove_db(_tmp)
            # Aggregation par job_id
            agg = {}  # job_id -> {count, completed, failed, last_ts, last_err}
            for r in rows:
                fa = r["finished_at"]
                ts = 0.0
                if fa:
                    try:
                        ts = datetime.datetime.fromisoformat(
                            str(fa).replace("Z", "+00:00")
                        ).timestamp()
                    except Exception:
                        ts = 0.0
                if ts < _mid:
                    continue  # hors jour courant
                st = "completed" if r["status"] == "completed" else "failed"
                if st == "completed":
                    completed += 1
                else:
                    failed += 1
                jid = r["job_id"] or "inconnu"
                a = agg.setdefault(jid, {"count": 0, "completed": 0, "failed": 0,
                                         "last_ts": 0.0, "last_err": None})
                a["count"] += 1
                if st == "completed":
                    a["completed"] += 1
                else:
                    a["failed"] += 1
                if ts > a["last_ts"]:
                    a["last_ts"] = ts
                    a["last_err"] = r["error"] if st != "completed" else None
            for jid, a in agg.items():
                _names = _cron_names()
                _label = _names.get(jid, jid) or "inconnu"
                _err = ((" — " + (a["last_err"] or "")) if a["failed"] and a["last_err"] else "")
                _detail = "%d exécution(s) aujourd'hui" % a["count"]
                if a["failed"]:
                    _detail += " (%d en échec)" % a["failed"]
                logs.append({
                    "agent": "CRON",
                    "task": "Tâche planifiée %s : %s%s" % (
                        _label[:40], _detail, _err),
                    "time": a["last_ts"],
                    "model": None,
                    "status": "completed" if a["failed"] == 0 else "failed",
                })
        except Exception:
            pass

        # --- (B) Sessions agent terminées aujourd'hui (state.db natifs) ---
        try:
            _roots = [os.path.join(HERMES_HOME, "state.db")]
            _profs = glob.glob(os.path.join(HERMES_HOME, "profiles", "*", "state.db"))
            for _db in [p for p in (_roots + _profs) if os.path.exists(p)]:
                _tmp = None
                try:
                    _tmp = _tf.NamedTemporaryFile(suffix=".db", delete=False).name
                    shutil.copyfile(_db, _tmp)
                    con = sqlite3.connect(_tmp, timeout=5.0)
                    con.row_factory = sqlite3.Row
                    rows = con.execute(
                        "SELECT id, title, last_activity_at, last_activity_description, profile "
                        "FROM sessions ORDER BY last_activity_at DESC LIMIT 30"
                    ).fetchall()
                    con.close()
                except Exception:
                    continue
                finally:
                    if _tmp:
                        _safe_remove_db(_tmp)
                for s in rows:
                    la = s.get("last_activity_at") or 0
                    if la < _mid:
                        continue  # hors jour courant
                    desc = (s.get("last_activity_description") or "").lower()
                    if not any(k in desc for k in
                                ("stream", "generate", "final", "complete", "responding", "tool completed")):
                        continue  # pas une fin de génération
                    prof = (s.get("profile") or "").lower()
                    meta = FLEET_META.get(prof, {})
                    display = meta.get("feed_display", (prof or "?").upper())
                    completed += 1
                    logs.append({
                        "agent": display,
                        "task": s.get("title") or s.get("id") or "(sans titre)",
                        "time": la,
                        "model": None,
                        "status": "completed",
                    })
        except Exception:
            pass

        # Tri décroissant par heure, 30 derniers affichés.
        logs.sort(key=lambda x: (x.get("time") or 0), reverse=True)
        total_today = completed + failed
        logs = logs[:30]
        return {
            "logs": logs,
            "stats": {"total": total_today, "completed": completed, "failed": failed},
        }
    return safe(_go, {"logs": [], "stats": {"total": 0, "completed": 0, "failed": 0}})


# ---------------------------------------------------------------------------
# Operator board (OWNER task board, read-write, project-local board.db)
# ---------------------------------------------------------------------------
BOARD_COLUMNS = ["todo", "doing", "done"]  # three kanban columns


def _init_board():
    """Create board.db if missing (empty schema). No seeded tasks.

    The operator board starts empty by design — tasks are added by the owner
    through the UI. Historical seed cards were fictive data and have been
    removed. An existing board.db (with leftover seeds) is cleared by the
    bootstrap step so the board reflects reality (or stays empty).
    """
    os.makedirs(PROJECT_DIR, exist_ok=True)
    con = sqlite3.connect(BOARD_DB)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute(
        "CREATE TABLE IF NOT EXISTS tasks ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        "title TEXT NOT NULL, "
        "status TEXT NOT NULL DEFAULT 'todo', "
        "priority TEXT NOT NULL DEFAULT 'normal', "
        "notes TEXT DEFAULT '', "
        "agent TEXT DEFAULT '', "
        "created_at INTEGER NOT NULL, "
        "updated_at INTEGER NOT NULL)"
    )
    try:
        con.execute("ALTER TABLE tasks ADD COLUMN agent TEXT DEFAULT ''")
    except Exception:
        pass
    con.commit()
    con.close()


# ---------------------------------------------------------------------------
# Scan results persistence (DEMANDE 1): a REAL SQLite table that mirrors every
# scan probe result, so results survive server restarts / browser F5 instead of
# living only in the frontend localStorage store. The DB is the server-side
# source of truth; the frontend store remains the live display cache.
# ---------------------------------------------------------------------------
def _init_scan_results_db():
    """Create scan_results.db (scan_results table) if missing. Idempotent."""
    os.makedirs(PROJECT_DIR, exist_ok=True)
    con = sqlite3.connect(SCAN_RESULTS_DB)
    try:
        con.execute(
            "CREATE TABLE IF NOT EXISTS scan_results ("
            "  provider TEXT NOT NULL, "
            "  model TEXT NOT NULL, "
            "  ok INTEGER, "                # 0/1 or NULL
            "  reason TEXT, "
            "  latency_ms REAL, "
            "  tokens_per_sec REAL, "
            "  last_checked REAL, "         # epoch seconds (status scan)
            "  last_cap_check REAL, "       # epoch seconds (capability test) - optional
            "  vision_supported INTEGER, "  # 0/1/NULL (capability test) - optional
            "  reasoning_supported INTEGER, "  # 0/1/NULL - optional
            "  tools_supported INTEGER, "   # 0/1/NULL - optional
            "  PRIMARY KEY (provider, model))"
        )
        con.commit()
        # NON-DESTRUCTIVE migration: add capability-detail columns if a DB
        # created before this change is already present. The table already
        # exists in most deployments, so CREATE TABLE IF NOT EXISTS above is
        # a no-op; these ALTERs add the missing columns when needed.
        for _col in ("vision_supported", "reasoning_supported", "tools_supported"):
            try:
                con.execute("ALTER TABLE scan_results ADD COLUMN %s INTEGER" % _col)
            except Exception:
                # duplicate column name -> already migrated, fine
                pass
        # 2026-08-06 - VERDICT DE VIE A 3 ETATS (vert/orange/rouge).
        # `ok` (0/1) est CONSERVE tel quel pour ne rien casser en aval (PDF,
        # filtres, score, compteurs) : ok=1 pour vert ET orange (le modele
        # repond dans les deux cas), ok=0 pour rouge. La nuance vert/orange
        # vit dans la nouvelle colonne TEXT `life_state`, et le texte reellement
        # recu dans `life_answer` (affiche au survol cote UI).
        # Migration SURE : ALTER TABLE conditionnel, aucune ligne existante
        # n'est touchee (les anciennes lignes ont life_state NULL -> l'UI
        # retombe sur ok pour les afficher vert/rouge comme avant).
        for _col, _typ in (("life_state", "TEXT"), ("life_answer", "TEXT"),
                           ("cap_latency_ms", "REAL")):
            try:
                con.execute("ALTER TABLE scan_results ADD COLUMN %s %s" % (_col, _typ))
            except Exception:
                pass
        # 2026-08-11 - SOLUTION 3 (capfix) : colonnes de confiance reseau.
        #   *_conf         : compteur plancher 0, +1 succes / -1 echec (plafonne
        #                    a _CAP_MAX_CONF). Un True n'est STICKY qu'apres
        #                    conf>=_CAP_STICKY_CONF (2 succes consecutifs).
        #   cap_neterr     : 1 si la DERNIERE sonde est tombee en erreur reseau
        #                    (etat indetermine) -> l'UI affiche "a reverbaliser".
        #   last_cap_check : deja present (epoch seconds) ; on ajoute pas de
        #                    doublon (la migration est idempotente + try/except).
        for _col, _typ in (("vision_conf", "INTEGER DEFAULT 0"),
                           ("reasoning_conf", "INTEGER DEFAULT 0"),
                           ("tools_conf", "INTEGER DEFAULT 0"),
                           ("cap_neterr", "INTEGER DEFAULT 0")):
            try:
                con.execute("ALTER TABLE scan_results ADD COLUMN %s %s" % (_col, _typ))
            except Exception:
                # duplicate column name -> already migrated, fine
                pass
        # 2026-08-12 - ETAT 'TIME' : on persiste l'etat fin de sonde capacite
        # ('ok'|'ko'|'time'|NULL) par capacite, distinct du booleen
        # *_supported (retro-compat). Garde PRAGMA : on verifie l'existence
        # de la colonne avant ALTER pour ne jamais planter la migration.
        _existing_cols = set()
        try:
            _existing_cols = {row[1] for row in con.execute(
                "PRAGMA table_info(scan_results)").fetchall()}
        except Exception:  # noqa: BLE001
            _existing_cols = set()
        for _col in ("vision_state", "reasoning_state", "tools_state"):
            if _col in _existing_cols:
                continue
            try:
                con.execute("ALTER TABLE scan_results ADD COLUMN %s TEXT" % _col)
            except Exception:
                # duplicate column name -> already migrated, fine
                pass
        # 2026-08-24 - SPECS DU MODELE : context_length, parameter_count, specs_display, specs_error
        # Remplis par _fetch_model_specs() lors du scan ou de la sonde capacites.
        for _col, _typ in (("context_length", "INTEGER"),
                           ("parameter_count", "TEXT"),
                           ("specs_display", "TEXT"),
                           ("specs_error", "TEXT")):
            if _col in _existing_cols:
                continue
            try:
                con.execute("ALTER TABLE scan_results ADD COLUMN %s %s" % (_col, _typ))
            except Exception:
                pass
        con.commit()
    finally:
        con.close()


def _save_scan_result(provider, model, ok, reason=None,
                      latency_ms=None, tokens_per_sec=None,
                      last_checked=None, last_cap_check=None,
                      vision_supported=None, reasoning_supported=None,
                      tools_supported=None, life_state=None, life_answer=None,
                      context_length=None, parameter_count=None,
                      specs_display=None, specs_error=None):
    """UPSERT a single scan probe result into scan_results.

    Called at the end of every _probe_one so each model's status/latency/tok/s
    is persisted to disk the moment it is known (not just at scan end).
    Capability booleans (vision/reasoning/tools) are optional detail; when
    None (e.g. a plain status probe), the previously stored value (if any) is
    preserved via COALESCE so a capability test result is never clobbered by a
    later status scan and vice-versa.
    """
    if not provider or not model:
        return
    try:
        con = sqlite3.connect(SCAN_RESULTS_DB)
        try:
            con.execute(
                "INSERT OR REPLACE INTO scan_results "
                "(provider, model, ok, reason, latency_ms, tokens_per_sec, "
                " last_checked, last_cap_check, vision_supported, "
                " reasoning_supported, tools_supported, life_state, life_answer, "
                " context_length, parameter_count, specs_display, specs_error) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, "
                "  COALESCE(?, (SELECT last_cap_check FROM scan_results "
                "             WHERE provider=? AND model=?)), "
                "  COALESCE(?, (SELECT vision_supported FROM scan_results "
                "             WHERE provider=? AND model=?)), "
                "  COALESCE(?, (SELECT reasoning_supported FROM scan_results "
                "             WHERE provider=? AND model=?)), "
                "  COALESCE(?, (SELECT tools_supported FROM scan_results "
                "             WHERE provider=? AND model=?)), "
                "  COALESCE(?, (SELECT life_state FROM scan_results "
                "             WHERE provider=? AND model=?)), "
                "  COALESCE(?, (SELECT life_answer FROM scan_results "
                "             WHERE provider=? AND model=?)), "
                "  COALESCE(?, (SELECT context_length FROM scan_results "
                "             WHERE provider=? AND model=?)), "
                "  COALESCE(?, (SELECT parameter_count FROM scan_results "
                "             WHERE provider=? AND model=?)), "
                "  COALESCE(?, (SELECT specs_display FROM scan_results "
                "             WHERE provider=? AND model=?)), "
                "  COALESCE(?, (SELECT specs_error FROM scan_results "
                "             WHERE provider=? AND model=?)))",
                (provider, model,
                 None if ok is None else (1 if ok else 0),
                 reason, latency_ms, tokens_per_sec,
                 last_checked, last_cap_check,
                 provider, model,
                 vision_supported,
                 provider, model,
                 reasoning_supported,
                 provider, model,
                 tools_supported,
                 provider, model,
                 life_state,
                 provider, model,
                 life_answer,
                 provider, model,
                 context_length,
                 provider, model,
                 parameter_count,
                 provider, model,
                 specs_display,
                 provider, model,
                 specs_error,
                 provider, model),
            )
            con.commit()
        finally:
            con.close()
        # Invalidate catalog cache so /api/models reflects new scan data.
        _CATALOG_CACHE["data"] = None
    except Exception:  # noqa: BLE001
        # Persisting a result must NEVER break the scan itself.
        pass


def _save_capability_result(provider, model,
                            vision_supported=None, reasoning_supported=None,
                            tools_supported=None, cap_latency_ms=None,
                            vision_probed=None, reasoning_probed=None,
                            tools_probed=None,
                            vision_state=None, reasoning_state=None,
                            tools_state=None):
    """Persist ONLY the capability detail of a capabilities test (SOLUTION 3,
    2026-08-11 - capfix).

    Arguments:
      *_supported : valeur BOOLEENNE cible (True/False) a appliquer si la
                    sonde a abouti (pas d'erreur reseau).
      *_probed    : None si la sonde est tombee en erreur RESEAU (etat
                    INDETERMINE) -> on NE TOUCHE AUCUNE colonne de capacite,
                    on pose juste cap_neterr=1 et on conserve l'ancienne valeur
                    (c'est tout le point de la sol. 3 : ne pas ecraser un True
                    connu a cause d'un 429/5xx/DNS).

    Logique appliquee PAR capacite (stricte, sans catch-all d'ecrasement):
      - probe=None (reseau)   -> cap inchange, conf inchange, cap_neterr=1.
      - probe=True  (succes)  -> cap=1, conf=min(conf+1, MAX), neterr=0,
                                 last_cap_check=now. STICKY si conf>=2.
      - probe=False (refus)   -> cap=0, conf=0, neterr=0 (ecrase un ancien True
                                 -> voulu : le modele a prouve ne pas savoir).
    """
    if not provider or not model:
        return
    _caps = (
        ("vision_supported", "vision_conf", vision_supported, vision_probed),
        ("reasoning_supported", "reasoning_conf", reasoning_supported, reasoning_probed),
        ("tools_supported", "tools_conf", tools_supported, tools_probed),
    )
    with _SCAN_DB_LOCK:
        try:
            con = sqlite3.connect(SCAN_RESULTS_DB, timeout=30)
            try:
                con.execute("PRAGMA journal_mode=WAL")
                con.execute("PRAGMA busy_timeout=30000")
                # Lit l'etat actuel (pour conf + ancienne valeur).
                _row = con.execute(
                    "SELECT vision_supported, reasoning_supported, tools_supported, "
                    "vision_conf, reasoning_conf, tools_conf, cap_neterr "
                    "FROM scan_results WHERE provider=? AND model=?",
                    (provider, model)).fetchone()
                if _row is None:
                    # Cree la ligne avec les seules colonnes capacites connues ;
                    # laisse les mesures de perf a NULL (score '—' jusqu'au scan).
                    # Une capacite NON testee (CAP_NOT_TESTED) garde cap=NULL.
                    # Une capacite en erreur reseau (None) -> cap inchange (NULL
                    # a la creation) + cap_neterr=1.
                    _v = None if vision_probed in (None, CAP_NOT_TESTED) else (1 if vision_supported else 0)
                    _r = None if reasoning_probed in (None, CAP_NOT_TESTED) else (1 if reasoning_supported else 0)
                    _t = None if tools_probed in (None, CAP_NOT_TESTED) else (1 if tools_supported else 0)
                    _vconf = 1 if (vision_probed is True) else 0
                    _rconf = 1 if (reasoning_probed is True) else 0
                    _tconf = 1 if (tools_probed is True) else 0
                    # 2026-08-12 - ETAT 'TIME' : si l'etat fin est connu
                    # ('ok'/'ko'/'time'), on derive le booleen retro-compat
                    # vision_supported (1 si 'ok', sinon 0). Sinon (None =
                    # reseau/indetermine) on garde la logique probed ci-dessus.
                    if vision_state is not None:
                        _v = 1 if vision_state == 'ok' else 0
                    if reasoning_state is not None:
                        _r = 1 if reasoning_state == 'ok' else 0
                    if tools_state is not None:
                        _t = 1 if tools_state == 'ok' else 0
                    _neterr = 1 if (None in (vision_probed, reasoning_probed, tools_probed)) else 0
                    con.execute(
                        "INSERT INTO scan_results "
                        "(provider, model, vision_supported, reasoning_supported, "
                        " tools_supported, vision_conf, reasoning_conf, tools_conf, "
                        " cap_neterr, cap_latency_ms, last_cap_check, "
                        " vision_state, reasoning_state, tools_state) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (provider, model, _v, _r, _t, _vconf, _rconf, _tconf,
                         _neterr, cap_latency_ms, time.time(),
                         vision_state, reasoning_state, tools_state),
                    )
                else:
                    (_v_old, _r_old, _t_old, _vconf_old, _rconf_old, _tconf_old, _neterr_old) = _row
                    _sets = []
                    _params = []
                    _neterr = 0
                    for _cap_col, _conf_col, _val, _probed in _caps:
                        if _probed is CAP_NOT_TESTED:
                            # Capacite non testee ce tour -> on la laisse telle
                            # quelle (ni lue, ni ecrite).
                            continue
                        if _probed is None:
                            # Erreur reseau -> on ne touche pas cap/conf, on
                            # marque l'etat indetermine.
                            _neterr = 1
                            continue
                        # recupere conf depuis la bonne variable :
                        if _cap_col == "vision_supported":
                            _cur_conf = _vconf_old or 0
                        elif _cap_col == "reasoning_supported":
                            _cur_conf = _rconf_old or 0
                        else:
                            _cur_conf = _tconf_old or 0
                        if _probed is True:
                            _new_cap = 1
                            _new_conf = min((_cur_conf or 0) + 1, _CAP_MAX_CONF)
                        else:
                            _new_cap = 0
                            _new_conf = 0
                        _sets.append("%s = ?" % _cap_col)
                        _params.append(_new_cap)
                        _sets.append("%s = ?" % _conf_col)
                        _params.append(_new_conf)
                    # 2026-08-12 - ETAT 'TIME' : on ecrit la colonne *_state
                    # (ok/ko/time) seulement pour les capacites DETERMINEES
                    # (probed n'est ni None ni CAP_NOT_TESTED). Pour une
                    # indetermine (reseau) on laisse l'ancienne valeur intacte.
                    if vision_probed is not None and vision_probed is not CAP_NOT_TESTED:
                        _sets.append("vision_state = ?")
                        _params.append(vision_state)
                    if reasoning_probed is not None and reasoning_probed is not CAP_NOT_TESTED:
                        _sets.append("reasoning_state = ?")
                        _params.append(reasoning_state)
                    if tools_probed is not None and tools_probed is not CAP_NOT_TESTED:
                        _sets.append("tools_state = ?")
                        _params.append(tools_state)
                    _sets.append("cap_neterr = ?")
                    _params.append(_neterr)
                    _sets.append("cap_latency_ms = COALESCE(?, cap_latency_ms)")
                    _params.append(cap_latency_ms)
                    # last_cap_check mis a jour SEULEMENT si au moins une sonde
                    # a abouti (pas de reseau) -> sinon on conserve l'ancien
                    # (ne pas "fraichement verifie" un modele qu'on n'a pas pu tester).
                    if _neterr == 0:
                        _sets.append("last_cap_check = ?")
                        _params.append(time.time())
                    _params.append(provider)
                    _params.append(model)
                    con.execute(
                        "UPDATE scan_results SET %s WHERE provider=? AND model=?" %
                        ", ".join(_sets), _params)
                con.commit()
            finally:
                con.close()
        except Exception:  # noqa: BLE001
            # Persisting a result must NEVER break the scan/sonde itself.
            pass
    # Invalidate catalog cache so /api/models reflects new capability data.
    _CATALOG_CACHE["data"] = None


def _get_scan_results(provider=None):
    """Read scan_results (all providers if provider is None, else filtered).

    Returns a list of dicts shaped like ScanModelResult (plus provider), with
    None fields dropped to keep the JSON shape identical to the live results.
    """
    try:
        con = sqlite3.connect(SCAN_RESULTS_DB)
        con.row_factory = sqlite3.Row
        try:
            if provider:
                rows = con.execute(
                    "SELECT provider, model, ok, reason, latency_ms, "
                    "tokens_per_sec, last_checked, last_cap_check, "
                    "vision_supported, reasoning_supported, tools_supported, "
                    "vision_conf, reasoning_conf, tools_conf, cap_neterr, "
                    "life_state, life_answer, context_length, parameter_count, "
                    "specs_display, specs_error "
                    "FROM scan_results WHERE provider=? ORDER BY model",
                    (provider,)).fetchall()
            else:
                rows = con.execute(
                    "SELECT provider, model, ok, reason, latency_ms, "
                    "tokens_per_sec, last_checked, last_cap_check, "
                    "vision_supported, reasoning_supported, tools_supported, "
                    "vision_conf, reasoning_conf, tools_conf, cap_neterr, "
                    "life_state, life_answer, context_length, parameter_count, "
                    "specs_display, specs_error "
                    "FROM scan_results ORDER BY provider, model").fetchall()
        finally:
            con.close()
    except Exception:  # noqa: BLE001
        return []
    _now = time.time()
    out = []
    for r in rows:
        item = {"provider": r["provider"], "model": r["model"]}
        item["ok"] = None if r["ok"] is None else bool(r["ok"])
        if r["reason"] is not None:
            item["reason"] = r["reason"]
        if r["latency_ms"] is not None:
            item["latency_ms"] = r["latency_ms"]
        if r["tokens_per_sec"] is not None:
            item["tokens_per_sec"] = r["tokens_per_sec"]
        if r["last_checked"] is not None:
            item["last_checked"] = r["last_checked"]
        if r["last_cap_check"] is not None:
            item["last_cap_check"] = r["last_cap_check"]
        # 2026-08-11 - SOLUTION 3 (capfix) : TTL de re-validation. Si le
        # dernier test de capacite date de > 24h, on marque la capacite
        # comme STALE (a re-tester) mais on GARDE la derniere valeur connue
        # pour l'affichage historique. On n'ecrase PAS en None (ca faisait
        # perdre l'historique OK et afficher "tout KO" dans l'UI). L'UI decide
        # d'afficher "a verifier" via cap_stale et propose un re-test.
        _stale = (r["last_cap_check"] is not None
                  and (_now - r["last_cap_check"]) > _CAP_TTL_SECONDS)
        _cap_neterr = bool(r["cap_neterr"])
        for _col, _key in (("vision_supported", "vision_supported"),
                           ("reasoning_supported", "reasoning_supported"),
                           ("tools_supported", "tools_supported")):
            _val = r[_col]
            # Valeur connue (meme stale) conservee pour l'affichage ; le flag
            # cap_stale permet a l'UI de proposer une re-validation.
            if _val is not None:
                item[_key] = bool(_val)
        if _stale:
            item["cap_stale"] = True
        # Indicateurs reseau/confiance (exploites par l'UI pour afficher
        # "a revérifier (réseau)" et le degre de certitude).
        if _cap_neterr:
            item["cap_neterr"] = True
        _conf = {
            "vision": r["vision_conf"] or 0,
            "reasoning": r["reasoning_conf"] or 0,
            "tools": r["tools_conf"] or 0,
        }
        if any(_conf.values()):
            item["cap_conf"] = _conf
        # Verdict de vie a 3 etats. Retro-compatibilite : une ligne anterieure
        # a la migration a life_state NULL -> on derive vert/rouge depuis ok
        # pour que l'UI reste coherente sans re-scanner.
        _ls = r["life_state"]
        if not _ls:
            _ls = None if item["ok"] is None else ("vert" if item["ok"] else "rouge")
        if _ls:
            item["life_state"] = _ls
        if r["life_answer"]:
            item["life_answer"] = r["life_answer"]
        # 2026-08-24 - SPECS DU MODELE (contexte, params).
        if r["context_length"] is not None:
            item["context_length"] = r["context_length"]
        if r["parameter_count"] is not None:
            item["parameter_count"] = r["parameter_count"]
        if r["specs_display"] is not None:
            item["specs_display"] = r["specs_display"]
        if r["specs_error"] is not None:
            item["specs_error"] = r["specs_error"]
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# Scan results -> PDF export (button "Exporter PDF" in the Scan tab).
# Rendered server-side via the utility venv ~/.venv_pdf (fpdf2 + DejaVuSans).
# ---------------------------------------------------------------------------
PDF_SCRIPT = os.path.join(PROJECT_DIR, "pdf_export.py")   # script fpdf2 (venv)
PDF_VENV_PY = os.path.expanduser("~/.venv_pdf/bin/python")


def _render_scan_pdf(provider=None, results=None, only_ok=False):
    """Generate the binary PDF of scan results via the ~/.venv_pdf util venv.

    Returns (bytes_pdf, None) on success or (None, err_msg) on failure.
    results = output of _get_scan_results(provider); if None, we re-read.
    If only_ok is True, rows whose ok is not True are dropped before export
    (so the PDF contains ONLY the models that actually responded).
    """
    if results is None:
        results = _get_scan_results(provider)
    if only_ok:
        results = [r for r in results if r.get("ok") is True]
    if not os.path.exists(PDF_SCRIPT):
        return None, "script pdf_export.py introuvable: {}".format(PDF_SCRIPT)
    if not os.path.exists(PDF_VENV_PY):
        return None, "venv absent: {}".format(PDF_VENV_PY)
    payload = json.dumps({"provider": provider, "rows": results}).encode("utf-8")
    proc = None
    try:
        proc = subprocess.run(
            [PDF_VENV_PY, PDF_SCRIPT],
            input=payload,
            capture_output=True,
            timeout=60,
        )
    except Exception as e:  # noqa: BLE001
        return None, str(e)
    if proc.returncode != 0:
        return None, proc.stderr.decode("utf-8", "replace")[:500]
    data = proc.stdout
    if not data.startswith(b"%PDF"):
        return None, "sortie inattendue (pas un PDF): {} ...".format(data[:60])
    return data, None


def _delete_scan_results(provider=None, model=None) -> int:
    """Delete persisted scan results (POINT 3b, 2026-08-01 DEVELOPPEUR).

    The SCAN tab now ALWAYS restores its table from scan_results.db at mount,
    so "EFFACER LES RESULTATS" (and the per-row trash button) must clear the
    server-side rows too — otherwise the deleted rows would reappear on the
    next mount. Scope:
      - provider=None, model=None -> wipe the whole table
      - provider only             -> wipe that provider
      - provider + model          -> wipe that single row
    Returns the number of deleted rows (0 on error).
    """
    try:
        con = sqlite3.connect(SCAN_RESULTS_DB)
        try:
            if provider and model:
                cur = con.execute(
                    "DELETE FROM scan_results WHERE provider=? AND model=?",
                    (provider, model))
            elif provider:
                cur = con.execute(
                    "DELETE FROM scan_results WHERE provider=?", (provider,))
            else:
                cur = con.execute("DELETE FROM scan_results")
            con.commit()
            return cur.rowcount or 0
        finally:
            con.close()
    except Exception:  # noqa: BLE001
        return 0


# ---------------------------------------------------------------------------
# Token usage tracking (REAL: read from the Hermes state.db session stores)
# ---------------------------------------------------------------------------
# Source of truth = every profile's own state.db (sessions + messages tables).
# Each session carries input_tokens/output_tokens (ALWAYS filled), model and
# started_at (epoch seconds). We scan ALL profiles and ALL sources (cli, tui,
# telegram, discord, ...) — no source filter — so dashboard chats, CLI
# delegations, Telegram and Discord all count. Period buckets (day / ISO week
# / month) are derived from started_at. Result is cached _TOK_REAL_TTL seconds
# so the 3s /api/state poll does not hammer the state.db files.
_TOK_REAL_CACHE = {"ts": 0.0, "payload": None}
_TOK_REAL_LOCK = threading.Lock()
_TOK_REAL_TTL = 10.0


def _iso(ts: float = None) -> str:
    """ISO8601 timestamp for a given epoch (or now)."""
    t = time.time() if ts is None else ts
    return datetime.datetime.fromtimestamp(t).strftime("%Y-%m-%dT%H:%M:%S")


def _periods(now: float = None):
    """Return (day, week, month) period keys for the given epoch (or today)."""
    d = (datetime.date.today() if now is None
         else datetime.datetime.fromtimestamp(now).date())
    iso = d.isocalendar()  # (year, week, weekday)
    week = "%04d-W%02d" % (iso[0], iso[1])
    return d.strftime("%Y-%m-%d"), week, d.strftime("%Y-%m")


def _profile_state_db_path(agent: str) -> str:
    """Resolve a fleet key to its REAL Hermes state.db file.

    Mirrors _profile_config_path(): 'manager' (alias 'default') reads the ROOT
    ~/.hermes/state.db (NOT profiles/default/state.db, which does not hold the
    sessions); every other profile reads ~/.hermes/profiles/<profil>/state.db.
    """
    real = _PROFILE_ALIASES.get(agent, agent)
    if real == "default":
        return STATE_DB
    return os.path.join(PROFILES_DIR, real, "state.db")


def _session_duration_seconds(db_path: str, session_id: str):
    """Duration (s) of a session = MAX(messages.timestamp) - MIN(...).

    ended_at is often NULL so it cannot be used for the duration; the message
    timestamps are the reliable measure. Returns None when not computable.
    """
    try:
        con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
        con.execute("PRAGMA query_only=1")
        try:
            row = con.execute(
                "SELECT MIN(timestamp) AS mn, MAX(timestamp) AS mx "
                "FROM messages WHERE session_id=? AND timestamp IS NOT NULL",
                (session_id,)).fetchone()
        finally:
            con.close()
        if not row or row[0] is None or row[1] is None:
            return None
        return float(row[1]) - float(row[0])
    except sqlite3.Error:
        return None


def _read_model_rate_persisted():
    """(agent, model) -> tokens_per_sec from the model_rate persistence table."""
    out = {}
    try:
        con = sqlite3.connect("file:%s?mode=ro" % AGENT_LOGS_DB, uri=True)
        con.execute("PRAGMA query_only=1")
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                "SELECT agent, model, tokens_per_sec FROM model_rate"
            ).fetchall()
        finally:
            con.close()
        for r in rows:
            out[(r["agent"], r["model"])] = r["tokens_per_sec"]
    except sqlite3.Error:
        pass
    return out


def _upsert_model_rate(agent, model, tps):
    """Persist the latest computed real tokens/sec for (agent, model)."""
    try:
        con = sqlite3.connect(AGENT_LOGS_DB)
        con.execute(
            "INSERT OR REPLACE INTO model_rate "
            "(agent, model, tokens_per_sec, updated_at) VALUES (?,?,?,?)",
            (agent, model, tps, _iso())
        )
        con.commit()
        con.close()
    except sqlite3.Error as exc:
        print("[model_rate] upsert failed:", exc)


def _scan_real_token_data():
    """One scan of every profile state.db.

    Returns (usage, latest) where:
      usage : agent -> model -> {day, week, month} REAL token sums (periods
              from started_at; all sources count; cached by caller).
      latest: (agent, model) -> (started_at, db_path, session_id, i, o) for
              the MOST RECENT session (max started_at) with input_tokens>0.
    """
    usage = {}
    latest = {}
    now_d = datetime.date.today()
    iso = now_d.isocalendar()
    now_day_key = now_d.strftime("%Y-%m-%d")
    now_week_key = "%04d-W%02d" % (iso[0], iso[1])
    now_month_key = now_d.strftime("%Y-%m")
    for agent in fleet_keys_ordered():
        db_path = _profile_state_db_path(agent)
        if not os.path.exists(db_path):
            continue
        try:
            con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
            con.execute("PRAGMA query_only=1")
            con.row_factory = sqlite3.Row
            try:
                rows = con.execute(
                    "SELECT id, model, started_at, "
                    "COALESCE(input_tokens,0) AS i, "
                    "COALESCE(output_tokens,0) AS o "
                    "FROM sessions"
                ).fetchall()
            finally:
                con.close()
        except sqlite3.Error:
            continue
        for r in rows:
            sa = r["started_at"]
            if not sa:
                continue
            try:
                sd = datetime.datetime.fromtimestamp(sa).date()
            except (ValueError, OSError, OverflowError, TypeError):
                continue
            i = int(r["i"] or 0)
            o = int(r["o"] or 0)
            tok = i + o
            model = r["model"] or "unknown"
            day_key = sd.strftime("%Y-%m-%d")
            wk = sd.isocalendar()
            week_key = "%04d-W%02d" % (wk[0], wk[1])
            month_key = sd.strftime("%Y-%m")
            if day_key == now_day_key or week_key == now_week_key \
                    or month_key == now_month_key:
                if tok > 0:
                    bucket = usage.setdefault(agent, {}).setdefault(
                        model, {"day": 0, "week": 0, "month": 0})
                    if day_key == now_day_key:
                        bucket["day"] += tok
                    if week_key == now_week_key:
                        bucket["week"] += tok
                    if month_key == now_month_key:
                        bucket["month"] += tok
            if i > 0:
                key = (agent, model)
                cur = latest.get(key)
                if cur is None or sa > cur[0]:
                    latest[key] = (sa, db_path, r["id"], i, o)
    return usage, latest


def _refresh_real_cache():
    """Compute (usage, rates) once, cached _TOK_REAL_TTL seconds."""
    now = time.time()
    with _TOK_REAL_LOCK:
        if _TOK_REAL_CACHE["payload"] is not None \
                and (now - _TOK_REAL_CACHE["ts"]) < _TOK_REAL_TTL:
            return _TOK_REAL_CACHE["payload"]
    usage, latest = _scan_real_token_data()
    rates = _compute_real_rates(latest)
    payload = {"usage": usage, "rates": rates}
    with _TOK_REAL_LOCK:
        _TOK_REAL_CACHE["ts"] = now
        _TOK_REAL_CACHE["payload"] = payload
    return payload


def _compute_real_rates(latest):
    """agent -> model -> REAL tokens/s for the most recent session per model,
    persisted into model_rate (so the last known rate survives a restart and
    a model switch). Falls back to the PERSISTED value when the most recent
    session is not computable (input=0 or no message timestamps) — that is how
    the dashboard recovers a previous model's rate instead of showing '—'.
    """
    out = {}
    for (agent, model), (sa, db_path, sid, i, o) in latest.items():
        dur = _session_duration_seconds(db_path, sid)
        if dur and dur > 0:
            tps = round((i + o) / dur, 1)
            out.setdefault(agent, {})[model] = tps
            _upsert_model_rate(agent, model, tps)
    for (agent, model), tps in _read_model_rate_persisted().items():
        if agent not in out or model not in out[agent]:
            out.setdefault(agent, {})[model] = tps
    return out


def _read_real_token_usage():
    """agent -> model -> {day,week,month} REAL token totals (all sources).

    Sums (input_tokens + output_tokens) of every session in every profile
    state.db, bucketed by started_at. Cached _TOK_REAL_TTL seconds.
    """
    try:
        return _refresh_real_cache()["usage"]
    except Exception as exc:
        print("[real_token_usage] failed:", exc)
        return {}


def _read_real_last_rates():
    """agent -> model -> REAL tokens/s (persisted per model)."""
    try:
        return _refresh_real_cache()["rates"]
    except Exception as exc:
        print("[real_last_rates] failed:", exc)
        return {}


def _init_model_rate():
    """Create / migrate the model_rate table in agent-logs.db (idempotent).

    Persists the last computed REAL tokens/sec per (agent, model) so the
    dashboard can recover a model's previous rate when switching back to it
    (instead of showing '—' after a restart).
    """
    try:
        con = sqlite3.connect(AGENT_LOGS_DB)
        con.execute("PRAGMA journal_mode=WAL")
        con.execute(
            "CREATE TABLE IF NOT EXISTS model_rate ("
            "agent TEXT NOT NULL, "
            "model TEXT NOT NULL, "
            "tokens_per_sec REAL NOT NULL DEFAULT 0, "
            "updated_at TEXT NOT NULL, "
            "PRIMARY KEY (agent, model))"
        )
        con.commit()
        con.close()
    except sqlite3.Error as exc:
        print("[model_rate] init failed:", exc)


def _acc_tokens(agent, eff_model, eff_provider, text, reply, t0):
    """NO-OP (2026-08-01): estimated token accounting is replaced by the REAL
    state.db aggregation (_read_real_token_usage / _read_real_last_rates).
    Kept as a no-op so the chat_send_agent call site stays intact.
    """
    return


def _init_token_usage():
    """Create / migrate the token_usage table in agent-logs.db (idempotent).

    NOTE (2026-08-01): the token_usage table is KEPT for historical/legacy
    rows and for scripts/delete_agent.sh compatibility, but the dashboard no
    longer reads it — real counters now come from the Hermes state.db session
    stores via _read_real_token_usage()/_read_real_last_rates().
    """
    try:
        con = sqlite3.connect(AGENT_LOGS_DB)
        con.execute("PRAGMA journal_mode=WAL")
        con.row_factory = sqlite3.Row
        con.execute(
            "CREATE TABLE IF NOT EXISTS token_usage ("
            "agent TEXT NOT NULL, "
            "model TEXT NOT NULL, "
            "day_tokens INTEGER NOT NULL DEFAULT 0, "
            "week_tokens INTEGER NOT NULL DEFAULT 0, "
            "month_tokens INTEGER NOT NULL DEFAULT 0, "
            "total_tokens INTEGER NOT NULL DEFAULT 0, "
            "day_key TEXT NOT NULL, "
            "week_key TEXT NOT NULL, "
            "month_key TEXT NOT NULL, "
            "updated_at TEXT NOT NULL, "
            "PRIMARY KEY (agent, model))"
        )
        # --- Migrate the legacy composite-PK schema (one row per period) ---
        # to the new single-row-per-(agent,model) schema, preserving totals.
        cur = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage_old'"
        ).fetchone()
        legacy = con.execute(
            "PRAGMA table_info(token_usage)"
        ).fetchall()
        has_period_pk = any((r["name"] == "day") for r in legacy)
        if has_period_pk and cur is None:
            # Sum legacy period rows into the new row per (agent, model).
            rows = con.execute(
                "SELECT agent, model, day, week, month, total_tokens FROM token_usage"
            ).fetchall()
            day, week, month = _periods()
            # Each legacy row is ONE day (PK includes day). Distribute correctly:
            # day_tokens = today's row, week_tokens = sum of this-week rows,
            # month_tokens = sum of this-month rows, total = sum of ALL rows.
            agg = {}  # (agent, model) -> {dt, wt, mt, total}
            for r in rows:
                k = (r["agent"], r["model"])
                a = agg.setdefault(k, {"dt": 0, "wt": 0, "mt": 0, "total": 0})
                a["total"] += r["total_tokens"]
                if r["day"] == day:
                    a["dt"] += r["total_tokens"]
                if r["week"] == week:
                    a["wt"] += r["total_tokens"]
                if r["month"] == month:
                    a["mt"] += r["total_tokens"]
            con.execute(
                "ALTER TABLE token_usage RENAME TO token_usage_old"
            )
            con.execute(
                "CREATE TABLE token_usage ("
                "agent TEXT NOT NULL, "
                "model TEXT NOT NULL, "
                "day_tokens INTEGER NOT NULL DEFAULT 0, "
                "week_tokens INTEGER NOT NULL DEFAULT 0, "
                "month_tokens INTEGER NOT NULL DEFAULT 0, "
                "total_tokens INTEGER NOT NULL DEFAULT 0, "
                "day_key TEXT NOT NULL, "
                "week_key TEXT NOT NULL, "
                "month_key TEXT NOT NULL, "
                "updated_at TEXT NOT NULL, "
                "PRIMARY KEY (agent, model))"
            )
            now_iso = _iso(time.time())
            for (a, m), v in agg.items():
                con.execute(
                    "INSERT INTO token_usage "
                    "(agent, model, day_tokens, week_tokens, month_tokens, "
                    " total_tokens, day_key, week_key, month_key, updated_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (a, m, v["dt"], v["wt"], v["mt"], v["total"],
                     day, week, month, now_iso),
                )
            con.execute("DROP TABLE token_usage_old")
        con.commit()
        con.close()
    except Exception as exc:
        print("[token_usage] init failed:", exc)


def read_board():
    def _go():
        con = sqlite3.connect(BOARD_DB)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                "SELECT id, title, status, priority, notes, agent, created_at, updated_at "
                "FROM tasks ORDER BY id ASC"
            ).fetchall()
        finally:
            con.close()
        items = [dict(r) for r in rows]
        board = {col: [] for col in BOARD_COLUMNS}
        for it in items:
            st = it["status"] if it["status"] in board else "todo"
            board[st].append(it)
        return board
    return safe(_go, {col: [] for col in BOARD_COLUMNS})


def board_create(title, status="todo", priority="normal", notes="", agent=""):
    status = status if status in BOARD_COLUMNS else "todo"
    now = int(time.time())
    con = sqlite3.connect(BOARD_DB)
    try:
        cur = con.execute(
            "INSERT INTO tasks (title, status, priority, notes, agent, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (title, status, priority, notes, agent or "", now, now),
        )
        con.commit()
        new_id = cur.lastrowid
    finally:
        con.close()
    return {"id": new_id, "ok": True}


def board_update(tid, **fields):
    allowed = {"title", "status", "priority", "notes", "agent"}
    sets = []
    vals = []
    for k, v in fields.items():
        if k in allowed:
            if k == "status" and v not in BOARD_COLUMNS:
                v = "todo"
            sets.append("%s=?" % k)
            vals.append(v)
    if not sets:
        return {"ok": False, "error": "no valid fields"}
    sets.append("updated_at=?")
    vals.append(int(time.time()))
    vals.append(tid)
    con = sqlite3.connect(BOARD_DB)
    try:
        con.execute("UPDATE tasks SET %s WHERE id=?" % ", ".join(sets), vals)
        con.commit()
    finally:
        con.close()
    return {"ok": True}


def read_cron_jobs():
    """Return the real Hermes cron jobs from ~/.hermes/cron/jobs.json.

    Normalises the on-disk schema (which varies by Hermes version) into a
    stable shape the frontend can render, without inventing any data.
    Missing/failed read -> [] (frontend shows "Aucune tâche planifiée").
    """
    out = []
    seen = set()
    for owner, jobs in _iter_all_cron_sources():
        for j in jobs:
            if not isinstance(j, dict):
                continue
            jid = j.get("id") or ""
            if jid and jid in seen:
                continue
            seen.add(jid)
            sched = j.get("schedule") or {}
            out.append({
                "id": jid,
                "name": j.get("name") or "(sans nom)",
                "schedule": j.get("schedule_display")
                            or sched.get("display")
                            or sched.get("expr")
                            or "",
                "next_run": j.get("next_run_at") or "",
                "last_run": j.get("last_run_at") or "",
                "last_status": j.get("last_status") or "",
                "enabled": bool(j.get("enabled", False)),
                "description": (j.get("prompt") or "").strip(),
                "profile": owner,
                "deliver": j.get("deliver") or "",
                "script": j.get("script") or "",
            })
    return out


def _load_cron_file(path):
    """Load a Hermes cron jobs.json -> list (never raises)."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return data.get("jobs", []) if isinstance(data, dict) else []


def _iter_all_cron_sources():
    """Yield (owner_label, jobs list) for the central store AND every profile.

    Hermes writes cron jobs created with `hermes -p <profile> cron create`
    into ~/.hermes/profiles/<profile>/cron/jobs.json, while the default
    (profile-less) store stays at ~/.hermes/cron/jobs.json. The dashboard
    must show both, otherwise a job created from the Planification tab for
    a specific agent would silently disappear from the list.
    """
    yield ("manager", _load_cron_file(os.path.join(HERMES_HOME, "cron", "jobs.json")))
    try:
        names = sorted(os.listdir(PROFILES_DIR))
    except OSError:
        return
    for name in names:
        if name.startswith("."):
            continue
        p = os.path.join(PROFILES_DIR, name, "cron", "jobs.json")
        if os.path.isfile(p):
            label = "manager" if name == "default" else name
            yield (label, _load_cron_file(p))


def read_cron_script(name):
    """Read a script referenced by a cron job (jobs no_agent).

    Security: the resolved path must live under ~/.hermes/scripts/ or
    ~/.hermes/skills/... — anything else is refused with a 403. Accepts a
    bare filename ("mail-watch.sh"), a relative path ("scripts/mail-watch.sh")
    or an absolute path already inside an allowed root (legacy jobs store
    absolute paths). Returns (payload, http_code).
    """
    name = (name or "").strip()
    if not name:
        return {"ok": False, "error": "Nom de script manquant."}, 400
    roots = [
        os.path.realpath(os.path.join(HERMES_HOME, "scripts")),
        os.path.realpath(os.path.join(HERMES_HOME, "skills")),
    ]
    if os.path.isabs(name):
        candidates = [name]
    elif "/" in name:
        # Chemin relatif ("scripts/x", "skills/prof/foo.py") -> résolu
        # depuis HERMES_HOME ; ".." fera sortir des racines -> 403.
        candidates = [os.path.join(HERMES_HOME, name)]
    else:
        # Nom de fichier nu -> cherché dans scripts/ puis skills/.
        candidates = [os.path.join(r, name) for r in roots]
    for cand in candidates:
        full = os.path.realpath(cand)
        allowed = any(full == r or full.startswith(r + os.sep) for r in roots)
        if not allowed:
            return {"ok": False,
                    "error": "Chemin de script refusé (hors ~/.hermes/scripts et ~/.hermes/skills)."}, 403
        if not os.path.isfile(full):
            continue
        try:
            with open(full, "r", encoding="utf-8", errors="replace") as fh:
                return {"ok": True, "content": fh.read()}, 200
        except OSError as exc:
            return {"ok": False, "error": "Lecture impossible : %s" % exc}, 500
    return {"ok": False, "error": "Script introuvable : %s" % name}, 404


# --- Cron creation from the dashboard (Planification tab) -------------------
_RE_CRON_EXPR = re.compile(r"^\s*\S+(\s+\S+){4}\s*$")
_RE_CRON_SHORT = re.compile(r"^\s*(every\s+)?\d+\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$", re.I)
_RE_CRON_ISO = re.compile(r"^\s*\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?\s*$")
_CRON_DELIVER_OK = {"origin", "local", "telegram", "discord", "signal", "email"}


def validate_cron_schedule(expr):
    """Return (ok, normalised_or_error). Mirrors what `hermes cron` accepts."""
    s = (expr or "").strip()
    if not s:
        return False, "Le champ planification est obligatoire."
    if _RE_CRON_EXPR.match(s) or _RE_CRON_SHORT.match(s) or _RE_CRON_ISO.match(s):
        return True, s
    return False, ("Planification invalide : utilisez une expression cron "
                   "(ex. '0 9 * * *'), un raccourci ('30m', 'every 2h') "
                   "ou une date ISO ('2026-09-01T09:00').")


def create_cron_job(payload):
    """Create a real Hermes cron job via the CLI. Returns a dict result."""
    agent = str(payload.get("agent") or payload.get("profile") or "").strip().lower()
    name = str(payload.get("name") or "").strip()
    prompt = str(payload.get("prompt") or "").strip()
    schedule = str(payload.get("schedule") or "").strip()
    raw_deliver = payload.get("deliver") or "local"
    if isinstance(raw_deliver, (list, tuple)):
        parts = [str(p).strip().lower() for p in raw_deliver if str(p).strip()]
    else:
        parts = [p.strip().lower() for p in str(raw_deliver).split(",") if p.strip()]
    if not parts:
        parts = ["local"]
    seen = []
    for p in parts:
        if p not in seen:
            seen.append(p)
    parts = seen
    deliver = ",".join(parts)
    enabled = payload.get("enabled", True)

    if not _is_fleet_agent(agent):
        return {"ok": False, "error": "Agent inconnu : %s" % (agent or "(vide)")}
    if not prompt:
        return {"ok": False, "error": "Le prompt / instruction est obligatoire."}
    ok, sched = validate_cron_schedule(schedule)
    if not ok:
        return {"ok": False, "error": sched}
    bad = [p for p in parts if p not in _CRON_DELIVER_OK and ":" not in p]
    if bad:
        return {"ok": False, "error": "Destination de livraison inconnue : %s" % ", ".join(bad)}

    profile = _PROFILE_ALIASES.get(agent, agent)
    hermes_bin = shutil.which("hermes") or os.path.expanduser("~/.local/bin/hermes")
    if not os.path.exists(hermes_bin):
        return {"ok": False, "error": "binaire `hermes` introuvable"}

    # Store racine (~/.hermes/cron/jobs.json, SANS `-p`) pour les agents
    # résolus en `default`/`manager` : `hermes -p default` écrirait dans
    # ~/.hermes/profiles/default/ (divergent du store racine). Tous les autres
    # profils utilisent `-p <profil>`.
    cli_prefix = [] if profile in ("", "manager", "default") else ["-p", profile]

    cmd = [hermes_bin] + cli_prefix + ["cron", "create", sched, prompt,
           "--deliver", deliver]
    if name:
        cmd += ["--name", name]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=90,
                              env=dict(os.environ, HERMES_ACCEPT_HOOKS="1"))
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout lors de la creation du job"}
    except Exception as exc:  # pragma: no cover
        return {"ok": False, "error": str(exc)}

    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        return {"ok": False, "error": (out.strip() or "hermes cron create a echoue")[-600:]}
    m = re.search(r"Created job:\s*([0-9a-f]{6,})", out)
    job_id = m.group(1) if m else ""
    if not job_id:
        return {"ok": False, "error": (out.strip() or "reponse hermes inattendue")[-600:]}

    if enabled is False:
        try:
            subprocess.run([hermes_bin] + cli_prefix + ["cron", "pause", job_id],
                           capture_output=True, text=True, timeout=30)
        except Exception:
            pass
    return {"ok": True, "id": job_id, "profile": profile, "agent": agent,
            "schedule": sched, "output": out.strip()[-600:]}


def modify_cron_job(job_id, payload):
    """Modify an existing cron job via the CLI. Returns a dict result."""
    if not job_id:
        return {"ok": False, "error": "job_id requis"}

    # Rechercher le job existant pour obtenir le profile
    all_jobs = read_cron_jobs()
    job_to_modify = None
    for j in all_jobs:
        if j.get("id") == job_id:
            job_to_modify = j
            break

    if not job_to_modify:
        return {"ok": False, "error": "job inconnu"}

    # IMPORTANT (2026-08-13, fix persistance réassignation) :
    # read_cron_jobs etiquette le store racine (~/.hermes/cron/jobs.json,
    # cree SANS `-p`) comme `profile="manager"`. Or `hermes -p manager` N'EXISTE
    # PAS (manager est un alias de `default` qui pointe vers
    # ~/.hermes/profiles/default/). Il faut donc distinguer le store racine du
    # store de profil :
    #   - owner "manager" (= store racine) -> invocation CLI SANS `-p`
    #   - tout autre profil resolu -> `hermes -p <profil>`
    # On calcule `cli_profile` (profil reel a passer au CLI) et `cli_prefix`
    # (argv sans `-p` pour le store racine).
    _display = job_to_modify.get("profile") or ""
    cli_profile = _PROFILE_ALIASES.get(_display, _display)
    # Le store racine n'a pas de sous-repertoire de profil : on invoque sans `-p`.
    cli_prefix = [] if cli_profile in ("", "manager", "default") else ["-p", cli_profile]
    agent = (payload.get("agent") or _display).strip().lower()

    # Champs modifiables
    name = str(payload.get("name") or job_to_modify.get("name", "")).strip()
    prompt = str(payload.get("prompt") or payload.get("description") or job_to_modify.get("prompt", "")).strip()
    schedule = str(payload.get("schedule") or job_to_modify.get("schedule", "")).strip()

    # Si le schedule change, valider le nouveau
    if schedule and schedule != job_to_modify.get("schedule", ""):
        ok, sched = validate_cron_schedule(schedule)
        if not ok:
            return {"ok": False, "error": sched}
    else:
        schedule = job_to_modify.get("schedule", "")

    raw_deliver = payload.get("deliver") or job_to_modify.get("deliver", "local")
    if isinstance(raw_deliver, (list, tuple)):
        parts = [str(p).strip().lower() for p in raw_deliver if str(p).strip()]
    else:
        parts = [p.strip().lower() for p in str(raw_deliver).split(",") if p.strip()]
    if not parts:
        parts = ["local"]
    seen = []
    for p in parts:
        if p not in seen:
            seen.append(p)
    parts = seen
    deliver = ",".join(parts)

    enabled = payload.get("enabled", job_to_modify.get("enabled", True))

    # Construire la commande hermes cron update ou recreate
    hermes_bin = shutil.which("hermes") or os.path.expanduser("~/.local/bin/hermes")
    if not os.path.exists(hermes_bin):
        return {"ok": False, "error": "binaire `hermes` introuvable"}

    # --- REAFFECTATION INTER-PROFIL (Feature sélecteur d'agent, 2026-08-13) ---
    # Le CLI Hermes ne peut pas changer le profil d'un job existant : on
    # supprime l'ancien job puis on en crée un nouveau dans le profil cible,
    # en réutilisant TOUS les champs actuels. Si l'agent demandé est identique
    # au profil actuel du job, on retombe sur la logique d'édition classique
    # ci-dessous (pas de recréation inutile).
    new_agent = (payload.get("agent") or "").strip().lower()
    current_profile_display = job_to_modify.get("profile") or ""
    if new_agent and new_agent != current_profile_display:
        if not _is_fleet_agent(new_agent):
            return {"ok": False, "error": "Agent inconnu : %s" % (new_agent or "(vide)")}
        target_profile = _PROFILE_ALIASES.get(new_agent, new_agent)
        # Suppression de l'ancien job (store racine OU profil, via cli_prefix).
        try:
            del_proc = subprocess.run(
                [hermes_bin] + cli_prefix + ["cron", "delete", job_id],
                capture_output=True, text=True, timeout=30,
            )
        except Exception as exc:
            return {"ok": False, "error": "echec suppression ancien job : %s" % exc}
        if del_proc.returncode != 0:
            del_out = (del_proc.stdout or "") + (del_proc.stderr or "")
            return {"ok": False,
                    "error": (del_out.strip() or "hermes cron delete a echoue")[-400:]}
        # Recréation dans le profil cible via create_cron_job (gère
        # _is_fleet_agent, validate_cron_schedule, deliver, enabled).
        # SÉCURITÉ (2026-08-13) : on garantit TOUJOURS un prompt/schedule/
        # deliver non-vides depuis le job existant, même si le payload de
        # réassignation ne les renvoie pas (sinon create_cron_job échoue et
        # l'ancien job est déjà supprimé -> job perdu).
        create_res = create_cron_job({
            "agent": new_agent,
            "name": name or job_to_modify.get("name", ""),
            "prompt": prompt or job_to_modify.get("prompt", "")
                      or job_to_modify.get("description", ""),
            "schedule": schedule or job_to_modify.get("schedule", ""),
            "deliver": deliver or job_to_modify.get("deliver", "") or "local",
            "enabled": enabled,
        })
        if not create_res.get("ok"):
            # L'ancien job a déjà été supprimé : on renvoie l'erreur de création.
            return {"ok": False,
                    "error": create_res.get("error", "echec creation nouveau job")}
        return {"ok": True, "id": create_res.get("id", ""),
                "profile": target_profile, "agent": new_agent, "moved": True}

    # Hermes cron modify n'existe pas toujours - on utilise edit
    # (store racine OU profil, via cli_prefix)
    cmd = [hermes_bin] + cli_prefix + ["cron", "edit", job_id]
    if name:
        cmd += ["--name", name]
    if schedule:
        cmd += ["--schedule", schedule]
    if prompt:
        cmd += ["--prompt", prompt]
    cmd += ["--deliver", deliver]

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        # Si update échoue, essayer de recréer (ancienne méthode)
        # Supprimer l'ancien job puis en créer un nouveau
        try:
            subprocess.run([hermes_bin] + cli_prefix + ["cron", "delete", job_id],
                          capture_output=True, text=True, timeout=30)
        except Exception:
            pass

        # Créer un nouveau job avec les mêmes paramètres
        cmd_create = [hermes_bin] + cli_prefix + ["cron", "create", schedule, prompt,
                      "--deliver", deliver]
        if name:
            cmd_create += ["--name", name]
        try:
            proc = subprocess.run(cmd_create, capture_output=True, text=True, timeout=90,
                                  env=dict(os.environ, HERMES_ACCEPT_HOOKS="1"))
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

        out = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            return {"ok": False, "error": (out.strip() or "hermes cron update a echoue")[-400:]}
        m = re.search(r"Created job:\s*([0-9a-f]{6,})", out)
        new_id = m.group(1) if m else ""
        if not new_id:
            return {"ok": False, "error": (out.strip() or "reponse hermes inattendue")[-400:]}
        return {"ok": True, "id": new_id, "profile": profile}

    m = re.search(r"Updated job:\s*([0-9a-f]{6,})", out)
    updated_id = m.group(1) if m else job_id

    # SYNCHRONISATION PAUSE / RESUME (2026-08-13) :
    # `hermes cron edit` ne gère pas --enabled/pause : on appelle explicitement
    # `hermes cron pause` ou `hermes cron resume` si l'état a changé.
    old_enabled = bool(job_to_modify.get("enabled", True))
    if enabled != old_enabled:
        action = "pause" if not enabled else "resume"
        try:
            subprocess.run(
                [hermes_bin] + cli_prefix + ["cron", action, updated_id],
                capture_output=True, text=True, timeout=30
            )
        except Exception:
            pass

    return {"ok": True, "id": updated_id, "profile": cli_profile, "output": out.strip()[-400:]}


def delete_cron_job(job_id):
    """Delete a cron job via the CLI. Returns a dict result."""
    if not job_id:
        return {"ok": False, "error": "job_id requis"}

    # Vérifier que le job existe
    all_jobs = read_cron_jobs()
    job_found = False
    for j in all_jobs:
        if j.get("id") == job_id:
            job_found = True
            break

    if not job_found:
        return {"ok": False, "error": "job inconnu"}

    # Trouver le profile pour ce job
    profile = "default"  # default, chercher dans tous les profiles
    try:
        names = sorted(os.listdir(PROFILES_DIR))
    except OSError:
        names = []

    for name in names:
        if name.startswith("."):
            continue
        p = os.path.join(PROFILES_DIR, name, "cron", "jobs.json")
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                jobs = data.get("jobs", []) if isinstance(data, dict) else []
                for j in jobs:
                    if j.get("id") == job_id:
                        profile = "default" if name == "default" else name
                        break
            except (OSError, ValueError):
                pass

    hermes_bin = shutil.which("hermes") or os.path.expanduser("~/.local/bin/hermes")
    if not os.path.exists(hermes_bin):
        return {"ok": False, "error": "binaire `hermes` introuvable"}

    cmd = [hermes_bin, "-p", profile, "cron", "delete", job_id]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        return {"ok": False, "error": (out.strip() or "hermes cron delete a echoue")[-400:]}

    return {"ok": True, "id": job_id, "profile": profile}


# ---------------------------------------------------------------------------
# Fleet daily metrics helpers (TÂCHES AUJOURD'HUI + RÉUSSITE + msgCount)
#
# These power the AgentsTab cards and the bottom "Débit à travers la flotte"
# bar chart. All three metrics are computed from REAL sources only:
#   - board.db  : Kanban tasks (status/agent/updated_at)
#   - cron jobs : ~/.hermes/cron/jobs.json (profile / last_run_at / last_status)
#   - state.db  : sessions.message_count grouped by profile_name
# No data is ever invented; missing sources degrade to 0.
# ---------------------------------------------------------------------------
def _start_of_today():
    """Midnight (local tz) as a unix epoch int — the boundary for "today"."""
    now = datetime.datetime.now()
    sod = datetime.datetime(now.year, now.month, now.day, tzinfo=now.tzinfo)
    return int(sod.timestamp())


def _read_cron_jobs_raw():
    """Read the raw Hermes cron jobs (un-normalised) from disk.

    Returns the list under the top-level "jobs" key, or [] on any failure.
    We read raw (not read_cron_jobs()) because the normalised output drops
    the `profile` field we need to attribute a cron to a specific agent.
    """
    path = os.path.join(HERMES_HOME, "cron", "jobs.json")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    return data.get("jobs", []) if isinstance(data, dict) else []


def _cron_last_run_epoch(job):
    """Parse a cron job's last_run_at into a unix epoch int, or 0 if unknown.

    On disk `last_run_at` is an ISO-8601 string (e.g.
    "2026-07-24T20:00:24.787116+02:00"); older versions may store a unix
    float/int. We accept both so the metric keeps working across Hermes
    versions. Returns 0 when the value is missing/unparseable.
    """
    raw = job.get("last_run_at")
    if raw is None:
        return 0
    if isinstance(raw, (int, float)):
        return int(raw)
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return 0
        # Normalise trailing 'Z' -> +00:00 for fromisoformat compatibility.
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.datetime.fromisoformat(s)
        except ValueError:
            return 0
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=datetime.timezone.utc)
        return int(dt.timestamp())
    return 0


def _fleet_tasks_today(start_of_today):
    """Return {agent_key: int} = Kanban done tasks + crons run today.

    Board: tasks with status=='done', agent==key, updated_at >= start_of_today.
    Crons: jobs with profile==key, last_run_at epoch >= start_of_today.
    """
    out = {k: 0 for k in FLEET_ORDER}

    # --- Board (Kanban) ---
    try:
        con = sqlite3.connect(BOARD_DB)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                "SELECT agent, updated_at FROM tasks "
                "WHERE status='done' AND updated_at >= ?",
                (start_of_today,),
            ).fetchall()
        finally:
            con.close()
        for r in rows:
            a = (r["agent"] or "").lower()
            if a in out:
                out[a] += 1
    except sqlite3.Error:
        pass  # board unavailable -> 0 contribution

    # --- Crons ---
    for j in _read_cron_jobs_raw():
        if not isinstance(j, dict):
            continue
        prof = (j.get("profile") or "").lower()
        if prof not in out:
            continue
        if _cron_last_run_epoch(j) >= start_of_today:
            out[prof] += 1

    return out


def _fleet_success_count(start_of_today):
    """Return {agent_key: int} = successful units among today's tasks.

    A "unit" is one done board task (always a success) or one cron that ran
    today with last_status in {ok, success} (i.e. not error/failed). The
    global success rate is derived from these counts vs tasks_today.
    """
    out = {k: 0 for k in FLEET_ORDER}

    # Board done tasks always count as successes.
    try:
        con = sqlite3.connect(BOARD_DB)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                "SELECT agent, updated_at FROM tasks "
                "WHERE status='done' AND updated_at >= ?",
                (start_of_today,),
            ).fetchall()
        finally:
            con.close()
        for r in rows:
            a = (r["agent"] or "").lower()
            if a in out:
                out[a] += 1
    except sqlite3.Error:
        pass

    # Crons that ran today and did not fail.
    for j in _read_cron_jobs_raw():
        if not isinstance(j, dict):
            continue
        prof = (j.get("profile") or "").lower()
        if prof not in out:
            continue
        if _cron_last_run_epoch(j) >= start_of_today:
            status = (j.get("last_status") or "").lower()
            if status not in ("error", "failed"):
                out[prof] += 1

    return out


def _fleet_msg_count():
    """Return {agent_key: int} = SUM(message_count) over sessions for each
    fleet agent's REAL state.db.

    Each Hermes profile writes its own sessions into
    ~/.hermes/profiles/<profile>/state.db (the 'default'/manager coordinator
    writes into the root ~/.hermes/state.db). We must scan every profile
    state.db -- not just the central one -- or every agent shows 0 messages.
    Mirrors _scan_real_token_data(): iterate fleet_keys_ordered(), resolve
    each key to its real db via _profile_state_db_path(), and SUM all
    message_count rows of that db, attributed to the fleet key. The session
    profile_name column is intentionally NOT used (it is NULL in the central
    db and redundant in per-profile dbs).
    """
    out = {k: 0 for k in fleet_keys_ordered()}
    for agent in fleet_keys_ordered():
        db_path = _profile_state_db_path(agent)
        if not os.path.exists(db_path):
            continue
        try:
            con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
            con.execute("PRAGMA query_only=1")
            con.row_factory = sqlite3.Row
            try:
                row = con.execute(
                    "SELECT COALESCE(SUM(message_count),0) AS m FROM sessions"
                ).fetchone()
            finally:
                con.close()
            if row is not None:
                out[agent] += int(row["m"] or 0)
        except sqlite3.Error:
            continue
    return out


# ---- Token usage aggregation from the REAL session store ----
# Each `hermes -p <agent> chat` (UI OR CLI delegation) writes its session into
# that profile's own state.db under ~/.hermes/profiles/<agent>/state.db — NOT the
# central ~/.hermes/state.db (which stays empty here). To get the TRUE token
# totals for every agent we must scan every profile state.db, not just the
# central one. profile_name values are normalised to fleet keys (aliases:
# 'dev' -> developpeur, 'documentaliste' -> redacteur).
_PROFILE_ALIASES = {
    "dev": "developpeur",
    "documentaliste": "redacteur",
    # 2026-07-28: the 'manager' coordinator role was merged into the 'default'
    # profile (the profiles/manager/ directory was deleted during cleanup).
    # Keep the 'manager' display label in FLEET_META/FLEET_ORDER but resolve
    # every file/session lookup to the real 'default' profile so no tab breaks.
    "manager": "default",
}

# ---------------------------------------------------------------------------
# Option A - MC Profile Aliases (2026-08-04)
# Mapping agents to their MC-dedicared profiles for Session CLEAN isolation.
# MC sessions go to ~/.hermes/profiles/<agent>-mc/sessions/ (isolated from
# native agent history which stays in ~/.hermes/profiles/<agent>/state.db).
# This prevents MC from polluting the native History tab in Hermes Agent.
# 2026-08-06 (BOB): dict neutralise (profils *-mc supprimes definitivement).
_MC_PROFILE_ALIASES = {}

# Inverse map: real Hermes CLI profile name -> fleet/display key.
# Lets read_working_agents() detect an agent whose process runs under its
# REAL profile (e.g. manager runs as `-p default`) as the display key.
_PROFILE_TO_FLEET = {real: key for key, real in _PROFILE_ALIASES.items()}

# Complete name -> fleet display key resolution for /proc argv scanning
# (2026-08-01, DEVELOPPEUR). _PROFILE_TO_FLEET alone is WRONG as a scanner
# map: it maps every real profile name through the alias table, so the real
# profile `developpeur` resolves to the historical alias `dev` (not a fleet
# key) and `redacteur` resolves to `documentaliste` — meaning a live
# `hermes chat -p developpeur` process was NEVER counted as WORKING for the
# Developpeur card. The correct resolution covers all three shapes argv can
# carry:
#   - the fleet key itself         (developpeur -> developpeur, identity)
#   - a historical alias           (dev -> developpeur, documentaliste -> redacteur)
#   - a real merged profile        (default -> manager)
_PROFILE_KEY_RESOLVE = {}
for _k in FLEET_META:
    _PROFILE_KEY_RESOLVE[_k] = _k                       # identity
for _alias, _real in _PROFILE_ALIASES.items():
    if _real in FLEET_META:
        _PROFILE_KEY_RESOLVE[_alias] = _real            # dev -> developpeur
    if _alias in FLEET_META:
        _PROFILE_KEY_RESOLVE[_real] = _alias            # default -> manager


def read_content_library():
    """Recursively list ~/hermes-docs as a real content library.

    Returns files (not directories) with name, relative path, absolute path,
    size and mtime. Symlinks/dirs are skipped. Empty or missing dir -> [].
    The frontend opens/reads the `path` via a separate endpoint.
    """
    root = os.path.expanduser("~/hermes-docs")
    if not os.path.isdir(root):
        return []
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip hidden dirs (e.g. .git) for a clean library view.
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            if fn.startswith("."):
                continue
            full = os.path.join(dirpath, fn)
            try:
                st = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(full, root)
            out.append({
                "name": fn,
                "rel_path": rel,
                "path": full,
                "size": st.st_size,
                "mtime": int(st.st_mtime),
            })
    out.sort(key=lambda x: x["rel_path"])
    return out


def read_content_file(rel_path):
    """Return the UTF-8 text of a single content library file.

    `rel_path` is sanitised against the ~/hermes-docs root to prevent path
    traversal. Returns {"ok": False, ...} if missing/outside-root.
    """
    if not rel_path or ".." in rel_path.split("/") or rel_path.startswith("/"):
        return {"ok": False, "error": "invalid path"}
    root = os.path.expanduser("~/hermes-docs")
    full = os.path.normpath(os.path.join(root, rel_path))
    if not full.startswith(os.path.normpath(root)) or not os.path.isfile(full):
        return {"ok": False, "error": "not found"}
    try:
        with open(full, "r", encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        return {"ok": False, "error": "read error: %s" % exc}
    return {"ok": True, "path": full, "name": os.path.basename(full),
            "text": text}


def board_delete(tid):
    con = sqlite3.connect(BOARD_DB)
    try:
        con.execute("DELETE FROM tasks WHERE id=?", (tid,))
        con.commit()
    finally:
        con.close()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Snapshot aggregation (cached)
# ---------------------------------------------------------------------------
_cache = {"payload": None, "ts": 0.0}
_cache_lock = threading.Lock()


def _scan_hermes_chat_procs():
    """Shared ground-truth scanner over /proc: return {pid: fleet_key} for
    every live `hermes chat|run -p <profile>` process on the box.

    This is the single source of truth used by BOTH read_working_agents()
    (working state) and read_waiting_agents() (parent/child delegation
    detection), so the two never drift apart.

    Detection criteria (identical to the historical read_working_agents FIX
    lot3): argv must contain `hermes` AND a `-p <profile>` /
    `--profile <profile>` token (or =name / combined -pdev forms) that
    resolves to a known FLEET_META key. Read-only housekeeping calls
    (`sessions`, `session`, `list`, `logs`, `status`, `dashboard`,
    `gateway`) are NOT agent runs and are skipped — the dashboard itself
    fires `hermes sessions list -p <agent>` on every refresh and without
    this guard every profiled agent would flicker red while idle. The
    server's own PID is ignored. Returns {} (never raises) if /proc is
    unavailable.
    """
    known = set(FLEET_META.keys())
    procs = {}
    proc_dir = "/proc"
    try:
        pids = os.listdir(proc_dir)
    except Exception as exc:  # noqa: BLE001
        print("[working_agents] cannot list /proc:", exc)
        return procs
    for pid in pids:
        if not pid.isdigit():
            continue
        try:
            if int(pid) == os.getpid():
                continue
        except ValueError:
            continue
        cmdline_path = os.path.join(proc_dir, pid, "cmdline")
        try:
            with open(cmdline_path, "rb") as fh:
                # cmdline is NUL-separated; argv tokens are NUL-separated.
                argv = fh.read().split(b"\x00")
        except Exception:
            continue
        # Decode tokens, drop the trailing empty entry.
        toks = [t.decode("utf-8", "replace") for t in argv if t]
        if not toks or "hermes" not in os.path.basename(toks[0]) and \
                not any("hermes" in t for t in toks):
            continue
        # FIX (lot3): only count a process as "working" if it is actually
        # RUNNING an agent (chat / run / agent / -Q), NOT a read-only house
        # keeping call. See module docstring of this helper for the why.
        _readonly_ops = ("sessions", "session", "list", "logs", "status", "dashboard", "gateway")
        lowered = [t.lower() for t in toks]
        if any(op in lowered for op in _readonly_ops):
            continue
        # Only count processes that are actually running an agent command (chat or run)
        cmdline = " ".join(toks)
        if not ("hermes" in cmdline and ("chat" in cmdline or "run" in cmdline)):
            continue
        # Walk tokens looking for -p/--profile <name> (or =name form).
        for i, tok in enumerate(toks):
            prof = None
            if tok in ("-p", "--profile"):
                if i + 1 < len(toks):
                    prof = toks[i + 1]
            elif tok.startswith("--profile="):
                prof = tok.split("=", 1)[1]
            elif tok.startswith("-p") and len(tok) > 2 and not tok.startswith("-p="):
                # rare: combined flag like -pdev (not used by hermes CLI, but safe)
                prof = tok[2:]
            if prof:
                prof_l = prof.strip().lower()
                # Resolve a real profile name to its fleet display key
                # (identity for normal keys, `dev`/`documentaliste` historical
                # aliases, and `default` for the merged Manager profile).
                fleet_key = _PROFILE_KEY_RESOLVE.get(prof_l, prof_l)
                if fleet_key in known:
                    procs[int(pid)] = fleet_key
    return procs


def _proc_ppid(pid):
    """Read the PPID of `pid` from /proc/<pid>/stat (4th field).

    stat format: "pid (comm) state ppid ..." — comm may contain spaces and
    parentheses, so we split on the LAST ')' and take the 2nd whitespace
    token of the remainder (1st = state). Returns None (never raises) if the
    process vanished between listing and reading, or if /proc is
    unavailable — the caller treats None as "no parent to match".
    """
    try:
        with open(os.path.join("/proc", str(pid), "stat"), "rb") as fh:
            stat = fh.read()
        rest = stat.split(b") ", 1)[1].split()
        if len(rest) >= 2:
            return int(rest[1])
    except Exception:  # noqa: BLE001
        return None
    return None


def read_working_agents():
    """Agents actively running RIGHT NOW (real-time, process-based).

    The fleet is a set of Hermes agent PROFILES, each invocable via the
    `hermes` CLI: `hermes chat -p <profile> -q <text>`. The ground-truth
    "is this agent working right now" signal is therefore a live `hermes`
    process for that profile on the box — not a DB timestamp that can go
    stale (session_model_usage.last_seen only updates on billing events and
    otherwise freezes, so a 60s window never matched).

    Uses the shared /proc scanner `_scan_hermes_chat_procs()` (same FIX lot3
    criteria: chat/run/-Q agent runs only, read-only calls ignored, server
    PID ignored). Read-only, no subprocess spawned. Falls back to [] if
    /proc is unavailable. Returns lowercase agent keys present in FLEET_META.
    """
    known = set(FLEET_META.keys())
    active = set(_scan_hermes_chat_procs().values())
    # (VISIBILITÉ) Délégations lancées par le Manager via subprocess Hermes :
    # le scan /proc ci-dessus peut manquer le process englobant (bash -c /
    # python du terminal). On lit un fichier de suivi écrit par le Manager à
    # chaque délégation, et on marque ces agents comme "working" tant que le
    # fichier est frais (< 30 min). Cela garantit que l'onglet Agents affiche
    # bien l'agent en rouge (WORKING) pendant qu'il travaille, jamais IDLE.
    try:
        _del_path = os.path.join(PROJECT_DIR, "delegations_active.json")
        if os.path.exists(_del_path):
            try:
                import json as _json
                _del = _json.load(open(_del_path))
                _now = time.time()
                for _a, _ts in (_del.get("active", {}) or {}).items():
                    if _a in known and (_now - float(_ts)) < 1800:
                        active.add(_a)
            except Exception:
                pass
    except Exception:
        pass
    return sorted(active)


def _walk_up_to_hermes_chat(start_pid, procs):
    """Walk the PPID chain upward from `start_pid` and return the first PID
    that is a known live hermes-chat process (present in `procs`), or None.

    Why: a delegated `hermes -p Y` process is NOT necessarily a direct
    child of the delegator's `hermes -p X` process. When the delegator's
    terminal tool launches the command it goes through an intermediate
    shell (`bash -c ...`), so the delegated process's direct PPID is the
    bash wrapper — which is not a hermes-chat process and therefore not in
    `procs`. We climb the chain (parent of parent of ...) until we reach a
    known hermes-chat ancestor, which is the real delegator.

    Guards: capped at MAX_CHAIN_DEPTH iterations (10) to avoid loops, and
    stops at pid <= 1 (init). Never raises: if a process vanishes mid-walk,
    _proc_ppid returns None and we bail. Returns None when no known
    hermes-chat ancestor is found.
    """
    MAX_CHAIN_DEPTH = 10
    pid = start_pid
    for _ in range(MAX_CHAIN_DEPTH):
        ppid = _proc_ppid(pid)
        if ppid is None:
            return None
        if ppid in procs:
            return ppid
        if ppid <= 1:
            return None
        pid = ppid
    return None


def read_waiting_agents():
    """Agents currently waiting for another agent to finish (delegation).

    Two sources, UNION-ed:

    1. Legacy tracker file ~/agent-mission-control/waiting_agents.json
       (kept for compatibility): entries whose timestamp is < 30 min old.

    2. REAL parent/child delegation detection over /proc (2026-08-01,
       DEVELOPPEUR): an agent X is WAITING whenever one of its own live
       `hermes chat -p X` processes has a CHILD process that is itself a
       live `hermes chat -p Y` process (Y != X, Y in FLEET_META). In other
       words X delegated to Y and is blocked until Y returns. We walk every
       live hermes-chat process C (profile Y): we climb C's PPID chain
       (handles the intermediate `bash -c` wrapper used by the delegator's
       terminal tool — the direct parent is the shell, the real parent is
       the hermes-chat ancestor found a few levels up, see
       _walk_up_to_hermes_chat()). If a known hermes-chat ancestor with
       profile X is found, X becomes waiting.

       Cascades work naturally: Manager -> Recherche -> Developpeur marks
       BOTH Manager and Recherche as waiting (each has an active child),
       while Developpeur stays working. An agent can therefore be working
       AND waiting at the same time; the frontend gives waiting priority
       (agentStatusFromStrings: waiting -> blue).

    Falls back to [] (never raises) if /proc is unavailable or a pid
    disappears mid-scan.
    """
    known = set(FLEET_META.keys())
    waiting = set()

    # 1) Legacy tracker file (compat): only fresh entries (< 30 min).
    try:
        wt_path = os.path.join(PROJECT_DIR, "waiting_agents.json")
        if os.path.exists(wt_path):
            with open(wt_path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict):
                now = time.time()
                for agent, ts in (data.get("waiting", {}) or {}).items():
                    if agent in known and isinstance(ts, (int, float)) and (now - float(ts)) < 1800:
                        waiting.add(agent)
    except Exception:  # noqa: BLE001
        pass

    # 2) Real parent/child delegation detection over /proc.
    procs = _scan_hermes_chat_procs()
    for child_pid, child_key in procs.items():
        # Walk UP the PPID chain: the delegated process may be a grandchild
        # (launched through an intermediate `bash -c` wrapper by the
        # delegator's terminal tool), so the DIRECT PPID is not necessarily
        # a hermes-chat process. _walk_up_to_hermes_chat() climbs until it
        # finds a known hermes-chat ancestor (10 levels max).
        parent_pid = _walk_up_to_hermes_chat(child_pid, procs)
        if parent_pid is None:
            continue
        parent_key = procs.get(parent_pid)
        # parent must be a live hermes-chat process of a DIFFERENT agent
        # (an agent delegating to itself is not a wait state).
        if parent_key is not None and parent_key != child_key:
            waiting.add(parent_key)

    return sorted(waiting)


# Serialise chat per agent profile. Hermes keeps a per-profile session store
# (SQLite at ~/.hermes/sessions); running two `hermes chat -p <agent>` calls
# concurrently can corrupt/diverge the session_id that `-Q` prints vs the one
# actually persisted. The dashboard is single-user, but we guard anyway so a
# fast double-click cannot race the session store.
_CHAT_SEM = {a: threading.Semaphore(1) for a in FLEET_META}


def _query_session_list(agent: str, mc_mode: bool = False):
    """Return the authoritative, most-recent session id for `agent` (Hermes store).

    Uses `hermes sessions list -p <agent>` — the id in the LAST column is the
    real, resumable session id (more reliable than the `session_id:` line that
    `-Q` prints, which can diverge under concurrent runs).
    
    When mc_mode=True, queries the MC-dedicated profile (e.g., 'redacteur-mc')
    instead of the real profile (e.g., 'redacteur'). Used by MC session bootstrap.
    """
    try:
        rc, out, err = _run_capture(
            [_resolve_hermes_bin(), "sessions", "list", "-p", _hermes_profile(agent, mc_mode=mc_mode)],
            _chat_env(), timeout=60,
        )
    except Exception:  # noqa: BLE001
        return None
    sid = None
    for line in out.splitlines():
        s = line.strip()
        if not s or s.startswith("Preview") or "──" in s:
            continue
        if "cli" in s or "tui" in s:
            # last whitespace-delimited token is the session id
            parts = s.split()
            if parts:
                cand = parts[-1]
                if re.match(r"^\d{8}_\d{6}_[0-9a-f]+$", cand):
                    sid = cand
    return sid


# ---------------------------------------------------------------------------
# NATIVE session store reader (Etape 2, Option A)
# ---------------------------------------------------------------------------
# Unifies Mission Control on the SAME store as 9119 + TUI + the relay
# (`~/.hermes/profiles/<agent>/state.db`, tables sessions/messages). This is
# the single source of truth. We read the authoritative list directly from the
# Hermes CLI (`hermes sessions list -p <agent>`) which prints a fixed-width
# table. Column offsets are verified against real output:
#   Preview=0  Workspace=39  Last Active=58  Src=72  ID=79
# "Last Active" is a relative string ("18h ago", "just now") so it is NOT
# sortable; we instead pick the ACTIVE session as the one with the max id
# (ids are %Y%m%d_%H%M%S_<hex> -> chronological == most recent). All other
# sessions are ARCHIVED, grouped by `title` (the subject / sujet).
#
# ANTI-INJECTION: agent is whitelisted by the caller (FLEET_META) before this
# runs. The id token is only used for equality / --resume, never interpolated
# into a shell string unsanitised (we pass it as a list arg to subprocess).
_NATIVE_COLS = {"preview": 0, "workspace": 39, "last_active": 58, "src": 72, "id": 79}
_RE_NATIVE_SID = re.compile(r"^\d{8}_\d{6}_[0-9a-f]+$")
# Hermes injects a system image-legend prefix into the *user* turn when the
# user attaches an image. It looks like:
#   "[The user attached an image. Here's what it contains: <desc>]\n<real text>"
# This is scaffolding noise, not the user's real words, so we strip it from
# user turns only (assistant turns are kept verbatim by user decision).
# Gated on the exact opening marker; non-greedy up to the first closing ']'
# plus the immediate newline. If the marker is absent the text is untouched.
_RE_IMG_LEGEND = re.compile(r'^\[The user attached an image\.?[\s\S]*?\]\n?',
                            re.IGNORECASE)








# ---------------------------------------------------------------------------
# Persistent per-agent chat sessions (clone memory)
# ---------------------------------------------------------------------------
# piloubruce requirement: ONE agent = ONE memory, regardless of interface. The
# dashboard chat must accumulate history across page reloads instead of spawning
# an amnesic fresh subprocess each time `session_id` is null (the page-reset
# case). To achieve this, the SERVER owns a fixed, persistent session id PER
# AGENT and resumes it whenever the caller does not pin its own session.
#
# Resolution order for the fixed id (first hit wins, cached in memory):
#   1. in-memory cache            (_PERSISTENT_SID)
#   2. env override              MC_MANAGER_SESSION / MC_<AGENT>_SESSION
#   3. on-disk file              ~/agent-mission-control/persistent_sessions.json
#   4. bootstrap a fresh session (hermes chat -p <agent> -q "init..." -Q) and
#      capture the REAL id (hermes --resume rejects unknown ids, so a
#      deterministic id is impossible — we must create then reuse the real one).
#
# A caller that explicitly passes a session_id (e.g. opening a historical
# thread) is always honoured — this feature only fills the null (fresh) gap, so
# the other agents and the "open history" flow are untouched.
_PERSISTENT_SESSIONS_FILE = os.path.join(PROJECT_DIR, "persistent_sessions.json")
# agent -> persistent session id (resolved + cached lazily)
_PERSISTENT_SID = {}
_PERSISTENT_SID_LOCK = threading.RLock()  # RLock: _invalidate_persistent_session() is called WHILE the caller already holds this lock -> a plain Lock would self-deadlock.
# regex for a real Hermes session id token (as printed by `hermes sessions list`)
_RE_HERMES_SID = re.compile(r"^\d{8}_\d{6}_[0-9a-f]+$")


def _env_persistent_sid(agent: str):
    """Read an explicit env override for the agent's fixed session id."""
    # 2026-07-28: the 'manager' coordinator was merged into the 'default'
    # profile. Honour the legacy MC_MANAGER_SESSION env var, but also accept
    # MC_DEFAULT_SESSION so the persistent-session feature keeps working.
    if agent == "manager":
        val = os.environ.get("MC_MANAGER_SESSION")
        if val and val.strip():
            return val.strip()
    if agent == "default":
        val = os.environ.get("MC_DEFAULT_SESSION")
        if val and val.strip():
            return val.strip()
    up = agent.upper().replace("-", "_")
    val = os.environ.get("MC_%s_SESSION" % up)
    if val and val.strip():
        return val.strip()
    return None


def _load_persistent_sids_from_disk():
    """Populate the in-memory cache from the on-disk JSON file (no subprocess).

    2026-07-28: the 'manager' coordinator was merged into the 'default' profile
    and its old persistent session id (stored under the 'manager' key) no longer
    exists in the 'default' profile's session store. Only accept ids that match
    Hermes' real session-id token format; a stale/dead id would otherwise be
    reused on --resume and fail with "Session not found". Dropped keys are
    lazily re-bootstrapped by _ensure_persistent_session().
    """
    try:
        with open(_PERSISTENT_SESSIONS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh) or {}
    except (OSError, ValueError):
        return
    for agent, sid in data.items():
        if agent in FLEET_META and sid and isinstance(sid, str) and _RE_HERMES_SID.match(sid):
            _PERSISTENT_SID.setdefault(agent, sid)


def _save_persistent_sids_to_disk():
    """Persist the current cache to the on-disk JSON file (best effort)."""
    try:
        tmp = _PERSISTENT_SESSIONS_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(_PERSISTENT_SID, fh, indent=2, sort_keys=True)
        os.replace(tmp, _PERSISTENT_SESSIONS_FILE)
    except OSError as exc:
        _chat_log("persistent sid save failed: %s" % exc)


def _bootstrap_persistent_session(agent: str):
    """NEUTRALIZED 2026-07-28: this bootstrap ran `hermes chat -q "init session"`
    with a 400s timeout and was the root cause of extreme MC chat latency.
    MC now always launches a FRESH `hermes chat` (no --resume). No-op forever."""
    _chat_log("agent=%s bootstrap SKIPPED (persistent sessions disabled)" % agent)
    return None


def _bootstrap_persistent_session_DISABLED(agent: str):
    """Original implementation, kept for reference only — never called."""
    """Create a brand-new Hermes session for `agent` and return its real id.

    Uses `hermes chat -p <agent> -q "init session" -Q` then queries the session
    store for the authoritative new id. Returns None on any failure (the caller
    then transparently falls back to a normal fresh call).

    The model/provider are resolved via the same free-safe logic as a normal
    chat call (_resolve_effective_model) so the bootstrap does NOT accidentally
    hit a paid profile default (which can hang / time out) — e.g. developpeur's default
    is tencent/hy3 (paid); the guard forces tencent/hy3:free, which responds.
    """
    hermes_bin = _resolve_hermes_bin()
    chat_env = _chat_env()
    eff_model, eff_provider = _resolve_effective_model(agent, None, None)
    cmd = [hermes_bin, "chat", "-p", _hermes_profile(agent), "-q",
           "init session %s (clone persistent memory)" % agent, "-Q"]
    if eff_model:
        cmd += ["-m", eff_model]
    if eff_provider:
        cmd += ["--provider", eff_provider]
    _chat_log("agent=%s bootstrap persistent session (model=%s provider=%s)"
              % (agent, eff_model, eff_provider))
    try:
        rc, out, err = _run_capture(cmd, chat_env, timeout=400)
    except Exception as exc:  # noqa: BLE001
        _chat_log("agent=%s bootstrap subprocess error: %s" % (agent, exc))
        return None
    if rc != 0:
        _chat_log("agent=%s bootstrap rc=%s stderr=%r"
                  % (agent, rc, (err or "")[:500]))
        return None
    new_sid = _query_session_list(agent)
    if not new_sid:
        _chat_log("agent=%s bootstrap: could not resolve new session id" % agent)
        return None
    _chat_log("agent=%s bootstrap ok sid=%s" % (agent, new_sid))
    return new_sid



def _resolve_hermes_bin():
    """Locate the hermes executable; guarantee ~/.local/bin is searched.

    The dashboard server may be launched from a context (systemd, cron, a
    re-parented shell) where PATH does not include ~/.local/bin even though
    `hermes` is reachable in an interactive shell. Resolving the absolute path
    once avoids a silent "FileNotFoundError"/hang in the chat subprocess.
    """
    candidates = [
        os.path.expanduser("~/.local/bin/hermes"),
        "/usr/local/bin/hermes",
        "/usr/bin/hermes",
    ]
    for cand in candidates:
        try:
            if os.path.isfile(cand) and os.access(cand, os.X_OK):
                return cand
        except OSError:
            pass
    return "hermes"  # last resort: rely on subprocess PATH


def _clean_opt(val):
    """Normalise an optional CLI value: JSON null / 'None' / 'null' -> None.

    a real JSON null into the string 'None'. Passing '-m None' to hermes makes it
    exit 1 with no stderr — the exact silent failure seen on the dashboard.
    """
    if val is None:
        return None
    s = str(val).strip()
    if not s or s.lower() in ("none", "null"):
        return None
    return s


_CHAT_ENV_LOGGED = set()


def _chat_env():
    """Environment for the chat subprocess.

    Copy the current environment and guarantee a MINIMAL sane set of vars so the
    `hermes` subprocess always boots (even if the server was launched with a
    stripped env, e.g. `env -i` / `env -u` from lot5). A subprocess missing
    HOME/HERMES_HOME/LANG can hang or error on startup -> the 300s chat timeout.

    Guaranteed minimum:
      - HOME, USER/LOGNAME, LANG                 (identity / locale)
      - PATH with ~/.local/bin prepended         (so `hermes` resolves)
      - HERMES_HOME pinned to the SHARED base     (canonical state dir)
      - XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_RUNTIME_DIR  (runtime dirs)
    """
    env = os.environ.copy()
    # Drop inherited SSH session vars so the subprocess does not pick up a
    # stale SSH_CONNECTION/SSH_TTY from the launching shell.
    for _k in ("SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"):
        env.pop(_k, None)

    home = os.path.expanduser("~")
    # HOME — without it, per-user config resolution silently breaks.
    if not env.get("HOME"):
        env["HOME"] = home
    # USER / LOGNAME — hermes (and child CLIs) expect a real user.
    if not env.get("USER"):
        env["USER"] = os.path.basename(home) or "piloubruce"
    env.setdefault("LOGNAME", env["USER"])
    # LANG — avoid locale errors ("unsupported locale", mojibake) on startup.
    if not env.get("LANG"):
        env["LANG"] = "C.UTF-8"
    # PATH — ensure ~/.local/bin (hermes binary) is present.
    local_bin = os.path.join(home, ".local", "bin")
    existing = env.get("PATH", "").split(os.pathsep)
    if local_bin not in existing:
        env["PATH"] = local_bin + os.pathsep + env.get("PATH", "")

    # Pin HERMES_HOME to the SHARED base (~/.hermes), never a profile subdir.
    # The launching shell may have HERMES_HOME pointing at ~/.hermes/profiles/developpeur
    # (the active session), which would mislead the subprocess about which
    # state/config dir is "home". -p still selects the right profile, but the
    # base path must be canonical so logs/sessions resolve to the real store.
    env["HERMES_HOME"] = HERMES_HOME
    env.pop("HERMES_PROFILE", None)

    # XDG_* — hermes writes runtime/cache under these; if absent some lib
    # (keyring, httpx cache, etc.) retries/loops. Pin to sane per-user dirs.
    env.setdefault("XDG_CONFIG_HOME", os.path.join(home, ".config"))
    env.setdefault("XDG_DATA_HOME", os.path.join(home, ".local", "share"))
    env.setdefault("XDG_RUNTIME_DIR", "/run/user/%s" % os.getuid()
                   if os.path.exists("/run/user/%s" % os.getuid())
                   else os.path.join(home, ".cache", "runtime"))
    env.setdefault("XDG_CACHE_HOME", os.path.join(home, ".cache"))

    # One-time diagnostic: log the env we hand to the subprocess so a silent
    # rc=1 can be traced to a missing var (HERMES_HOME, XDG_*, etc.).
    if "keys" not in _CHAT_ENV_LOGGED:
        _CHAT_ENV_LOGGED.add("keys")
        _chat_log("chat env keys=%s" % sorted(env.keys()))
        _chat_log("chat env PATH=%s" % env.get("PATH", ""))
        _chat_log("chat env HERMES_HOME=%s XDG_CONFIG_HOME=%s XDG_DATA_HOME=%s"
                  % (env.get("HERMES_HOME"), env.get("XDG_CONFIG_HOME"),
                     env.get("XDG_DATA_HOME")))
    return env


def _chat_log(msg):
    """Append a chat diagnostic line to /tmp/mc_server.log (and stdout)."""
    line = "[chat] %s" % msg
    print(line)
    try:
        with open(_CHAT_LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), line))
    except OSError:
        pass


# Regex robuste: exclut toute ligne qui DEBUTE par une variante de
# "session_id:" quel que soit la casse et avec/sans espaces autour des ":".
# Avant ce fix, seul le match exact "session_id:" (lower) etait filtre,
# donc "session_id :" (espace) ou "Session_ID:" (majuscule) passait a
# travers et devenait la "reply" affichee a l'utilisateur.
_RE_SESSION_ID_LINE = re.compile(r"^\s*session[_\s-]*id\s*:", re.IGNORECASE)


def _parse_session_id(out: str) -> str | None:
    """Extract the Hermes native session id from `hermes chat -Q` output.

    Hermes prints a `session_id: <YYYYMMDD_HHMMSS_hex>` line at the end of a
    -Q run. Parsing it from OUR worker's own output is deterministic (the
    worker just created THAT session) — unlike `_query_session_list` which
    returns the agent's LATEST session and races with concurrent runs.
    """
    if not out:
        return None
    m = re.search(r"session[_-]?id\s*:\s*(\d{8}_\d{6}_[0-9a-fA-F]+)", out, re.IGNORECASE)
    if m and _RE_HERMES_SID.match(m.group(1)):
        return m.group(1)
    return None


def _is_session_id_line(line: str) -> bool:
    """True si la ligne est un artifact 'session_id: ...' a exclure du reply."""
    return bool(_RE_SESSION_ID_LINE.match(line or ""))


def _build_failure_error(out: str, err: str, rc: int) -> str:
    """Construit le message d'erreur remonte en cas d'echec (rc != 0).

    IMPORTANT: chez Hermes, le message d'erreur reel (ex: 'HTTP 404: Model
    ... requires available credits') arrive souvent dans STDOUT, tandis que
    STDERR contient la ligne 'session_id: ...' (artifact). On ne doit DONC
    jamais renvoyer STDERR brut tel quel -- il contiendrait 'session_id: ...'
    affiche a l'utilisateur comme une 'erreur'. On nettoie l'artifact
    session_id des DEUX flux et on combine (stderr prioritaire, sinon stdout).
    """
    out_clean = "\n".join(
        ln for ln in (out or "").splitlines() if not _is_session_id_line(ln)
    ).strip()
    err_clean = "\n".join(
        ln for ln in (err or "").splitlines() if not _is_session_id_line(ln)
    ).strip()
    msg = err_clean or out_clean
    if not msg:
        msg = "hermes chat a echoue (rc=%s, aucun message d'erreur)" % rc
    return msg[:800]


def _resolve_effective_model(agent: str, model: str, provider: str):
    """Resolve the model/provider actually handed to `hermes chat`.

    Priority: explicit caller override (the dashboard model picker) >
    the agent profile's own default. Safety net: if the resolved provider
    is 'nous' and the model is the PAID 'tencent/hy3' (missing the
    ':free' suffix), force the free variant. This guarantees a dashboard
    chat never silently burns Nous credits on a model the operator did not
    explicitly choose as paid -- the exact Documentaliste failure of lot7.
    """
    eff_model = model
    eff_provider = provider
    if not eff_model or not eff_provider:
        prof = read_agent_model(agent) or {}
        if not eff_model:
            eff_model = prof.get("model")
        if not eff_provider:
            eff_provider = prof.get("provider")
    # Safety net ONLY when the caller did NOT override the model: a paid
    # 'tencent/hy3' profile default is forced to the free variant so a
    # dashboard chat never silently burns Nous credits. An explicit caller
    # choice (model picker) is always respected.
    if (not model) and (eff_provider or "").lower() == "nous" and eff_model == "tencent/hy3":
        _chat_log("agent=%s model guard: forcing tencent/hy3:free (paid default)" % agent)
        eff_model = "tencent/hy3:free"
    return eff_model, eff_provider


def _run_hermes(cmd, chat_env, timeout=120):
    """Run `hermes chat` in a DETACHED process group so a timeout-kill takes
    down the whole child tree.

    WHY: hermes spawns helper subprocesses that keep the stdout pipe open.
    Killing only the direct child (subprocess.run timeout) leaves
    communicate() hanging forever waiting for EOF -> the caller's
    for that agent deadlocks, leaving board tasks stuck forever in 'doing'.

    Returns (returncode, stdout, stderr). On timeout/error returns
    (None, out, err_msg) so the caller can branch without raising.
    """
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            env=chat_env,
            text=True,
            bufsize=1,
            start_new_session=True,  # own PGID == proc.pid
        )
    except Exception as exc:  # noqa: BLE001
        return (None, "", "subprocess spawn error: %s" % exc)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Kill the ENTIRE process group, not just the direct child.
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:  # noqa: BLE001
            out, err = ("", "")
        return (None, out or "", "timeout (process group killed)")
    return (proc.returncode, (out or "").strip(), (err or "").strip())


def _run_capture(cmd, env, timeout=60):
    """Run a hermes CLI command (sessions list, delete, scan, bootstrap) in a
    DETACHED process group and return (rc, stdout, stderr).

    Identical robustness to _run_hermes: capturing via Popen + communicate()
    with an explicit timeout, and killing the WHOLE process group on timeout
    (subprocess.run(..., capture_output=True) can hang forever if a child
    keeps the stdout pipe open -> the caller's lock/semaphore is never freed
    and every subsequent call deadlocks, e.g. _ensure_persistent_session).
    """
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            env=env,
            text=True,
            bufsize=1,
            start_new_session=True,
        )
    except Exception as exc:  # noqa: BLE001
        return (None, "", "spawn error: %s" % exc)
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        try:
            out, err = proc.communicate(timeout=5)
        except Exception:  # noqa: BLE001
            out, err = ("", "")
        return (None, out or "", "timeout (process group killed)")
    return (proc.returncode, (out or "").strip(), (err or "").strip())


def build_state():
    fleet_full = read_fleet()
    total_lines = fleet_full.pop("_total_lines", 0)
    agentlogs = read_agentlogs()
    return {
        "health": read_health(),
        "sessions": read_sessions(),
        "vps": read_vps(),
        "fleet": fleet_full["agents"],       # array of per-agent objects
        "models": fleet_full["models"],
        "model_usage": fleet_full["model_usage"],
        "routing": fleet_full["routing"],
        "agentlogs": agentlogs["logs"],
        "agentlogs_stats": agentlogs["stats"],
        "board": read_board(),
        "working_agents": read_working_agents(),   # real: active sessions per profile
        "waiting_agents": read_waiting_agents(),   # real: waiting states
        "hermes_cron": read_cron_jobs(),          # real Hermes cron jobs
        # NOTE (optA 2026-08-02): "content" deliberately EXCLUDED from the SSE
        # snapshot. ~/hermes-docs is 674 MB / 6785 files and serialized to ~1.77 MB
        # here, i.e. 97% of every /api/state payload pushed to all clients every 3s.
        # The Content tab loads it on demand via GET /api/content (paginated).
        "agent_tokens": _read_real_token_usage(),  # REEL: tokens state.db / (agent,model)
        "agent_rate": _read_real_last_rates(),     # REEL: débit tok/s persisté par modèle
    }


def get_state():
    now = time.time()
    with _cache_lock:
        if _cache["payload"] is not None and (now - _cache["ts"]) < CACHE_TTL:
            return _cache["payload"]
    payload = build_state()
    with _cache_lock:
        _cache["payload"] = payload
        _cache["ts"] = time.time()
    return payload


# ---------------------------------------------------------------------------
# Model availability scan (real per-model call) — req #7 (Scan tab)
# ---------------------------------------------------------------------------
# The Scan feature fires a REAL inference call for every model of a chosen
# provider (mini prompt "reponds juste OK", short timeout) and reports
# VERT (ok) / ROUGE (failure reason: quota exceeded, insufficient credits,
# 401/404, timeout, empty content, ...). It reuses the SAME real calling
# mechanisms the agents use:
#   * lmstudio (OpenAI-compatible local) -> direct /v1/chat/completions
#     probe (the `hermes chat` path returns empty content here, so we go
#     straight to the provider the dashboard already enumerates).
#   * cloud providers (nous, openrouter, openai-api, anthropic, ...) ->
#     `hermes chat -q ... -Q -m <model> --provider <provider>` subprocess,
#
# Concurrency is capped by a semaphore (MAX_SCAN_CONCURRENCY) so we never
# storm a provider or burn quotas. Providers with NO configured key/URL
# (e.g. azure-foundry, vertex) return a single "non configure" row instead
# of crashing.
import urllib.request
import urllib.error

MAX_SCAN_CONCURRENCY = 4
_SCAN_SEM = threading.Semaphore(MAX_SCAN_CONCURRENCY)
# Providers that look identical to a built-in provider in plugin scan but
# require a key/URL we may not have. Kept small; detection is dynamic below.
_SCAN_TIMEOUT = 60.0

# ---------------------------------------------------------------------------
# TEST DE VIE "MIXTE" + VERDICT A 3 ETATS (2026-08-06, DEVELOPPEUR)
# ---------------------------------------------------------------------------
# Ancien comportement (faux positifs): prompt "reponds juste OK", max_tokens=50
# et proof_of_life = (content OU reasoning OU tok_out>0 OU usage>tok_in).
# Un modele consommant des tokens SANS produire un seul caractere exploitable
# passait VERT. Corrige ici: seul du TEXTE compte.
#
#   VERT   : le texte contient une salutation (normalisee sans accents).
#   ORANGE : texte non vide, mais sans salutation -> il repond quand meme.
#   ROUGE  : aucun texte (content ET reasoning vides), timeout, erreur HTTP.
_LIFE_PROMPT = "bonjour, reponds-moi en un mot"

# ---------------------------------------------------------------------------
# PHASE 1 (2026-08-06, BOB) — ANTI-CACHE DU SCAN DE MODELES
#
# Constat: 29 lignes du scan affichaient > 10 000 tok/s (pointe 142 811 tok/s,
# latence min 15,4 ms), toutes chez omni-route sur ses alias auto/*. Aucun
# modele ne genere a cette vitesse: c'etaient des reponses SERVIES EN CACHE.
# Le prompt de vie etait strictement constant -> la passerelle renvoyait la
# reponse memorisee, le scan concluait VERT sans jamais solliciter le modele,
# d'ou les "Primary auth failed" au premier usage reel.
#
# Correctifs:
#   1. Prompt NON CACHABLE: un nonce aleatoire (uuid4 court) est injecte a
#      chaque appel et le modele doit le recopier. Une reponse cache ne peut
#      pas contenir un nonce jamais vu.
#   2. PLAFOND DE PLAUSIBILITE: debit > _CACHE_MAX_TOKS tok/s ou latence <
#      _CACHE_MIN_LATENCY_MS -> refus du vert, statut "suspect", aucun score
#      (latency_ms / tokens_per_sec non enregistres).
#   3. La raison du rejet est journalisee (logger + colonne reason).
# ---------------------------------------------------------------------------
_CACHE_MAX_TOKS = 2000.0      # tok/s au-dela = physiquement implausible
_CACHE_MIN_LATENCY_MS = 200.0  # sous 200 ms = reponse pre-calculee


def _life_make_nonce() -> str:
    """Nonce court, unique par sonde (casse tout cache de passerelle)."""
    return uuid.uuid4().hex[:8].upper()


def _life_prompt_with_nonce(nonce: str) -> str:
    """Prompt de vie non cachable: la reponse DOIT contenir le nonce."""
    return ("bonjour. Code de verification: %s. "
            "Reponds exactement par: bonjour %s" % (nonce, nonce))
# 180 s demande explicitement par l'utilisateur (modeles a raisonnement lents).
_LIFE_TIMEOUT = 35.0
# max_tokens=512 : un modele a raisonnement (deepseek-r1, qwq, nemotron...)
# consomme facilement 100-300 tokens de reasoning AVANT d'ecrire le moindre
# caractere de content. Avec 50 tokens il epuisait le budget dans le
# raisonnement -> content vide -> faux ROUGE (ou faux VERT via les tokens).
# 512 laisse la marge pour que le content apparaisse, tout en restant petit
# (cout et duree negligeables pour un simple mot de reponse).
_LIFE_MAX_TOKENS = 512

_LIFE_GREETINGS = (
    "bonjour", "bonsoir", "bonne journee", "salut", "coucou", "salutations",
    "hello", "hi", "hey", "greetings", "good morning", "good evening",
    "buenos dias", "hola", "ciao", "guten tag", "hallo", "ola", "yo",
)


def _life_normalize(text: str) -> str:
    """Minuscules + suppression des accents (NFD) pour comparer les salutations."""
    import unicodedata
    t = unicodedata.normalize("NFD", str(text or ""))
    t = "".join(ch for ch in t if unicodedata.category(ch) != "Mn")
    return t.lower()


def _life_has_greeting(text: str) -> bool:
    """True si le texte contient une salutation (mot entier, accents ignores)."""
    norm = _life_normalize(text)
    if not norm.strip():
        return False
    for g in _LIFE_GREETINGS:
        if re.search(r"(?<![a-z0-9])" + re.escape(g) + r"(?![a-z0-9])", norm):
            return True
    return False


def _life_verdict(content: str, reasoning: str,
                  nonce: str = None,
                  latency_ms: float = None,
                  tokens_per_sec: float = None,
                  provider: str = None, model: str = None) -> tuple:
    """Retourne (life_state, ok, reason, answer) a partir du texte recu.

    ok reste un BOOLEEN pour ne rien casser en aval : True pour vert ET orange
    (dans les deux cas le modele repond vraiment), False pour rouge/suspect.

    PHASE 1 anti-cache: avant tout verdict positif on applique le PLAFOND DE
    PLAUSIBILITE (debit/latence) puis la verification du NONCE. Un echec sur
    l'un des deux donne life_state="suspect", ok=False, et la raison est
    journalisee pour audit.
    """
    text = (content or "").strip() or (reasoning or "").strip()
    answer = " ".join(text.split())[:300]
    if not text:
        return ("rouge", False, "aucune reponse textuelle (0 caractere)", "")

    tag = "%s/%s" % (provider or "?", model or "?")

    # --- 1. Plafond de plausibilite (debit / latence) ----------------------
    try:
        tps = float(tokens_per_sec) if tokens_per_sec is not None else None
    except (TypeError, ValueError):
        tps = None
    try:
        lat = float(latency_ms) if latency_ms is not None else None
    except (TypeError, ValueError):
        lat = None

    if tps is not None and tps > _CACHE_MAX_TOKS:
        reason = ("suspect: cache probable — debit %.1f tok/s > plafond %.0f"
                  % (tps, _CACHE_MAX_TOKS))
        logging.warning("[scan-cache] %s REJET vert: %s", tag, reason)
        return ("suspect", False, reason, answer)

    if lat is not None and lat < _CACHE_MIN_LATENCY_MS:
        reason = ("suspect: cache probable — latence %.1f ms < plancher %.0f ms"
                  % (lat, _CACHE_MIN_LATENCY_MS))
        logging.warning("[scan-cache] %s REJET vert: %s", tag, reason)
        return ("suspect", False, reason, answer)

    # --- 2. Verification du nonce -----------------------------------------
    if nonce:
        if _life_normalize(nonce) not in _life_normalize(text):
            reason = ("suspect: nonce %s absent de la reponse "
                      "(reponse generique/cache)" % nonce)
            logging.warning("[scan-cache] %s REJET vert: %s | recu=%r",
                            tag, reason, answer[:120])
            return ("suspect", False, reason, answer)

    if _life_has_greeting(text):
        # ETAT 'TIME' prioritaire : meme avec salutation, un modele qui met
        # >30s a repondre est TROP LENT -> time (orange), jamais vert.
        # (corrige l'ancien ordre ou la salutation masquait le seuil TIME)
        if lat is not None and lat > 30000:
            reason = ("trop lent (latence %.0f ms > 30000) — modele repond mais lent"
                      % lat)
            logging.warning("[scan-time] %s ETAT 'time': %s", tag, reason)
            return ("time", True, reason, answer)
        return ("vert", True, "salutation detectee (nonce verifie)", answer)
    # 2026-08-12 - ETAT 'TIME' : le modele REPOND (HTTP 200, nonce verifie)
    # mais met plus de 30s a repondre -> etat 'time' (trop lent), ni vert ni
    # rouge, et SURTOUT jamais blackliste. On applique l'etat apres les
    # verifications de cache (qui auraient deja renvoye 'suspect' sinon).
    if lat is not None and lat > 30000:
        reason = ("trop lent (latence %.0f ms > 30000) — modele repond mais lent"
                  % lat)
        logging.warning("[scan-time] %s ETAT 'time': %s", tag, reason)
        return ("time", True, reason, answer)
    return ("orange", True, "reponse sans salutation (nonce verifie)", answer)

# POINT 4 (2026-08-01, DEVELOPPEUR) — FAUX KO "403 forbidden".
# Cause reelle mesuree: urllib envoie par defaut "Python-urllib/3.13" comme
# User-Agent. Le WAF Cloudflare devant inference-api.nousresearch.com le
# bloque avec "error code: 1010" en HTTP 403 -> le scan marquait ROUGE des
# modeles parfaitement vivants (ex: tencent/hy3:free, utilise en production
# par la flotte). Verifie: meme requete, meme cle, seul l'User-Agent change
# -> 200 OK avec une vraie completion.
# Fix: tous les probes HTTP du scan envoient un User-Agent explicite (et
# Accept: application/json). Aucun vrai KO n'est masque: un modele mort,
# hors quota ou sans droits renvoie toujours son 401/403/429 metier.
_SCAN_USER_AGENT = "hermes-mission-control/1.0 (+scan)"


def _scan_http_headers(api_key: str) -> dict:
    """Common headers for every scan probe (see _SCAN_USER_AGENT note)."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": _SCAN_USER_AGENT,
        "Authorization": "Bearer %s" % (api_key or "x"),
    }
    # OpenRouter EXIGE l'en-tete HTTP-Referer (et accepte X-Title) pour
    # authentifier la requete; sans eux il repond 401 pour TOUTE cle.
    # Auto-detecte: les cles OpenRouter commencent TOUJOURS par "sk-or-".
    # Le prefixe n'existe que pour OpenRouter -> n'affecte aucun autre provider.
    if api_key and str(api_key).startswith("sk-or-"):
        headers["HTTP-Referer"] = "http://192.168.1.240"
        headers["X-Title"] = "Hermes Mission Control"
    return headers


def _scan_reason_from_error(text: str) -> str:
    """Normalise an error blob into a short human reason for the UI."""
    t = (text or "").lower()
    if "quota" in t:
        return "quota exceeded"
    if "insufficient" in t and "credit" in t:
        return "insufficient credits"
    if "credit" in t:
        return "credits required"
    if "401" in t or "unauthorized" in t or "invalid api key" in t:
        return "401 unauthorized"
    if "403" in t or "forbidden" in t:
        return "403 forbidden"
    if "404" in t or "not found" in t:
        return "404 not found"
    if "timeout" in t or "timed out" in t:
        return "timeout"
    if "empty content" in t or "no reply" in t:
        return "empty content"
    if "rate limit" in t or "429" in t:
        return "rate limited (429)"
    if "connection" in t or "refused" in t or "resolve" in t:
        return "connection error"
    # Fallback: first line, truncated.
    first = (text or "").strip().splitlines()
    first = [l for l in first if l.strip()]
    if first:
        return first[0][:120]
    return "unknown error"


def _probe_lmstudio(model: str) -> dict:
    """Real OpenAI-compatible call to LM Studio for one model.

    LM Studio serves ONE loaded model at a time, so this is always called
    SEQUENTIALLY by the scanner (concurrent probes against other models
    return HTTP 500). Reasoning models (e.g. nemotron-3-nano) burn the
    whole token budget in `reasoning_content` and leave `content` empty,
    so we also accept a non-empty `reasoning_content` as proof of life.
    """
    _load_hermes_dotenv()
    base = (os.environ.get("LM_BASE_URL") or "").strip().rstrip("/")
    if not base:
        return {"ok": False, "reason": "LM_BASE_URL non configure"}
    key = os.environ.get("LM_API_KEY") or "lm-studio"
    nonce = _life_make_nonce()
    prompt = _life_prompt_with_nonce(nonce)
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        # test de vie "mixte" (voir _LIFE_MAX_TOKENS)
        "max_tokens": _LIFE_MAX_TOKENS,
        "temperature": 0.0,
    }).encode("utf-8")
    req = urllib.request.Request(
        base + "/v1/chat/completions",
        data=payload,
        headers=_scan_http_headers(key),   # POINT 4 (UA explicite)
        method="POST",
    )
    t0 = time.time()
    _hard_abort = {"sock": None, "fired": False}
    def _abort():
        # Force la fermeture du socket si le modele depasse _LIFE_TIMEOUT
        # (urllib ne coupe pas si le socket reste actif / envoie par petits bouts).
        s = _hard_abort["sock"]
        if s is not None:
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass
        _hard_abort["fired"] = True
    import threading
    _timer = threading.Timer(_LIFE_TIMEOUT, _abort)
    _timer.daemon = True
    _timer.start()
    try:
        with urllib.request.urlopen(req, timeout=_LIFE_TIMEOUT) as resp:
            _hard_abort["sock"] = getattr(resp, "fp", None)
            if _hard_abort["sock"] is not None:
                _hard_abort["sock"] = getattr(_hard_abort["sock"], "raw", _hard_abort["sock"])
            body = resp.read().decode("utf-8", "replace")
        t1 = time.time()
        latency_ms = round((t1 - t0) * 1000, 1)
        # Si le timer a deja coupe le socket -> on n'arrive jamais ici (exception),
        # mais on garde une garde : plafonne la latence rapportee a _LIFE_TIMEOUT.
        if _hard_abort["fired"] and latency_ms > _LIFE_TIMEOUT * 1000:
            latency_ms = round(_LIFE_TIMEOUT * 1000, 1)
        data = json.loads(body)
        content = ""
        reasoning = ""
        try:
            msg = data["choices"][0]["message"]
            content = msg.get("content") or ""
            reasoning = msg.get("reasoning_content") or ""
        except Exception:  # noqa: BLE001
            content = ""
        # Token estimation (chars / 4), or real usage if LM Studio reports it.
        tok_in = len(prompt) // 4
        tok_out = len(content or "") // 4
        try:
            usage_total = (data.get("usage") or {}).get("total_tokens")
        except Exception:  # noqa: BLE001
            usage_total = None
        tok_total = usage_total if usage_total else (tok_in + tok_out)
        duration = t1 - t0
        tokens_per_sec = round(tok_total / duration, 1) if duration > 0 else 0
        life_state, ok, reason, answer = _life_verdict(
            content, reasoning, nonce=nonce, latency_ms=latency_ms,
            tokens_per_sec=tokens_per_sec, provider="lmstudio", model=model)
        if life_state == "suspect":
            # Aucun score enregistre pour une reponse suspecte de cache.
            return {"ok": False, "reason": reason,
                    "life_state": "suspect", "life_answer": answer,
                    "latency_ms": None, "tokens_per_sec": None}
        return {"ok": ok, "reason": reason,
                "life_state": life_state, "life_answer": answer,
                "latency_ms": latency_ms,
                "tokens_per_sec": tokens_per_sec}
    except urllib.error.HTTPError as exc:
        t1 = time.time()
        latency_ms = round((t1 - t0) * 1000, 1)
        try:
            detail = exc.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            detail = str(exc)
        reason = _scan_reason_from_error("HTTP %d: %s" % (exc.code, detail))
        # 5xx / timeout-like errors = server instable/trop lent -> TIME (jamais blacklist)
        # 4xx (auth, not found, rate limit) = KO -> ROUGE (blacklistable)
        # 2026-08-24 - DEVELOPPEUR : "credits required" / "insufficient credits" /
        # "quota exceeded" ne sont PAS des modeles morts — c'est un probleme de
        # COMPTE (cle MC sans credit, alors que le modele repond ailleurs).
        # On les traite comme 'time' (orange, a verifier) et NON comme ROUGE/KO
        # pour eviter les faux negatifs (ex: nemotron-3-ultra-550b discute
        # par ailleurs mais scanne KO car le compte MC OpenRouter est a sec).
        _acct_problem = any(k in reason.lower() for k in
                            ("credit", "quota", "insufficient", "credits required"))
        if 500 <= getattr(exc, "code", 0) < 600:
            return {"ok": True, "reason": reason,
                    "life_state": "time", "life_answer": "",
                    "latency_ms": latency_ms, "tokens_per_sec": 0}
        if _acct_problem:
            # Compte sans credit -> orange "a verifier", jamais ROUGE/KO.
            return {"ok": True, "reason": reason,
                    "life_state": "time", "life_answer": "",
                    "latency_ms": latency_ms, "tokens_per_sec": 0}
        return {"ok": False, "reason": reason,
                "life_state": "rouge", "life_answer": "",
                "latency_ms": latency_ms, "tokens_per_sec": 0}
    except Exception as exc:  # noqa: BLE001
        t1 = time.time()
        latency_ms = round((t1 - t0) * 1000, 1)
        # Timeout socket (modele trop lent) -> etat 'time' (orange), jamais rouge/KO.
        if "timed out" in str(exc).lower() or "timeout" in str(exc).lower():
            return {"ok": True, "reason": _scan_reason_from_error(str(exc)),
                    "life_state": "time", "life_answer": "",
                    "latency_ms": latency_ms, "tokens_per_sec": 0}
        return {"ok": False, "reason": _scan_reason_from_error(str(exc)),
                "life_state": "rouge", "life_answer": "",
                "latency_ms": latency_ms, "tokens_per_sec": 0}


def _provider_base_url(provider: str):
    """Resolve the OpenAI-compatible base_url + api_key for a provider.

    Priority:
      1. $<NAME>_BASE_URL (e.g. OMNIROUTE_BASE_URL) in ~/.hermes/.env
      2. the matching ``custom_providers`` entry in config.yaml
    Returns (base_url, api_key) or (None, None) when unknown.
    """
    prov = (provider or "").strip().lower()
    if not prov:
        return None, None
    _load_hermes_dotenv()
    # --- lmstudio: local LM Studio server (OpenAI-compatible on :1234) ---
    # piloubruce's .env exposes LM_BASE_URL (and LM_API_KEY); older setups may
    # still use LMSTUDIO_BASE_URL / LMSTUDIO_API_KEY. Read LM_BASE_URL first
    # with LMSTUDIO_BASE_URL as fallback so the scan can actually probe the
    # local server instead of returning (None, None) and marking every model
    # vision/reasoning/tools=False.
    if prov == "lmstudio":
        bu = (os.environ.get("LM_BASE_URL")
              or os.environ.get("LMSTUDIO_BASE_URL") or "").strip()
        if bu:
            key = (os.environ.get("LM_API_KEY")
                   or os.environ.get("LMSTUDIO_API_KEY") or "").strip()
            return bu.rstrip("/"), key
        # fall through to native resolution below
    env_base = "%s_BASE_URL" % prov.upper()
    bu = (os.environ.get(env_base) or "").strip()
    if bu:
        key = (os.environ.get("%s_API_KEY" % prov.upper()) or "").strip()
        return bu.rstrip("/"), key
    custom = _read_custom_providers()
    if prov in custom:
        cp = custom[prov]
        return (cp.get("base_url") or "").rstrip("/") or None, cp.get("api_key", "") or ""
    # Also resolve from the top-level `providers:` section of config.yaml
    # (e.g. OMNI-ROUTE declared with `api:` + `key_env:`). Same source the
    # model catalog reads (section #5), so a provider configured there is
    # scannable too. Read config.yaml directly (yaml.safe_load) to avoid
    # relying on mc_backend.load_config() caching/empty results.
    try:
        import yaml
        _cfg_path = os.path.join(HERMES_HOME, "config.yaml")
        if os.path.exists(_cfg_path):
            with open(_cfg_path, "r") as _fh:
                _cfg = yaml.safe_load(_fh) or {}
            _providers = _cfg.get("providers") or {}
            _entry = _providers.get(prov) or _providers.get(prov.upper())
            if isinstance(_entry, dict):
                _api = (_entry.get("api") or "").strip()
                if _api:
                    _key_env = _entry.get("key_env") or ""
                    _key = (os.environ.get(_key_env) or "").strip() if _key_env else ""
                    return _api.rstrip("/"), _key
    except Exception:  # noqa: BLE001
        pass
    # Native / built-in providers (e.g. 'nous'): resolve base_url from the
    # Hermes config + api_key from auth.json so we can probe them DIRECTLY
    # (via _probe_api) instead of shelling out to `hermes chat`, which would
    # otherwise create a polluting session in the global history.
    nb, nk = _native_provider_base_url(prov)
    if nb:
        return nb.rstrip("/"), nk
    return None, None


def _native_provider_base_url(provider: str):
    """Resolve (base_url, api_key) for a KNOWN native Hermes provider.

    Built-in cloud providers are mapped to their OpenAI-compatible base_url so
    the scan can probe them DIRECTLY via ``_probe_api`` (a plain HTTP
    ``/v1/chat/completions`` call that NEVER spawns a Hermes session in the
    global history). This is the core fix for scan-history pollution: every
    resolvable provider now goes through the session-free direct probe.

    Known providers (OpenAI-compatible):
      - nous        -> inference-api.nousresearch.com/v1  (NOUS_API_KEY / auth.json)
      - openrouter  -> openrouter.ai/api/v1              (OPENROUTER_API_KEY)
      - openai-api  -> api.openai.com/v1                 (OPENAI_API_KEY)
      - google/gemini -> generativelanguage.googleapis.com/v1beta/openai (GOOGLE_API_KEY)
      - deepseek    -> api.deepseek.com/v1               (DEEPSEEK_API_KEY)
      - groq        -> api.groq.com/openai/v1            (GROQ_API_KEY)
      - mistral     -> api.mistral.ai/v1                 (MISTRAL_API_KEY)
      - ollama      -> localhost:11434/v1                (no key, local)

    anthropic is intentionally UNRESOLVED: it is not OpenAI-compatible
    (it exposes /v1/messages). Rather than emit a misleading 404 from
    ``_probe_api`` or shell out to ``hermes chat`` (which would pollute the
    history), we return (None, None) so the scan marks it as a clean RED
    ("provider non scannable directement"). It can be added later with a
    dedicated /v1/messages probe if desired.

    Returns (base_url, api_key) or (None, None) when not a known native
    provider (or known-but-not-directly-scannable like anthropic).
    """
    prov = (provider or "").strip().lower()

    # --- anthropic: not OpenAI-compatible -> leave unresolved (clean red) ---
    if prov == "anthropic":
        return None, None

    # --- lmstudio: local LM Studio server (OpenAI-compatible on :1234) ---
    # Mirrors the logic in _provider_base_url: read LM_BASE_URL first with
    # LMSTUDIO_BASE_URL as fallback. This keeps native resolution consistent
    # so the scan can probe the local server directly instead of (None, None).
    if prov == "lmstudio":
        bu = (os.environ.get("LM_BASE_URL")
              or os.environ.get("LMSTUDIO_BASE_URL") or "").strip()
        if bu:
            key = (os.environ.get("LM_API_KEY")
                   or os.environ.get("LMSTUDIO_API_KEY") or "").strip()
            return bu.rstrip("/"), key
        return None, None

    # --- nous: built-in cloud provider (base_url from config.yaml or fallback) ---
    if prov == "nous":
        base = ""
        try:
            path = os.path.join(HERMES_HOME, "config.yaml")
            with open(path, "r", encoding="utf-8") as fh:
                cfg = yaml.safe_load(fh) or {}
            base = (((cfg.get("model") or {}).get("base_url")) or "").strip()
        except Exception:  # noqa: BLE001
            base = ""
        if not base:
            base = "https://inference-api.nousresearch.com/v1"
        key = (os.environ.get("NOUS_API_KEY") or "").strip()
        if not key:
            try:
                apath = os.path.join(HERMES_HOME, "auth.json")
                with open(apath, "r", encoding="utf-8") as fh:
                    auth = json.load(fh) or {}
                np = ((auth.get("providers") or {}).get("nous") or {})
                key = (np.get("agent_key") or np.get("access_token") or "").strip()
            except Exception:  # noqa: BLE001
                key = ""
        return base.rstrip("/"), key

    # --- nvidia: NVIDIA NIM (integrate.nvidia.com, OpenAI-compatible /v1) ---
    # The key lives in auth.json credential_pool.nvidia[0].access_token (NOT
    # in providers — nvidia is only present in credential_pool). Fall back to
    # the NVIDIA_API_KEY env var if the auth.json entry is missing.
    if prov == "nvidia":
        base = "https://integrate.api.nvidia.com/v1"
        key = (os.environ.get("NVIDIA_API_KEY") or "").strip()
        if not key:
            try:
                apath = os.path.join(HERMES_HOME, "auth.json")
                with open(apath, "r", encoding="utf-8") as fh:
                    auth = json.load(fh) or {}
                cp = ((auth.get("credential_pool") or {}).get("nvidia") or [])
                nv = cp[0] if cp else {}
                key = (nv.get("access_token") or "").strip()
            except Exception:  # noqa: BLE001
                key = ""
        return base.rstrip("/"), key

    # --- generic OpenAI-compatible native cloud providers ---
    NATIVE = {
        "openrouter": ("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
        "openai-api": ("https://api.openai.com/v1", "OPENAI_API_KEY"),
        "google":     ("https://generativelanguage.googleapis.com/v1beta/openai", "GOOGLE_API_KEY"),
        "gemini":     ("https://generativelanguage.googleapis.com/v1beta/openai", "GOOGLE_API_KEY"),
        "deepseek":   ("https://api.deepseek.com/v1", "DEEPSEEK_API_KEY"),
        "groq":       ("https://api.groq.com/openai/v1", "GROQ_API_KEY"),
        "mistral":    ("https://api.mistral.ai/v1", "MISTRAL_API_KEY"),
        "ollama":     ("http://localhost:11434/v1", ""),
    }
    if prov not in NATIVE:
        return None, None
    base, env_key = NATIVE[prov]
    key = (os.environ.get(env_key) or "").strip()
    if not key and env_key:
        # best-effort fallback: look the key up in auth.json providers.<prov>
        try:
            apath = os.path.join(HERMES_HOME, "auth.json")
            with open(apath, "r", encoding="utf-8") as fh:
                auth = json.load(fh) or {}
            npd = ((auth.get("providers") or {}).get(prov) or {})
            key = (npd.get("agent_key") or npd.get("access_token")
                   or npd.get("api_key") or "").strip()
        except Exception:  # noqa: BLE001
            key = ""
    return base.rstrip("/"), key


def _probe_api(base_url: str, model: str, api_key: str = None,
               provider: str = None) -> dict:
    """Real OpenAI-compatible call to ANY /v1/chat/completions endpoint.

    This does NOT shell out to ``hermes chat`` — it never creates a Hermes
    session in the global history. This is the single, session-free probe path
    used for every resolvable provider (custom providers, built-in cloud
    providers like nous/openrouter/openai/groq/..., and LM Studio on LAN) that
    we can reach directly with a known base_url.
    """
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return {"ok": False, "reason": "base_url non configure"}
    key = api_key or "x"  # bearer still required by most gateways; harmless
    # Build the chat/completions endpoint without doubling the version
    # segment. Handles three shapes of base_url:
    #   - .../v1            -> .../v1/chat/completions
    #   - .../openai        -> .../openai/chat/completions  (Google Gemini)
    #   - <anything else>   -> <base>/v1/chat/completions
    if base.endswith("/chat/completions"):
        endpoint = base
    elif base.endswith("/v1") or base.endswith("/openai"):
        endpoint = base + "/chat/completions"
    else:
        endpoint = base + "/v1/chat/completions"
    nonce = _life_make_nonce()
    prompt = _life_prompt_with_nonce(nonce)
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        # test de vie "mixte": budget large, les modeles a raisonnement
        # epuisaient 50 tokens avant d'ecrire le moindre caractere.
        "max_tokens": _LIFE_MAX_TOKENS,
        "temperature": 0.0,
        # Force a NON-streamed JSON response so we can parse it directly
        # (gateways like OmniRoute default to SSE streaming otherwise).
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=payload,
        # POINT 4: User-Agent explicite obligatoire (WAF Cloudflare -> 403/1010
        # sur le defaut "Python-urllib"). Voir _SCAN_USER_AGENT.
        headers=_scan_http_headers(key),
        method="POST",
    )
    t0 = time.time()
    _hard_abort = {"sock": None, "fired": False}
    def _abort():
        # Force la fermeture du socket si le modele depasse _LIFE_TIMEOUT
        # (urllib ne coupe pas si le socket reste actif / envoie par petits bouts).
        s = _hard_abort["sock"]
        if s is not None:
            try:
                s.close()
            except Exception:  # noqa: BLE001
                pass
        _hard_abort["fired"] = True
    import threading
    _timer = threading.Timer(_LIFE_TIMEOUT, _abort)
    _timer.daemon = True
    _timer.start()
    try:
        with urllib.request.urlopen(req, timeout=_LIFE_TIMEOUT) as resp:
            _hard_abort["sock"] = getattr(resp, "fp", None)
            if _hard_abort["sock"] is not None:
                _hard_abort["sock"] = getattr(_hard_abort["sock"], "raw", _hard_abort["sock"])
            body = resp.read().decode("utf-8", "replace")
        t1 = time.time()
        latency_ms = round((t1 - t0) * 1000, 1)
        # Si le timer a deja coupe le socket -> on n'arrive jamais ici (exception),
        # mais on garde une garde : plafonne la latence rapportee a _LIFE_TIMEOUT.
        if _hard_abort["fired"] and latency_ms > _LIFE_TIMEOUT * 1000:
            latency_ms = round(_LIFE_TIMEOUT * 1000, 1)
        data = json.loads(body)
        content = ""
        reasoning = ""
        try:
            msg = data["choices"][0]["message"]
            content = msg.get("content") or ""
            reasoning = msg.get("reasoning_content") or ""
        except Exception:  # noqa: BLE001
            content = ""
        # Token estimation (chars / 4), or real usage if the gateway reports it.
        tok_in = len(prompt) // 4
        tok_out = len(content or "") // 4
        try:
            usage_total = (data.get("usage") or {}).get("total_tokens")
        except Exception:  # noqa: BLE001
            usage_total = None
        tok_total = usage_total if usage_total else (tok_in + tok_out)
        duration = t1 - t0
        tokens_per_sec = round(tok_total / duration, 1) if duration > 0 else 0
        # VERDICT A 3 ETATS. Des tokens consommes SANS texte = ROUGE (fin du
        # faux positif: l'ancien proof_of_life acceptait tok_out/usage seuls).
        life_state, ok, reason, answer = _life_verdict(
            content, reasoning, nonce=nonce, latency_ms=latency_ms,
            tokens_per_sec=tokens_per_sec, provider=provider, model=model)
        if life_state == "suspect":
            # PHASE 1: reponse en cache -> pas de vert, et AUCUN score
            # enregistre (latence/debit fictifs ecartes de la base).
            return {"ok": False, "reason": reason,
                    "life_state": "suspect", "life_answer": answer,
                    "latency_ms": None, "tokens_per_sec": None}
        return {"ok": ok, "reason": reason,
                "life_state": life_state,
                "life_answer": answer,
                "latency_ms": latency_ms,
                "tokens_per_sec": tokens_per_sec}
    except urllib.error.HTTPError as exc:
        t1 = time.time()
        latency_ms = round((t1 - t0) * 1000, 1)
        try:
            detail = exc.read().decode("utf-8", "replace")
        except Exception:  # noqa: BLE001
            detail = str(exc)
        reason = _scan_reason_from_error("HTTP %d: %s" % (exc.code, detail))
        # 5xx / timeout-like errors = server instable/trop lent -> TIME (jamais blacklist)
        # 4xx (auth, not found, rate limit) = KO -> ROUGE (blacklistable)
        # 2026-08-24 - DEVELOPPEUR : "credits required" / "insufficient credits" /
        # "quota exceeded" ne sont PAS des modeles morts — c'est un probleme de
        # COMPTE (cle MC sans credit, alors que le modele repond ailleurs).
        # On les traite comme 'time' (orange, a verifier) et NON comme ROUGE/KO
        # pour eviter les faux negatifs (ex: nemotron-3-ultra-550b discute
        # par ailleurs mais scanne KO car le compte MC OpenRouter est a sec).
        _acct_problem = any(k in reason.lower() for k in
                            ("credit", "quota", "insufficient", "credits required"))
        if 500 <= getattr(exc, "code", 0) < 600:
            return {"ok": True, "reason": reason,
                    "life_state": "time", "life_answer": "",
                    "latency_ms": latency_ms, "tokens_per_sec": 0}
        if _acct_problem:
            # Compte sans credit -> orange "a verifier", jamais ROUGE/KO.
            return {"ok": True, "reason": reason,
                    "life_state": "time", "life_answer": "",
                    "latency_ms": latency_ms, "tokens_per_sec": 0}
        return {"ok": False, "reason": reason,
                "life_state": "rouge", "life_answer": "",
                "latency_ms": latency_ms, "tokens_per_sec": 0}
    except Exception as exc:  # noqa: BLE001
        t1 = time.time()
        latency_ms = round((t1 - t0) * 1000, 1)
        # Timeout socket (modele trop lent) -> etat 'time' (orange), jamais rouge/KO.
        if "timed out" in str(exc).lower() or "timeout" in str(exc).lower():
            return {"ok": True, "reason": _scan_reason_from_error(str(exc)),
                    "life_state": "time", "life_answer": "",
                    "latency_ms": latency_ms, "tokens_per_sec": 0}
        return {"ok": False, "reason": _scan_reason_from_error(str(exc)),
                "life_state": "rouge", "life_answer": "",
                "latency_ms": latency_ms, "tokens_per_sec": 0}



def _looks_like_modality_error(text: str) -> bool:
    """Heuristique: le content semble-t-il etre un message d'erreur de modality
    (image non supportee, etc.) plutot qu'une vraie description ? Sert a ne pas
    valider a tort la vision quand le modele repond 200 avec un refus explicite."""
    if not text:
        return False
    low = text.lower()
    markers = (
        "modality", "unsupported", "not supported", "cannot process",
        "can't process", "unable to process", "image input", "not support",
        "does not support", "n'est pas support", "impossible de traiter",
        "je ne peux pas", "i cannot", "i can't", "sorry",
    )
    return any(k in low for k in markers)


# Modeles de raisonnement connus (liste blanche). Sert de PREUVE de
# raisonnement quand l'API ne renvoie pas de champ reasoning_content separe
# (certains routeurs l'inlinent dans le content). Pas de faux positifs: ces
# familles raisonnent reellement. On reste conservateur (false par defaut +
# preuve pour true).
REASONING_MODEL_PATTERNS = (
    "deepseek-r1", "deepseek-reasoner", "deepseek-ai/deepseek-r1",
    "qwq", "qwen-qwq", "qwq-32b", "qwq-35b",
    "nemotron", "nemotron-3", "nemotron-3-nano", "nemotron-ultra",
    "o1", "o1-mini", "o1-preview", "o3", "o3-mini", "o4-mini",
    "claude-3-7-sonnet", "claude-3.7-sonnet",
    "qwen3", "glm-z1", "skywork", "hunyuan-thinking", "seed-thinking",
)


def _is_known_reasoning_model(model: str) -> bool:
    """Vrai si le modele appartient a une famille de raisonnement connue.
    Match insensible a la casse et tolerant (contient l'un des motifs)."""
    if not model:
        return False
    m = model.lower()
    return any(pat in m for pat in REASONING_MODEL_PATTERNS)


def _detect_reasoning(content: str) -> bool:
    """Detecte un bloc de raisonnement EXPLICITE (natif) dans la reponse:
    uniquement un bloc <think:6124c78e>...</think:6124c78e> ou <reasoning>...</reasoning>.
    On ne se fie PLUS au contenu textuel (mots-cles 'donc'/'etape' ou etapes
    numerotees) car cela produisait des faux positifs sur de simples reponses
    structurees. Preuve requise = bloc de reasoning natif explicite."""
    if not content:
        return False
    text = content.strip()
    if re.search(r"<\s*think\s*>.+?<\s*/\s*think\s*>", text, re.IGNORECASE | re.DOTALL):
        return True
    if re.search(r"<\s*reasoning\s*>.+?<\s*/\s*reasoning\s*>", text, re.IGNORECASE | re.DOTALL):
        return True
    return False


def _norm_probe_text(text: str) -> str:
    """Normalise un texte pour la sonde tools: minuscules, accents retires,
    espaces compresses. Permet d'accepter 'test valide' comme 'test valid\u00e9'."""
    import unicodedata
    t = unicodedata.normalize("NFD", text or "")
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", t).strip().lower()


# 2026-08-12 - ETAT 'TIME' (modele trop lent) : le timeout passe de 120s a 30s.
# Une sonde qui depasse 30s est desormais 'TIME' (trop lent) et NON plus un KO
# aveugle. Vision: 1 appel max 30s. Raisonnement: 3 items x 30s. Tools: 2 tours
# x 30s. Le test 'all' reste theoriquement ~150s mais s'arrete au 1er timeout.
_PROBE_TIMEOUT = 30.0  # secondes par sonde de capacite (3 sondes sequentielles)

# ---------------------------------------------------------------------------
# Sonde VISION: image de test reelle (remplace l'ancien PNG 1x1 qui rendait la
# sonde ininterpretable -> les modeles honnetes echouaient, les bavards
# passaient). L'image contient un personnage a CAPE ROUGE + le texte
# "Hermes Agent". La validation est OBJECTIVE: le modele doit restituer le
# texte lu ET la couleur de la cape.
# ---------------------------------------------------------------------------
VISION_PROBE_IMAGE_PATH = os.path.expanduser("~/mc-assets/vision_probe.jpg")
_VISION_PROBE_DATA_URL = None

VISION_PROBE_PROMPT = (
    "Regarde cette image et reponds en 2 lignes, sans commentaire:\n"
    "1) TEXTE: recopie exactement le texte ecrit dans l'image.\n"
    "2) CAPE: donne la couleur de la cape du personnage (un seul mot).\n"
    "Si tu ne vois pas l'image, reponds uniquement: AUCUNE IMAGE."
)


def _vision_probe_data_url() -> str:
    """Charge (et met en cache) l'image de sonde vision en data URL base64.
    Retourne None si le fichier est absent/illisible."""
    global _VISION_PROBE_DATA_URL
    if _VISION_PROBE_DATA_URL is not None:
        return _VISION_PROBE_DATA_URL or None
    try:
        with open(VISION_PROBE_IMAGE_PATH, "rb") as fh:
            raw = fh.read()
        if not raw:
            _VISION_PROBE_DATA_URL = ""
            return None
        _VISION_PROBE_DATA_URL = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
    except Exception:
        _VISION_PROBE_DATA_URL = ""
        return None
    return _VISION_PROBE_DATA_URL


_VISION_RED_WORDS = ("rouge", "red", "rouges", "carmin", "ecarlate", "écarlate", "crimson", "scarlet", "rojo", "rot")


def _vision_normalize(text: str) -> str:
    """Minuscules + accents aplatis, pour un matching robuste."""
    if not text:
        return ""
    try:
        t = unicodedata.normalize("NFKD", text)
        t = "".join(c for c in t if not unicodedata.combining(c))
    except Exception:
        t = text
    return t.lower()


def _vision_validate_answer(text: str) -> tuple:
    """Validation OBJECTIVE et non bavarde de la reponse de la sonde vision.
    VERT uniquement si la reponse contient 'hermes' ET 'agent' ET une mention
    de la couleur rouge. Retourne (ok: bool, reason: str)."""
    if not text or not text.strip():
        return False, "reponse vide"
    low = _vision_normalize(text)
    if "aucune image" in low:
        return False, "le modele declare ne pas voir l'image"
    if _looks_like_modality_error(text):
        return False, "refus/erreur de modality (image non traitee)"
    has_hermes = "hermes" in low
    has_agent = "agent" in low
    has_red = any(w in low for w in _VISION_RED_WORDS)
    missing = []
    if not has_hermes:
        missing.append("texte 'hermes'")
    if not has_agent:
        missing.append("texte 'agent'")
    if not has_red:
        missing.append("couleur cape 'rouge'")
    if missing:
        return False, "manquant: " + ", ".join(missing)
    return True, "texte 'Hermes Agent' lu + cape rouge identifiee"
# 30s produisait des FAUX NEGATIFS sur modeles lents (deepseek-v4-pro & co):
# la sonde timeoutait puis passait au re-test. 120s par sonde => cap='all'
# peut durer jusqu'a ~480s (vision + reasoning N items + tools tour1 + tour2).
# La chaine doit suivre: front AbortSignal >= 600s (dashboard/src/api.ts).


# ---------------------------------------------------------------------------
# Sonde REASONING v2 : on valide la JUSTESSE de la reponse, pas le FORMAT.
# Chaque item est un piege classique qui echoue si le modele ne raisonne pas.
# La reponse finale doit tenir sur une derniere ligne "REPONSE: <valeur>".
# ---------------------------------------------------------------------------
_REASONING_ITEMS = (
    {
        "id": "arith",
        "prompt": (
            "Probleme: un panier contient 3 boites. Chaque boite contient 4 sachets, "
            "et chaque sachet contient 5 bonbons. On retire 7 bonbons du panier. "
            "Combien reste-t-il de bonbons au total ?\n"
            "Reflechis etape par etape, puis termine ta reponse par une DERNIERE LIGNE "
            "exactement au format:\nREPONSE: <nombre>"
        ),
        # 3*4*5 = 60 ; 60-7 = 53
        "expected": ("53",),
    },
    {
        "id": "compare",
        "prompt": (
            "Question: quel nombre est le plus grand, 9.11 ou 9.9 ?\n"
            "Reflechis, puis termine ta reponse par une DERNIERE LIGNE exactement "
            "au format:\nREPONSE: <le nombre le plus grand>"
        ),
        "expected": ("9.9", "9,9", "9.90"),
        # Pas de repli plein-texte : l'enonce lui-meme contient "9.9", un modele
        # qui se contente de reformuler la question passerait a tort.
        "fallback": False,
    },
    {
        "id": "logique",
        "prompt": (
            "Enigme: Paul est plus grand que Marie. Marie est plus grande que Luc. "
            "Luc est plus grand que Sarah. Qui est la personne la plus petite ?\n"
            "Reflechis, puis termine ta reponse par une DERNIERE LIGNE exactement "
            "au format:\nREPONSE: <prenom>"
        ),
        "expected": ("sarah",),
        # Idem: "Sarah" figure dans l'enonce -> repli restreint a la fin.
        "fallback": False,
    },
)

# Seuil de validation : 2 items justes sur 3.
# Justification : 3/3 penalise injustement un bon modele sur un seul item
#   (formatage rate, troncature, aleas d'un routeur) alors que 1/3 se laisse
#   atteindre par hasard (le piege 9.11/9.9 est un binaire devinable, et un
#   modele non raisonnant peut tomber juste sur la deduction logique).
#   2/3 exige au moins un succes non devinable et tolere un aleas isole.
_REASONING_MIN_SCORE = 2


def _reasoning_extract_answer(text: str) -> str:
    """Extrait la valeur apres le dernier 'REPONSE:' du texte (tolerant aux
    accents, gras markdown, deux-points optionnels). Retourne '' si absent."""
    if not text:
        return ""
    norm = _norm_probe_text(text)
    matches = re.findall(r"reponse\s*[:=]?\s*([^\n]*)", norm)
    if not matches:
        return ""
    val = matches[-1].strip()
    # nettoyage: gras/backticks/ponctuation finale
    val = val.strip("*`_ \t.\u00a0")
    return val.strip()


def _reasoning_check_item(item: dict, text: str):
    """Retourne (ok, valeur_recue). Cherche d'abord la valeur de la ligne
    'REPONSE:', sinon en repli dans le texte (integral, ou seulement la fin
    quand l'attendu figure deja dans l'enonce -> item['fallback'] = False)."""
    if not text:
        return False, ""
    answer = _reasoning_extract_answer(text)
    expected = tuple(_norm_probe_text(e) for e in item["expected"])

    def _hit(hay: str) -> bool:
        return any(
            hay == exp or re.search(r"(?<![\w.,])%s(?![\w.,])" % re.escape(exp), hay)
            for exp in expected
        )

    if answer and _hit(answer):
        return True, answer[:60]
    full = _norm_probe_text(text)
    if item.get("fallback", True):
        hay = full
    else:
        # L'attendu figure deja dans l'enonce -> repli restreint a la derniere
        # ligne non vide, et on ignore une ligne interrogative (simple echo de
        # la question), qui ne prouve rien.
        lines = [l.strip() for l in (text or "").splitlines() if l.strip()]
        last = _norm_probe_text(lines[-1]) if lines else ""
        hay = "" if (not last or last.endswith("?")) else last
    if hay and _hit(hay):
        return True, (answer or hay[-60:])
    return False, (answer or full[-60:])


def _probe_capabilities(base_url: str, model: str, api_key: str = None, cap: str = 'all') -> dict:
    """Sonde 3 capacites sequentiellement (vision, reasoning, tools) avec un
    timeout de _PROBE_TIMEOUT (120s) par sonde. Aucune sonde ne fait planter les autres: chaque
    bloc est enveloppe dans un try/except global et les exceptions sont
    capturees (la capacite concernee reste False, l'erreur est notee)."""
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return {"vision_supported": False, "reasoning_supported": False, "tools_supported": False, "error": "base_url non configure"}
    key = api_key or "x"
    endpoint = base + ("/chat/completions" if base.endswith("/v1") else "/v1/chat/completions")
    headers = _scan_http_headers(key)   # POINT 4 (UA explicite)

    def _post(payload: dict, timeout: float = _PROBE_TIMEOUT):
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(endpoint, data=data, headers=headers, method="POST")
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode("utf-8", "replace")
            return None, body, round((time.time()-t0)*1000, 1)
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", "replace")
            except Exception:
                detail = str(exc)
            return "HTTP %d: %s" % (exc.code, detail), None, round((time.time()-t0)*1000, 1)
        except Exception as exc:  # noqa: BLE001
            return str(exc), None, round((time.time()-t0)*1000, 1)

    vision = False
    vision_reason = None
    vision_answer = None
    vision_state = None  # 'ok' | 'ko' | 'time' (None = indetermine / reseau)
    reasoning = False
    reasoning_state = None  # 'ok' | 'ko' | 'time' (None = indetermine / reseau)
    tools = False
    tools_state = None  # 'ok' | 'ko' | 'time' (None = indetermine / reseau)
    tools_reason = None
    reasoning_reason = None
    error = None

    _do_vision = (cap == 'all' or cap == 'vision')
    _do_reasoning = (cap == 'all' or cap == 'reasoning')
    _do_tools = (cap == 'all' or cap == 'tools')

    # 1) vision probe: image de test REELLE (Hermes Agent, cape rouge) +
    #    validation objective (texte lu + couleur de la cape).
    if _do_vision:
        _img_url = _vision_probe_data_url()
        if not _img_url:
            vision = False
            vision_reason = "image de sonde introuvable: %s" % VISION_PROBE_IMAGE_PATH
        else:
            vision_payload = {
                "model": model,
                "messages": [{"role": "user", "content": [
                    {"type": "text", "text": VISION_PROBE_PROMPT},
                    {"type": "image_url", "image_url": {"url": _img_url}}
                ]}],
                "max_tokens": 200,
                "temperature": 0.0,
                "stream": False,
            }
            try:
                err, body, _ = _post(vision_payload, timeout=_PROBE_TIMEOUT)
                if err is None:
                    try:
                        data = json.loads(body or "{}")
                        msg = data.get("choices", [{}])[0].get("message", {})
                        content = (msg.get("content") or "").strip()
                        # Certains modeles placent la description dans
                        # reasoning_content et laissent content vide.
                        reasoning_field = (msg.get("reasoning_content") or "").strip()
                        _txt = content or reasoning_field
                        vision, vision_reason = _vision_validate_answer(_txt)
                        vision_answer = _txt[:400]
                        # Succes de sonde -> etat 'ok' (meme si vision=False :
                        # la sonde a abouti, elle a juste prouve l'absence de vision).
                        vision_state = 'ok' if vision else 'ko'
                    except Exception as _exc:
                        vision = False
                        vision_state = 'ko'
                        vision_reason = "reponse illisible: %s" % str(_exc)[:120]
                else:
                    low = (err or "").lower()
                    vision = False
                    if "timed out" in low or "timeout" in low:
                        # 2026-08-12 - ETAT 'TIME' : la sonde capacite a depasse
                        # _PROBE_TIMEOUT -> modele trop lent, PAS un KO aveugle.
                        vision_state = 'time'
                        vision_reason = "trop lent (timeout capacite %.0fs): %s" % (_PROBE_TIMEOUT, err[:120])
                    elif any(k in low for k in ["image", "modality", "unsupported"]):
                        vision_state = 'ko'
                        vision_reason = "image refusee par l'API: %s" % err[:160]
                    else:
                        # Erreur reseau (5xx/429/DNS) -> indetermine (on ne
                        # touche pas l'ancienne valeur en base, cap_neterr=1).
                        vision_reason = "erreur HTTP: %s" % err[:160]
                        error = (error or err)
            except Exception as exc:  # noqa: BLE001
                vision = False
                vision_reason = "exception: %s" % str(exc)[:160]
                error = (error or str(exc))

    # 2) reasoning probe (v2): on valide la JUSTESSE des reponses, pas le format.
    #   3 items a reponse deterministe (arithmetique multi-etapes, piege de
    #   comparaison decimale, deduction logique). Seuil: 2/3 (cf.
    #   _REASONING_MIN_SCORE). La presence d'un champ reasoning_content n'est
    #   plus qu'une INFO complementaire, jamais une condition d'echec.
    if _do_reasoning:
        _score = 0
        _native = False
        _fail_detail = None
        _hard_err = None
        for _idx, _item in enumerate(_REASONING_ITEMS, start=1):
            payload = {
                "model": model,
                "messages": [{"role": "user", "content": _item["prompt"]}],
                # large: les modeles a raisonnement consomment beaucoup de
                # tokens avant de produire la ligne REPONSE -> evite les
                # finish_reason='length' (faux negatifs).
                "max_tokens": 2048,
                "temperature": 0.0,
                "stream": False,
            }
            try:
                err, body, _ = _post(payload, timeout=_PROBE_TIMEOUT)
            except Exception as exc:  # noqa: BLE001
                err, body = str(exc), None
            if err is not None:
                low = (err or "").lower()
                if "timed out" in low or "timeout" in low:
                    _hard_err = "timeout item %d" % _idx
                else:
                    _hard_err = "erreur API item %d: %s" % (_idx, err[:120])
                break
            try:
                data = json.loads(body or "{}")
                choice = (data.get("choices") or [{}])[0]
                msg = choice.get("message") or {}
                content = (msg.get("content") or "").strip()
                rc = (msg.get("reasoning_content") or "").strip()
                if rc:
                    _native = True
                # content prioritaire; si vide on accepte reasoning_content.
                text = content or rc
                ok_item, got = _reasoning_check_item(_item, text)
                if ok_item:
                    _score += 1
                elif _fail_detail is None:
                    if not text and choice.get("finish_reason") == "length":
                        _fail_detail = "item %d (%s) tronque (finish_reason=length)" % (_idx, _item["id"])
                    else:
                        _fail_detail = "item %d (%s): attendu %s, recu '%s'" % (
                            _idx, _item["id"], _item["expected"][0], (got or "vide")[:40])
            except Exception as exc:  # noqa: BLE001
                if _fail_detail is None:
                    _fail_detail = "item %d parsing: %s" % (_idx, str(exc)[:80])

        _total = len(_REASONING_ITEMS)
        # 2026-08-12 - ETAT 'TIME' : un timeout de sonde (meme si le seuil
        # etait deja atteint ailleurs) marque 'time' (trop lent), distinct du
        # KO. Une erreur reseau (5xx/429) reste indeterminee (None).
        _timeout_err = bool(_hard_err) and _hard_err.startswith("timeout")
        if _timeout_err:
            reasoning = False
            reasoning_state = 'time'
            reasoning_reason = "trop lent (timeout capacite): %s (score partiel %d/%d)" % (_hard_err, _score, _total)
        elif _hard_err is not None:
            # Erreur reseau sur un item -> indetermine : on ne prouve ni OK
            # ni KO, on ne touche pas l'ancienne valeur en base.
            reasoning = False
            reasoning_state = None
            reasoning_reason = "%s (score partiel %d/%d)" % (_hard_err, _score, _total)
        elif _score >= _REASONING_MIN_SCORE:
            reasoning = True
            reasoning_state = 'ok'
            reasoning_reason = "ok (%d/%d)" % (_score, _total)
        else:
            reasoning = False
            reasoning_state = 'ko'
            reasoning_reason = "echec (%d/%d) - %s" % (_score, _total, _fail_detail or "reponses incorrectes")
        if _native:
            reasoning_reason += " [reasoning_content natif]"

    # 3) tools probe (v2): VRAI aller-retour d'outil en 2 tours.
    #   Tour 1 : on demande la lecture d'un fichier test reel avec un outil
    #            'read_file(path)' declare au format OpenAI. On verifie le NOM
    #            de la fonction ET l'argument path (basename tolerant).
    #   Tour 2 : on renvoie le tool_calls de l'assistant + un message role=tool
    #            contenant 'test valide' et on exige que la reponse finale
    #            restitue ce contenu.
    #   tools_supported=True uniquement si les 2 tours passent.
    if _do_tools:
        _probe_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Test", "test.txt")
        _probe_expected = "test valide"
        try:
            with open(_probe_file, "r", encoding="utf-8") as _fh:
                _probe_content = _fh.read().strip() or "test valid\u00e9"
        except Exception:
            _probe_content = "test valid\u00e9"

        _tool_def = [{"type": "function", "function": {
            "name": "read_file",
            "description": "Lit et retourne le contenu texte d'un fichier a partir de son chemin absolu.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "Chemin absolu du fichier a lire"}},
                "required": ["path"],
            },
        }}]
        _user_msg = {
            "role": "user",
            "content": ("Lis le contenu du fichier %s et dis-moi exactement ce qu'il contient." % _probe_file),
        }
        turn1 = {
            "model": model,
            "messages": [_user_msg],
            "tools": _tool_def,
            "tool_choice": "auto",
            "max_tokens": 300,
            "temperature": 0.0,
            "stream": False,
        }
        try:
            err, body, _ = _post(turn1, timeout=_PROBE_TIMEOUT)
            if err is not None:
                tools = False
                low = (err or "").lower()
                if "timed out" in low or "timeout" in low:
                    # 2026-08-12 - ETAT 'TIME' : sonde outils trop lente.
                    tools_state = 'time'
                    tools_reason = "trop lent (timeout tour 1 capacite)"
                elif "http 4" in low and ("tool" in low or "function" in low):
                    tools_state = 'ko'
                    tools_reason = "outils refuses par l'API (%s)" % err[:120]
                else:
                    # Erreur reseau -> indetermine (cap_neterr, on ne touche pas la base).
                    tools_reason = "erreur API tour 1: %s" % err[:160]
            else:
                data = json.loads(body or "{}")
                msg1 = (data.get("choices") or [{}])[0].get("message") or {}
                tcs = msg1.get("tool_calls") or []
                tc = tcs[0] if (isinstance(tcs, list) and tcs and isinstance(tcs[0], dict)) else None
                if tc is None:
                    tools = False
                    tools_state = 'ko'
                    tools_reason = "tool_calls absent"
                else:
                    fn = (tc.get("function") or {})
                    fname = (fn.get("name") or "").strip()
                    if fname != "read_file":
                        tools = False
                        tools_state = 'ko'
                        tools_reason = "mauvaise fonction (%s)" % (fname or "sans nom")
                    else:
                        _args_raw = fn.get("arguments")
                        _path_arg = ""
                        try:
                            if isinstance(_args_raw, dict):
                                _path_arg = str(_args_raw.get("path") or "")
                            else:
                                _path_arg = str((json.loads(_args_raw or "{}") or {}).get("path") or "")
                        except Exception:
                            _path_arg = str(_args_raw or "")
                        if "test.txt" not in _path_arg.replace("\\", "/").lower():
                            tools = False
                            tools_state = 'ko'
                            tools_reason = "argument path invalide (%s)" % (_path_arg[:80] or "vide")
                        else:
                            # ---- TOUR 2 : renvoi du resultat d'outil ----
                            _tc_id = tc.get("id") or "call_probe_1"
                            _assistant_msg = {
                                "role": "assistant",
                                "content": msg1.get("content") or None,
                                "tool_calls": [{
                                    "id": _tc_id,
                                    "type": "function",
                                    "function": {"name": "read_file", "arguments": fn.get("arguments") if isinstance(fn.get("arguments"), str) else json.dumps(fn.get("arguments") or {})},
                                }],
                            }
                            turn2 = {
                                "model": model,
                                "messages": [
                                    _user_msg,
                                    _assistant_msg,
                                    {"role": "tool", "tool_call_id": _tc_id, "name": "read_file", "content": _probe_content},
                                    {"role": "user", "content": "Donne maintenant ta reponse finale: cite exactement le contenu du fichier."},
                                ],
                                "tools": _tool_def,
                                "max_tokens": 300,
                                "temperature": 0.0,
                                "stream": False,
                            }
                            err2, body2, _ = _post(turn2, timeout=_PROBE_TIMEOUT)
                            if err2 is not None:
                                tools = False
                                low2 = (err2 or "").lower()
                                if "timeout" in low2 or "timed out" in low2:
                                    # 2026-08-12 - ETAT 'TIME' : sonde outils trop lente (tour 2).
                                    tools_state = 'time'
                                    tools_reason = "trop lent (timeout tour 2 capacite)"
                                else:
                                    tools_reason = "erreur API tour 2: %s" % err2[:160]
                            else:
                                d2 = json.loads(body2 or "{}")
                                m2 = (d2.get("choices") or [{}])[0].get("message") or {}
                                final_txt = ((m2.get("content") or "") + " " + (m2.get("reasoning_content") or ""))
                                if _norm_probe_text(final_txt).find(_probe_expected[:10]) >= 0:
                                    tools = True
                                    tools_state = 'ok'
                                    tools_reason = "ok"
                                else:
                                    tools = False
                                    tools_state = 'ko'
                                    tools_reason = "contenu non restitue"
        except Exception as exc:  # noqa: BLE001
            tools = False
            tools_reason = "exception: %s" % str(exc)[:160]

    return {
        "vision_supported": vision,
        "vision_state": vision_state,
        "vision_reason": vision_reason,
        "vision_answer": vision_answer,
        "reasoning_supported": reasoning,
        "reasoning_state": reasoning_state,
        "tools_supported": tools,
        "tools_state": tools_state,
        "tools_reason": tools_reason,
        "reasoning_reason": reasoning_reason,
        "error": error,
        # 2026-08-11 - SOLUTION 3 (capfix) : etat reseau PAR capacite.
        # None = erreur reseau (indetermine) ; True/False = sonde aboutie.
        # CAP_NOT_TESTED = capacite non demandee ce tour (on ne touche pas
        # l'ancienne valeur en base).
        # 2026-08-12 - ETAT 'TIME' : si l'etat est 'ok'/'ko'/'time' (sonde
        # aboutie), on force probed=True ; sinon (None = reseau) on retombe
        # sur _cap_state_from_probe pour l'indetermination.
        "vision_probed": (True if vision_state is not None
                         else _cap_state_from_probe(vision, vision_reason)
                         if _do_vision else CAP_NOT_TESTED),
        "reasoning_probed": (True if reasoning_state is not None
                             else _cap_state_from_probe(reasoning, reasoning_reason)
                             if _do_reasoning else CAP_NOT_TESTED),
        "tools_probed": (True if tools_state is not None
                         else _cap_state_from_probe(tools, tools_reason)
                         if _do_tools else CAP_NOT_TESTED),
    }

# ---------------------------------------------------------------------------
# Récupération des specs du modèle (contexte, params, archi)
# 2026-08-24 : DEVELOPPEUR — quand on scanne un modèle, on veut aussi ses
# specs (contexte, params) sans avoir à ouvrir une session de chat pour les
# voir. Source : API OpenRouter (/models) pour les providers proxys
# (nous/openrouter/omni-route) + cache local en dur pour les cas hors-ligne.
# ---------------------------------------------------------------------------
# Cache local de specs connues (fallback si l'API est injoignable).
_MODEL_SPECS_CACHE = {
    "nvidia/nemotron-3-ultra-550b-a55b:free": {"context_length": 1000000, "parameter_count": "550B"},
    "nvidia/nemotron-3-ultra-550b": {"context_length": 1000000, "parameter_count": "550B"},
    "nvidia/nemotron-3.5-lightning:free": {"context_length": 32768, "parameter_count": "?"},
    "omni-route/groq/groq/compound-mini": {"context_length": 131072, "parameter_count": "?"},
    "omni-route/groq/qwen/qwen3.6-27b": {"context_length": 131072, "parameter_count": "27B"},
    "omni-route/groq/openai/gpt-oss-120b": {"context_length": 131072, "parameter_count": "120B"},
    "omni-route/cohere/command-a-plus-05-2026": {"context_length": 256000, "parameter_count": "?"},
}

# Cache des modèles OpenRouter (rempli au premier appel réseau réussi).
_OPENROUTER_MODELS_CACHE = None
_OPENROUTER_CACHE_TS = 0
_OPENROUTER_CACHE_TTL = 3600  # 1h

def _fetch_openrouter_models():
    """Récupère la liste des modèles OpenRouter (avec context_length)."""
    global _OPENROUTER_MODELS_CACHE, _OPENROUTER_CACHE_TS
    now = time.time()
    if _OPENROUTER_MODELS_CACHE is not None and (now - _OPENROUTER_CACHE_TS) < _OPENROUTER_CACHE_TTL:
        return _OPENROUTER_MODELS_CACHE
    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/models",
            headers={"User-Agent": "HermesMC/1.0", "Accept": "application/json"},
            method="GET",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        models = {}
        for m in data.get("data", []):
            mid = m.get("id", "")
            if not mid:
                continue
            ctx = m.get("context_length")
            params = m.get("architecture", {}).get("parameter_count")
            if ctx or params:
                models[mid] = {
                    "context_length": ctx,
                    "parameter_count": str(params) if params else None,
                }
        if models:
            _OPENROUTER_MODELS_CACHE = models
            _OPENROUTER_CACHE_TS = now
            return models
    except Exception:  # noqa: BLE001
        pass
    return _OPENROUTER_MODELS_CACHE or {}

def _fetch_model_specs(provider: str, model: str) -> dict:
    """Retourne {context_length, parameter_count, specs_display, specs_error}.

    ORDRE DE PRIORITE pour context_length :
    1. Cache Hermes (context_length_cache.yaml) — source de verite universelle,
       contient le contexte de CHAQUE modele deja charge par Hermes, peu importe
       le provider. C'est ca qui fait que le chat affiche le bon contexte.
    2. Cache local _MODEL_SPECS_CACHE (fallback hors-ligne)
    3. API OpenRouter (providers proxys: nous/openrouter/omni-route)
    - sinon {} (pas d'info dispo)
    """
    if not provider or not model:
        return {}
    prov_norm = (provider or "").strip().lower()
    context_length = None
    parameter_count = None

    # 1. Cache Hermes (PRIORITAIRE) — contexte de tous les modeles charges
    _hermes_ctx = _get_hermes_context(model)
    if _hermes_ctx:
        context_length = _hermes_ctx
    # 2. Cache local
    if context_length is None:
        local = _MODEL_SPECS_CACHE.get(model) or _MODEL_SPECS_CACHE.get(model.lower())
        if local:
            context_length = local.get("context_length")
            parameter_count = local.get("parameter_count")
    # 3. OpenRouter API pour les providers proxys
    if context_length is None and prov_norm in ("nous", "openrouter", "omni-route"):
        try:
            orm = _fetch_openrouter_models()
            # Cherche correspondance exacte puis par préfixe (ex: nous/xxx -> xxx,
            # nvidia/nvidia/xxx -> nvidia/xxx -> xxx). On teste toutes les
            # variantes de stripping de préfixes pour gérer les IDs à double
            # préfixe (ex: nvidia/nvidia/nemotron-3-super-120b-a12b).
            key = model
            _tried = set()
            _candidates = [key]
            # Génère toutes les variantes en retirant un préfixe à chaque fois
            _cur = key
            while "/" in _cur:
                _cur = _cur.split("/", 1)[1]
                if _cur not in _tried:
                    _candidates.append(_cur)
                    _tried.add(_cur)
            for _cand in _candidates:
                if _cand in orm:
                    spec = orm[_cand]
                    context_length = spec.get("context_length")
                    parameter_count = spec.get("parameter_count")
                    break
        except Exception:  # noqa: BLE001
            pass

    # Construit specs_display (ex: "Ctx: 1M | Params: 550B")
    specs_display = None
    parts = []
    if context_length:
        parts.append("Ctx: %s" % _fmt_tokens(context_length))
    if parameter_count:
        parts.append("Params: %s" % str(parameter_count))
    if parts:
        specs_display = " | ".join(parts)

    return {
        "context_length": context_length,
        "parameter_count": parameter_count,
        "specs_display": specs_display,
        "specs_error": None,
    }


def _load_hermes_context_cache():
    """Lit le cache de context_length de Hermes (~/.hermes/context_length_cache.yaml).

    Source de verite universelle : Hermes y stocke le contexte de CHAQUE modele
    deja charge (model@base_url -> context_length). On l'utilise pour peupler
    context_length lors du scan, peu importe le provider — pas besoin d'ajouter
    les modeles un par un.
    """
    cache = {}
    try:
        p = os.path.join(HERMES_HOME, "context_length_cache.yaml")
        if not os.path.exists(p):
            return cache
        with open(p, "r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh) or {}
        raw = data.get("context_lengths") or {}
        for key, val in raw.items():
            # key = "model@base_url" ou "model"
            model_part = key.split("@", 1)[0] if "@" in key else key
            try:
                ctx = int(val)
            except (TypeError, ValueError):
                ctx = None
            if ctx:
                cache[model_part.lower()] = ctx
    except Exception:  # noqa: BLE001
        pass
    return cache


# Cache module-level (recharge toutes les 5 min)
_HERMES_CTX_CACHE = None
_HERMES_CTX_CACHE_TS = 0
_HERMES_CTX_CACHE_TTL = 300

def _get_hermes_context(model: str):
    """Retourne le context_length depuis le cache Hermes, ou None."""
    global _HERMES_CTX_CACHE, _HERMES_CTX_CACHE_TS
    now = time.time()
    if _HERMES_CTX_CACHE is None or (now - _HERMES_CTX_CACHE_TS) > _HERMES_CTX_CACHE_TTL:
        _HERMES_CTX_CACHE = _load_hermes_context_cache()
        _HERMES_CTX_CACHE_TS = now
    if not model:
        return None
    m = model.lower()
    # Correspondance exacte d'abord
    if m in _HERMES_CTX_CACHE:
        return _HERMES_CTX_CACHE[m]
    # Puis par suffixe (strip prefixes "prov/prov/...")
    while "/" in m:
        m = m.split("/", 1)[1]
        if m in _HERMES_CTX_CACHE:
            return _HERMES_CTX_CACHE[m]
    return None


def _fmt_tokens(n):
    """Formate un nombre de tokens en unité lisible (ex: 1000000 -> '1M')."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return str(n)
    if n >= 1_000_000:
        return "%.0fM" % (n / 1_000_000)
    if n >= 1_000:
        return "%.0fK" % (n / 1_000)
    return str(n)
_SCANS: dict = {}          # scan_id -> scan state dict (see _new_scan_state)
_SCANS_LOCK = threading.Lock()
_CAP_RESULTS: dict = {}    # cap_id -> {"status": "running"|"done"|"error", "result": {...}}


def _new_scan_state(provider: str, model_ids: list, freeform: bool) -> dict:
    """Allocate a fresh scan-state record and register it."""
    scan_id = uuid.uuid4().hex
    state = {
        "scan_id": scan_id,
        "provider": provider,
        "freeform": freeform,
        "total": len(model_ids),
        "done": 0,                 # number of models probed so far
        "status": "running",       # running | done | cancelled | error
        "configured": True,
        "error": None,
        "results": [],            # [{model, ok, reason}] (unsorted, live)
        "cancel": threading.Event(),  # set -> stop launching new probes
    }
    with _SCANS_LOCK:
        _SCANS[scan_id] = state
    return state


def _scan_purge_old():
    """Best-effort cleanup of finished scans older than ~10 min."""
    cutoff = time.time() - 600
    with _SCANS_LOCK:
        stale = [sid for sid, s in _SCANS.items()
                 if s.get("status") in ("done", "cancelled", "error")
                 and s.get("_ended", 0) and s["_ended"] < cutoff]
        for sid in stale:
            _SCANS.pop(sid, None)


def scan_provider_models_async(provider: str, model_ids: list, scan_id: str):
    """Run a real probe per model in the background, writing into _SCANS.

    Honours a cancellation Event: stops launching NEW probes and joins the
    in-flight threads, so Stop is real. Reuses _SCAN_SEM / _SCAN_TIMEOUT.
    """
    state = None
    with _SCANS_LOCK:
        state = _SCANS.get(scan_id)
    if state is None:
        return

    prov = (provider or "").strip().lower()
    model_ids = list(model_ids or [])
    # Route selection (all paths below are SESSION-FREE — no `hermes chat`):
    #   - lmstudio          -> _probe_lmstudio (already a direct HTTP call)
    #   - base_url known    -> _probe_api (direct /v1/chat/completions, NO session)
    #   - otherwise         -> clean RED ("provider non scannable directement"):
    #                          never shells out to `hermes chat`, so no history
    #                          pollution. (The old _probe_hermes_cli was removed.)
    use_direct_lmstudio = (prov == "lmstudio")
    prov_base_url, prov_api_key = (None, None)
    if not use_direct_lmstudio:
        prov_base_url, prov_api_key = _provider_base_url(prov)
    _results_lock = threading.Lock()
    _started_threads = []

    def _probe_one(m: str):
        if state["cancel"].is_set():
            # Cancelled before we even probed -> record as skipped (rouge).
            with _results_lock:
                state["results"].append(
                    {"provider": prov, "model": m, "ok": False,
                     "reason": "annule", "life_state": "rouge",
                     "life_answer": "", "last_checked": time.time()})
                state["done"] += 1
            return
        if use_direct_lmstudio:
            r = _probe_lmstudio(m)
        elif prov_base_url:
            # Direct OpenAI-compatible call — creates NO Hermes session.
            with _SCAN_SEM:
                # If cancellation landed mid-wait, abort this probe too.
                if state["cancel"].is_set():
                    with _results_lock:
                        state["results"].append(
                            {"provider": prov, "model": m, "ok": False,
                             "reason": "annule", "life_state": "rouge",
                             "life_answer": "", "last_checked": time.time()})
                    state["done"] += 1
                    return
                r = _probe_api(prov_base_url, m, prov_api_key, provider=prov)
        else:
            # Provider without a resolvable base_url (e.g. anthropic, unknown
            # custom providers, or a known provider whose key is absent). We
            # deliberately DO NOT shell out to `hermes chat` here: that would
            # create a polluting session in the global Hermes history on every
            # scan. Instead we mark the model as a clean RED with an explicit
            # reason so the dashboard shows it as "non scannable directement".
            r = {"ok": False,
                 "reason": "provider non scannable directement (base_url/cle inconnue)",
                 "life_state": "rouge", "life_answer": "",
                 "latency_ms": None,
                 "tokens_per_sec": None}
        with _results_lock:
            # Récupère les specs du modèle (contexte, params) si dispo.
            _specs = _fetch_model_specs(prov, m)
            state["results"].append(
                {"provider": prov, "model": m, "ok": r["ok"], "reason": r["reason"],
                 "life_state": r.get("life_state") or ("vert" if r.get("ok") else "rouge"),
                 "life_answer": r.get("life_answer") or "",
                 "latency_ms": r.get("latency_ms"),
                 "tokens_per_sec": r.get("tokens_per_sec"),
                 "last_checked": time.time(),
                 "context_length": _specs.get("context_length"),
                 "parameter_count": _specs.get("parameter_count"),
                 "specs_display": _specs.get("specs_display"),
                 "specs_error": _specs.get("specs_error")})
            # Auto-blacklist KO models (scan-detected) — persisted server-side.
            # PHASE 1: un "suspect" (cache probable) n'est PAS un modele mort,
            # on ne le blackliste donc pas — il est seulement non valide.
            # 2026-08-12 - ETAT 'TIME' : un modele TROP LENT (life_state='time')
            # REPOND, il n'est donc PAS mort -> il ne doit JAMAIS etre
            # blackliste. Garde STRICTE : seul un KO avare (ok=False et
            # life_state='rouge') est blackliste.
            _ls = r.get("life_state")
            if (not r.get("ok") and r.get("reason") not in ("annule",)
                    and _ls == "rouge" and _ls != "time" and _ls != "suspect"):
                _auto_blacklist(prov, m)
            # DEMANDE 1: persist this probe result to scan_results.db (upsert)
            # so the result survives restarts / F5 (server-side source of truth).
            _save_scan_result(prov, m, r.get("ok"),
                              r.get("reason"),
                              r.get("latency_ms"),
                              r.get("tokens_per_sec"),
                              time.time(),
                              life_state=(r.get("life_state")
                                          or ("vert" if r.get("ok") else "rouge")),
                              life_answer=(r.get("life_answer") or ""),
                              context_length=_specs.get("context_length"),
                              parameter_count=_specs.get("parameter_count"),
                              specs_display=_specs.get("specs_display"),
                              specs_error=_specs.get("specs_error"))
            state["done"] += 1

    try:
        # Sequential for ALL providers: check cancel before each model.
        for m in model_ids:
            if state["cancel"].is_set():
                state["status"] = "cancelled"
                break
            _probe_one(m)

        if state["status"] == "running":
            state["status"] = "done"
    except Exception as exc:  # noqa: BLE001
        state["status"] = "error"
        state["error"] = str(exc)
    finally:
        with _SCANS_LOCK:
            state["_ended"] = time.time()
        # periodic cleanup so the registry does not grow unbounded
        try:
            _scan_purge_old()
        except Exception:  # noqa: BLE001
            pass


def scan_provider_models(provider: str, limit: int = 0) -> dict:
    """Legacy SYNCHRONOUS scan (kept for compatibility / quick curl use).

    Returns {provider, configured:bool, models:[{model, ok, reason}]}.
    Delegates to the async worker but blocks until completion so the
    call shape stays identical for old callers. `limit` (0 = all) caps the
    probe count so huge catalogs (e.g. nous = 279) stay quick.
    """
    prov = (provider or "").strip().lower()
    if not prov:
        return {"provider": prov, "configured": False,
                "models": [], "error": "provider requis"}

    # Enumerate the real model list for this provider.
    models, freeform = _mc_provider_model_ids(prov, force_live=True)
    if not models:
        # No discoverable list -> "provider non configure" signal.
        return {
            "provider": prov,
            "configured": False,
            "freeform": freeform,
            "models": [{
                "provider": prov,
                "model": "(provider)",
                "ok": False,
                "reason": "provider non configure (pas de cle/URL)",
            }],
        }

    scanned_total = len(models)
    if limit and limit > 0:
        models = models[:limit]

    # Run the async worker synchronously (block until done).
    state = _new_scan_state(prov, models, freeform)
    scan_provider_models_async(prov, models, state["scan_id"])
    results = list(state["results"])
    results.sort(key=lambda x: (x["ok"], x["model"]))
    return {
        "provider": prov,
        "configured": True,
        "freeform": freeform,
        "scanned_total": scanned_total,
        "scanned": len(results),
        "models": results,
    }


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# SSE BROADCAST MUTUALISE (audit 2026-08-07, DEVELOPPEUR)
# Avant : chaque client /events avait sa propre boucle -> get_state() recalculait
# le payload TOUTES les 3s PAR client (2-4 connexions = 2-4x le meme calcul CPU,
# ~0.8s par build_state sous GIL). Maintenant UN thread calcule le state une
# fois par tick et le pousse dans la file de chaque client abonne. Les
# notifications ne sont poussees QU'UNE FOIS (watermark ts), plus a chaque tick.
# ---------------------------------------------------------------------------
_SSE_CLIENTS: list = []
_SSE_CLIENTS_LOCK = threading.Lock()


def _sse_register(q):
    with _SSE_CLIENTS_LOCK:
        _SSE_CLIENTS.append(q)


def _sse_unregister(q):
    with _SSE_CLIENTS_LOCK:
        try:
            _SSE_CLIENTS.remove(q)
        except ValueError:
            pass


def _sse_broadcast_loop():
    """Une seule boucle : calcule get_state() (cache TTL 3.5s) et diffuse."""
    last_notif_ts = 0.0
    while True:
        try:
            payload = get_state()
            chunk = "event: state\ndata: %s\n\n" % json.dumps(payload, ensure_ascii=False)
            with _SSE_CLIENTS_LOCK:
                clients = list(_SSE_CLIENTS)
            # Notifications NON encore diffusees (watermark sur ts).
            try:
                mc_backend._detect_event_notifications()
            except Exception:
                pass
            with mc_backend._NOTIFICATIONS_LOCK:
                # _NOTIFICATIONS contient des tuples (type,title,message,ts,agent)
                # ; accès défensif tuple/dict (si un jour on passe en dicts).
                fresh = [n for n in mc_backend._NOTIFICATIONS
                         if (n[3] if isinstance(n, tuple) else n.get("ts", 0)) > last_notif_ts]
                if fresh:
                    last_notif_ts = max(
                        (n[3] if isinstance(n, tuple) else n.get("ts", 0)) for n in fresh
                    )
            for q in clients:
                try:
                    q.put_nowait(chunk)
                except queue.Full:
                    pass  # client lent : on saute ce tick, pas de blocage
            for n in fresh:
                n_chunk = "event: notification\ndata: %s\n\n" % json.dumps(n, ensure_ascii=False)
                for q in clients:
                    try:
                        q.put_nowait(n_chunk)
                    except queue.Full:
                        pass
        except Exception as exc:  # noqa: BLE001
            print("[sse broadcast] error:", exc)
        time.sleep(SSE_INTERVAL)


# =====================================================================
# Backup / Restore MC (feature ajoutee 2026-08-10)
# ---------------------------------------------------------------------
# Le backup/restore complet doit arreter le service (systemctl stop) pour
# capturer un etat coherent. Un handler HTTP qui fait `systemctl --user stop`
# EN SYNCHRONE se tue lui-meme (KillMode=control-group) : le tar ne
# s'executerait jamais. On lance donc un script bash DETACHE via
# `systemd-run --user` (unite transiente = cgroup separe, non tue par le
# stop du service). Le script reproduit le pattern prouve par le log
# ~/mc-backups/mc-backup.log : stop -> tar -> relance (trap EXIT) -> purge.
# =====================================================================
# Accepte HHMM (4 chiffres) ou HHMMSS (6 chiffres) dans l'horodatage
_MC_BACKUP_RE = re.compile(r"^mc-full-\d{8}-\d{4}(\d{2})?\.tar\.gz$")


def _mc_backup_dir() -> str:
    return os.path.expanduser("~/mc-backups")


def _mc_purge_old_backups(keep: int = 2) -> None:
    """Ne conserve que les `keep` backups mc-full-*.tar.gz les plus recents."""
    d = _mc_backup_dir()
    if not os.path.isdir(d):
        return
    try:
        cands = sorted(
            (f for f in os.listdir(d) if _MC_BACKUP_RE.match(f)),
            reverse=True,  # horodatage YYYYMMDD-HHMMSS triable lexicographiquement
        )
    except OSError:
        return
    for old in cands[keep:]:
        try:
            os.remove(os.path.join(d, old))
        except OSError:
            pass


_DAILY_BACKUP_SCRIPT = os.path.expanduser("~/scripts/mc_daily_backup.sh")


def _mc_backup_script(backup_name: str) -> str:
    """Backup complet : delegue au script valide ~/scripts/mc_daily_backup.sh
    (stop -> tar -> relance trap EXIT -> purge 2). Autonome et teste."""
    backups = _mc_backup_dir()
    return (
        "#!/bin/bash\n"
        "exec >> " + backups + "/mc-backup.log 2>&1\n"
        'echo "[MC-API] backup demande via dashboard: ' + backup_name + '"\n'
        "bash " + _DAILY_BACKUP_SCRIPT + "\n"
        "exit $?\n"
    )


def _mc_restore_script(backup_name: str) -> str:
    """Script bash du restore : stop -> verif anti-path-traversal -> extract
    -> relance (trap EXIT). Pas d'apostrophes internes dans le trap pour
    eviter la coupure prematuee du guillemet (bug precedent)."""
    home = os.path.expanduser("~")
    backups = _mc_backup_dir()
    return (
        "#!/bin/bash\n"
        "# restore MC genere par server.py (" + backup_name + ")\n"
        "exec >> " + backups + "/mc-backup.log 2>&1\n"
        'echo "[$(date +%F_%T)] === debut restore MC (' + backup_name + ') ==="\n'
        "systemctl --user stop hermes-mission-control.service || { echo \"[$(date +%F_%T)] ERREUR stop\"; exit 1; }\n"
        "trap 'systemctl --user start hermes-mission-control.service; echo \"[$(date +%F_%T)] relance hermes-mission-control.service\" >> " + backups + "/mc-backup.log' EXIT\n"
        "BACKUP_PATH=" + backups + "/" + backup_name + "\n"
        'echo "[$(date +%F_%T)] verif archive $BACKUP_PATH"\n'
        "LIST=$(mktemp)\n"
        "tar -tzf \"$BACKUP_PATH\" > \"$LIST\"\n"
        "if grep -E '(^|/)\\.\\.(/|$)|^/' \"$LIST\"; then\n"
        '  echo "[$(date +%F_%T)] REFUS: entree path traversal dans l archive"\n'
        "  rm -f \"$LIST\"\n"
        "  exit 1\n"
        "fi\n"
        "rm -f \"$LIST\"\n"
        "cd " + home + " || exit 1\n"
        "tar -xzf \"$BACKUP_PATH\"\n"
        "rc=$?\n"
        'echo "[$(date +%F_%T)] === fin restore MC (' + backup_name + ') rc=$rc ==="\n'
        "exit $rc\n"
    )


def _mc_spawn_detached(unit: str, script_path: str) -> None:
    """Lance un script dans une unite transiente systemd --user (cgroup
    separe) : il survit au stop du service principal ('systemctl --user stop')."""
    subprocess.Popen(
        ["systemd-run", "--user", "--collect", "--unit", unit, script_path],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def _read_dashboard_version():
    """Read dashboard version from VERSION file (falls back to 0.0.0)."""
    try:
        with open(os.path.join(PROJECT_DIR, "VERSION"), "r", encoding="utf-8") as fh:
            return fh.read().strip() or "0.0.0"
    except Exception:
        return "0.0.0"


class Handler(BaseHTTPRequestHandler):
    server_version = "HermesMissionControl/" + _read_dashboard_version()

    # ---- quiet logging ----
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not getattr(self, "_head", False):
            self.wfile.write(body)

    def _send_text(self, text, code=200, ctype="text/plain; charset=utf-8"):
        body = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # Anti-cache on static 404s / errors too (LOT 8).
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not getattr(self, "_head", False):
            self.wfile.write(body)

    def _send_html(self, html, code=200):
        body = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # Anti-cache STRICT: no-store empeche le navigateur de garder le moindre
        # index.html en cache. Avec le cache-busting ?v=<mtime> sur les assets,
        # le client recharge TOUJOURS le bon bundle (jamais un JS pereme). LOT 8.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if not getattr(self, "_head", False):
            self.wfile.write(body)


    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path in ("/login", "/logout"):
                # Authentification SUPPRIMEE (2026-08-09) : ces routes n'existent
                # plus. 404 = "page introuvable", comme si login n'avait jamais existe.
                self._send_text("Not Found", code=404)
                return
            # ---- BOB 2026-08-05 : terminal WS + explorateur RW + config ----
            if path == "/ws/terminal":
                mc_backend.serve_terminal_ws(self)
                return
            if path == "/api/config":
                self._send_json(mc_backend.load_config())
                return
            if path == "/api/config/scan_providers":
                self._send_json({"scan_providers": mc_backend.load_config().get("scan_providers", {})})
                return
            if path == "/api/fs/list":
                _q = parse_qs(parsed.query)
                try:
                    self._send_json(mc_backend.fs_list(
                        _q.get("path", [""])[0],
                        _q.get("hidden", ["0"])[0] in ("1", "true", "yes"),
                    ))
                except mc_backend.FsError as _e:
                    self._send_json({"ok": False, "error": str(_e)}, code=_e.code)
                return
            if path == "/api/files/download":
                _q = parse_qs(parsed.query)
                try:
                    _full = mc_backend.fs_download_path(_q.get("path", [""])[0])
                except mc_backend.FsError as _e:
                    self._send_json({"ok": False, "error": str(_e)}, code=_e.code)
                    return
                _ct, _ = mimetypes.guess_type(_full)
                _inline = _q.get("inline", [""])[0] in ("1", "true", "yes")
                self.send_response(200)
                self.send_header("Content-Type", _ct or "application/octet-stream")
                self.send_header("Content-Length", str(os.path.getsize(_full)))
                self.send_header("Content-Disposition",
                                 'inline; filename="%s"' % os.path.basename(_full) if _inline
                                 else 'attachment; filename="%s"' % os.path.basename(_full))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if not getattr(self, "_head", False):
                    with open(_full, "rb") as _fh:
                        shutil.copyfileobj(_fh, self.wfile)
                return
            if path == "/" or path == "/index.html":
                self._serve_index()
            if path == "/api/mc_favs":
                _ag = str(parse_qs(parsed.query).get("agent", [""])[0]).strip()
                _all = load_mc_favs()
                if _ag:
                    self._send_json({"ids": _all.get(_ag) or []})
                else:
                    self._send_json({"ids": [], "all": _all})
                return
            if path == "/api/board":
                self._send_json(read_board())
            elif path == "/api/board":
                self._send_json(read_board())
            elif path == "/api/cron":
                self._send_json({"jobs": read_cron_jobs()})
            elif path == "/api/cron/script":
                # GET /api/cron/script?path=<nom_du_script> -> contenu d'un
                # script de job cron (jobs no_agent). Lecture sécurisée :
                # uniquement sous ~/.hermes/scripts/ ou ~/.hermes/skills/.
                _q = parse_qs(parsed.query)
                _payload, _code = read_cron_script(_q.get("path", [""])[0])
                self._send_json(_payload, code=_code)
                return
            elif path == "/api/content":
                qs = parse_qs(parsed.query)
                rel = qs.get("path", [""])[0].strip()
                if rel:
                    self._send_json(read_content_file(rel))
                else:
                    # Paginated listing (optA 2026-08-02): ~/hermes-docs is 674 MB
                    # / 6785 files, ~1.77 MB serialized. Return 50 at a time so the
                    # Content tab never pulls the whole tree in one shot.
                    try:
                        page = int(qs.get("page", ["1"])[0])
                    except (ValueError, TypeError):
                        page = 1
                    per = 50
                    all_files = read_content_library()
                    total = len(all_files)
                    if page < 1:
                        # page absent ou <=0 -> compat legacy: renvoie toute la
                        # bibliothèque (le frontend ContentTab sans pagination).
                        self._send_json({
                            "files": all_files,
                            "page": 1,
                            "per_page": total,
                            "total": total,
                            "pages": 1,
                        })
                        return
                    start = (page - 1) * per
                    chunk = all_files[start:start + per]
                    self._send_json({
                        "files": chunk,
                        "page": page,
                        "per_page": per,
                        "total": total,
                        "pages": (total + per - 1) // per,
                    })
            elif path == "/api/models":
                # Optional ?provider=X -> live single-provider model list
                # (used by the UI on provider select + curl verification).
                _mprovider = parse_qs(parsed.query).get("provider", [""])[0].strip()
                try:
                    _payload = read_model_catalog(_mprovider) if _mprovider else read_model_catalog()
                    print(f"[debug] /api/models provider={_mprovider!r} providers={len(_payload.get('providers', {}))} models={sum(len(p.get('models', [])) for p in _payload.get('providers', {}).values())}", flush=True)
                except Exception as _exc:  # noqa: BLE001
                    print("[debug] /api/models error:", repr(_exc), flush=True)
                    raise
                self._send_json(_payload)
            elif path == "/api/scan/blacklist":
                # GET the full persisted blacklist { "<provider>": [model,...] }.
                self._send_json({"blacklist": _load_blacklist()})
            elif path == "/api/scan":
                # SCAN tab v2: NON-blocking scan. Returns a scan_id
                # immediately; results stream via /api/scan/status.
                #   ?provider=X            required
                #   ?models=a,b,c          explicit model_ids to probe (v2 UI)
                #   ?limit=N               legacy cap (ignored when models= set)
                _sq = parse_qs(parsed.query)
                _sprovider = _sq.get("provider", [""])[0].strip().lower()
                if not _sprovider:
                    self._send_json(
                        {"provider": "", "configured": False,
                         "models": [], "error": "provider requis"}, code=400)
                    return

                # Check if provider is enabled for scanning
                config = mc_backend.load_config()
                scan_providers = config.get("scan_providers", {})
                # If scan_providers is empty, all providers are enabled (backward compatibility)
                if scan_providers and _sprovider not in scan_providers:
                    self._send_json(
                        {"provider": _sprovider, "configured": False,
                         "models": [], "error": "provider non autorise pour le scan"},
                        code=403)
                    return

                # Resolve the real model list for this provider.
                _models, _freeform = _mc_provider_model_ids(
                    _sprovider, force_live=True)

                if not _models:
                    # No discoverable list => provider not configured.
                    # Return a single informational row (legacy shape).
                    self._send_json({
                        "provider": _sprovider,
                        "configured": False,
                        "freeform": _freeform,
                        "models": [{
                            "provider": _sprovider,
                            "model": "(provider)",
                            "ok": False,
                            "reason": "provider non configure (pas de cle/URL)",
                        }],
                    })
                    return

                # Explicit model list (v2 UI) overrides any limit cap.
                _explicit = _sq.get("models", [""])[0].strip()
                if _explicit:
                    _wanted = [m.strip() for m in _explicit.split(",") if m.strip()]
                    # Keep only ids that actually belong to this provider.
                    _model_set = set(_models)
                    _model_ids = [m for m in _wanted if m in _model_set]
                    if not _model_ids:
                        self._send_json(
                            {"error": "aucun model_id valide pour ce provider"},
                            code=400)
                        return
                else:
                    # Legacy path: honor ?limit=N (default 12, cap 40).
                    try:
                        _slimit = int(_sq.get("limit", ["12"])[0])
                    except Exception:  # noqa: BLE001
                        _slimit = 12
                    if _slimit <= 0 or _slimit > 40:
                        _slimit = 40  # hard safety cap
                    _model_ids = _models[:_slimit]

                # Launch the scan in a background daemon thread.
                _state = _new_scan_state(_sprovider, _model_ids, _freeform)
                _t = threading.Thread(
                    target=scan_provider_models_async,
                    args=(_sprovider, _model_ids, _state["scan_id"]),
                    daemon=True)
                _t.start()
                self._send_json({
                    "scan_id": _state["scan_id"],
                    "provider": _sprovider,
                    "total": _state["total"],
                    "status": "running",
                })
            elif path == "/api/scan/status":
                # Live progress + partial results for a running/ended scan.
                _sq = parse_qs(parsed.query)
                _sid = _sq.get("scan_id", [""])[0].strip()
                with _SCANS_LOCK:
                    _st = _SCANS.get(_sid)
                    if _st is None:
                        self._send_json({"error": "scan_id inconnu"}, code=404)
                        return
                    # Snapshot (dict is mutated in place; copy the list).
                    _snap = {
                        "scan_id": _st["scan_id"],
                        "provider": _st["provider"],
                        "freeform": _st["freeform"],
                        "total": _st["total"],
                        "done": _st["done"],
                        "status": _st["status"],
                        "configured": _st["configured"],
                        "error": _st["error"],
                        # sorted for stable display: vert first then rouge
                        "results": sorted(
                            _st["results"], key=lambda x: (x["ok"], x["model"])),
                    }
                self._send_json(_snap)
            elif path == "/api/scan/results":
                # DEMANDE 1: read persisted scan results from scan_results.db.
                #   ?provider=X  (optional) -> filter to one provider
                # Returns { provider: <str|null>, results: [ScanModelResult-ish] }.
                _sq = parse_qs(parsed.query)
                _prov = _sq.get("provider", [""])[0].strip().lower() or None
                _rows = _get_scan_results(_prov)
                self._send_json({"provider": _prov, "results": _rows})
            elif path == "/api/scan/pdf":
                # Demande "Exporter PDF" (tab Scan). Genere un PDF consultable
                # des resultats de scan (scan_results.db) via le venv utilitaire
                # ~/.venv_pdf, puis l'envoie en Content-Disposition attachment.
                # Filtrage OK : par DEFAIUT, seul les modeles qui ont REPONDU
                # (ok is True) sont exportes. Pour exporter TOUT (debug), passer
                #   ?ok=0  (ou ?ok=false / ?onlyok=0).
                #   ?ok=1 / ?ok=true / ?onlyok=1  =  explicite "uniquement OK".
                _sq = parse_qs(parsed.query)
                _prov = _sq.get("provider", [""])[0].strip().lower() or None
                _only_ok = True  # defaut : uniquement les modeles OK
                _ok_raw = (_sq.get("ok", _sq.get("onlyok", [""]))[0]).strip().lower()
                if _ok_raw in ("1", "true", "yes", "on"):
                    _only_ok = True           # ?ok=1 / ?onlyok=1 -> uniquement OK
                elif _sq.get("ok", []) or _sq.get("onlyok", []):
                    # un parametre ok/onlyok est PRESENT mais sa valeur n'est pas
                    # vrai (0/false/no/off/garbage) -> exporter TOUT (debug).
                    _only_ok = False
                _data, _err = _render_scan_pdf(_prov, only_ok=_only_ok)
                if _err:
                    self._send_json({"error": _err}, code=500)
                    return
                _fname = "scan-results-{}.pdf".format(time.strftime("%Y%m%d"))
                self.send_response(200)
                self.send_header("Content-Type", "application/pdf")
                self.send_header(
                    "Content-Disposition",
                    'attachment; filename="{}"'.format(_fname),
                )
                self.send_header("Content-Length", str(len(_data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if not getattr(self, "_head", False):
                    self.wfile.write(_data)
            elif path == "/api/scan/cancel":
                # Stop a running scan: set its cancellation Event so no new
                # probes launch and in-flight threads are joined.
                _sq = parse_qs(parsed.query)
                _sid = _sq.get("scan_id", [""])[0].strip()
                with _SCANS_LOCK:
                    _st = _SCANS.get(_sid)
                    if _st is None:
                        self._send_json({"error": "scan_id inconnu"}, code=404)
                        return
                    if _st["status"] == "running":
                        _st["cancel"].set()
                        _st["status"] = "cancelling"
                    self._send_json({"ok": True, "status": _st["status"]})
            elif path == "/api/scan/active":
                # Source of truth for in-flight scans (backend registry).
                # Lets the UI resume a polling session after navigating away
                # and back, even if the frontend store / localStorage is in an
                # inconsistent state: the backend is the authoritative list of
                # scans still running. Returns only running/cancelling scans.
                with _SCANS_LOCK:
                    _active = []
                    for _st in _SCANS.values():
                        if _st.get("status") in ("running", "cancelling"):
                            _active.append({
                                "scan_id": _st["scan_id"],
                                "provider": _st.get("provider", ""),
                                "status": _st["status"],
                                "total": _st.get("total", 0),
                                "done": _st.get("done", 0),
                            })
                self._send_json({"scans": _active})
            elif path == "/api/scan/cancel-all":
                # Force-cancel every running/cancelling scan and clear the registry.
                with _SCANS_LOCK:
                    _cancelled = 0
                    for _st in _SCANS.values():
                        if _st.get("status") in ("running", "cancelling"):
                            _st["cancel"].set()
                            _st["status"] = "cancelling"
                            _cancelled += 1
                    _SCANS.clear()
                self._send_json({"ok": True, "cancelled": _cancelled})
            elif path == "/api/scan/test-capabilities":
                _sq = parse_qs(parsed.query)
                _provider = _sq.get("provider", [""])[0].strip().lower()
                _model = _sq.get("model", [""])[0].strip()
                _cap = _sq.get("cap", ["all"])[0].strip().lower()
                if _cap not in ("all", "vision", "reasoning", "tools"):
                    _cap = "all"
                if not _provider or not _model:
                    self._send_json({"error": "provider et model requis", "vision_supported": False, "reasoning_supported": False, "tools_supported": False}, code=400)
                    return
                _base, _key = _provider_base_url(_provider)
                if not _base:
                    self._send_json({"vision_supported": False, "reasoning_supported": False, "tools_supported": False, "error": "provider non configure (pas de base_url/cle)"})
                    return
                # Run capability probe in a background thread to avoid
                # blocking the HTTP handler (and the entire dashboard).
                _cap_id = uuid.uuid4().hex
                _CAP_RESULTS[_cap_id] = {"status": "running", "result": None}
                def _run_cap_probe():
                    try:
                        _t_cap0 = time.time()
                        res = _probe_capabilities(_base, _model, _key, cap=_cap)
                        _vt = res.get("vision_supported") or False
                        _rt = res.get("reasoning_supported") or False
                        _tt = res.get("tools_supported") or False
                        # 2026-08-12 - ETAT 'TIME' : on persiste l'etat fin de
                        # sonde capacite ('ok'|'ko'|'time') pour chaque capacite.
                        _vs = res.get("vision_state")
                        _rs = res.get("reasoning_state")
                        _ts = res.get("tools_state")
                        # 2026-08-11 - SOLUTION 3 (capfix) : etat reseau par
                        # capacite (None = erreur reseau -> on ne touche pas
                        # l'ancienne valeur en base).
                        _vp = res.get("vision_probed")
                        _rp = res.get("reasoning_probed")
                        _tp = res.get("tools_probed")
                        _save_capability_result(
                            _provider, _model,
                            vision_supported=1 if _vt else 0,
                            reasoning_supported=1 if _rt else 0,
                            tools_supported=1 if _tt else 0,
                            cap_latency_ms=round((time.time() - _t_cap0) * 1000, 1),
                            vision_probed=_vp,
                            reasoning_probed=_rp,
                            tools_probed=_tp,
                            vision_state=_vs,
                            reasoning_state=_rs,
                            tools_state=_ts,
                        )
                        _CAP_RESULTS[_cap_id] = {"status": "done", "result": res}
                    except Exception as exc:
                        _CAP_RESULTS[_cap_id] = {"status": "error", "result": {"error": str(exc), "vision_supported": False, "reasoning_supported": False, "tools_supported": False}}
                threading.Thread(target=_run_cap_probe, daemon=True).start()
                self._send_json({"cap_id": _cap_id, "status": "running"})
            elif path == "/api/scan/cap-status":
                _sq = parse_qs(parsed.query)
                _cid = _sq.get("cap_id", [""])[0].strip()
                if not _cid or _cid not in _CAP_RESULTS:
                    self._send_json({"error": "cap_id inconnu"}, code=404)
                    return
                _cr = _CAP_RESULTS[_cid]
                self._send_json(_cr)
            elif path == "/api/agent/model":
                agent = parse_qs(parsed.query).get("agent", [""])[0].strip().lower()
                if not _is_fleet_agent(agent):
                    self._send_json({"error": "unknown agent"}, code=400)
                else:
                    self._send_json({"agent": agent, "model": read_agent_model(agent)})
            elif path == "/api/agent/model/batch":
                # Read config for every fleet agent in one call.
                results = []
                for a in FLEET_ORDER:
                    m = read_agent_model(a)
                    results.append({
                        "agent": a,
                        "provider": m.get("provider") if m else None,
                        "model": m.get("model") if m else None,
                        "fallbacks": m.get("fallbacks") if m else None,
                    })
                self._send_json({"results": results})
            elif path == "/api/agent/skills":
                # 2026-08-01 (DEVELOPPEUR): skills list + enabled state for one
                # agent. Skills = every dir under the profile's skills/ root
                # containing SKILL.md; enabled = name not in skills.disabled
                # (normalised from YAML list OR legacy JSON string).
                agent = parse_qs(parsed.query).get("agent", [""])[0].strip().lower()
                if not _is_fleet_agent(agent):
                    self._send_json({"error": "unknown agent"}, code=400)
                    return
                cfg_path = _profile_config_path(agent)
                if not os.path.exists(cfg_path):
                    self._send_json({"error": "no profile for agent %s" % agent}, code=400)
                    return
                disabled = set(_read_disabled_skills(cfg_path))
                skills = [
                    {"name": name, "enabled": name not in disabled}
                    for name, _ in _discover_profile_skills(agent)
                ]
                self._send_json({"agent": agent, "skills": skills})
            elif path == "/api/state":
                # Aggregated read-only snapshot (agents, fleet, board, etc.).
                # Consumed by the SPA's useApiState() initial fetch; the SSE
                # /events also pushes this same payload every 3s for live
                # updates. Without this endpoint the initial fetch 404s and
                # per-agent fields like the configured model never populate
                # (UI showed "MODÈLE IA: —").
                self._send_json(get_state())
            elif path == "/api/messages/sessions":
                _sq = parse_qs(parsed.query)
                _a = _sq.get("agent", [""])[0].strip().lower()
                if not _is_fleet_agent(_a):
                    self._send_json({"error": "unknown agent"}, code=400)
                    return
                # 2026-08-19 (PILOUBRUCE) : l'historique MC = LA MEME session
                # native Hermes Agent (state.db). On lit donc le store natif
                # directement (_read_native_sessions) au lieu du vieux store
                # MC sessions/<agent>.json (vide -> historique vide).
                _sessions = _read_native_sessions(_a)
                # newest first + attach the live (in-flight) status if any
                _sessions.sort(key=lambda s: s.get("updated_at", 0), reverse=True)
                # POINT 2a (2026-08-01, DEVELOPPEUR): expose provider/model on
                # every session so the chat bubbles can display
                # "provider · model" next to the timestamp. The model is a
                # PROFILE-level fact (read_agent_model), so it is attached per
                # SESSION, not per message. A session that already carries its
                # own persisted provider/model (written at send time) keeps it.
                _cfg = read_agent_model(_a) or {}
                for _s in _sessions:
                    if not _s.get("provider"):
                        _s["provider"] = _cfg.get("provider")
                    if not _s.get("model"):
                        _s["model"] = _cfg.get("model")
                with _MESSAGES_SSE_LOCK:
                    _sse_snapshot = dict(_MESSAGES_SSE)
                with _MESSAGES_LIVE_LOCK:
                    for _s in _sessions:
                        _live = _MESSAGES_LIVE.get((_a, _s.get("id")))
                        _buf = _sse_snapshot.get((_a, _s.get("id")))
                        # FIX (2026-08-21): running derive de l'etat SSE reel
                        # (buf["done"]) et pas du seul dict _MESSAGES_LIVE, qui
                        # peut rester colle a running=True (spinner fantome, BUG C).
                        _running = bool(_live and _live.get("running")) and not bool(_buf and _buf.get("done"))
                        if _running:
                            _s["live"] = {
                                "running": True,
                                "text": _live.get("text", ""),
                                "error": _live.get("error"),
                                "phase": _live.get("phase"),
                            }
                self._send_json({"agent": _a, "sessions": _sessions})
            elif path == "/api/messages/status":
                _sq = parse_qs(parsed.query)
                _a = _sq.get("agent", [""])[0].strip().lower()
                _sid = _sq.get("session_id", [""])[0].strip()
                if not _is_fleet_agent(_a):
                    self._send_json({"error": "unknown agent"}, code=400)
                    return
                with _MESSAGES_LIVE_LOCK:
                    _live = _MESSAGES_LIVE.get((_a, _sid)) or {
                        "running": False, "text": "", "error": None, "ts": 0}
                with _MESSAGES_SSE_LOCK:
                    _buf = _MESSAGES_SSE.get((_a, _sid))
                self._send_json({
                    "agent": _a, "session_id": _sid,
                    # FIX (2026-08-21): idem /api/messages/sessions - un buffer
                    # SSE marque done => la generation est finie, quel que soit
                    # l'etat colle dans _MESSAGES_LIVE.
                    "running": bool(_live.get("running")) and not bool(_buf and _buf.get("done")),
                    "text": _live.get("text", ""),
                    "error": _live.get("error"),
                    "phase": _live.get("phase"),
                })
            elif path == "/events":
                self._serve_sse()
            elif path == "/api/chat/stream":
                # Dedicated SSE endpoint for real-time chat token streaming.
                # Replaces the 1.5s HTTP poll with instant token-by-token push,
                # matching (and exceeding) the built-in Hermes Agent dashboard.
                # Query: ?agent=<agent>&session_id=<sid>
                # Emits: event: token  (data: incremental text block, UTF-8)
                #        event: done   (data: {"error": null|<msg>}) when finished
                #        event: ping   (keepalive every 15s)
                _sq = parse_qs(parsed.query)
                _a = _sq.get("agent", [""])[0].strip().lower()
                _sid = _sq.get("session_id", [""])[0].strip()
                if not _is_fleet_agent(_a):
                    self._send_json({"error": "unknown agent"}, code=400)
                    return
                self._serve_chat_sse(_a, _sid)
            elif path.startswith("/api/files/"):
                # Sert un fichier uploade dans UPLOAD_DIR (attachments des messages).
                # rel = reste du chemin apres "/api/files/".
                self._serve_file(path[len("/api/files/"):])
            elif path.startswith("/api/content/file/"):
                # Sert le binaire d'un fichier de la bibliotheque ~/hermes-docs
                # (PDF, images, etc.) pour ouverture directe dans le navigateur
                # depuis l'onglet CONTENU. Meme garde d'auth + sanitize que
                # read_content_file.
                self._serve_content_file(path[len("/api/content/file/"):])
            elif path.startswith("/api/content/download/"):
                # Comme /api/content/file mais force le telechargement
                # (Content-Disposition: attachment) pour n'importe quel type
                # (PDF, DOC, XLS, MD...) depuis l'icone "Enregistrer".
                self._serve_content_file(path[len("/api/content/download/"):], force_attach=True)
            elif path.startswith("/assets/") or path.endswith(".js") or path.endswith(".css") or path.endswith(".svg") or path.endswith(".png") or path.endswith(".ico"):
                self._serve_static(path)
            elif path == "/api/mc/backup/list":
                try:
                    backups_dir = _mc_backup_dir()
                    backups = []
                    if os.path.isdir(backups_dir):
                        for f in os.listdir(backups_dir):
                            if _MC_BACKUP_RE.match(f):
                                mtime = os.path.getmtime(os.path.join(backups_dir, f))
                                backups.append({"name": f, "size": os.path.getsize(os.path.join(backups_dir, f)), "mtime": mtime})
                    backups.sort(key=lambda x: x["mtime"], reverse=True)
                    self._send_json({"ok": True, "backups": backups})
                except Exception as exc:
                    self._send_json({"ok": False, "error": str(exc)}, code=500)
                return
            elif path.startswith("/api/mc/backup/download/"):
                # GET /api/mc/backup/download/<filename> -> binaire du backup.
                # Le nom est valide par regex (jamais de path traversal).
                filename = path.split("/")[-1]
                if _MC_BACKUP_RE.match(filename):
                    backup_path = os.path.join(_mc_backup_dir(), filename)
                    if os.path.isfile(backup_path):
                        self.send_response(200)
                        self.send_header("Content-Type", "application/octet-stream")
                        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                        self.end_headers()
                        with open(backup_path, "rb") as fh:
                            self.wfile.write(fh.read())
                    else:
                        self._send_json({"ok": False, "error": "fichier inexistant"}, code=404)
                else:
                    self._send_json({"ok": False, "error": "fichier inexistant ou non autorisé"}, code=404)
                return
            # ---- NEW FEATURES (2026-08-05) ----
            # Feature 1: Cron execution logs visible
            elif path.startswith("/api/cron/") and "/logs" in path:
                # /api/cron/:job_id/logs -> execution logs for a cron job
                job_id = path.replace("/api/cron/", "").replace("/logs", "").strip()
                self._send_json(get_cron_execution_logs(job_id))
                return
            elif path == "/api/cron/logs":
                # /api/cron/logs -> logs for all cron executions
                self._send_json(get_cron_all_logs())
                return
            # Feature 4: Notifications
            elif path == "/api/notifications":
                _q = parse_qs(parsed.query)
                _clear = _q.get("clear", ["0"])[0] in ("1", "true", "yes")
                self._send_json(get_notifications(clear=_clear))
                return
            # v1.17.141 - GET ordre des cartes agents (persistance serveur).
            elif path == "/api/fleet/agents_order":
                _cfg = mc_backend.load_config()
                self._send_json({"ok": True, "agents_order": _cfg.get("agents_order", [])})
                return
            else:
                if path.startswith("/api/") or path == "/events":
                    # Route API inconnue : 404 "introuvable". (Avant la
                    # suppression de l'auth, le garde _require_auth() renvoyait
                    # 401 sur ces routes ; l'auth n'existant plus, une API
                    # inexistante doit etre not found, PAS servir le SPA.)
                    self._send_json({"error": "not found"}, code=404)
                else:
                    self._serve_index()
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001
            print("[GET %s] error:" % path, exc)
            try:
                self._send_json({"error": str(exc)}, code=500)
            except Exception:
                pass

    def do_HEAD(self):
        # Mirror GET routing but suppress the response body (RFC 7231), so
        # `curl -I` works for header verification (LOT 8).
        self._head = True
        try:
            self.do_GET()
        finally:
            self._head = False


    def do_DELETE(self):
        # BOB 2026-08-05 : DELETE /api/files?path=<rel> (explorateur RW).
        # + DELETE /api/cron/:id (Planification tab).
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/cron/"):
            # DELETE /api/cron/:id -> cron job deletion
            job_id = parsed.path[len("/api/cron/"):].strip()
            if job_id.startswith("execution/"):
                execution_id = job_id[len("execution/"):].strip()
                res = mc_backend.delete_cron_execution(execution_id)
                self._send_json(res, code=200 if res.get("ok") else 400)
                return
            res = delete_cron_job(job_id)
            self._send_json(res, code=200 if res.get("ok") else 400)
            return
        if parsed.path not in ("/api/files", "/api/files/"):
            self._send_json({"error": "not found"}, code=404)
            return
        _q = parse_qs(parsed.query)
        try:
            self._send_json(mc_backend.fs_delete(_q.get("path", [""])[0]))
        except mc_backend.FsError as _e:
            self._send_json({"ok": False, "error": str(_e)}, code=_e.code)
        except Exception as _e:  # noqa: BLE001
            self._send_json({"ok": False, "error": str(_e)}, code=500)

    def do_PATCH(self):
        # Fix BOB 2026-08-08: PATCH had no handler, so /api/cron/:id always
        # answered HTTP 501 Not Implemented (BaseHTTPRequestHandler's default
        # for an undefined do_PATCH). Frontend updateCron() sends a JSON body
        # parsed exactly like do_POST.
        parsed = urlparse(self.path)
        path = parsed.path
        # Read + parse the JSON body (mirrors do_POST's application/json path).
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            data = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(data, dict):
                data = {}
        except Exception as exc:
            self._send_json({"error": str(exc)}, code=400)
            return
        if path.startswith("/api/cron/"):
            # PATCH /api/cron/:id -> modify existing cron job.
            job_id = path[len("/api/cron/"):].strip()
            res = modify_cron_job(job_id, data)
            self._send_json(res, code=200 if res.get("ok") else 400)
            return
        self._send_json({"error": "not found"}, code=404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            ctype = self.headers.get("Content-Type", "")
            data = {}
            try:
                if "application/json" in ctype:
                    data = json.loads(raw.decode("utf-8") or "{}")
                elif "application/x-www-form-urlencoded" in ctype:
                    data = {k: v[0] for k, v in parse_qs(raw.decode("utf-8")).items()}
                elif "multipart/form-data" in ctype:
                    bm = re.search(r"boundary=([^;]+)", ctype)
                    boundary = bm.group(1).strip().strip('"') if bm else ""
                    data = {"__multipart__": (raw, boundary)}
                else:
                    # try JSON first, fallback to form
                    try:
                        data = json.loads(raw.decode("utf-8") or "{}")
                    except Exception:
                        data = {k: v[0] for k, v in parse_qs(raw.decode("utf-8")).items()}
            except Exception:
                data = {}
        except Exception as exc:
            self._send_json({"error": str(exc)}, code=400)
            return
        try:
            # ---- BOB 2026-08-05 : config / explorateur RW ----
            if path == "/api/config":
                try:
                    self._send_json(mc_backend.save_config(data if isinstance(data, dict) else {}))
                except Exception as _e:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(_e)}, code=400)
                return
            if path == "/api/config/scan_providers":
                try:
                    # Expect {"scan_providers": {"provider1": true, "provider2": false}}
                    if not isinstance(data, dict) or "scan_providers" not in data:
                        self._send_json({"ok": False, "error": "Expected {\"scan_providers\": {...}}"}, code=400)
                        return
                    scan_providers = data["scan_providers"]
                    if not isinstance(scan_providers, dict):
                        self._send_json({"ok": False, "error": "scan_providers must be an object"}, code=400)
                        return
                    # Save the scan_providers config
                    patch = {"scan_providers": scan_providers}
                    self._send_json(mc_backend.save_config(patch))
                except Exception as _e:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(_e)}, code=400)
                return
            if path == "/api/models/refresh":
                # Force a full recompute of the model catalog, bypassing the
                # in-process cache. Lets the UI pick up newly-added providers
                # (config.yaml `providers:` endpoints, fresh `hermes setup`
                # custom endpoints) without restarting the server. READ-ONLY:
                # never touches config.yaml or .env.
                try:
                    _CATALOG_CACHE["data"] = None
                    _payload = read_model_catalog()
                    self._send_json({
                        "ok": True,
                        "providers": len(_payload.get("providers", {})),
                        "models": sum(len(p.get("models", [])) for p in _payload.get("providers", {}).values()),
                    })
                except Exception as _exc:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(_exc)}, code=500)
                return
            # v1.17.141 - agents_order GET/POST (persistance cote serveur pour partager
            # l'ordre entre navigateurs/profils -- localStorage perdu en navigation privee).
            if path == "/api/fleet/agents_order":
                if self.command == "GET":
                    cfg = mc_backend.load_config()
                    self._send_json({"ok": True, "agents_order": cfg.get("agents_order", [])})
                    return
                if self.command == "POST":
                    _order = data.get("agents_order")
                    if not isinstance(_order, list) or not all(isinstance(x, str) for x in _order):
                        self._send_json({"ok": False, "error": "agents_order doit etre un tableau de chaines"}, code=400)
                        return
                    patch = {"agents_order": _order}
                    self._send_json(mc_backend.save_config(patch))
                    return
            if path == "/api/mc/backup/create":
                # POST /api/mc/backup/create -> lance le script de backup complet
                try:
                    timestamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
                    backup_name = f"mc-full-{timestamp}.tar.gz"
                    script_path = os.path.join("/tmp", f"mc-backup-{timestamp}.sh")
                    with open(script_path, "w") as fh:
                        fh.write(_mc_backup_script(backup_name))
                    os.chmod(script_path, 0o700)
                    unit = f"mc-backup-{os.getpid()}-{timestamp}"
                    _mc_spawn_detached(unit, script_path)
                    # reponse immediate : le script en arriere-plan ecrit le log
                    self._send_json({"ok": True, "msg": "backup lance en arriere-plan", "backup_name": backup_name})
                except Exception as exc:
                    self._send_json({"ok": False, "error": str(exc)}, code=500)
                return
            if path == "/api/mc/backup/restore":
                # POST /api/mc/backup/restore {file, confirm:true}
                try:
                    if not isinstance(data, dict):
                        raise ValueError("JSON object attendu")
                    filename = data.get("file")
                    confirm = data.get("confirm")
                    if not filename or not _MC_BACKUP_RE.match(filename):
                        raise ValueError("filename invalide ou manquant")
                    if confirm is not True:
                        raise ValueError("confirmation requise (confirm:true)")
                    backup_path = os.path.join(_mc_backup_dir(), filename)
                    if not os.path.isfile(backup_path):
                        raise FileNotFoundError(f"backup inexistant: {filename}")
                    script_path = os.path.join("/tmp", f"mc-restore-{os.getpid()}-{int(time.time())}.sh")
                    with open(script_path, "w") as fh:
                        fh.write(_mc_restore_script(filename))
                    os.chmod(script_path, 0o700)
                    unit = f"mc-restore-{os.getpid()}-{int(time.time())}"
                    _mc_spawn_detached(unit, script_path)
                    self._send_json({"ok": True, "msg": "restore lance en arriere-plan", "backup_name": filename})
                except Exception as exc:
                    self._send_json({"ok": False, "error": str(exc)}, code=400)
                return
            if path in ("/api/files/upload", "/api/files/rename",
                        "/api/files/mkdir", "/api/files/delete"):
                try:
                    if path == "/api/files/upload":
                        _mp = data.get("__multipart__")
                        if not _mp:
                            self._send_json({"ok": False, "error": "multipart/form-data requis"},
                                            code=400)
                            return
                        _raw, _bnd = _mp
                        _parts = _parse_multipart(_raw, _bnd)
                        _dir = ""
                        if "path" in _parts and _parts["path"]:
                            _dir = _parts["path"][0][1].decode("utf-8", "replace").strip()
                        _files = _parts.get("file") or []
                        if not _files:
                            self._send_json({"ok": False, "error": "champ 'file' manquant"}, code=400)
                            return
                        _res = [mc_backend.fs_upload(_dir, _fn, _body) for _fn, _body in _files]
                        self._send_json({"ok": True, "uploaded": _res})
                    elif path == "/api/files/rename":
                        self._send_json(mc_backend.fs_rename(data.get("old", ""), data.get("new", "")))
                    elif path == "/api/files/mkdir":
                        self._send_json(mc_backend.fs_mkdir(data.get("path", "")))
                    else:
                        self._send_json(mc_backend.fs_delete(
                            data.get("path", ""),
                            bool(data.get("recursive", True))))
                except mc_backend.FsError as _e:
                    self._send_json({"ok": False, "error": str(_e)}, code=_e.code)
                except Exception as _e:  # noqa: BLE001
                    self._send_json({"ok": False, "error": str(_e)}, code=500)
                return
            if path == "/api/mc_favs":
                _ag = str(data.get("agent") or qs.get("agent", [""])[0]).strip()
                _ids = data.get("ids")
                if not _ag or not isinstance(_ids, list):
                    self._send_json({"ok": False, "error": "agent et ids[] requis"}, code=400)
                    return
                _clean = [str(x) for x in _ids if x]
                with _MC_FAVS_LOCK:
                    _all = load_mc_favs()
                    if _clean:
                        _all[_ag] = _clean
                    else:
                        _all.pop(_ag, None)
                    _ok = save_mc_favs(_all)
                self._send_json({"ok": bool(_ok), "ids": _clean}, code=200 if _ok else 500)
                return
            if path == "/api/restart":
                # Restart the MC service itself (detached so we don't kill our own PID).
                try:
                    import subprocess as _sp
                    _sp.Popen(
                        ["systemctl", "--user", "restart", "hermes-mission-control.service"],
                        stdout=_sp.DEVNULL, stderr=_sp.DEVNULL,
                        start_new_session=True,  # own PGID -> survives our termination
                    )
                    self._send_json({"ok": True, "msg": "redemarrage en cours"})
                except Exception as exc:
                    self._send_json({"ok": False, "error": str(exc)}, code=500)
                return
            if path == "/api/scan/blacklist":
                # POST toggle: {provider, model}. If present -> remove, else -> add.
                _bp = str(data.get("provider", "")).strip().lower()
                _bm = str(data.get("model", "")).strip()
                if not _bp or not _bm:
                    self._send_json(
                        {"ok": False, "error": "provider et model requis"}, code=400)
                    return
                _new = _blacklist_toggle(_bp, _bm)
                self._send_json({"ok": True, "blacklist": _new})
                return
            if path == "/api/scan/blacklist/clear":
                # POST clear: {provider} (or ?provider=X) -> wipe that provider's list.
                _cp = str(data.get("provider") or qs.get("provider", [""])[0]).strip().lower()
                _new = _blacklist_clear(_cp)
                self._send_json({"ok": True, "blacklist": _new})
                return
            if path == "/api/scan/results/clear":
                # POINT 3b (2026-08-01): wipe persisted scan results so the
                # "EFFACER LES RESULTATS" button (and the per-row trash) also
                # clears the server-side DB, not just localStorage.
                #   {} -> all | {provider} -> one provider | {provider, model} -> one row
                _dp = str(data.get("provider") or qs.get("provider", [""])[0]).strip().lower() or None
                _dm = str(data.get("model") or qs.get("model", [""])[0]).strip() or None
                _n = _delete_scan_results(_dp, _dm)
                self._send_json({"ok": True, "deleted": _n})
                return
            if path == "/api/fleet/agent/create":
                _key = (str(data.get("key") or "").strip().lower())
                _name = (str(data.get("name") or "").strip())
                _role = (str(data.get("role") or "").strip())
                # Nouveau champ (2026-07-30) : description libre de ce que l'agent
                # doit faire, distincte de la liste de fonctions.
                _mission = (str(data.get("mission") or data.get("description") or "")).strip()
                _functions = (str(data.get("functions") or "").strip() or "à définir.")
                if not _key or not _name or not _role:
                    self._send_json({"ok": False, "error": "key/name/role requis"}, code=400)
                    return
                _safe_key = re.sub(r"[^a-z0-9-]+", "-", _key).strip("-")
                if not _safe_key:
                    self._send_json({"ok": False, "error": "key invalide"}, code=400)
                    return
                if _safe_key in {"manager", "default"}:
                    self._send_json({"ok": False, "error": "cle reservee"}, code=400)
                    return
                # 2026-08-06 (BOB): interdit toute recreation de profil *-mc
                if _safe_key.endswith("-mc"):
                    self._send_json({"ok": False, "error": "suffixe -mc interdit"}, code=400)
                    return
                _profile_dir = os.path.join(PROFILES_DIR, _safe_key)
                try:
                    os.makedirs(_profile_dir, exist_ok=True)
                except Exception as exc:
                    self._send_json({"ok": False, "error": "mkdir: %s" % exc}, code=500)
                    return
                _soul = os.path.join(_profile_dir, "SOUL.md")
                _config_path = os.path.join(_profile_dir, "config.yaml")
                if not os.path.exists(_config_path):
                    _cfg = (
                        "model:\n  provider: nous\n  model: tencent/hy3:free\n"
                    )
                    try:
                        _atomic_write_text(_config_path, _cfg)
                    except Exception:
                        pass
                # Orchestration (2026-07-30, DEVELOPPEUR) : ne PAS generer le
                # SOUL.md ici. On delegue la REDACTION a l'agent redacteur (comme
                # demande par piloubruce) via un subprocess en arriere-plan, qui
                # ecrit le fichier lui-meme en respectant le format commun de la
                # flotte. L'agent Developpeur (ce serveur) ne fait QUE l'integration
                # dashboard, deja assuree par le scan dynamique de profils.
                threading.Thread(
                    target=_redacteur_write_soul,
                    args=(_safe_key, _name, _role, _mission, _functions, _soul),
                    daemon=True,
                ).start()
                self._send_json({
                    "ok": True,
                    "agent": _safe_key,
                    "name": _name,
                    "profile_dir": _profile_dir,
                    "soul": _soul,
                    "note": "Profil cree. Rédaction du SOUL.md déléguée à l'agent Rédacteur (arrière-plan).",
                })
                return

            if path == "/api/fleet/agent/soul-status":
                # Permet au frontend de savoir si le SOUL.md a deja ete redige
                # par le Redacteur (polling leger post-creation).
                _k = (str(data.get("agent") or "").strip().lower())
                _soul = os.path.join(PROFILES_DIR, _k, "SOUL.md")
                _ready = os.path.exists(_soul) and os.path.getsize(_soul) > 200
                self._send_json({"ok": True, "agent": _k, "soul_ready": _ready,
                                 "bytes": os.path.getsize(_soul) if os.path.exists(_soul) else 0})
                return

            if path == "/api/fleet/agent/delete":
                # Suppression d'un agent de la flotte + nettoyage complet du
                # dashboard MC (profil + DB agent-logs/board). Le nettoyage
                # reel est delegue au script scripts/delete_agent.sh lance en
                # arriere-plan (thread daemon) : il fait la sauvegarde dans
                # ~/.hermes/profiles_trash/ AVANT suppression et nettoie les
                # trace dans les DB. manager/default NEVER supprimes.
                _key = (str(data.get("agent") or "").strip().lower())
                if not _key:
                    self._send_json({"ok": False, "error": "agent requis"}, code=400)
                    return
                if _key in {"manager", "default"}:
                    self._send_json({"ok": False, "error": "suppression de %s interdite" % _key}, code=403)
                    return
                _safe_key = re.sub(r"[^a-z0-9_-]+", "-", _key).strip("-")
                if not _safe_key or _safe_key in {"manager", "default"}:
                    self._send_json({"ok": False, "error": "cle invalide"}, code=400)
                    return
                _script = os.path.join(PROJECT_DIR, "scripts", "delete_agent.sh")
                if not os.path.exists(_script):
                    self._send_json({"ok": False, "error": "script de suppression absent"}, code=500)
                    return

                def _run_delete_agent(agent_key):
                    try:
                        _out = subprocess.run(
                            ["bash", _script, agent_key],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, timeout=120,
                        )
                        for _line in (_out.stdout or "").splitlines():
                            _chat_log("delete_agent[%s]: %s" % (agent_key, _line))
                    except Exception as _exc:  # noqa: BLE001
                        _chat_log("delete_agent[%s] ECHEC: %s" % (agent_key, _exc))

                threading.Thread(
                    target=_run_delete_agent, args=(_safe_key,), daemon=True
                ).start()
                self._send_json({
                    "ok": True,
                    "agent": _safe_key,
                    "note": "Suppression lancee en arriere-plan (sauvegarde + nettoyage DB). L'agent disparaitra du dashboard au prochain rafraichissement.",
                })
                return

            elif path == "/api/board":
                ok = board_create(
                    data.get("title", "Sans titre"),
                    data.get("status", "todo"),
                    data.get("priority", "normal"),
                    data.get("notes", ""),
                    data.get("agent", ""),
                )
                self._send_json(ok)
            elif path == "/api/cron":
                res = create_cron_job(data if isinstance(data, dict) else {})
                self._send_json(res, code=200 if res.get("ok") else 400)
            elif path.startswith("/api/cron/"):
                # DELETE / PATCH /api/cron/:id  and  POST /api/cron/:id/run
                raw = path[len("/api/cron/"):].strip()
                # Strip the "/run" action suffix if present so run_cron_now gets the real job_id
                if raw.endswith("/run"):
                    raw = raw[: -len("/run")]
                job_id = raw
                if self.command == "DELETE":
                    res = delete_cron_job(job_id)
                    self._send_json(res, code=200 if res.get("ok") else 400)
                elif self.command == "PATCH":
                    res = modify_cron_job(job_id, data if isinstance(data, dict) else {})
                    self._send_json(res, code=200 if res.get("ok") else 400)
                elif self.command == "POST":
                    # NEW: POST /api/cron/:id/run - Execute cron now
                    # ASYNC (2026-08-09, DEVELOPPEUR): `run_cron_now` lance
                    # `hermes cron run` avec un timeout de 60s bloquant -> le
                    # bouton Exécuter pouvait afficher le popup "timeout lors
                    # de l'execution du cron" sur un agent long, et geler le
                    # thread HTTP. On ne bloque plus : on délègue à un thread
                    # daemon et on répond "accepted" tout de suite. Le suivi
                    # se fait via les logs d'exécution (CronLogsDisplay /
                    # executions.db) qui se rafraîchissent seuls.
                    def _run_async(jid, handler_self):
                        try:
                            run_cron_now(jid)
                        except Exception as _exc:  # ne jamais planter le daemon
                            handler_self.log_message(
                                "run_cron_now thread error for %s: %s", jid, _exc
                            )
                    _t = threading.Thread(
                        target=_run_async,
                        args=(job_id, self),
                        name="mc-cron-run-%s" % job_id,
                        daemon=True,
                    )
                    _t.start()
                    self._send_json(
                        {"ok": True, "accepted": True, "job_id": job_id,
                         "message": "Exécution déclenchée (asynchrone)."},
                        code=202,
                    )
            elif path == "/api/board/update":
                tid = qs.get("id", [None])[0]
                if not tid or not tid.isdigit():
                    self._send_json({"ok": False, "error": "id required"}, code=400)
                    return
                ok = board_update(int(tid), **data)
                self._send_json(ok)
            elif path == "/api/board/delete":
                tid = qs.get("id", [None])[0]
                if not tid or not tid.isdigit():
                    self._send_json({"ok": False, "error": "id required"}, code=400)
                    return
                ok = board_delete(int(tid))
                self._send_json(ok)
            elif path == "/api/agent/model":
                agent = str(data.get("agent", "")).strip().lower()
                provider = str(data.get("provider", "")).strip()
                model = str(data.get("model", "")).strip()
                fallbacks = data.get("fallbacks")
                # Anti-injection: agent must be a real fleet agent.
                if not _is_fleet_agent(agent):
                    self._send_json({"ok": False, "error": "unknown agent: %s" % agent}, code=400)
                    return
                if not provider or not model:
                    self._send_json({"ok": False, "error": "provider and model required"}, code=400)
                    return
                if provider == "__all__" or provider.lower() == "__all__":
                    # Sentinelle "Tous les providers" du picker — jamais un
                    # provider Hermes valide (audit 2026-08-07).
                    self._send_json({"ok": False,
                                     "error": "provider '__all__' invalide : selectionnez un provider reel"},
                                    code=400)
                    return
                ok = set_agent_model(agent, provider, model, fallbacks)
                if not ok:
                    self._send_json({"ok": False,
                                     "error": "cannot write model for agent (no profile?)"}, code=400)
                    return
                self._send_json({"ok": True, "agent": agent,
                                 "model": read_agent_model(agent)})
            elif path == "/api/agent/model/batch":
                # Accept either a list payload {agent,provider,model,...}
                # or a wrapped object {items:[...]}. The frontend modal sends
                # {agents, provider, model}; the GET-format fallback may send list.
                if isinstance(data, dict):
                    _agents = data.get("agents")
                    _global_fb = data.get("fallbacks")
                    if isinstance(_agents, list) and len(_agents):
                        items = [
                            {
                                "agent": str(a).strip().lower(),
                                "provider": str(data.get("provider", "")).strip(),
                                "model": str(data.get("model", "")).strip(),
                                "fallbacks": _global_fb,
                            }
                            for a in _agents
                        ]
                    else:
                        _it = data.get("items")
                        items = _it if isinstance(_it, list) else []
                else:
                    items = data if isinstance(data, list) else []
                results = []
                for item in items:
                    agent = str(item.get("agent", "")).strip().lower()
                    provider = str(item.get("provider", "")).strip()
                    model = str(item.get("model", "")).strip()
                    fallbacks = item.get("fallbacks")
                    if not _is_fleet_agent(agent):
                        results.append({"ok": False, "agent": agent,
                                        "error": "unknown agent"})
                        continue
                    if not provider or not model:
                        results.append({"ok": False, "agent": agent,
                                        "error": "provider and model required"})
                        continue
                    ok = set_agent_model(agent, provider, model, fallbacks)
                    if not ok:
                        results.append({"ok": False, "agent": agent,
                                        "error": "cannot write model (no profile?)"})
                    else:
                        results.append({"ok": True, "agent": agent})
                self._send_json({"results": results})
            elif path == "/api/agent/skills/toggle":
                # 2026-08-01 (DEVELOPPEUR): enable/disable ONE skill for ONE
                # agent. Adds/removes the name from skills.disabled and rewrites
                # the block as a REAL YAML list (never a JSON string). Backup of
                # config.yaml before any write. Anti-injection: agent must be a
                # fleet agent; skill must be an existing leaf skill dir name
                # (no path separators, no '..', resolved against the profile).
                agent = str(data.get("agent", "")).strip().lower()
                skill = str(data.get("skill", "")).strip()
                enabled = bool(data.get("enabled", True))
                if not _is_fleet_agent(agent):
                    self._send_json({"ok": False, "error": "unknown agent: %s" % agent}, code=400)
                    return
                if not skill or ".." in skill or "/" in skill or "\\" in skill:
                    self._send_json({"ok": False, "error": "invalid skill name"}, code=400)
                    return
                cfg_path = _profile_config_path(agent)
                if not os.path.exists(cfg_path):
                    self._send_json({"ok": False, "error": "no profile for agent %s" % agent}, code=400)
                    return
                known = dict(_discover_profile_skills(agent))
                if skill not in known:
                    self._send_json({"ok": False, "error": "unknown skill: %s" % skill}, code=400)
                    return
                disabled = _read_disabled_skills(cfg_path)
                if enabled:
                    disabled = [d for d in disabled if d != skill]
                else:
                    if skill not in disabled:
                        disabled.append(skill)
                disabled = sorted(set(disabled))
                _backup_config(cfg_path)
                if not _write_disabled_skills(cfg_path, disabled):
                    self._send_json({"ok": False, "error": "cannot write config for %s" % agent}, code=400)
                    return
                self._send_json({"ok": True, "disabled": disabled})
            elif path == "/api/messages/send":
                _a = (data.get("agent") or "").strip().lower()
                if not _is_fleet_agent(_a):
                    self._send_json({"error": "unknown agent"}, code=400)
                    return
                _text = (data.get("text") or "").strip()
                # Resolve attachments up-front so an empty text is still valid
                # when at least one file is attached (send image with no text).
                _files = [f for f in (data.get("files") or []) if isinstance(f, str)]
                if not _text and not _files:
                    self._send_json({"error": "texte vide (ni message ni piece jointe)"}, code=400)
                    return
                # Use the caller's session_id if provided (reply inside an
                # existing conversation) — otherwise mint a fresh dashboard
                # session id. The Hermes persistent session (for --resume) is
                # resolved separately inside the background thread.
                _provided = (data.get("session_id") or "").strip()
                # FIX (2026-08-21): le front recoit des ids NATIFS depuis
                # /api/messages/sessions. Si le caller repasse un id natif,
                # c'est LA session Hermes a reprendre : on l'auto-mappe
                # (mc_sid == hermes_sid) au lieu de repartir FRESH.
                if _provided and _RE_HERMES_SID.match(_provided):
                    _key = "%s|%s" % (_a, _provided)
                    with _MC_SESSION_MAP_LOCK:
                        _MC_SESSION_MAP.setdefault(_key, _provided)
                    _save_mc_session_map()
                _sid = _provided if _provided else (
                    "msg_%d_%s" % (int(time.time() * 1000), secrets.token_hex(4))
                )
                # IDEMPOTENCE (debug 2026-07-28): refuse a 2nd concurrent send for
                # the SAME (agent, sid). A double-send (double-click / Enter+bouton
                # / React re-render) would spawn a 2nd worker that re-persists the
                # user turn -> duplicate user bubbles (and a racy session file).
                # If a worker is already running for this session, just return the
                # existing sid without launching another. The client keeps polling.
                with _MESSAGES_LIVE_LOCK:
                    _already = _MESSAGES_LIVE.get((_a, _sid))
                    if _already is not None and _already.get("running"):
                        self._send_json(
                            {"ok": True, "agent": _a, "session_id": _sid,
                             "duplicate": True})
                        return
                # persist=False => run the agent + keep live status, but DO NOT
                # write the session into the agent's message history (used by
                # board task execution so a task never shows up in MESSAGES).
                _persist = bool(data.get("persist", True))
                threading.Thread(
                    target=_messages_send_bg,
                    args=(_a, _sid, _text, _files, _persist),
                    daemon=True,
                ).start()
                self._send_json({"ok": True, "agent": _a, "session_id": _sid})
            elif path == "/api/messages/resolve-native":
                # FIX (2026-08-22) : le front recoit le mc_sid (msg_…) de
                # /api/messages/send, MAIS la session native creee par le worker
                # a un id DIFFERENT (20260822_…). Le front doit ouvrir EXACTEMENT
                # la session native => il interroge ce endpoint pour resoudre le
                # mc_sid en id natif via _MC_SESSION_MAP (peuple dans le worker,
                # agent|mc_sid -> natif, cf. L9464).
                _a = (data.get("agent") or "").strip().lower()
                _mc = (data.get("mc_sid") or "").strip()
                _nat = None
                if _a and _mc:
                    with _MC_SESSION_MAP_LOCK:
                        _nat = _MC_SESSION_MAP.get("%s|%s" % (_a, _mc))
                self._send_json({"agent": _a, "mc_sid": _mc,
                                 "native_session_id": _nat})
            elif path == "/api/messages/cancel":
                # Feature 5 (Annuler) : stoppe la generation EN COURS pour un
                # agent + session precise. Tue UNIQUEMENT le groupe de process
                # de CETTE session (start_new_session=True au spawn => le
                # hermes chat et ses enfants sont dans un pgid dedie). Aucun
                # autre agent / session n'est touche.
                _a = (data.get("agent") or "").strip().lower()
                if not _is_fleet_agent(_a):
                    self._send_json({"error": "unknown agent"}, code=400)
                    return
                _sid = (data.get("session_id") or "").strip()
                if not _sid:
                    self._send_json({"error": "session_id requis"}, code=400)
                    return
                # FIX (2026-08-21): unification d'ids -> le front peut envoyer un
                # id NATIF (20260821_…) alors que le worker est indexé par le mc_sid
                # (msg_…). Si la clé directe n'existe pas, on résout le mc_sid via
                # _MC_SESSION_MAP (agent|mc_sid -> natif) pour annuler la bonne session.
                key = (_a, _sid)
                with _MESSAGES_LIVE_LOCK:
                    _direct = (_a, _sid) in _MESSAGES_LIVE
                if not _direct:
                    with _MC_SESSION_MAP_LOCK:
                        _map = dict(_MC_SESSION_MAP)
                    for _k, _v in _map.items():
                        if _k.startswith(_a + "|") and _v == _sid and _k.split("|", 1)[1].startswith("msg_"):
                            key = (_a, _k.split("|", 1)[1])
                            break
                cancelled = False
                with _MESSAGES_LIVE_LOCK:
                    entry = _MESSAGES_LIVE.get(key)
                    if entry and entry.get("running") and entry.get("proc") is not None:
                        proc = entry["proc"]
                        # Tente killpg (groupe complet) puis repli proc.kill().
                        try:
                            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                        except Exception:
                            try:
                                proc.kill()
                            except Exception:
                                pass
                        # Pose le drapeau : le worker, en finissant, marquera
                        # l'erreur "annule par l'utilisateur" et conservera le
                        # texte deja capture. Nettoyage du proc pour eviter un
                        # handle mort dans le statut live.
                        entry["proc"] = None
                        cancelled = True
                if cancelled:
                    with _MESSAGES_CANCELLED_LOCK:
                        _MESSAGES_CANCELLED[key] = True
                self._send_json({"ok": True, "cancelled": cancelled})
            elif path == "/api/messages/delete":
                _a = (data.get("agent") or "").strip().lower()
                if not _is_fleet_agent(_a):
                    self._send_json({"error": "unknown agent"}, code=400)
                    return
                _ids = data.get("session_ids") or []
                _removed = _delete_agent_sessions(_a, _ids)
                self._send_json({"ok": True, "removed": _removed})
            elif path in ("/api/messages/message/delete",
                          "/api/messages/message/edit",
                          "/api/messages/attachment/delete"):
                # ---- Edition fine de l'historique (2026-08-02) --------------
                # Permet de supprimer un message individuel, d'editer le texte
                # d'un message user, ou de retirer une piece jointe. Le fichier
                # sessions/<agent>.json est relu par --resume : modifier ces
                # entrees change reellement le cours de la discussion.
                _a = (data.get("agent") or "").strip().lower()
                if not _is_fleet_agent(_a):
                    self._send_json({"error": "unknown agent"}, code=400)
                    return
                _sid = (data.get("session_id") or "").strip()
                try:
                    _idx = int(data.get("message_index"))
                except (TypeError, ValueError):
                    self._send_json({"error": "message_index invalide"}, code=400)
                    return
                _sessions = _read_agent_sessions(_a)
                _sess = next((s for s in _sessions if s.get("id") == _sid), None)
                if _sess is None:
                    self._send_json({"error": "session inconnue"}, code=404)
                    return
                _msgs = _sess.get("messages") or []
                if _idx < 0 or _idx >= len(_msgs):
                    self._send_json({"error": "message_index hors bornes"}, code=400)
                    return
                _resp = {"ok": True}
                if path == "/api/messages/message/delete":
                    _msgs.pop(_idx)
                    _resp["removed"] = True
                elif path == "/api/messages/message/edit":
                    _msg = _msgs[_idx]
                    if (_msg.get("role") or "") != "user":
                        self._send_json({"error": "seuls les messages user sont editables"}, code=400)
                        return
                    _msg["text"] = data.get("text") or ""
                    _files = data.get("files")
                    if isinstance(_files, list):
                        _msg["attachments"] = _files
                    _msg["edited_at"] = int(time.time())
                    _resp["edited"] = True
                else:  # /api/messages/attachment/delete
                    _ap = data.get("attachment_path") or ""
                    _atts = _msgs[_idx].get("attachments") or []
                    _kept = [x for x in _atts if x != _ap]
                    _msgs[_idx]["attachments"] = _kept
                    _resp["removed"] = len(_kept) != len(_atts)
                _sess["messages"] = _msgs
                _sess["message_count"] = len(_msgs)
                _sess["updated_at"] = int(time.time())
                _write_agent_sessions(_a, _sessions)
                self._send_json(_resp)
            elif path == "/api/messages/upload":
                import base64, binascii
                _raw = data.get("file")
                _name = _safe_filename((data.get("name") or "upload.bin"))
                if not _raw:
                    self._send_json({"error": "no file"}, code=400)
                    return
                try:
                    _b = base64.b64decode(_raw, validate=True)
                except (binascii.Error, ValueError):
                    self._send_json({"error": "bad base64"}, code=400)
                    return
                os.makedirs(UPLOAD_DIR, exist_ok=True)
                _dest = os.path.join(UPLOAD_DIR, _name)
                # avoid clobber
                if os.path.exists(_dest):
                    _dest = os.path.join(UPLOAD_DIR, "%d_%s" % (int(time.time()), _name))
                with open(_dest, "wb") as _fh:
                    _fh.write(_b)
                _chat_log("messages upload -> %s (%d bytes)" % (_dest, len(_b)))
                self._send_json({"ok": True, "path": _dest, "name": _name, "size": len(_b)})
            if path == "/api/notifications/add":
                # Feature 4: Add a notification (POST)
                _type = str(data.get("type", "info")).lower()
                if _type not in ("success", "error", "warning", "info"):
                    _type = "info"
                _title = str(data.get("title", "Notification"))
                _msg = str(data.get("message", ""))
                _agent = str(data.get("agent", "")) or None
                mc_backend.add_notification(_type, _title, _msg, _agent)
                self._send_json({"ok": True})
                return
            elif path == "/api/notifications":
                _q = parse_qs(parsed.query)
                _clear = _q.get("clear", ["0"])[0] in ("1", "true", "yes")
                self._send_json(mc_backend.get_notifications(clear=_clear))
                return
            elif path == "/api/notifications/clear":
                # Efface des notifs côté serveur (ids=None => tout).
                _ids = data.get("ids")
                self._send_json(mc_backend.clear_notifications(_ids))
                return
            else:
                self._send_text("Not Found", code=404)
        except Exception as exc:  # noqa: BLE001
            print("[POST %s] error:" % path, exc)
            self._send_json({"error": str(exc)}, code=500)

    # ---- React build (dist/) ----
    def _serve_index(self):
        dist_dir = os.path.join(PROJECT_DIR, "dist")
        index_path = os.path.join(dist_dir, "index.html")
        try:
            with open(index_path, "r", encoding="utf-8") as f:
                html = f.read()
            # Cache-busting: stamp the built assets with a build-time query so a
            # stale index.html can never pin an obsolete hashed bundle (LOT 8).
            build_ts = int(time.time())
            html = re.sub(r'(src="(/assets/[^"]+\.js))"',
                          r'\1?v=%d"' % build_ts, html)
            html = re.sub(r'(href="(/assets/[^"]+\.css))"',
                          r'\1?v=%d"' % build_ts, html)
        except Exception:
            html = INDEX_PLACEHOLDER
        self._send_html(html)

    def _serve_file(self, rel):
        # Sert un fichier (attachments du chat) via HTTP depuis UPLOAD_DIR ou
        # IMAGES_GEN_DIR. On ne construit JAMAIS le chemin a partir du rel direct
        # : on ne garde que le basename, donc aucune traversee de repertoire
        # (pas de "../" possible). Recherche dans UPLOAD_DIR d'abord, puis
        # IMAGES_GEN_DIR. 404 si introuvable dans les deux.
        # Nettoyage du rel demande (decode les %20 etc., garde le nom de fichier).
        rel = unquote(rel)
        name = _safe_filename(os.path.basename(rel))
        if not name or name in (".", ".."):
            self._send_text("Forbidden", code=403)
            return
        full = None
        for root in _SERVE_ROOTS:
            cand = os.path.join(os.path.normpath(root), name)
            if os.path.isfile(cand):
                full = cand
                break
        if not full:
            self._send_text("Not Found", code=404)
            return
        # Type MIME : image -> image/* pour affichage inline, sinon octet-stream.
        ctype, _ = mimetypes.guess_type(full)
        is_image = bool(ctype) and ctype.startswith("image/")
        if not ctype:
            ctype = "application/octet-stream"
        # Content-Disposition : image inline (vignette/clic ouvrant l'image),
        # tout le reste en telechargement force (attachment).
        disp_name = _safe_filename(os.path.basename(full))
        if is_image:
            content_disp = "inline; filename=\"%s\"" % disp_name
        else:
            content_disp = "attachment; filename=\"%s\"" % disp_name
        try:
            size = os.path.getsize(full)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", content_disp)
            # Anti-cache : on force la revalidation (un attachment peut changer).
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if getattr(self, "_head", False):
                return
            # Streaming par chunks (evite de charger un gros fichier en memoire).
            with open(full, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile)
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001
            print("[_serve_file] error:", exc)
            try:
                self._send_text("Internal Server Error", code=500)
            except Exception:
                pass

    def _serve_content_file(self, rel, force_attach=False):
        # Sert le binaire d'un fichier de ~/hermes-docs (PDF, images, etc.)
        # pour ouverture directe dans le navigateur depuis l'onglet CONTENU.
        # Meme sanitize que read_content_file (anti-path-traversal).
        # force_attach=True -> Content-Disposition: attachment (telechargement)
        # quel que soit le type (icone "Enregistrer").
        rel = unquote(rel)
        if not rel or ".." in rel.split("/") or rel.startswith("/"):
            self._send_text("Forbidden", code=403)
            return
        root = os.path.expanduser("~/hermes-docs")
        full = os.path.normpath(os.path.join(root, rel))
        if not full.startswith(os.path.normpath(root)) or not os.path.isfile(full):
            self._send_text("Not Found", code=404)
            return
        ctype, _ = mimetypes.guess_type(full)
        if not ctype:
            ctype = "application/octet-stream"
        # PDF et images : inline (ouverture/affichage dans l'onglet navigateur).
        # Le reste : attachment (telechargement).
        disp_name = _safe_filename(os.path.basename(full))
        if force_attach:
            content_disp = "attachment; filename=\"%s\"" % disp_name
        elif ctype in ("application/pdf",) or ctype.startswith("image/"):
            content_disp = "inline; filename=\"%s\"" % disp_name
        else:
            content_disp = "attachment; filename=\"%s\"" % disp_name
        try:
            size = os.path.getsize(full)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(size))
            self.send_header("Content-Disposition", content_disp)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            if getattr(self, "_head", False):
                return
            with open(full, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile)
        except BrokenPipeError:
            pass
        except Exception as exc:  # noqa: BLE001
            print("[_serve_content_file] error:", exc)

    def _serve_static(self, path):
        dist_dir = os.path.join(PROJECT_DIR, "dist")
        rel = path.lstrip("/").split("?", 1)[0]
        full = os.path.normpath(os.path.join(dist_dir, rel))
        if not full.startswith(os.path.normpath(dist_dir)):
            self._send_text("Forbidden", code=403)
            return
        ctype = "application/octet-stream"
        if rel.endswith(".js"):
            ctype = "text/javascript; charset=utf-8"
        elif rel.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        elif rel.endswith(".svg"):
            ctype = "image/svg+xml"
        elif rel.endswith(".png"):
            ctype = "image/png"
        elif rel.endswith(".ico"):
            ctype = "image/x-icon"
        try:
            with open(full, "rb") as fh:
                body = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            # Anti-cache strict: never keep a dead bundle (LOT 8). no-store empêche
            # le navigateur de servir un JS périmé sans revalidation.
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not getattr(self, "_head", False):
                self.wfile.write(body)
        except Exception:
            self._send_text("Not Found", code=404)

    # ---- SSE ----
    def _serve_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        if getattr(self, "_head", False):
            return  # HEAD: headers only, no streaming body
        # Abonnement au broadcast mutualise : la boucle serveur (_sse_broadcast_loop)
        # calcule get_state() UNE fois par tick et alimente cette file. On ne fait
        # plus AUCUN calcul ici (audit 2026-08-07 : le state etait recalcule par
        # client toutes les 3s, ~0.8s de CPU chacun sous GIL).
        q: queue.Queue = queue.Queue(maxsize=100)
        _sse_register(q)
        try:
            while True:
                try:
                    chunk = q.get(timeout=SSE_INTERVAL)
                except queue.Empty:
                    # Keepalive : certains proxys coupent un flux silencieux.
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                self.wfile.write(chunk.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            _sse_unregister(q)


    def _serve_chat_sse(self, agent: str, sid: str):
        """Stream chat tokens for (agent, sid) over Server-Sent Events.

        Behaviour:
        - On connect, flush any backlog already buffered in _MESSAGES_SSE
          (anti-coupure: client can attach mid-generation and still receive
          every token emitted so far).
        - Then block on the per-session threading.Event; each token pushed by
          the worker wakes us and we forward it as `event: token`.
        - `event: done` is sent (with an optional error field) when the worker
          finishes, then the connection closes cleanly.
        - A `event: ping` keepalive is sent every 15s so proxies do not drop
          the idle connection between tokens.
        Route servie sans garde d'auth (auth supprimee 2026-08-09).
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        # Disable proxy buffering for this long-lived stream.
        self.send_header("Proxy-Window-Size", "1")
        self.end_headers()
        if getattr(self, "_head", False):
            return  # HEAD: headers only

        key = (agent, sid)
        # Ensure a buffer exists even if the worker has not started yet.
        with _MESSAGES_SSE_LOCK:
            buf = _MESSAGES_SSE.get(key)
            if buf is None:
                buf = {"chunks": collections.deque(), "event": threading.Event(),
                       "done": False, "error": None}
                _MESSAGES_SSE[key] = buf

        def _emit(event: str, data: str):
            # SSE requires UTF-8 and no embedded newlines in `data:` lines.
            safe = data.replace("\r\n", "\n").replace("\r", "\n")
            # Multi-line data: prefix each line with "data: ".
            lines = safe.split("\n")
            payload = "".join("data: %s\n" % ln for ln in lines)
            frame = "event: %s\n%s\n" % (event, payload)
            try:
                self.wfile.write(frame.encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                raise

        # 1) Flush backlog accumulated before the client connected.
        with _MESSAGES_SSE_LOCK:
            while buf["chunks"]:
                chunk = buf["chunks"].popleft()
                if chunk:
                    _emit("token", chunk)
            already_done = buf["done"]
            if already_done:
                _emit("done", json.dumps({"error": buf["error"]}, ensure_ascii=False))
                return

        # 2) Live loop: wait for tokens or completion.
        try:
            last_ping = time.time()
            while True:
                buf["event"].wait(timeout=15.0)
                with _MESSAGES_SSE_LOCK:
                    buf["event"].clear()
                    # Drain all queued chunks in order.
                    while buf["chunks"]:
                        chunk = buf["chunks"].popleft()
                        if chunk:
                            _emit("token", chunk)
                    if buf["done"]:
                        _emit("done", json.dumps({"error": buf["error"]}, ensure_ascii=False))
                        return
                # Keepalive if idle for a while.
                if time.time() - last_ping >= 15.0:
                    _emit("ping", "")
                    last_ping = time.time()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            # Best-effort cleanup so the dict does not grow unbounded; only
            # drop the buffer if it is already finished (no more tokens coming).
            with _MESSAGES_SSE_LOCK:
                live = _MESSAGES_SSE.get(key)
                if live is not None and live["done"]:
                    _MESSAGES_SSE.pop(key, None)


INDEX_PLACEHOLDER = """<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8">
<title>Hermes Mission Control</title></head>
<body style="font-family:system-ui;background:#0b0f17;color:#e6e6e6;padding:2rem">
<h1>Hermes Mission Control</h1>
<p>Backend operationnel. UI construite a l'etape suivante.</p>
<p>Endpoints: <code>GET /api/state</code>, <code>GET /events</code>, <code>GET /api/board</code>.</p>
</body></html>"""


# ---------------------------------------------------------------------------
# MESSAGES (onglet Discussion) — chat per-agent, cote serveur decouple du navigateur
# ---------------------------------------------------------------------------
# Objectif anti-fantome / anti-coupure (exigence piloubruce 2026-07-24) :
#   - L'envoi lance un SOUS-PROCESS hermes chat EN ARRIERE-PLAN (thread daemon).
#   - Le subprocess tourne COTE SERVEUR : changer d'onglet/agent ne l'interrompt JAMAIS.
#   - La reponse est stockee PROGRESSIVEMENT dans _MESSAGES_LIVE (memoire serveur)
#     et ecrite dans le fichier de session (sessions/<agent>.json) UNIQUEMENT A LA FIN.
#   - Une session n'est creee en BDD que terminee -> ZERO fantome.
#   - Au retour sur l'agent, le front relit _MESSAGES_LIVE (ou le fichier) -> reponse
#     COMPLETE, jamais coupee.
_MESSAGES_DIR = SESSIONS_DIR  # reuse ~/agent-mission-control/sessions/
_MESSAGES_LIVE = {}        # (agent, sid) -> {"running":bool,"text":str,"error":str|None,"ts":float,"proc":Popen|None}

# ---------------------------------------------------------------------------
# MC Dedicated Messages Database (BUG MC FIX)
# ---------------------------------------------------------------------------
# A separate SQLite database for Mission Control message history, avoiding
# WAL contention on the shared state.db when the Telegram gateway and CLI
# both access it concurrently. No --resume on state.db for MC conversations.
_MC_MESSAGES_DB = MC_MESSAGES_DB
_MC_MESSAGES_LOCK = threading.Lock()

def _init_mc_messages_db():
    """Initialize the MC messages database with table and index."""
    try:
        conn = sqlite3.connect(_MC_MESSAGES_DB, timeout=30.0)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent TEXT NOT NULL,
                mc_sid TEXT NOT NULL,
                role TEXT NOT NULL,
                text TEXT,
                ts REAL NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mc_messages ON messages (agent, mc_sid, id)")
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"[mc_messages_db] init failed: {e}")

_init_mc_messages_db()

def _read_mc_messages(agent: str, mc_sid: str, limit: int = 30) -> list:
    """Read the last N turns from mc_messages.db for (agent, mc_sid).
    
    Returns list of dicts with keys: role, text (in order: oldest first).
    """
    try:
        conn = sqlite3.connect(_MC_MESSAGES_DB, timeout=30.0)
        conn.row_factory = sqlite3.Row
        cursor = conn.execute(
            "SELECT role, text FROM messages WHERE agent = ? AND mc_sid = ? ORDER BY id ASC LIMIT ?",
            (agent, mc_sid, limit)
        )
        rows = [dict(row) for row in cursor.fetchall()]
        conn.close()
        return rows
    except Exception as e:
        _chat_log(f"[mc_messages] read failed: {e}")
        return []

def _write_mc_message(agent: str, mc_sid: str, role: str, text: str):
    """Write a message turn to mc_messages.db."""
    try:
        conn = sqlite3.connect(_MC_MESSAGES_DB, timeout=30.0)
        conn.execute(
            "INSERT INTO messages (agent, mc_sid, role, text, ts) VALUES (?, ?, ?, ?, ?)",
            (agent, mc_sid, role, text, time.time())
        )
        conn.commit()
        conn.close()
    except Exception as e:
        _chat_log(f"[mc_messages] write failed: {e}")


_MESSAGES_LIVE_LOCK = threading.Lock()
# Feature 5 (Annuler): drapeau par session pour que le worker, a la fin du
# stream, sache qu'il a ete tue volontairement et marque "annule par
# l'utilisateur" (au lieu d'une erreur generique). Cible UNIQUEMENT cette
# session (agent, sid) -> True, jamais globale.
_MESSAGES_CANCELLED = {}   # (agent, sid) -> True
_MESSAGES_CANCELLED_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# MC Session -> Hermes Session mapping (OPTION A - persistent --resume)
# ---------------------------------------------------------------------------
# Le dashboard MC envoie des messages avec un mc_sid genere par le frontend
# (format: msg_<ts>_<hex>). Pour que le modele se souvienne de l'historique,
# on doit mapper chaque (agent, mc_sid) vers une vraie session Hermes qui
# persistera entre les messages. Ce mapping est stocke sur disque pour survivre
# au redemarrage du serveur.
_MC_SESSION_MAP_FILE = os.path.join(PROJECT_DIR, "mc_session_map.json")
# (agent, mc_sid) -> hermes_sid
_MC_SESSION_MAP = {}  # in-memory cache
_MC_SESSION_MAP_LOCK = threading.Lock()


def _load_mc_session_map():
    """Load the MC session -> Hermes session mapping from disk (in-memory cache)."""
    try:
        with open(_MC_SESSION_MAP_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh) or {}
        if isinstance(data, dict):
            with _MC_SESSION_MAP_LOCK:
                for key, val in data.items():
                    if isinstance(val, str) and _RE_HERMES_SID.match(val):
                        _MC_SESSION_MAP[key] = val
    except (OSError, ValueError):
        pass


def _save_mc_session_map():
    """Persist the MC session mapping to disk (best effort)."""
    with _MC_SESSION_MAP_LOCK:
        data = dict(_MC_SESSION_MAP)
    try:
        tmp = _MC_SESSION_MAP_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp, _MC_SESSION_MAP_FILE)
    except OSError as exc:
        _chat_log("MC session map save failed: %s" % exc)


def _bootstrap_mc_session(agent: str, mc_sid: str):
    """Create a new Hermes session for (agent, mc_sid) and return its real id.

    This is called once per (agent, mc_sid) pair. The bootstrap runs a fresh
    `hermes chat -p <agent>-mc -q "init session" -Q` to create the session, then
    captures the real session id from `hermes sessions list -p <agent>-mc`.
    """
    hermes_bin = _resolve_hermes_bin()
    chat_env = _chat_env()
    eff_model, eff_provider = _resolve_effective_model(agent, None, None)
    cmd = [hermes_bin, "chat", "-p", _hermes_profile(agent), "-q",
           "init session (MC persistent memory)", "-Q"]
    if eff_model:
        cmd += ["-m", eff_model]
    if eff_provider:
        cmd += ["--provider", eff_provider]
    _chat_log("MC bootstrap agent=%s mc_sid=%s (model=%s provider=%s)"
              % (agent, mc_sid, eff_model, eff_provider))
    try:
        rc, out, err = _run_capture(cmd, chat_env, timeout=400)
    except Exception as exc:
        _chat_log("MC bootstrap subprocess error agent=%s: %s" % (agent, exc))
        return None
    if rc != 0:
        _chat_log("MC bootstrap rc=%s stderr=%r"
                  % (rc, (err or "")[:500]))
        return None
    new_sid = _query_session_list(agent)
    if not new_sid:
        _chat_log("MC bootstrap: could not resolve new session id for agent=%s" % agent)
        return None
    if not _RE_HERMES_SID.match(new_sid):
        _chat_log("MC bootstrap: invalid session id format: %s" % new_sid)
        return None
    # Store the mapping
    key = "%s|%s" % (agent, mc_sid)
    with _MC_SESSION_MAP_LOCK:
        _MC_SESSION_MAP[key] = new_sid
    _save_mc_session_map()
    _chat_log("MC bootstrap ok agent=%s mc_sid=%s -> hermes_sid=%s" % (agent, mc_sid, new_sid))
    return new_sid


def _ensure_persistent_session(agent: str, mc_sid: str):
    """Return the cached Hermes session id for (agent, mc_sid), or None.

    FIX 2026-08-20 (non-bloquant) : on ne bootstrap PLUS ici. Le bootstrap
    lanceait `hermes chat -Q` qui peut TIMEOUT (provider lent type omni-route /
    mistral) -> bloquait l'envoi et jamais le map n'etait sauve -> retombait en
    FRESH -> recréait une session native à chaque message (bug '4 questions =
    4 sessions'). A la place, le worker cree la session native au 1er message
    (FRESH) puis recupere son sid et le sauve dans le map (voir
    _messages_send_bg). Les messages suivants (meme mc_sid) reprennent via
    --resume.
    """
    # Check in-memory cache
    key = "%s|%s" % (agent, mc_sid)
    with _MC_SESSION_MAP_LOCK:
        if key in _MC_SESSION_MAP:
            cached_sid = _MC_SESSION_MAP[key]
            if cached_sid and _RE_HERMES_SID.match(cached_sid):
                return cached_sid
    # Load from disk (in case of server restart)
    _load_mc_session_map()
    with _MC_SESSION_MAP_LOCK:
        if key in _MC_SESSION_MAP:
            cached_sid = _MC_SESSION_MAP[key]
            if cached_sid and _RE_HERMES_SID.match(cached_sid):
                return cached_sid
    return None


def _messages_file(agent: str) -> str:
    os.makedirs(_MESSAGES_DIR, exist_ok=True)
    return os.path.join(_MESSAGES_DIR, "%s.json" % agent)


# ---------------------------------------------------------------------------
# NATIVE HISTORY (2026-08-19) : l'historique MC = LA MEME session native
# Hermes Agent (~/.hermes/state.db pour manager/default, ou
# ~/.hermes/profiles/<profil>/state.db pour les autres). On lit ce store
# DIRECTEMENT (helper _profile_state_db_path deja present) au lieu du vieux
# store MC sessions/<agent>.json qui etait vide -> historique vide dans l'onglet.
# Cela garanti l'identite parfaite MC == Hermes Agent demandee par piloubruce.
# ---------------------------------------------------------------------------
def _read_native_sessions(agent: str):
    """Lit toutes les sessions natives de l'agent depuis son state.db natif.

    Repli sur l'ancien store MC (sessions/<agent>.json) si le state.db natif
    est absent ou illisible. Renvoie une liste de dicts au format MC
    (MessageSession). Sessions triees du plus recent au plus ancien.
    """
    db = _profile_state_db_path(agent)
    if not os.path.exists(db):
        return _read_agent_sessions(agent)
    try:
        con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
        con.row_factory = sqlite3.Row
        rows = con.execute(
            "SELECT * FROM sessions ORDER BY last_activity_at DESC, "
            "started_at DESC"
        ).fetchall()
        out = []
        for srow in rows:
            s = dict(srow)
            sid = s.get("id")
            mrows = con.execute(
                "SELECT * FROM messages WHERE session_id=? AND active=1 "
                "ORDER BY timestamp ASC",
                (sid,),
            ).fetchall()
            msgs = []
            for mr in mrows:
                m = dict(mr)
                role = (m.get("role") or "").lower()
                # store natif: user / assistant / tool. MC attend user|agent.
                if role == "user":
                    disp = "user"
                elif role in ("assistant", "agent"):
                    disp = "agent"
                else:
                    # tool / system: on les masque de l'affichage MC
                    continue
                # FIX (2026-08-26): le store natif Hermes separe le texte
                # final (`content`) du fil de travail/reflexion (`reasoning`
                # ou `reasoning_content`). Pour de nombreux agents (ex.
                # recherche) TOUTES les etapes intermediaires n'ont QUE du
                # reasoning et un `content` VIDE -> la bulle agent apparaissait
                # vide dans MC ("petits traits, marque AGENT, rien dedans")
                # alors que le dashboard natif Hermes affiche tout.
                # On renvoie le `content` final en clair, et on emballe le
                # `reasoning` dans des balises <thinking>...</thinking> pour
                # que le FRONT (AgentMessageBody / parseAgentText) le place
                # dans sa section repliable "Reflexion / commandes (N)"
                # (clic sur le ▸). Comme ca : le rapport final reste toujours
                # visible, et le fil de travail est deroulable si besoin.
                _content = m.get("content") or ""
                _reasoning = m.get("reasoning_content") or m.get("reasoning") or ""
                if _reasoning:
                    # Emballe le reasoning en balise thinking reconnue du front.
                    _think = "<thinking>\n" + _reasoning + "\n</thinking>"
                    text = (_content + "\n\n" + _think) if _content else _think
                else:
                    text = _content or ""
                msgs.append({
                    "role": disp,
                    "text": text,
                    "ts": m.get("timestamp") or 0,
                    "attachments": [],
                })
            created = (s.get("started_at") or 0)
            updated = (s.get("last_activity_at") or s.get("ended_at")
                       or created or 0)
            out.append({
                "id": sid,
                "title": s.get("title") or "(sans titre)",
                "created_at": created,
                "updated_at": updated,
                "message_count": len(msgs),
                "messages": msgs,
                "model": s.get("model") or "",
                "provider": s.get("billing_provider") or "",
                "source": s.get("source") or "",
            })
        con.close()
        return out
    except sqlite3.Error as exc:
        _chat_log("native sessions read error agent=%s: %s" % (agent, exc))
        return _read_agent_sessions(agent)


def _read_agent_sessions(agent: str):
    """Return the list of sessions for `agent` (newest first). [] if none/file absent."""
    p = _messages_file(agent)
    try:
        with open(p, "r", encoding="utf-8") as fh:
            data = json.load(fh) or {}
    except (OSError, ValueError):
        return []
    return data.get("sessions", []) or []


def _write_agent_sessions(agent: str, sessions: list):
    """Atomically write the full session list for `agent` (called ONLY at end of a turn)."""
    p = _messages_file(agent)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"agent": agent, "sessions": sessions}, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, p)


# ---------------------------------------------------------------------------
# SSE chat streaming infrastructure (2026-07-30, DEVELOPPEUR).
# The chat worker already accumulates token text into _MESSAGES_LIVE. We add a
# per-(agent, sid) deque + wakeup Event so a dedicated SSE connection
# (GET /api/chat/stream) can receive each token block the instant it is
# produced instead of waiting up to POLL_MS for the HTTP poll. This matches
# (and is smoother than) the built-in Hermes Agent dashboard, which renders
# tokens over SSE.
# ---------------------------------------------------------------------------
_MESSAGES_SSE = {}  # (agent, sid) -> {"chunks": collections.deque, "event": threading.Event, "done": bool, "error": str|None}
_MESSAGES_SSE_LOCK = threading.Lock()


def _sse_push(agent: str, sid: str, text: str):
    """Append a token chunk to the live SSE buffer and wake any subscriber."""
    key = (agent, sid)
    with _MESSAGES_SSE_LOCK:
        buf = _MESSAGES_SSE.get(key)
        if buf is None:
            # No subscriber connected yet; still buffer so it can replay the
            # backlog when a client connects mid-generation (anti-coupure).
            buf = {"chunks": collections.deque(), "event": threading.Event(),
                   "done": False, "error": None}
            _MESSAGES_SSE[key] = buf
        buf["chunks"].append(text)
        buf["event"].set()


def _sse_mark_done(agent: str, sid: str, error: str | None = None):
    """Mark the stream finished so the SSE loop flushes the tail and closes."""
    key = (agent, sid)
    with _MESSAGES_SSE_LOCK:
        buf = _MESSAGES_SSE.get(key)
        if buf is None:
            buf = {"chunks": collections.deque(), "event": threading.Event(),
                   "done": False, "error": None}
            _MESSAGES_SSE[key] = buf
        buf["done"] = True
        buf["error"] = error
        buf["event"].set()


def _children_alive(pgid: int) -> bool:
    """Return True if any process still belongs to `pgid` (excluding the
    group leader itself, which is already dead after communicate()).

    Used by the finalization phase: hermes chat -Q exits as soon as the model
    stops generating, but tools it spawned (terminal -> python3, servers…)
    may still be running. We scan /proc for any process whose pgid matches the
    hermes process group (start_new_session=True => pgid == hermes pid)."""
    try:
        for pid_str in os.listdir("/proc"):
            if not pid_str.isdigit():
                continue
            pid = int(pid_str)
            if pid == pgid:
                continue
            try:
                with open("/proc/%d/stat" % pid, "r") as fh:
                    stat = fh.read()
                rparen = stat.rfind(")")
                if rparen < 0:
                    continue
                fields = stat[rparen + 1:].split()
                if len(fields) >= 3 and fields[2] == str(pgid):
                    return True
            except (OSError, ValueError, IndexError):
                continue
    except OSError:
        return False
    return False


def _persist_user_msg(agent: str, sid: str, user_text: str, files: list):
    """Persist the USER message IMMEDIATELY when a send starts (not at end).

    2026-07-28 (piloubruce): the user bubble vanished on tab-switch / F5 /
    agent-switch while the agent was still generating, because persistence
    only happened at the END of the worker. Now we write the user turn up
    front so it survives any UI reload and reappears from the API history.
    """
    sessions = _read_agent_sessions(agent)
    sess = None
    for s in sessions:
        if s.get("id") == sid:
            sess = s
            break
    if sess is None:
        sess = {
            "id": sid, "agent": agent,
            "title": (user_text[:60] or "(sans titre)"),
            "created_at": time.time(), "updated_at": time.time(),
            "message_count": 0, "messages": [],
        }
        sessions.append(sess)
    user_attachments = [f for f in (files or []) if f and os.path.isfile(f)]
    # IDEMPOTENCE (debug 2026-07-28): do NOT append a duplicate user turn if the
    # last message in the session is already a user message with the SAME text
    # written within the last 10s. This survives a double-send / worker replay
    # without creating two identical question bubbles (the tablet issue where
    # only the user question seemed visible because it was stacked 2x).
    _msgs = sess.setdefault("messages", [])
    if _msgs:
        _last = _msgs[-1]
        _same_text = (_last.get("role") == "user"
                      and (_last.get("text") or "") == user_text)
        _recent = (time.time() - float(_last.get("ts", 0) or 0)) < 10.0
        if _same_text and _recent:
            # already persisted this exact turn -> skip the duplicate append
            sess["message_count"] = len(_msgs)
            sess["updated_at"] = time.time()
            _write_agent_sessions(agent, sessions)
            return
    _msgs.append(
        {"role": "user", "text": user_text, "ts": time.time(),
         "attachments": user_attachments})
    sess["message_count"] = len(_msgs)
    sess["updated_at"] = time.time()
    _write_agent_sessions(agent, sessions)


_REASONING_CUES = (
    "the user", "the assistant", "i should", "i'll respond", "i will respond",
    "let me", "no tools", "respond in", "this is a", "in french", "in english",
    "i need to", "the question", "they're speaking", "they are speaking",
    "so the", "probably", "keep it short", "keep it brief", "we should",
)

_BOX_RE = re.compile(r"[\u250c\u2502][\u2500\s]*Reasoning[\u2500\s]*[\u2510\u2502]?", re.IGNORECASE)
_BOX_CLOSE_RE = re.compile(r"[\u2514][\u2500\s]*[\u2518]")


def _looks_reasoning(line: str) -> bool:
    ls = line.strip().lower()
    if not ls:
        return False
    hits = sum(1 for cue in _REASONING_CUES if cue in ls)
    if hits >= 1 and re.search(r"\b(the|i|they|we|should|user|tools|respond)\b", ls):
        # require the line to be mostly english-ish monologue
        return True
    return False


def _dedup_glued(line: str) -> str:
    """'Salut! X ?Salut! X ?' -> 'Salut! X ?' (hy3 glues a duplicated echo)."""
    s = line.strip()
    n = len(s)
    if n >= 8 and n % 2 == 0 and s[: n // 2] == s[n // 2:]:
        return s[: n // 2]
    return line


def _strip_reasoning(text: str) -> str:
    """Remove reasoning blocks from a raw hermes chat reply.

    hy3:free prints an OPENING box '┌─ Reasoning ─┐' with NO closing '└─┘',
    then its internal monologue (often echoed twice), then the final answer.
    Everything before the box (CLI warnings) is dropped too.
    """
    if not text:
        return text
    m = None
    for m in _BOX_RE.finditer(text):
        pass  # keep the LAST opener
    if m:
        after = text[m.end():]
        # if a proper closer exists, everything after it is the answer
        c = _BOX_CLOSE_RE.search(after)
        if c:
            after = after[c.end():]
            return after.strip()
        out = []
        in_reasoning = True
        for ln in after.split("\n"):
            if in_reasoning:
                if not ln.strip():
                    continue
                if _looks_reasoning(ln):
                    continue
                # hy3 echoes its monologue twice glued together on one line;
                # such a line is always reasoning, never the final answer.
                if _dedup_glued(ln) != ln:
                    continue
                in_reasoning = False
            out.append(_dedup_glued(ln))
        # drop leading blanks / duplicate first line
        while out and not out[0].strip():
            out.pop()
        if len(out) >= 2:
            first = out[0].strip()
            rest = "\n".join(out[1:])
            if first and first in rest:
                out = out[1:]
        res = "\n".join(out).strip()
        if not res:
            nonempty = [l.strip() for l in after.split("\n") if l.strip()]
            res = _dedup_glued(nonempty[-1]) if nonempty else ""
        return res.strip()
    text = re.sub(r"<(thinking|think)>[\s\S]*?</(thinking|think)>",
                  "", text, flags=re.IGNORECASE)
    return text.strip()


def _messages_send_bg(agent: str, sid: str, user_text: str, files: list,
                      persist: bool = True):
    """BACKGROUND worker: run hermes chat, stream the reply into _MESSAGES_LIVE.
    
    FIX MC (2026-08-04): Utilise le mapping mc_sid -> hermes_sid PERSISTENT
    pour eviter la pollution de l'historique natif de Hermes Agent.
    
    - CHAQUE appel MC utilise --resume avec une session Hermes deja declaree
    - L'historique est gere par le store Hermes natif (state.db) via --resume
    - mc_messages.db sert uniquement a la UI Mission Control (pas de duplication)
    - sessions/<agent>.json MC sert a l'onglet Discussion de l'UI MC
    
    Writes the session to disk ONLY when the reply is complete (no phantom),
    AND only when persist=True. When persist=False the agent still runs and
    the live status is updated (so polling works) but nothing is stored in the
    agent's message history — used by board task execution.
    """
    import base64
    key = (agent, sid)
    with _MESSAGES_LIVE_LOCK:
        _MESSAGES_LIVE[key] = {"running": True, "text": "", "error": None, "ts": time.time()}
    # FIX MC (2026-08-21): sur une session EXISTANTE tous les messages partagent
    # le meme sid, donc le meme buffer _MESSAGES_SSE. Un `done=True` residuel du
    # message precedent faisait fermer immediatement le flux SSE du message
    # suivant (3e message invisible en live, visible seulement apres F5).
    # On repart donc d'un buffer PROPRE au demarrage de chaque worker.
    # Reinit EN PLACE (pas de nouveau dict) : un flux SSE deja connecte garde
    # une reference sur ce dict et son Event ; le remplacer l'orphanerait.
    with _MESSAGES_SSE_LOCK:
        buf = _MESSAGES_SSE.get(key)
        if buf is None:
            _MESSAGES_SSE[key] = {
                "chunks": collections.deque(),
                "event": threading.Event(),
                "done": False,
                "error": None,
            }
        else:
            buf["chunks"].clear()
            buf["done"] = False
            buf["error"] = None
            buf["event"].clear()
    hermes_bin = _resolve_hermes_bin()
    eff_model, eff_provider = _resolve_effective_model(agent, None, None)
    # --- FIX CONCESSION 2026-08-18 (fuite de sessions natives) ---
    # On reprend UNE session Hermes native par (agent, sid) MC via --resume,
    # au lieu de lancer `hermes chat -Q` sans --resume (qui creait une
    # NOUVELLE session native a CHAQUE message -> 4 questions = 4 sessions
    # dans l'historique de l'agent). L'id natif est resolu UNE FOIS par
    # (agent, sid) et mis en cache sur disque (mc_session_map.json).
    # Le cleanup natif (suppression de la derniere session via
    # _query_session_list) est supprime plus bas : on CONSERVE la session
    # native car c'est elle la source de verite lue par _read_native_sessions.
    hermes_sid = _ensure_persistent_session(agent, sid)
    if not hermes_sid:
        _chat_log("messages send agent=%s sid=%s : echec resolution session native persistante (resume desactive)" % (agent, sid))
    _t0 = time.time()  # token-debit timing reference (set before hermes runs)

    # --- BUG MC FIX (2026-08-03): NO --resume on the shared state.db.
    # --resume was disabled on 2026-07-28 because it caused WAL contention
    # with the Telegram gateway (error "session storage could not be written").
    # History is read from a DEDICATED mc_messages.db and injected into the prompt.
    hist_turns = _read_mc_messages(agent, sid, limit=30)
    if hist_turns:
        hist_blocks = []
        for turn in hist_turns:
            role = turn.get("role", "")
            text = turn.get("text", "")
            if role == "user":
                hist_blocks.append("User: " + text)
            elif role == "agent":
                hist_blocks.append("Assistant: " + text)
        hist_block = "\n\n".join(hist_blocks)
        full_prompt = "<HISTORIQUE>\n" + hist_block + "\n</HISTORIQUE>\n\nNouvelle question de l'utilisateur:\n" + user_text
    else:
        full_prompt = user_text

    _chat_log("messages send agent=%s sid=%s files=%d (history=%d turns)" % (agent, sid, len(files or []), len(hist_turns)))
    
    # --- Persist user message to mc_messages.db (pour l'UI MC) ---
    try:
        _write_mc_message(agent, sid, "user", user_text)
    except Exception as _exc:
        _chat_log("mc_messages user persist failed agent=%s sid=%s: %s" % (agent, sid, _exc))
    # --- Persist user message to the MC native store (sessions/<agent>.json) ---
    # This is what /api/messages/sessions returns to the frontend. Without it the
    # user bubble never appears in the UI after the agent replies (bug 2026-08-03).
    try:
        _persist_user_msg(agent, sid, user_text, files)
    except Exception as _exc:
        _chat_log("persist_user_msg failed agent=%s sid=%s: %s" % (agent, sid, _exc))
    
    # --- Spawn hermes chat AVEC --resume (reprend UNE session native par
    #     conversation MC). Cela EVITE de creer une nouvelle session native a
    #     chaque message (bug 2026-08-18 : 4 questions = 4 sessions). Hermes
    #     gère l'historique du contexte lui-meme via --resume, donc on n'injecte
    #     PLUS l'historique dans le prompt (qui doublonnait la memoire).
    #     Repli : si hermes_sid est absent (bootstrap echoue), on retombe sur
    #     un chat frais (comportement d'avant) pour ne pas bloquer l'envoi.
    if hermes_sid:
        cmd = [hermes_bin, "chat", "-p", _hermes_profile(agent),
               "--resume", hermes_sid, "-q", user_text, "-Q",
               "--reasoning", "none", "--source", "mc"]
        _chat_log("messages send agent=%s sid=%s RESUME hermes_sid=%s" % (agent, sid, hermes_sid))
    else:
        cmd = [hermes_bin, "chat", "-p", _hermes_profile(agent), "-q", full_prompt, "-Q",
               "--reasoning", "none", "--source", "mc"]
        _chat_log("messages send agent=%s sid=%s FRESH (resume indispo)" % (agent, sid))
    # PILU (2026-08-18) : hermes chat en mode non-TTY bufferise sa stdout par
    # blocs -> le fichier de sortie reste vide jusqu'a la fin -> le streaming
    # token-par-token ne livre rien en direct (reponse visible qu'au refresh).
    # On force le line-buffering via stdbuf -oL pour que chaque ligne soit
    # ecrite immediatement dans le fichier, donc lus par la boucle de streaming.
    import shutil as _shutil
    _stdbuf = _shutil.which("stdbuf")
    if _stdbuf:
        cmd = [_stdbuf, "-oL", *cmd]
    if eff_model:
        cmd += ["-m", eff_model]
    if eff_provider:
        cmd += ["--provider", eff_provider]
    # attachments (absolute paths, already uploaded to UPLOAD_DIR)
    # Hermes chat accepts images via --image <path> (one flag per file).
    for fpath in (files or []):
        if fpath and os.path.isfile(fpath):
            cmd += ["--image", fpath]
    
    import tempfile
    _out_path = os.path.join(tempfile.gettempdir(), "mc_%s_%s.txt" % (agent, sid))
    _chat_env_mc = _chat_env()
    _chat_env_mc["PYTHONUNBUFFERED"] = "1"
    try:
        with open(_out_path, "w") as _of:
            proc = subprocess.Popen(
                cmd, stdout=_of, stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL, env=_chat_env_mc,
                start_new_session=True,
            )
    except Exception as exc:  # noqa: BLE001
        with _MESSAGES_LIVE_LOCK:
            _MESSAGES_LIVE[key] = {"running": False, "text": "",
                                     "error": "spawn error: %s" % exc, "ts": time.time()}
        _sse_mark_done(agent, sid, error="spawn error: %s" % exc)
        return
    # Feature 5 (Annuler): on garde une reference MEMOIRE au subprocess pour
    # pouvoir le tuer depuis un endpoint HTTP.
    with _MESSAGES_LIVE_LOCK:
        _MESSAGES_LIVE[key]["proc"] = proc
    # Streaming: on lit le fichier de sortie pendant la generation, puis on
    # recupere le texte complet a la fin. Rediriger vers un fichier (et non un
    # PIPE) est REQUISE : avec stdout=PIPE, hermes chat garde le pipe ouvert
    # (processus enfants non termines) -> communicate() bloque indéfiniment.
    try:
        # 2026-08-09 (piloubruce) : 90s -> 1800s. L'ancien delai tuait le
        # groupe de processus pendant la generation d'agents qui reflechissent
        # longtemps (tools, delegations) -> erreur "hermes chat a echoue
        # (rc=None)" dans le chat du dashboard. 1800s = meme horizon que le
        # _finalize_deadline plus bas : 30 min de securite pour une generation
        # longue, largement suffisant pour ne PAS tuer une reponse legitime.
        _hard_deadline = time.time() + 1800.0
        _emitted_len = 0  # longueur deja poussee au SSE (pour diff incremental)
        _emitted_text = ""  # contenu deja pousse au SSE (pour dedup doublon)
        while proc.poll() is None:
            # hermes chat (non-TTY) ne ferme pas toujours son stdout -> le
            # subprocess parent reste vivant meme apres la generation. On lit
            # le fichier de sortie en continu, et on tue le GROUPE de processus
            # au bout d'un delai de securite (la reponse est deja dans le fichier).
            if time.time() > _hard_deadline:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception:
                    try: proc.kill()
                    except Exception: pass
                break
            try:
                try:
                    with open(_out_path, "r") as _rf:
                        _content = _rf.read()
                except Exception:
                    _content = ""
                with _MESSAGES_LIVE_LOCK:
                    _live = _MESSAGES_LIVE.get(key, {"text": ""})
                    _live["text"] = _content
                    _live["running"] = True
                    _live["ts"] = time.time()
                    _live["text"] = _content
                    _MESSAGES_LIVE[key] = _live
                # STREAMING INCREMENTAL (piloubruce 2026-08-17) : on pousse le
                # NOUVEAU texte depuis le dernier envoi. hermes chat peut
                # re-ecrire le fichier (vider + re-remplir) -> on ne se base
                # PAS sur la longueur mais sur le contenu deja emis pour eviter
                # les doublons (sinon le texte est pousse 2x et l'UI l'affiche
                # en double).
                if _content and _content != _emitted_text:
                    # Calcul du vrai nouveau suffixe : si _content se termine par
                    # _emitted_text (le fichier a ete re-rempli avec le meme
                    # texte + ajout), on pousse seulement l'ajout. Sinon (cas
                    # simple : fichier grandit), on pousse la difference.
                    if _emitted_text and _content.endswith(_emitted_text):
                        _delta = _content[len(_emitted_text):]
                    elif _emitted_text and _content.startswith(_emitted_text):
                        _delta = _content[len(_emitted_text):]
                    else:
                        # Contenu different (re-ecriture complete) : on pousse
                        # tout sauf si c'est identique a ce qu'on a deja emis.
                        _delta = _content if _content != _emitted_text else ""
                    if _delta:
                        _emitted_text = _content
                        _sse_push(agent, sid, _delta)
            except Exception:
                pass
            time.sleep(0.4)
        # Process termine : recuperation finale du fichier.
        try:
            with open(_out_path, "r") as _rf:
                out = _rf.read()
        except Exception:
            out = ""
        err = ""
        if out:
            with _MESSAGES_LIVE_LOCK:
                _live = _MESSAGES_LIVE.get(key, {"text": ""})
                _live["text"] = out
                _MESSAGES_LIVE[key] = _live
            _sse_push(agent, sid, out)
    except Exception as exc:  # noqa: BLE001
        err = "read error: %s" % exc
        out = ""
        with _MESSAGES_LIVE_LOCK:
            _MESSAGES_LIVE[key] = {"running": False, "text": "", "error": "AGENT INTERROMPU : %s" % exc, "ts": time.time()}
        _sse_mark_done(agent, sid, error="AGENT INTERROMPU : %s" % exc)
        _chat_log("messages worker agent=%s sid=%s INTERROMPU: %s" % (agent, sid, exc))
    rc = proc.returncode
    try:
        os.remove(_out_path)
    except Exception:
        pass
    rc = proc.returncode
    # --- Persist IMMEDIATEMENT (piloubruce 2026-08-11) : on sauvegarde la
    # reponse des que le texte est lu, AVANT la phase de finalisation et AVANT
    # de poser running=False. Le front recharge l'historique des que running
    # passe a False ; or la finalisation attend les enfants jusqu'a 1800s
    # (exactement le cas du bug : enfants bloques). Sans ce deplacement, un
    # F5 pendant la finalisation chargeait un historique sans la reponse.
    reply = _strip_reasoning(out)
    error = None if rc == 0 else (err or "hermes chat a echoue (rc=%s)" % rc)
    try:
        _acc_tokens(agent, eff_model, eff_provider, user_text, reply, _t0)
    except Exception as _exc:  # noqa: BLE001
        _chat_log("messages token acc failed agent=%s: %s" % (agent, _exc))
    if persist:
        try:
            sessions = _read_agent_sessions(agent)
            sess = None
            for s in sessions:
                if s.get("id") == sid:
                    sess = s
                    break
            if sess is None:
                sess = {
                    "id": sid, "agent": agent,
                    "title": (user_text[:60] or "(sans titre)"),
                    "created_at": time.time(), "updated_at": time.time(),
                    "message_count": 0, "messages": [],
                }
                sessions.append(sess)
            try:
                _write_mc_message(agent, sid, "agent", reply)
            except Exception as _exc:
                _chat_log("mc_messages agent persist failed agent=%s sid=%s: %s" % (agent, sid, _exc))
            agent_attachments = _extract_image_paths(reply)
            sess.setdefault("messages", []).append(
                {"role": "agent", "text": reply, "ts": time.time(),
                 "error": error, "attachments": agent_attachments})
            sess["message_count"] = len(sess["messages"])
            sess["updated_at"] = time.time()
            _write_agent_sessions(agent, sessions)
            # FIX FUITE SESSIONS NATIVES (2026-08-20) : avec --resume on reprend
            # UNE session native par conversation MC. Quand hermes_sid etait
            # None (1er message d'une conversation -> on a lance FRESH), on
            # recupere le sid natif QUE le worker vient de creer (derniere
            # session de l'agent via _query_session_list) et on le sauve dans
            # le map (agent, mc_sid) -> les messages suivants (meme mc_sid)
            # feront --resume dessus au lieu de recréer. On CONSERVE cette
            # session native (c'est la source de verite lue par
            # _read_native_sessions) : plus de cleanup supprimant la derniere.
            if not hermes_sid and persist:
                # Capture deterministe du sid natif QUE le worker vient de
                # creer : on parse la ligne `session_id: ...` dans la sortie
                # `out` du worker (et pas _query_session_list qui renvoie la
                # DERNIERE session de l'agent = race si parallele). On lie ce
                # sid au (agent, mc_sid) dans le map -> les messages suivants
                # (meme mc_sid) feront --resume dessus au lieu de recréer.
                try:
                    _new_native = _parse_session_id(out)
                    if _new_native:
                        key = "%s|%s" % (agent, sid)
                        with _MC_SESSION_MAP_LOCK:
                            _MC_SESSION_MAP[key] = _new_native
                            # FIX (2026-08-21): cle identite agent|<sid natif>
                            # -> la 2e question (id natif repasse par le front)
                            # reprend CETTE session et non une nouvelle.
                            _MC_SESSION_MAP.setdefault(
                                "%s|%s" % (agent, _new_native), _new_native)
                        _save_mc_session_map()
                        hermes_sid = _new_native
                        _chat_log("MC: nouveau sid natif capture %s pour (agent=%s, mc_sid=%s)" % (_new_native, agent, sid))
                    else:
                        _chat_log("MC: pas de session_id trouve dans la sortie (pas de capture)")
                except Exception as _e:
                    _chat_log("MC: echec capture sid natif: %s" % _e)
            _chat_log("MC: session native hermes %s conservee (resume, pas de cleanup)" % hermes_sid)
        except Exception as exc:  # noqa: BLE001
            _chat_log("messages persist failed agent=%s: %s" % (agent, exc))
    else:
        _chat_log("messages send agent=%s sid=%s NOT persisted (task exec)" % (agent, sid))
    # --- UI fix (piloubruce 2026-08-11) : la reponse texte est deja persistee
    # et disponible -> on marque running=False maintenant (point vert) sans
    # attendre la finalisation des enfants. La boucle de finalisation ci-dessous
    # ne remet PLUS running=True (cf. garde plus bas).
    with _MESSAGES_LIVE_LOCK:
        _live = _MESSAGES_LIVE.get(key, {"text": out})
        _live["running"] = False
        _MESSAGES_LIVE[key] = _live
    _sse_mark_done(agent, sid)
    # --- Phase de FINALISATION (piloubruce 2026-07-26) ---
    # hermes chat -Q se termine des que le modele a fini de generer son texte,
    # SANS attendre que les sous-process qu'il a lances (via l'outil terminal)
    # soient reellement termines. On surveille le groupe de process et on ne
    # marque running=False QUE quand plus aucun enfant n'est vivant. Timeout
    # 300s (5 min) de securite : une tache normale (redemarrage, compilation,
    # delegation a un autre agent) finit largement avant ; au-dela, c'est un
    # blocage -> on affiche quand meilleure la coche verte pour ne pas rester bloque.
    _finalize_deadline = time.time() + 1800.0
    while time.time() < _finalize_deadline:
        if proc and not _children_alive(proc.pid):
            break
        with _MESSAGES_LIVE_LOCK:
            _live = _MESSAGES_LIVE.get(key)
            if _live is not None:
                # FIX (piloubruce 2026-08-11): ne PAS remettre running=True ici.
                # Le texte de reponse est deja disponible (running=False pose a
                # la ligne ~8616 des que 'out' est lu). Garder le point rouge
                # colle parce que des sous-process (outils/delegation) tournent
                # en arriere-plan etait le bug signale. On attend leur fin en
                # silence (nettoyage + timeout de securite 1800s) sans impacter
                # l'UI. Le front peut afficher 'finalizing' via phase, sans rouge.
                _live["phase"] = "finalizing"
                _live["ts"] = time.time()
        time.sleep(0.5)
    # La reponse a deja ete persitee et running=False pose AVANT la boucle
    # ci-dessus (piloubruce 2026-08-11) : pas de double-persist, pas de doublon.
    # On relit 'reply' (deja strippe) depuis la live pour le bloc Annuler.
    reply = ""
    with _MESSAGES_LIVE_LOCK:
        reply = _MESSAGES_LIVE.get(key, {}).get("text", "")
    # Garde le comportement d'affichage d'origine : la bulle finale (recharge
    # F5) ne doit pas montrer le bloc <thinking> (strippé pour l'historique).
    reply = _strip_reasoning(reply)
    # Feature 5 (Annuler): si cette session a ete explicitement annulee, on
    # marque l'erreur comme telle. On persiste la reponse (partielle) AVANT de
    # poser running=False pour qu'aucune course avec le front (qui recharge
    # l'historique des que running passe a False) ne coupe la sauvegarde.
    # Note: hermes ecrit parfois du texte sur stderr meme quand tue (ex.
    # banniere "Resumed session"), donc `error` n'est jamais None apres un
    # SIGKILL ; on force donc le libelle quand annule, sauf si le process a
    # fini NORMALMENT (rc==0) -> race rare ou le cancel arrive apres la fin.
    with _MESSAGES_CANCELLED_LOCK:
        cancelled = _MESSAGES_CANCELLED.pop(key, False)
    if cancelled and rc != 0:
        error = "annule par l'utilisateur"
    with _MESSAGES_LIVE_LOCK:
        _MESSAGES_LIVE[key] = {
            "running": False, "text": reply, "error": error, "ts": time.time()}
    # Close the SSE stream for any client subscribed to this (agent, sid).
    _sse_mark_done(agent, sid, error=error)



def _delete_agent_sessions(agent: str, ids):
    """Delete the given session ids (or ALL if ids is None/'__all__').

    The sessions listed in the Messages tab are NATIVE Hermes sessions
    (state.db), so deletion must go through `hermes sessions delete`, not the
    legacy mc_messages/<agent>.json store (which is no longer the source of
    truth and whose rewrite had no effect on the real history).
    """
    profile = _hermes_profile(agent)
    hermes_bin = _resolve_hermes_bin()
    if ids and "__all__" not in ids:
        want = list(ids)
    else:
        # ALL: read native ids and delete every one
        want = [s.get("id") for s in _read_native_sessions(agent)
                if s.get("id")]
    removed = 0
    for sid in want:
        if not sid:
            continue
        try:
            subprocess.run([hermes_bin, "sessions", "delete", "-p", profile, sid, "--yes"],
                           capture_output=True, text=True, timeout=60)
            removed += 1
        except Exception as exc:
            _chat_log("delete session failed agent=%s sid=%s: %s" % (agent, sid, exc))
    return removed


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def _reap_orphaned_hermes_chat():
    """Kill leftover `hermes chat` subprocesses from a previous server run.

    2026-07-These workers are spawned with start_new_session=True (own process
    group) so a server restart does NOT cascade-kill them. After a systemd
    stop/start the old chat workers are reparented to PID 1 and keep running,
    holding their stdout pipe open — which makes the Messages tab hang on the
    next launch (the new worker's pipe never drains). Killing them at startup
    guarantees a clean slate. We target only `hermes chat` (not `hermes
    gateway` / `hermes scan` / etc.) to avoid touching unrelated processes.
    """
    import signal as _signal
    try:
        hermes_bin = _resolve_hermes_bin()
    except Exception:
        hermes_bin = "hermes"
    killed = 0
    for pid_str in os.listdir("/proc"):
        if not pid_str.isdigit():
            continue
        pid = int(pid_str)
        try:
            with open("/proc/%d/cmdline" % pid, "rb") as fh:
                cmd = fh.read().decode("utf-8", "replace")
        except OSError:
            continue
        # cmd is NUL-separated; rebuild argv and look for the chat subcommand
        argv = [a for a in cmd.split("\0") if a]
        if len(argv) < 2:
            continue
        if os.path.basename(argv[0]) != os.path.basename(hermes_bin) and \
                "hermes" not in os.path.basename(argv[0]):
            continue
        # only match `hermes chat ...` (not gateway/scan/sessions/etc.)
        if "chat" not in argv[1:3]:
            continue
        try:
            # Only reap if orphaned (parent is PID 1 / init) — a live chat
            # spawned by the *current* server still has this server as parent
            # and must be left alone. We can't know the current server pid here
            # cheaply, so we reap only truly detached (PPID==1) processes.
            ppid = int(open("/proc/%d/stat" % pid).read().split()[3])
            if ppid == 1:
                os.kill(pid, _signal.SIGKILL)
                killed += 1
        except (OSError, ValueError, IndexError):
            continue
    if killed:
        _chat_log("reaped %d orphaned hermes chat subprocess(es) at startup" % killed)


def main():
    # Source ~/.hermes/.env into os.environ BEFORE anything else, so the
    # `hermes chat -p <agent>` subprocess inherits provider credentials
    # (notably GOOGLE.com API key for provider gemini). The dashboard server is
    # launched outside `hermes`, so it never loads the dotenv itself and
    # Gemini otherwise fails with "No usable credentials found".
    _load_hermes_dotenv()
    # 2026-07-28: reap orphaned `hermes chat` subprocesses left behind by a
    # previous server instance. Chat workers spawn with start_new_session=True
    # (own PGID) so a server restart (systemd stop/start) does NOT kill them;
    # they become zombies (parent PID 1) that keep holding stdin/stdout pipes
    # open and block the Messages tab forever. Kill any such residual process
    # at startup so a fresh server never inherits a stuck conversation.
    _reap_orphaned_hermes_chat()
    _init_board()
    _init_scan_results_db()
    _init_token_usage()
    _init_model_rate()
    # Prime the persistent per-agent session cache from disk + env at startup so
    # the FIRST chat call for each agent does NOT need a bootstrap subprocess
    # (it only bootstraps lazily on demand if neither disk nor env has an id).
    _load_persistent_sids_from_disk()
    # Load MC session -> Hermes session mapping (Option A persistent --resume)
    _load_mc_session_map()
    # SSE broadcast mutualise : UN thread calcule /api/state par tick et le
    # diffuse a tous les clients /events (audit 2026-08-07). Avant : chaque
    # client recalculait le state dans sa propre boucle.
    threading.Thread(target=_sse_broadcast_loop, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Hermes Mission Control backend -> http://%s:%d/" % (HOST, PORT))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
