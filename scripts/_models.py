import os, glob, re

base = os.path.expanduser("~/.hermes/profiles")
for a in ["developpeur", "bob", "recherche", "redacteur", "reseau", "social", "vision-image", "vision-media"]:
    p = os.path.join(base, a, "config.yaml")
    if not os.path.exists(p):
        print(a, "NO CONFIG"); continue
    txt = open(p).read()
    m = re.search(r"default:\s*([^\n]+)", txt)
    prov = re.search(r"provider:\s*([^\n]+)", txt)
    mt = re.search(r"max_tokens:\s*(\d+)", txt)
    print(f"{a:14} model={m.group(1).strip() if m else '?':30} provider={prov.group(1).strip() if prov else '?':14} max_tokens={mt.group(1) if mt else '?'}")
