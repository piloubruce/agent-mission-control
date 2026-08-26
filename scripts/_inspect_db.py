import os, sqlite3, json

HERMES = os.path.expanduser("~/.hermes")

def db_for(profile):
    if profile == "default":
        return os.path.join(HERMES, "state.db")
    return os.path.join(HERMES, "profiles", profile, "state.db")

# 1. The default profile has a live session "Faire action demandée" 20260818_222142_c4160d
db = db_for("default")
print("=== default state.db exists:", os.path.exists(db))
con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
con.row_factory = sqlite3.Row
# sessions schema columns
cols = [r[1] for r in con.execute("PRAGMA table_info(sessions)")]
print("sessions cols:", cols)
print()
print("=== recent sessions (default) ===")
for r in con.execute("SELECT id, source, title, started_at, message_count, input_tokens, output_tokens, model FROM sessions ORDER BY started_at DESC LIMIT 3"):
    print(dict(r))
print()
sid = "20260818_222142_c4160d"
print("=== messages for", sid, "===")
rows = con.execute("SELECT role, timestamp, substr(content,1,60) as c, token_count, tool_calls, reasoning FROM messages WHERE session_id=? ORDER BY timestamp LIMIT 6", (sid,)).fetchall()
for r in rows:
    print(dict(r))
print()
# Count active messages
cnt = con.execute("SELECT COUNT(*), SUM(CASE WHEN role='user' THEN 1 ELSE 0 END), SUM(CASE WHEN role='assistant' THEN 1 ELSE 0 END) FROM messages WHERE session_id=? AND active=1", (sid,)).fetchone()
print("msg count (total/user/asst):", tuple(cnt))
con.close()

# 2. Check what columns hold context / token info across schema
print()
print("=== model_context / token columns in sessions ===")
con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
con.row_factory = sqlite3.Row
for r in con.execute("PRAGMA table_info(sessions)"):
    print(r[1], r[2])
con.close()

# 3. Check hermes config.yaml for context window of tencent/hy3
print()
cfg = os.path.expanduser("~/.hermes/profiles/default/config.yaml")
print("config exists:", os.path.exists(cfg))
if os.path.exists(cfg):
    with open(cfg) as fh:
        print(fh.read()[:1500])
