"""Mission Control - extensions backend (BOB, 2026-08-05).

Trois blocs, tous en stdlib pure (aucune dependance externe) :

  1. Terminal WebSocket + PTY  ->  GET /ws/terminal (Upgrade: websocket)
  2. Explorateur de fichiers RW sandboxe /home/piloubruce
  3. Config serveur (theme / raccourcis)

Le WebSocket est servi par le MEME serveur HTTP (meme port) : on "hijacke"
la socket de la requete apres le handshake RFC6455. Aucune socket
supplementaire n'est ouverte, donc aucune surface reseau supplementaire.
(Authentification du dashboard SUPPRIMEE 2026-08-09.)
"""

import base64
import datetime
import errno
import glob
import fcntl
import getpass
import hashlib
import io
import json
import os
import tempfile
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import termios
import threading
import time
import sqlite3

HOME = os.path.expanduser("~")
SANDBOX_ROOT = os.path.realpath(HOME)          # /home/piloubruce
CONFIG_PATH = os.path.join(HOME, "agent-mission-control", "mc_config.json")
PROJECT_DIR = os.environ.get("MC_PROJECT_DIR", os.path.join(HOME, "agent-mission-control"))

# Cron executions database path
CRON_EXEC_DB = os.path.expanduser("~/.hermes/cron/executions.db")

# Notification state
_NOTIFICATIONS = []  # [(type, title, message, ts, agent), ...]
_NOTIFICATIONS_LOCK = threading.Lock()

# ---------------------------------------------------------------------------
# 3) Config serveur
# ---------------------------------------------------------------------------
DEFAULT_CONFIG = {
    "theme": "dark",
    # FIX (audit 2026-08-07) : plus AUCUN shortcuts par defaut cote serveur.
    # Les defaults vivent dans dashboard/src/lib/hotkeys.ts (DEFAULT_HOTKEYS).
    # Avant, _deep_merge(DEFAULT_CONFIG, data) re-injectait a chaque GET les
    # vieilles combos "ctrl+1..", "ctrl+k: search", "ctrl+4: board" — dont
    # certaines ne sont meme pas des onglets du dashboard — et polluait le
    # localStorage a chaque ouverture de l'onglet Configuration (bug de
    # persistance remonte par l'utilisateur).
    "shortcuts": {},
    "terminal": {"font_size": 13, "shell": "/bin/bash", "scrollback": 2000},
    "files": {"root": SANDBOX_ROOT, "show_hidden": False},
    # Scan provider enablement: mapping from provider name to boolean.
    # If missing or empty, all providers are considered enabled.
    "scan_providers": {},
    # v1.17.141 - ordre des cartes agents (persiste cote serveur pour etre
    # partage entre navigateurs/profils -- localStorage etait perdu en prive).
    "agents_order": [],
}

_CFG_LOCK = threading.Lock()


def _deep_merge(base, over):
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config():
    with _CFG_LOCK:
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            data = {}
    if not isinstance(data, dict):
        data = {}
    return _deep_merge(DEFAULT_CONFIG, data)


def save_config(patch):
    """Merge-and-persist. Retourne la config complete resultante.

    FIX (audit 2026-08-07) : `shortcuts` et `theme` sont des blocs OPAQUES
    geres par l'UI (ordre + combos). Un _deep_merge accumulait les anciennes
    combos (`ctrl+1` et `1` ensemble) et ne supprimait jamais un raccourci
    retire par l'utilisateur -> au rechargement le localStorage etait
    re-ecrase avec des defaults fantomes. On remplace ces blocs quand le
    patch les fournit.
    """
    if not isinstance(patch, dict):
        raise ValueError("body JSON objet attendu")
    current = load_config()
    for key in ("shortcuts", "theme"):
        if key in patch and isinstance(patch[key], dict):
            current[key] = patch[key]
    # Autres cles (terminal, files, ...) : merge conservateur
    for key, value in patch.items():
        if key not in ("shortcuts", "theme"):
            current[key] = value
    merged = current
    with _CFG_LOCK:
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(merged, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_PATH)
        try:
            os.chmod(CONFIG_PATH, 0o600)
        except OSError:
            pass
    return merged


# ---------------------------------------------------------------------------
# 2) Explorateur de fichiers RW (sandbox /home/piloubruce)
# ---------------------------------------------------------------------------
class FsError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def safe_path(rel, must_exist=False):
    """Resout `rel` DANS la sandbox. Bloque ../, chemins absolus hors home,
    et symlinks pointant en dehors."""
    rel = (rel or "").strip()
    if rel.startswith("~"):
        rel = rel[1:].lstrip("/")
    if os.path.isabs(rel):
        cand = os.path.realpath(rel)
    else:
        cand = os.path.realpath(os.path.join(SANDBOX_ROOT, rel))
    if cand != SANDBOX_ROOT and not cand.startswith(SANDBOX_ROOT + os.sep):
        raise FsError("chemin hors sandbox", 403)
    if must_exist and not os.path.exists(cand):
        raise FsError("introuvable", 404)
    return cand


def fs_list(rel="", show_hidden=False):
    full = safe_path(rel, must_exist=True)
    if not os.path.isdir(full):
        raise FsError("pas un repertoire", 400)
    items = []
    for name in sorted(os.listdir(full)):
        if not show_hidden and name.startswith("."):
            continue
        p = os.path.join(full, name)
        try:
            st = os.stat(p)
            isdir = os.path.isdir(p)
        except OSError:
            continue
        items.append({
            "name": name,
            "path": os.path.relpath(p, SANDBOX_ROOT),
            "dir": isdir,
            "size": 0 if isdir else st.st_size,
            "mtime": int(st.st_mtime),
        })
    return {"ok": True, "path": os.path.relpath(full, SANDBOX_ROOT) if full != SANDBOX_ROOT else "",
            "root": SANDBOX_ROOT, "items": items}


def fs_upload(rel_dir, filename, content_bytes, overwrite=True):
    d = safe_path(rel_dir or "", must_exist=True)
    if not os.path.isdir(d):
        raise FsError("destination invalide", 400)
    name = os.path.basename(filename or "").strip()
    if not name or name in (".", ".."):
        raise FsError("nom de fichier invalide", 400)
    dest = safe_path(os.path.join(os.path.relpath(d, SANDBOX_ROOT), name))
    if os.path.exists(dest) and not overwrite:
        raise FsError("existe deja", 409)
    with open(dest, "wb") as fh:
        fh.write(content_bytes)
    return {"ok": True, "path": os.path.relpath(dest, SANDBOX_ROOT),
            "size": len(content_bytes)}


def fs_rename(old, new):
    src = safe_path(old, must_exist=True)
    # `new` peut etre un nom simple (rename dans le meme dossier) ou un chemin
    if "/" in (new or ""):
        dst = safe_path(new)
    else:
        base = os.path.basename((new or "").strip())
        if not base or base in (".", ".."):
            raise FsError("nouveau nom invalide", 400)
        dst = safe_path(os.path.join(os.path.dirname(os.path.relpath(src, SANDBOX_ROOT)), base))
    if os.path.exists(dst):
        raise FsError("cible existante", 409)
    os.rename(src, dst)
    return {"ok": True, "from": os.path.relpath(src, SANDBOX_ROOT),
            "to": os.path.relpath(dst, SANDBOX_ROOT)}


def fs_delete(rel, recursive=True):
    full = safe_path(rel, must_exist=True)
    if full == SANDBOX_ROOT:
        raise FsError("suppression de la racine interdite", 403)
    if os.path.isdir(full) and not os.path.islink(full):
        if not recursive and os.listdir(full):
            raise FsError("repertoire non vide", 409)
        shutil.rmtree(full)
    else:
        os.remove(full)
    return {"ok": True, "deleted": os.path.relpath(full, SANDBOX_ROOT)}


def fs_download_path(rel):
    full = safe_path(rel, must_exist=True)
    if os.path.isdir(full):
        raise FsError("repertoire : telechargement non supporte", 400)
    return full


def fs_mkdir(rel):
    full = safe_path(rel)
    if os.path.exists(full):
        raise FsError("existe deja", 409)
    os.makedirs(full)
    return {"ok": True, "path": os.path.relpath(full, SANDBOX_ROOT)}


# ---------------------------------------------------------------------------
# 1) WebSocket (RFC6455) minimal, stdlib pure
# ---------------------------------------------------------------------------
# GUID RFC 6455 section 4.2.2. ATTENTION: la valeur exacte est
# ...-95CA-C5AB0DC85B11 (le C precede 5AB0). Une inversion en
# ...-95CA-5AB0DC85B11C produit un Sec-WebSocket-Accept faux : le handshake
# renvoie bien 101 mais TOUT client conforme (navigateurs, lib websockets)
# ferme aussitot la connexion -> close 1006. Vecteur de test RFC :
#   cle "dGhlIHNhbXBsZSBub25jZQ==" -> "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


def ws_accept_key(key):
    return base64.b64encode(
        hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()
    ).decode("ascii")


def ws_encode(payload, opcode=OP_TEXT):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    n = len(payload)
    head = bytearray([0x80 | opcode])
    if n < 126:
        head.append(n)
    elif n < (1 << 16):
        head.append(126)
        head += struct.pack(">H", n)
    else:
        head.append(127)
        head += struct.pack(">Q", n)
    return bytes(head) + payload


def _read_exact(sock_file, n):
    buf = b""
    while len(buf) < n:
        chunk = sock_file.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


class SocketReader:
    """Lecteur d'octets sur la socket BRUTE (pas handler.rfile).

    BaseHTTPRequestHandler lit les en-tetes via un BufferedReader ; apres
    l'upgrade, une partie des octets du client peut deja se trouver dans ce
    buffer. On recupere donc ce reliquat (drain non bloquant) puis on lit
    exclusivement via conn.recv() : plus de desync entre lecture (rfile) et
    ecriture (conn), qui provoquait des frames corrompues -> close 1006 sous
    Chrome.
    """

    def __init__(self, conn, prebuf=b""):
        self.conn = conn
        self.buf = bytearray(prebuf)

    @classmethod
    def from_handler(cls, handler):
        conn = handler.connection
        pre = b""
        rfile = getattr(handler, "rfile", None)
        if rfile is not None:
            try:
                conn.setblocking(False)
                try:
                    pre = rfile.peek(0) or b""
                    if pre:
                        pre = rfile.read(len(pre)) or b""
                except Exception:
                    pre = b""
                finally:
                    conn.setblocking(True)
            except Exception:
                pre = b""
        return cls(conn, pre)

    def read(self, n):
        """Retourne jusqu'a n octets, b'' si la socket est fermee."""
        if self.buf:
            out = bytes(self.buf[:n])
            del self.buf[:n]
            return out
        try:
            return self.conn.recv(n)
        except (ConnectionResetError, OSError):
            return b""


def ws_read_frame(rfile):
    """Retourne (opcode, payload_bytes) ou None si la socket est fermee.

    Gere les frames fragmentees (opcode 0x0 de continuation) : la valeur
    retournee est le message complet avec l'opcode du premier fragment.
    Les frames de controle (ping/pong/close) intercalees sont retournees
    telles quelles a l'appelant.
    """
    first_op = None
    payload = b""
    while True:
        f = _ws_read_one(rfile)
        if f is None:
            return None
        fin, opcode, data = f
        if opcode in (OP_CLOSE, OP_PING, OP_PONG):
            return opcode, data
        if opcode == OP_CONT:
            if first_op is None:
                continue  # continuation orpheline : on ignore
            payload += data
        else:
            first_op = opcode
            payload = data
        if fin:
            return first_op, payload


def _ws_read_one(rfile):
    """Lit UNE frame brute. Retourne (fin, opcode, payload) ou None."""
    hdr = _read_exact(rfile, 2)
    if not hdr:
        return None
    b0, b1 = hdr[0], hdr[1]
    fin = bool(b0 & 0x80)
    opcode = b0 & 0x0F
    masked = bool(b1 & 0x80)
    ln = b1 & 0x7F
    if ln == 126:
        ext = _read_exact(rfile, 2)
        if not ext:
            return None
        ln = struct.unpack(">H", ext)[0]
    elif ln == 127:
        ext = _read_exact(rfile, 8)
        if not ext:
            return None
        ln = struct.unpack(">Q", ext)[0]
    mask = _read_exact(rfile, 4) if masked else None
    if masked and mask is None:
        return None
    data = _read_exact(rfile, ln) if ln else b""
    if data is None:
        return None
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return fin, opcode, data


# ---------------------------------------------------------------------------
# PTY terminal over WebSocket
# ---------------------------------------------------------------------------
TERM_SHELL = os.environ.get("MC_TERM_SHELL", "/bin/bash")

# rcfile minimal injecte au shell : garde --noprofile (pas de .bashrc lourd,
# cf. pieges de bufferisation PTY) mais active la COULEUR (ls/grep) et le
# prompt. Sans ca, `ls` n'emet aucun code ANSI et tout est monochrome.
_TERM_RC = """
PS1='\\[\\e[1;32m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[1;34m\\]\\w\\[\\e[0m\\]\\$ '
export CLICOLOR=1
if [ -x /usr/bin/dircolors ]; then
  eval "$(dircolors -b 2>/dev/null)"
fi
alias ls='ls --color=auto'
alias ll='ls -alF --color=auto'
alias la='ls -A --color=auto'
alias grep='grep --color=auto'
alias egrep='egrep --color=auto'
alias fgrep='fgrep --color=auto'
"""
_TERM_RC_PATH = os.path.join(tempfile.gettempdir(), "mc_term_bashrc")
try:
    with open(_TERM_RC_PATH, "w") as _f:
        _f.write(_TERM_RC)
except Exception:
    _TERM_RC_PATH = None
_MAX_SESSIONS = 8
_sessions_lock = threading.Lock()
_sessions = 0


def _set_winsize(fd, rows, cols):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def serve_terminal_ws(handler):
    """Appele depuis Handler.do_GET pour /ws/terminal (pas de garde d'auth
    depuis la suppression de l'authentification le 2026-08-09).

    Protocole client -> serveur (frames TEXT JSON) :
        {"type":"input","data":"ls\\n"}
        {"type":"resize","cols":120,"rows":30}
        {"type":"ping"}
    Serveur -> client (frames TEXT JSON) :
        {"type":"output","data":"..."}
        {"type":"exit","code":0}
    """
    global _sessions
    key = handler.headers.get("Sec-WebSocket-Key", "")
    upgrade = (handler.headers.get("Upgrade") or "").lower()
    if upgrade != "websocket" or not key:
        handler._send_json({"error": "websocket upgrade requis"}, code=400)
        return

    with _sessions_lock:
        if _sessions >= _MAX_SESSIONS:
            handler._send_json({"error": "trop de sessions terminal"}, code=429)
            return
        _sessions += 1

    conn = handler.connection
    # Lecture des frames sur la socket BRUTE (voir SocketReader) : ne JAMAIS
    # relire handler.rfile apres l'upgrade, sinon desync -> close 1006.
    reader = SocketReader.from_handler(handler)
    wlock = threading.Lock()

    # Plus rien ne doit transiter par les file-objects bufferises du handler.
    # On les neutralise pour que finish() ne flush/ferme pas notre socket.
    try:
        handler.rfile = io.BytesIO()
        handler.wfile = io.BytesIO()
    except Exception:
        pass
    try:
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except Exception:
        pass

    def send(obj, opcode=OP_TEXT):
        data = obj if isinstance(obj, (bytes, bytearray)) else json.dumps(obj)
        with wlock:
            conn.sendall(ws_encode(data, opcode))

    def _dbg(*a):
        if os.environ.get("MC_WS_DEBUG"):
            print("[ws]", *a, flush=True)

    pid = None
    fd = None
    try:
        resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Accept: %s\r\n\r\n" % ws_accept_key(key)
        )
        conn.sendall(resp.encode("ascii"))
        handler.close_connection = True  # on gere la socket nous-memes

        pid, fd = pty.fork()
        if pid == 0:  # enfant
            os.environ["TERM"] = "xterm-256color"
            os.environ["HOME"] = HOME
            os.environ.setdefault("USER", getpass.getuser())
            os.environ.setdefault("LOGNAME", os.environ["USER"])
            os.environ.setdefault("LANG", "fr_FR.UTF-8")
            os.environ["PATH"] = (
                os.environ.get("PATH", "")
                or "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            )
            _lb = os.path.join(HOME, ".local", "bin")
            if _lb not in os.environ["PATH"].split(":"):
                os.environ["PATH"] = _lb + ":" + os.environ["PATH"]
            # Prompt informatif : user@host:cwd$ , recalcule a chaque affichage
            # (donc suit les 'cd'). \w abrege $HOME en ~.
            os.environ["PS1"] = r"\u@\h:\w\$ "
            os.chdir(HOME)
            # --norc --noprofile: avoid loading .bashrc/.profile which can cause
            # PTY buffering/timing issues in interactive mode. PS1 vient de l'env.
            if TERM_SHELL.endswith("bash"):
                if _TERM_RC_PATH:
                    os.execv(TERM_SHELL, [TERM_SHELL, "--noprofile",
                                          "--rcfile", _TERM_RC_PATH, "-i"])
                os.execv(TERM_SHELL, [TERM_SHELL, "--norc", "--noprofile", "-i"])
            else:
                os.execv(TERM_SHELL, [TERM_SHELL, "-i"])
            os._exit(1)

        _set_winsize(fd, 30, 100)
        alive = threading.Event()
        alive.set()

        def pump_pty():
            try:
                while alive.is_set():
                    r, _, _ = select.select([fd], [], [], 0.2)
                    if not r:
                        continue
                    try:
                        out = os.read(fd, 65536)
                    except OSError:
                        break
                    if not out:
                        break
                    send({"type": "output", "data": out.decode("utf-8", "replace")})
            except Exception:
                pass
            finally:
                alive.clear()
                try:
                    send({"type": "exit", "code": 0})
                    with wlock:
                        conn.sendall(ws_encode(b"", OP_CLOSE))
                except Exception:
                    pass

        t = threading.Thread(target=pump_pty, daemon=True)
        t.start()

        while alive.is_set():
            frame = ws_read_frame(reader)
            if frame is None:
                break
            opcode, data = frame
            if opcode == OP_CLOSE:
                break
            if opcode == OP_PING:
                send(data, OP_PONG)
                continue
            if opcode == OP_PONG:
                continue
            if opcode not in (OP_TEXT, OP_BIN):
                continue
            try:
                msg = json.loads(data.decode("utf-8", "replace"))
            except Exception:
                # tolerant : texte brut = input direct
                msg = {"type": "input", "data": data.decode("utf-8", "replace")}
            mtype = msg.get("type")
            if mtype == "input":
                try:
                    os.write(fd, str(msg.get("data", "")).encode("utf-8"))
                except OSError:
                    break
            elif mtype == "resize":
                _set_winsize(fd, int(msg.get("rows") or 24), int(msg.get("cols") or 80))
            elif mtype == "ping":
                send({"type": "pong", "t": time.time()})
    except (BrokenPipeError, ConnectionResetError, OSError) as exc:
        _dbg("session terminee:", type(exc).__name__, exc)
    except Exception as exc:  # ne jamais mourir en silence
        _dbg("ERREUR session:", type(exc).__name__, exc)
        if os.environ.get("MC_WS_DEBUG"):
            import traceback
            traceback.print_exc()
    finally:
        try:
            alive.clear()
        except Exception:
            pass
        try:
            if pid:
                os.kill(pid, signal.SIGHUP)
        except Exception:
            pass
        try:
            if fd is not None:
                os.close(fd)
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
        # ---------------------------------------------------------------------------
# 4) Cron execution logs
# ---------------------------------------------------------------------------
def get_cron_execution_logs(job_id: str, limit: int = 10):
    """Get execution logs for a specific cron job from executions.db.
    
    Returns list of execution records with stdout, returncode, duration, timestamp.
    """
    if not job_id:
        return {"ok": False, "error": "job_id requis"}
    
    try:
        conn = sqlite3.connect(CRON_EXEC_DB, timeout=10.0)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, job_id, source, pid, process_started_at, status, claimed_at, started_at, finished_at, error, delivery_outcome "
            "FROM executions WHERE job_id = ? ORDER BY started_at DESC LIMIT ?",
            (job_id, limit)
        ).fetchall()
        conn.close()
        
        results = []
        for r in rows:
            started = r["started_at"]
            finished = r["finished_at"]
            duration = None
            if started and finished:
                try:
                    dt_started = datetime.datetime.fromisoformat(str(started).replace("Z", "+00:00"))
                    dt_finished = datetime.datetime.fromisoformat(str(finished).replace("Z", "+00:00"))
                    duration = (dt_finished - dt_started).total_seconds()
                except:
                    duration = None
            
            results.append({
                "id": r["id"],
                "job_id": r["job_id"],
                "status": r["status"],
                "timestamp": r["started_at"] or r["claimed_at"],
                "duration": duration,
                "error": r["error"],
                "returncode": 0 if r["status"] == "completed" else 1,
            })
        
        return {"ok": True, "executions": results}
    except sqlite3.Error as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"Erreur lecture logs: {e}"}


def get_cron_all_logs(limit: int = 50):
    """Get all cron execution logs across all jobs."""
    try:
        conn = sqlite3.connect(CRON_EXEC_DB, timeout=10.0)
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, job_id, source, pid, process_started_at, status, claimed_at, started_at, finished_at, error "
            "FROM executions ORDER BY started_at DESC LIMIT ?",
            (limit,)
        ).fetchall()
        conn.close()
        
        results = []
        for r in rows:
            started = r["started_at"]
            finished = r["finished_at"]
            duration = None
            if started and finished:
                try:
                    dt_started = datetime.datetime.fromisoformat(str(started).replace("Z", "+00:00"))
                    dt_finished = datetime.datetime.fromisoformat(str(finished).replace("Z", "+00:00"))
                    duration = (dt_finished - dt_started).total_seconds()
                except Exception:
                    duration = None
            
            results.append({
                "id": r["id"],
                "job_id": r["job_id"],
                "status": r["status"],
                "timestamp": r["started_at"] or r["claimed_at"],
                "duration": duration,
                "error": r["error"],
                "returncode": 0 if r["status"] == "completed" else 1,
            })
        
        return {"ok": True, "executions": results}
    except sqlite3.Error as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        return {"ok": False, "error": f"Erreur lecture logs: {e}"}


def delete_cron_execution(execution_id: str) -> dict:
    """Delete a single execution log entry from executions.db."""
    if not execution_id:
        return {"ok": False, "error": "execution_id requis"}
    try:
        conn = sqlite3.connect(CRON_EXEC_DB, timeout=10.0)
        cur = conn.execute("DELETE FROM executions WHERE id = ?", (execution_id,))
        conn.commit()
        deleted = cur.rowcount
        conn.close()
        if deleted:
            return {"ok": True, "deleted": deleted}
        return {"ok": False, "error": "exécution introuvable"}
    except sqlite3.Error as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# 5) Notifications
# (Les définitions UNIQUES de add_notification / get_notifications /
#  clear_notifications se trouvent en section 5c plus bas, au format tuple
#  (type, title, message, ts, agent). Cette ancienne double définition
#  (dict + get_notifications(clear, limit)) a été supprimée pour éviter la
#  confusion et le désaccord de format avec le reste du code.)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 5b) Détection automatique d'événements -> notifications (cloche fonctionnelle)
# ---------------------------------------------------------------------------
# Watermarks pour ne notifier chaque événement qu'UNE fois.
_NOTIF_CRON_TS = [0.0]          # dernier finished_at (epoch s) déjà notifié
_NOTIF_CRON_DONE = set()        # ids d'exécutions cron déjà notifiées
_NOTIF_AGENT_DONE = set()       # session ids déjà notifiés "agent a fini"


def _agent_state_dbs():
    """Tous les state.db natifs (racine + chaque profil agent)."""
    roots = [os.path.join(HOME, ".hermes", "state.db")]
    profs = glob.glob(os.path.join(HOME, ".hermes", "profiles", "*", "state.db"))
    return [p for p in (roots + profs) if os.path.exists(p)]


def _detect_event_notifications():
    """Pousse des notifications pour : (1) tâche/cron terminée, (2) agent ayant
    fini de répondre. Appelé périodiquement par la boucle SSE. Idempotent
    (watermarks)."""
    # --- (1) Cron / tâche terminée ---
    try:
        if os.path.exists(CRON_EXEC_DB):
            con = sqlite3.connect(CRON_EXEC_DB, timeout=5.0)
            con.row_factory = sqlite3.Row
            rows = con.execute(
                "SELECT id, job_id, status, finished_at FROM executions "
                "WHERE status IN ('completed','failed','error') "
                "ORDER BY finished_at DESC LIMIT 50"
            ).fetchall()
            con.close()
            last_ts = _NOTIF_CRON_TS[0]
            new_last = last_ts
            for r in rows:
                fa = r["finished_at"]
                # finished_at est un ISO string -> epoch
                ts = 0.0
                if fa:
                    try:
                        ts = datetime.datetime.fromisoformat(
                            str(fa).replace("Z", "+00:00")
                        ).timestamp()
                    except Exception:
                        ts = 0.0
                if ts > new_last:
                    new_last = ts
                if ts > last_ts and r["id"] not in _NOTIF_CRON_DONE:
                    # nouvelle exécution terminée non encore notifiée
                    st = r["status"]
                    ntype = "success" if st == "completed" else "error"
                    job = (r["job_id"] or "inconnu")[:24]
                    add_notification(
                        ntype,
                        "Tâche planifiée terminée" if st == "completed"
                        else "Tâche planifiée en échec",
                        "Job %s : %s%s" % (
                            job,
                            st,
                            ((" — " + (r["error"] or "")) if (st != "completed" and r["error"]) else ""),
                        ),
                        agent="cron",
                    )
                    _NOTIF_CRON_DONE.add(r["id"])
            _NOTIF_CRON_TS[0] = new_last
    except Exception as exc:  # noqa: BLE001
        pass

    # --- (2) Agent ayant fini de répondre (session terminée récemment) ---
    try:
        import tempfile as _tf
        cutoff = time.time() - 25.0  # fenêtre de détection
        _dbs = _agent_state_dbs()
        for db in _dbs:
            tmp = None
            try:
                # Copie locale pour éviter le verrou du gateway (écrit en
                # continu dans state.db). Lecture directe = timeout/exception.
                tmp = _tf.NamedTemporaryFile(suffix=".db", delete=False).name
                shutil.copyfile(db, tmp)
                con = sqlite3.connect(tmp, timeout=3.0)
                con.row_factory = sqlite3.Row
                rows = con.execute(
                    "SELECT id, title, last_activity_at, last_activity_description "
                    "FROM sessions ORDER BY last_activity_at DESC LIMIT 20"
                ).fetchall()
                con.close()
            except Exception as _e:
                continue
            finally:
                if tmp:
                    for _s in ("", "-shm", "-wal"):
                        try:
                            if os.path.exists(tmp + _s):
                                os.remove(tmp + _s)
                        except Exception:
                            pass
            for s in rows:
                sid = s["id"]
                la = s.get("last_activity_at") or 0
                if la and la >= cutoff and sid not in _NOTIF_AGENT_DONE:
                    desc = (s.get("last_activity_description") or "")
                    title = s.get("title") or sid
                    # Ne notifie que les sessions ayant effectivement fini de
                    # générer (pas un simple "message reçu").
                    desc_l = desc.lower()
                    _is_streaming = (
                        "stream" in desc_l or "generating" in desc_l
                        or "responding" in desc_l or "receive" in desc_l
                    )
                    _is_done = (
                        "complete" in desc_l or "final" in desc_l or "done" in desc_l
                    )
                    if _is_done and not _is_streaming:
                        add_notification(
                            "info",
                            "Agent a fini de répondre",
                            "\"%s\"" % title,
                            agent="messages",
                        )
                        _NOTIF_AGENT_DONE.add(sid)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 6) Scan model scoring
# ---------------------------------------------------------------------------
def calculate_model_score(latency_ms: float, ok: bool, error: str = None) -> dict:
    """Calculate a quality score for a model based on scan result.
    
    Score: 0-100, higher is better.
    Factors:
    - Success: -30 if failed
    - Latency: faster is better (normalized to 0-30 range)
    - Error type: specific penalties
    """
    base_score = 50
    
    if not ok:
        base_score -= 30
        # Additional penalties for specific errors
        if error:
            err_lower = str(error).lower()
            if "quota" in err_lower or "rate limit" in err_lower:
                base_score -= 10
            elif "401" in err_lower or "unauthorized" in err_lower:
                base_score -= 5
            elif "500" in err_lower or "timeout" in err_lower:
                base_score -= 20
    else:
        # Reward successful low-latency
        if latency_ms and latency_ms < 1000:
            base_score += 25
        elif latency_ms and latency_ms < 3000:
            base_score += 15
        elif latency_ms and latency_ms < 5000:
            base_score += 5
    
    # Normalize latency component
    latency_score = 0
    if ok and latency_ms:
        latency_score = max(0, min(30, 30 - (latency_ms / 100)))  # Cap at 30
    
    final_score = max(0, min(100, base_score + latency_score))
    
    return {
        "ok": ok,
        "score": final_score,
        "score_letter": "A" if final_score >= 80 else "B" if final_score >= 60 else "C" if final_score >= 40 else "D",
        "latency_ms": latency_ms,
        "error": error,
    }


# ---------------------------------------------------------------------------
# Cron execution logs functions
# ---------------------------------------------------------------------------
def get_cron_execution_logs(job_id: str = None, limit: int = 10) -> dict:
    """Get execution logs for cron jobs.
    
    Args:
        job_id: If provided, return logs for this specific job. Otherwise return recent logs.
        limit: Maximum number of execution records to return.
    
    Returns:
        dict with 'ok' and 'executions' list containing:
        - id, job_id, status, timestamp, duration, error, returncode
    """
    try:
        if not os.path.exists(CRON_EXEC_DB):
            return {"ok": True, "executions": []}
        
        conn = sqlite3.connect(CRON_EXEC_DB, timeout=30.0)
        conn.row_factory = sqlite3.Row
        
        if job_id:
            # Les runs manuels (`hermes cron run`) sont enregistres par le
            # scheduler avec un job_id suffixe "/run" ("<job_id>/run") alors
            # que les runs automatiques (builtin) utilisent l'id nu. On matche
            # donc les DEUX formes pour que l'historique du dashboard montre
            # aussi les executions direct (FIX 2026-08-08).
            cursor = conn.execute(
                """SELECT id, job_id, source, status, error, started_at, finished_at FROM executions
                   WHERE job_id = ? OR job_id = ? || '/run' ORDER BY started_at DESC LIMIT ?""",
                (job_id, job_id, limit)
            )
        else:
            cursor = conn.execute(
                """SELECT id, job_id, source, status, error, started_at, finished_at FROM executions
                   ORDER BY started_at DESC LIMIT ?""",
                (limit,)
            )
        
        rows = []
        for row in cursor.fetchall():
            started = row['started_at'] or 0
            finished = row['finished_at'] or 0
            duration = None
            
            # Handle duration calculation safely - values can be strings or numbers
            if started and finished:
                try:
                    # Convert to float if strings (ISO timestamps stored as TEXT in some contexts)
                    if isinstance(started, str):
                        started = float(started) if started.replace('.', '').replace('-', '').isdigit() else 0
                    if isinstance(finished, str):
                        finished = float(finished) if finished.replace('.', '').replace('-', '').isdigit() else 0
                    if started and finished:
                        duration = finished - started if isinstance(finished, (int, float)) and isinstance(started, (int, float)) else None
                except (ValueError, TypeError):
                    duration = None

            # ISO 8601 strings (e.g. "2026-08-08T12:15:53.744020+02:00") stored
            # as TEXT: float conversion fails above, so parse them properly to
            # expose a real duration in the UI (Feature 1: modal de détail).
            if duration is None and isinstance(row['started_at'], str) and isinstance(row['finished_at'], str):
                try:
                    start_dt = datetime.datetime.fromisoformat(row['started_at'])
                    finish_dt = datetime.datetime.fromisoformat(row['finished_at'])
                    duration = (finish_dt - start_dt).total_seconds()
                    if duration < 0:
                        duration = None
                except (ValueError, TypeError):
                    duration = None
            
            ts_str = None
            if row['started_at']:
                try:
                    ts_str = datetime.datetime.fromtimestamp(row['started_at']).isoformat()
                except:
                    ts_str = str(row['started_at'])
            
            rows.append({
                "id": row['id'],
                "job_id": row['job_id'],
                "source": row['source'] if 'source' in row.keys() else None,
                "status": row['status'] or 'unknown',
                "timestamp": ts_str,
                "duration": duration,
                "error": row['error'],
                "returncode": 0 if (row['status'] or '') in ('completed', 'ok') else 1
            })
        
        conn.close()
        return {"ok": True, "executions": rows}
    except Exception as e:
        return {"ok": False, "error": str(e), "executions": []}


def run_cron_now(job_id: str) -> dict:
    """Execute a cron job immediately via the hermes CLI.
    
    Args:
        job_id: The cron job ID to run
        
    Returns:
        dict with 'ok', 'execution_id', and optionally 'error'
    """
    if not job_id:
        return {"ok": False, "error": "job_id requis"}
    
    # Find the job to get its profile
    hermes_bin = shutil.which("hermes") or os.path.expanduser("~/.hermes/bin/hermes")
    if not os.path.exists(hermes_bin):
        # Try common locations
        hermes_bin = os.path.expanduser("~/.local/bin/hermes")
        if not os.path.exists(hermes_bin):
            return {"ok": False, "error": "binaire 'hermes' introuvable"}
    
    import uuid
    try:
        # Feature 1 : un run manuel doit TOUJOURS laisser une trace durable dans
        # executions.db avec source='direct'. `hermes cron run` ne crée pas
        # d'exécution quand le job n'est pas dû (le claim est perdu au profit du
        # ticker gateway -> "already being fired by the scheduler") ou quand il
        # passe par le dispatch en arrière-plan. On compte donc les lignes
        # 'direct' existantes pour ce job avant le run, puis on vérifie après :
        # si rien de neuf a été écrit par le CLI, on insère nous-mêmes une ligne
        # source='direct' qui reflète l'issue du déclenchement.
        direct_before = 0
        if os.path.exists(CRON_EXEC_DB):
            try:
                conn = sqlite3.connect(CRON_EXEC_DB, timeout=30.0)
                direct_before = conn.execute(
                    "SELECT COUNT(*) FROM executions WHERE job_id = ? AND source = 'direct'",
                    (job_id,)
                ).fetchone()[0]
                conn.close()
            except Exception:
                direct_before = -1  # ne pas insérer si la DB est illisible

        # Find the job's profile by scanning profiles/*/cron/jobs.json
        profile = None
        for p in glob.glob(os.path.expanduser("~/.hermes/profiles/*/cron/jobs.json")):
            try:
                data = json.load(open(p))
                if any(j.get("id") == job_id for j in data.get("jobs", [])):
                    profile = os.path.basename(os.path.dirname(os.path.dirname(p)))
                    break
            except Exception:
                pass
        profile_flag = ["-p", profile] if profile else []

        # Use hermes cron run to execute the job now
        proc = subprocess.run(
            [hermes_bin] + profile_flag + ["cron", "run", job_id],
            capture_output=True,
            text=True,
            timeout=60,
            env=dict(os.environ, HERMES_ACCEPT_HOOKS="1"),
        )
        
        out = (proc.stdout or "") + (proc.stderr or "")
        
        if proc.returncode != 0:
            return {
                "ok": False,
                "error": (out.strip() or "echec execution cron")[-500:]
            }
        
        # Try to extract execution ID from output
        import re
        m = re.search(r"execution_id[:=]\s+([a-f0-9]+)", out)
        execution_id = m.group(1) if m else None
        
        # Refresh the executions DB to get the new execution
        # The job has run, fetch the latest execution logs
        time.sleep(0.5)  # Brief pause to let the execution be recorded
        
        # Feature 1 : si le CLI n'a pas écrit de nouvelle exécution 'direct',
        # la créer nous-mêmes pour que le run manuel soit toujours visible.
        if direct_before >= 0 and os.path.exists(CRON_EXEC_DB):
            try:
                conn = sqlite3.connect(CRON_EXEC_DB, timeout=30.0)
                direct_after = conn.execute(
                    "SELECT COUNT(*) FROM executions WHERE job_id = ? AND source = 'direct'",
                    (job_id,)
                ).fetchone()[0]
                if direct_after <= direct_before:
                    # Déterminer l'issue : le CLI signale "Ran now: succeeded"
                    # quand l'exécution immédiate a eu lieu ; tout le reste
                    # (run planifié au prochain tick, claim perdu, échec) est
                    # enregistré comme échec avec le message dans error.
                    ok_run = "Ran now: succeeded" in out or "execution_id" in out
                    now_iso = datetime.datetime.now().astimezone().isoformat()
                    new_id = uuid.uuid4().hex
                    status = "completed" if ok_run else "failed"
                    detail = None if ok_run else (out.strip() or "run manuel non execute (claim perdu ou run differe)")[-500:]
                    conn.execute(
                        """INSERT INTO executions
                           (id, job_id, source, process_id, pid, process_started_at,
                            status, claimed_at, started_at, finished_at, error)
                           VALUES (?, ?, 'direct', ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (new_id, job_id, "mc-manual-" + str(os.getpid()), os.getpid(),
                         int(time.time()), status, now_iso, now_iso, now_iso, detail)
                    )
                    conn.commit()
                    execution_id = execution_id or new_id
                conn.close()
            except Exception:
                pass
        
        return {"ok": True, "execution_id": execution_id, "output": out.strip()[-500:]}
        
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "timeout lors de l'execution du cron"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_cron_all_logs(limit: int = 50) -> dict:
    """Get logs for all cron executions, grouped by job."""
    try:
        logs = get_cron_execution_logs(None, limit)
        return logs
    except Exception as e:
        return {"ok": False, "error": str(e)}


def get_notifications(clear: bool = False) -> dict:
    """Get all unread notifications.
    
    Args:
        clear: If True, mark all as read (remove from list).
    
    Returns:
        dict with 'ok' and 'notifications' list.
    """
    global _NOTIFICATIONS
    with _NOTIFICATIONS_LOCK:
        notif_copy = list(_NOTIFICATIONS)
        result = [{
            "type": n[0],
            "title": n[1],
            "message": n[2],
            "ts": n[3],
            "agent": n[4]
        } for n in notif_copy]
        if clear:
            _NOTIFICATIONS = []
        return {"ok": True, "notifications": result}


def clear_notifications(ids=None):
    """Efface des notifications côté serveur.

    ids=None  -> tout effacer.
    sinon     -> retire les notifications dont l'id front correspond.

    Les ids front sont de la forme ``notif-<ts>-<title>-<message>`` (voir
    toToast dans NotificationProvider.tsx). _NOTIFICATIONS stocke des tuples
    (type, title, message, ts, agent), on mappe donc via le critère
    (ts, title, message).
    """
    global _NOTIFICATIONS
    import re as _re

    def _match(n):
        # n est un tuple (type, title, message, ts, agent)
        if not ids:
            return False
        ts = n[3]
        title = n[1]
        msg = n[2]
        for i in ids:
            # id front: notif-<ts>-<title>-<message>  (ts = float epoch SECONDES
            # depuis epoch, ex. 1755771234.56). Le brief original utilisait
            # r"notif-(\d+)-" mais \d+ s'arrete au point decimal -> le float ne
            # match jamais. On accepte donc la partie decimale ([\d.]+).
            # Le front tronque l'id a 80 chars (.slice(0,80)) : on tolera la
            # troncature en exigeant title OU msg dans l'id (pas les deux).
            # Le ts seul suffit a identifier la notif de facon unique.
            m = _re.match(r"notif-([\d.]+)-", i or "")
            if m and float(m.group(1)) == ts and (title in i or msg in i):
                return True
        return False

    with _NOTIFICATIONS_LOCK:
        if ids is None:
            _NOTIFICATIONS = []
        else:
            _NOTIFICATIONS = [n for n in _NOTIFICATIONS if not _match(n)]
    return {"ok": True, "remaining": len(_NOTIFICATIONS)}


def add_notification(type: str, title: str, message: str, agent: str = None) -> dict:
    """Add a new notification.
    
    Args:
        type: 'success', 'error', 'warning', 'info'
        title: Short title
        message: Full message
        agent: Optional agent identifier
    
    Returns:
        dict with 'ok'.
    """
    global _NOTIFICATIONS
    if type not in ('success', 'error', 'warning', 'info'):
        type = 'info'
    
    with _NOTIFICATIONS_LOCK:
        _NOTIFICATIONS.append((type, title, message, time.time(), agent))
        # Keep only last 100 notifications
        if len(_NOTIFICATIONS) > 100:
            _NOTIFICATIONS = _NOTIFICATIONS[-100:]
    
    return {"ok": True}
