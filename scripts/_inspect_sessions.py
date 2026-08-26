import os, json, glob

base = os.path.expanduser("~/.hermes/profiles")
for agent in ["bob", "developpeur"]:
    d = os.path.join(base, agent, "sessions")
    files = sorted(glob.glob(os.path.join(d, "*.json")), key=lambda p: os.path.getmtime(p), reverse=True)
    real = [f for f in files if "request_dump" not in f]
    print(f"=== agent={agent} : {len(real)} real sessions ===")
    if not real:
        continue
    f = real[0]
    print("NEWEST REAL:", os.path.basename(f))
    try:
        data = json.load(open(f))
        print("top keys:", list(data.keys()))
        print("title:", repr(data.get("title")))
        msgs = data.get("messages", [])
        print("num messages:", len(msgs))
        if msgs:
            m0 = msgs[0]
            print("msg[0] type:", type(m0).__name__)
            if isinstance(m0, dict):
                print("msg[0] keys:", list(m0.keys()))
                print("msg[0] sample:", {k: (str(v)[:80] if isinstance(v, str) else v) for k, v in m0.items()})
        for k in data.keys():
            if k != "messages":
                v = data[k]
                print(f"  {k} = {str(v)[:120]}")
    except Exception as e:
        print("ERR", e)
