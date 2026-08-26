import os, sqlite3, json

HERMES = os.path.expanduser("~/.hermes")

def db_for(profile):
    if profile == "default":
        return os.path.join(HERMES, "/state.db") if False else os.path.join(HERMES, "state.db")
    return os.path.join(HERMES, "profiles", profile, "state.db")

db = db_for("default")
con = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
con.row_factory = sqlite3.Row
# model_config for the mc session
sid = "20260818_222142_c4160d"
r = con.execute("SELECT model, model_config, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, message_count FROM sessions WHERE id=?", (sid,)).fetchone()
print("model:", r["model"])
print("input_tokens:", r["input_tokens"], "output_tokens:", r["output_tokens"])
print("model_config:", r["model_config"])
# roles present
print("roles:", con.execute("SELECT role, COUNT(*) c FROM messages WHERE session_id=? GROUP BY role", (sid,)).fetchall())
# A clean assistant message content (latest assistant, skip tool)
row = con.execute("SELECT content, role, tool_calls, reasoning FROM messages WHERE session_id=? AND role='assistant' AND tool_calls IS NULL ORDER BY timestamp DESC LIMIT 1", (sid,)).fetchone()
if row:
    print("ASSISTANT content sample:", (row["content"] or "")[:200])
    print("reasoning present:", bool(row["reasoning"]))
# user content sample
row2 = con.execute("SELECT content, role FROM messages WHERE session_id=? AND role='user' ORDER BY timestamp DESC LIMIT 1", (sid,)).fetchone()
if row2:
    print("USER content sample:", (row2["content"] or "")[:200])
con.close()
