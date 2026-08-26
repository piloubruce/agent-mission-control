#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Applique la matrice d'affectation des modeles sur les config.yaml des profils Hermes.
Backup + remplacement bloc model + ajout fallback_providers (ecriture atomique).
Reste intact: tout le reste du fichier. Non destructif.
"""
import os, re, time, sys, copy

HOME = os.path.expanduser("~")
PROFILES = os.path.join(HOME, ".hermes", "profiles")
BACKUP_DIR = os.path.join(HOME, "agent-mission-control", "mc-backups")  # existe

# Providers de base: globales resolve (base_url par fournisseur)
OMNI_BASE   = "http://192.168.1.240:20128/v1"   # OmniRoute local (custom)
LMST_BASE   = "http://192.168.1.10:1234/v1"     # LM Studio local (custom)
OLLAMA_BASE = "http://192.168.1.10:11434/v1"    # Ollama local (custom) - a verifier

def resolve(p):
    """Retourne (provider, base_url_or_None) pour le nom de provider de la matrice."""
    if p == "gemini":
        return "gemini", None
    if p == "nous":
        return "nous", None
    if p == "omni-route":
        return "custom", OMNI_BASE
    if p == "lmstudio":
        return "custom", LMST_BASE
    if p == "ollama-local":
        return "custom", OLLAMA_BASE
    return p, None

# Matrice d'affectation: profil -> [(provider, model), ...] ordre de priorite
MATRIX = {
    "default":    [("gemini", "gemini-3.6-flash"), ("omni-route", "qwen-web/qwen3.7-max"), ("nous", "tencent/hy3:free"), ("lmstudio", "qwen/qwen3.6-35b-a3b")],
    "recherche":  [("gemini", "gemini-flash-latest"), ("omni-route", "oc/deepseek-v4-flash-free"), ("nous", "stepfun/step-3.7-flash:free"), ("lmstudio", "google/gemma-4-26b-a4b-qat")],
    "reseau":     [("gemini", "gemini-3.6-flash"), ("omni-route", "nvidia/nemotron-3-super-120b-a12b"), ("nous", "tencent/hy3:free"), ("ollama-local", "nemotron-3-nano:latest")],
    "developpeur":[("omni-route", "qwen-web/qwen3.7-max"), ("gemini", "gemini-3.6-flash"), ("nous", "poolside/laguna-xs-2.1:free"), ("ollama-local", "qwen3-coder:latest")],
    "analyse":    [("omni-route", "nvidia/nemotron-3-super-120b-a12b"), ("gemini", "gemini-flash-latest"), ("nous", "stepfun/step-3.7-flash:free"), ("lmstudio", "qwen/qwen3.6-35b-a3b")],
    "redacteur":  [("gemini", "gemini-3.6-flash"), ("omni-route", "qwen-web/qwen3.7-plus"), ("nous", "tencent/hy3:free"), ("lmstudio", "qwythos-9b-claude-mythos-5-1m")],
    "social":     [("gemini", "gemini-3.6-flash"), ("omni-route", "qwen-web/qwen3.6-plus"), ("nous", "tencent/hy3:free"), ("lmstudio", "mistralai/mistral-small-3.2")],
    "vision-image": [("gemini", "gemini-3.6-flash"), ("omni-route", "qwen-web/qwen3.7-max"), ("nous", "tencent/hy3:free"), ("lmstudio", "zai-org/glm-4.6v-flash")],
    "vision-media": [("gemini", "gemini-3.6-flash"), ("omni-route", "qwen-web/qwen3.7-plus"), ("nous", "stepfun/step-3.7-flash:free"), ("lmstudio", "nvidia/nemotron-3-nano-omni")],
    "bob":        [("omni-route", "nvidia/nemotron-3-super-120b-a12b"), ("gemini", "gemini-3.6-flash"), ("nous", "poolside/laguna-xs-2.1:free"), ("ollama-local", "qwen3-coder:latest")],
    "agentique":  [("gemini", "gemini-flash-latest"), ("omni-route", "oc/deepseek-v4-flash-free"), ("nous", "tencent/hy3:free"), ("lmstudio", "google/gemma-4-26b-a4b-qat")],
}

def build_model_block(primary):
    prov, base = resolve(primary[0])
    lines = ["model:"]
    if prov == "custom":
        lines.append("  provider: custom")
        lines.append(f"  base_url: {base}")
        lines.append(f"  default: {primary[1]}")
    else:
        lines.append(f"  provider: {prov}")
        lines.append(f"  default: {primary[1]}")
    return "\n".join(lines) + "\n"

def build_fallback(list_models):
    out = ["fallback_providers:"]
    for prov, mdl in list_models:
        p, base = resolve(prov)
        if p == "custom":
            out.append(f"  - provider: custom")
            out.append(f"    model: {mdl}")
            out.append(f"    base_url: {base}")
        else:
            out.append(f"  - provider: {p}")
            out.append(f"    model: {mdl}")
    return "\n".join(out) + "\n"

def atomic_write(path, text):
    tmp = path + ".tmp." + str(os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)

def replace_model_block(content, new_block):
    """Remplace le bloc 'model:' en haut (jusqu'a la prochaine cle de niveau 0)."""
    m = re.match(r"(?ms)^model:\n(?:[^\n]*\n|  .*\n)*?(?=^\S|\Z)", content)
    if not m:
        return None
    return new_block + content[m.end():]

def main():
    ts = time.strftime("%Y%m%d-%H%M%S")
    os.makedirs(BACKUP_DIR, exist_ok=True)
    applied = []
    for name, entries in MATRIX.items():
        path = os.path.join(PROFILES, name, "config.yaml")
        if not os.path.isfile(path):
            print(f"[SKIP] {name}: pas de config.yaml"); continue
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        # backup
        bak = os.path.join(BACKUP_DIR, f"config-{name}-{ts}.yaml.bak")
        with open(bak, "w", encoding="utf-8") as f:
            f.write(content)
        primary = entries[0]
        fallbacks = entries[1:]
        new_model = build_model_block(primary)
        new_fb = build_fallback(fallbacks)
        content2 = replace_model_block(content, new_model)
        if content2 is None:
            print(f"[FAIL] {name}: bloc model introuvable"); continue
        # retire toute fallback_providers existante puis ajoute en fin
        content2 = re.sub(r"(?ms)^fallback_providers:.*?(?=^\S|\Z)", "", content2).rstrip() + "\n\n" + new_fb
        atomic_write(path, content2)
        applied.append((name, primary, fallbacks, bak))
        print(f"[OK ] {name}: backup={os.path.basename(bak)}")
        print(f"      primary={primary[0]}/{primary[1]}  fallback={[f[0]+'/'+f[1] for f in fallbacks]}")
    print(f"\nTermine: {len(applied)} profils modifies, backups dans {BACKUP_DIR}/")

if __name__ == "__main__":
    main()