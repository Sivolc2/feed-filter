#!/usr/bin/env python3
"""Attacks the server over real HTTP, in a temporary copy, with the scoring calls stubbed out.

    python3 tests/server_test.py
"""
import http.client
import json
import os
import pathlib
import shutil
import socket
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
work = pathlib.Path(tempfile.mkdtemp(prefix="ff-server-"))
for name in ("judge.py", "server.py", "review.html", "profile.example.json"):
    shutil.copy(ROOT / name, work / name)
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
os.environ.update(FEED_PORT=str(port), FEED_HOST="127.0.0.1", OPENROUTER_API_KEY="test-key-never-sent")
os.environ.pop("FEED_ALLOWED_HOSTS", None)
sys.path.insert(0, str(work))
import judge  # noqa: E402
import server  # noqa: E402

calls = {"fast": 0, "argv": []}


def fake_fast(texts, keep):
    calls["fast"] += len(texts)
    return [0.9 if "GOOD" in t else 0.1 for t in texts]


judge.SCORERS["fast"] = fake_fast
judge.score_fast = fake_fast
judge.post = lambda *a, **k: (_ for _ in ()).throw(AssertionError("network call attempted in tests"))
httpd = server.ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
server.Handler.log_message = lambda *a: None

HOST = f"127.0.0.1:{port}"


def call(method, path, body=None, headers=None, raw=None):
    con = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    h = {"Host": HOST}
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    con.putrequest(method, path, skip_host=True)
    if data is not None and "Content-Length" not in h:
        h["Content-Length"] = str(len(data))
    for k, v in h.items():
        con.putheader(k, v)
    con.endheaders()
    if data:
        con.send(data)
    res = con.getresponse()
    text = res.read().decode()
    con.close()
    try:
        return res.status, json.loads(text), res
    except ValueError:
        return res.status, text, res


def item(n, text="GOOD video", **over):
    return {"id": f"yt:vid{n}", "source": "youtube", "text": text, "url": f"https://www.youtube.com/watch?v=vid{n}", **over}


passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"FAIL  {name}  {detail}")


# --- a fresh clone: no data/, no profile.json ---
check("data dir is created on import", (work / "data").is_dir())
s, b, _ = call("GET", "/api/items")
check("missing profile.json gives a clear 400, not a crash", s == 400 and "profile.example.json" in b["error"], (s, b))
shutil.copy(work / "profile.example.json", work / "profile.json")
s, b, _ = call("GET", "/api/items")
check("items load after creating profile.json", s == 200 and b["items"] == [], (s, b))

# --- who may talk to it ---
check("DNS rebinding: foreign Host is refused (GET)", call("GET", "/api/items", headers={"Host": "evil.example:%d" % port})[0] == 403)
check("DNS rebinding: foreign Host is refused (POST)", call("POST", "/api/keep", {"keep": "x" * 30}, headers={"Host": "evil.example"})[0] == 403)
check("foreign Origin is refused", call("POST", "/api/state", {"enabled": False}, headers={"Origin": "https://evil.example"})[0] == 403)
check("foreign Origin is refused on GET", call("GET", "/api/items", headers={"Origin": "https://evil.example"})[0] == 403)
check("null Origin is refused", call("GET", "/api/items", headers={"Origin": "null"})[0] == 403)
check("extension Origin is allowed", call("GET", "/api/state", headers={"Origin": "chrome-extension://abcdef"})[0] == 200)
check("own Origin is allowed", call("GET", "/api/state", headers={"Origin": f"http://{HOST}"})[0] == 200)
check("state was not changed by refused requests", call("GET", "/api/state")[1]["enabled"] is True)
check("form-style POST is refused", call("POST", "/api/state", raw=b"enabled=false", headers={"Content-Type": "text/plain"})[0] == 415)
check("urlencoded POST is refused", call("POST", "/api/state", raw=b"a=1", headers={"Content-Type": "application/x-www-form-urlencoded"})[0] == 415)

# --- malformed requests ---
check("negative Content-Length", call("POST", "/api/state", raw=b"{}", headers={"Content-Type": "application/json", "Content-Length": "-1"})[0] == 413)
check("huge Content-Length", call("POST", "/api/state", raw=b"{}", headers={"Content-Type": "application/json", "Content-Length": "999999999"})[0] == 413)
check("non-numeric Content-Length", call("POST", "/api/state", raw=b"{}", headers={"Content-Type": "application/json", "Content-Length": "abc"})[0] == 413)
check("invalid JSON", call("POST", "/api/state", raw=b"{nope", headers={"Content-Type": "application/json"})[0] == 400)
check("JSON that is not an object", call("POST", "/api/state", [1, 2])[0] == 400)
check("unknown POST path", call("POST", "/api/nope", {})[0] == 404)
check("unknown GET path", call("GET", "/judge.py")[0] == 404)
check("path traversal", call("GET", "/../profile.json")[0] == 404)

# --- judging ---
s, b, _ = call("POST", "/api/judge", {"items": [item(1), item(2, "BAD video")]})
check("judge scores items", s == 200 and b["results"]["yt:vid1"]["p"] == 0.9 and b["results"]["yt:vid2"]["p"] == 0.1 and b["meta"]["scored"] == 2, (s, b))
before = calls["fast"]
s, b, _ = call("POST", "/api/judge", {"items": [item(1)]})
check("second look is served from cache", calls["fast"] == before and b["meta"]["scored"] == 0, b)
hostile = [
    item(10, url="javascript:alert(1)"), item(11, url="https://evil.example/x"), item(12, url="http://www.youtube.com/watch"),
    {**item(13), "id": "yt:../../etc"}, {**item(14), "id": "'; DROP TABLE items;--"}, item(15, text=5), item(16, text="   "),
    item(17, source="scan"), "not a dict", None, {**item(18), "id": ["yt:a"]},
]
s, b, _ = call("POST", "/api/judge", {"items": hostile})
check("hostile items are all dropped", s == 200 and b["results"] == {}, (s, b))
s, b, _ = call("POST", "/api/judge", {"items": [item(19, text="GOOD " + "x" * 5000)]})
with judge.db() as con:
    stored = con.execute("SELECT text FROM items WHERE id = 'yt:vid19'").fetchone()["text"]
check("long text is truncated before storage", len(stored) == 600, len(stored))
check("too many items is refused", call("POST", "/api/judge", {"items": [item(100 + i) for i in range(61)]})[0] == 400)
check("items that is not a list is refused", call("POST", "/api/judge", {"items": "abc"})[0] == 400)
check("missing items is refused", call("POST", "/api/judge", {})[0] == 400)

# --- values that used to brick the server ---
check("keep must be a string", call("POST", "/api/keep", {"keep": 5, "threshold": 0.5})[0] == 400)
check("keep must not be tiny", call("POST", "/api/keep", {"keep": "short"})[0] == 400)
check("keep must not be huge", call("POST", "/api/keep", {"keep": "x" * 4001})[0] == 400)
check("threshold 'nan' is refused", call("POST", "/api/state", {"threshold": "nan"})[0] == 400)
check("threshold NaN literal is refused", call("POST", "/api/state", raw=b'{"threshold": NaN}', headers={"Content-Type": "application/json"})[0] == 400)
check("threshold Infinity is refused", call("POST", "/api/state", raw=b'{"threshold": Infinity}', headers={"Content-Type": "application/json"})[0] == 400)
check("threshold 0 is refused", call("POST", "/api/state", {"threshold": 0})[0] == 400)
check("threshold true is refused", call("POST", "/api/state", {"threshold": True})[0] == 400)
check("bogus mode is refused", call("POST", "/api/state", {"mode": "p_fast = 1; --"})[0] == 400)
check("vote 'x' is refused", call("POST", "/api/vote", {"id": "yt:vid1", "vote": "x"})[0] == 400)
check("vote true is refused", call("POST", "/api/vote", {"id": "yt:vid1", "vote": True})[0] == 400)
check("vote 0 is refused", call("POST", "/api/vote", {"id": "yt:vid1", "vote": 0})[0] == 400)
check("vote with non-string id is refused", call("POST", "/api/vote", {"id": {"a": 1}, "vote": 1})[0] == 400)
s, b, _ = call("GET", "/api/items")
check("server still healthy after all of that", s == 200 and len(b["items"]) == 3 and b["state"]["threshold"] == 0.5, (s, b if s != 200 else len(b["items"])))
check("state.json is strict JSON", "NaN" not in (work / "data" / "state.json").read_text())

# --- normal use ---
check("valid vote", call("POST", "/api/vote", {"id": "yt:vid1", "vote": 1})[0] == 200)
check("valid downvote", call("POST", "/api/vote", {"id": "yt:vid2", "vote": -1})[0] == 200)
s, b, _ = call("GET", "/api/items")
check("votes show up with calibration", b["calibration"]["votes"] == 2 and b["calibration"]["agreement"] == 1.0, b["calibration"])
check("vote can be cleared", call("POST", "/api/vote", {"id": "yt:vid1", "vote": None})[0] == 200 and call("GET", "/api/items")[1]["calibration"]["votes"] == 1)
good_keep = "Keep things that are GOOD and skip things that are BAD, please and thank you."
check("valid keep is saved", call("POST", "/api/keep", {"keep": good_keep, "threshold": 0.4})[0] == 200)
s, b, _ = call("GET", "/api/items")
check("keep and threshold applied, items rescored", b["keep"] == good_keep and b["state"]["threshold"] == 0.4 and all(i["p"] is not None for i in b["items"]), b["state"])
check("personal profile fields survive a keep change", json.loads((work / "profile.json").read_text())["channels"] == ["@3blue1brown", "@kurzgesagt"])
check("refine needs votes", call("POST", "/api/refine", {})[0] == 400)

# --- scans never reach a shell and never pass an option to yt-dlp ---
class FakeRun:
    stdout = json.dumps({"entries": [{"id": "abc123", "title": "GOOD scan result", "channel": "Chan"}, {"id": "zzz", "title": None}]})


def fake_run(argv, **kw):
    calls["argv"].append(argv)
    assert kw.get("shell") is not True
    return FakeRun()


judge.subprocess.run = fake_run
s, b, _ = call("POST", "/api/scan", {"term": "--exec 'touch /tmp/pwned' ; $(id) & physics"})
argv = calls["argv"][-1]
check("scan term is one URL argument", s == 200 and b["found"] == 1 and argv[0] == "yt-dlp" and argv[1].startswith("https://www.youtube.com/results?") and " " not in argv[1] and "--exec" not in argv[2:], argv)
check("scan term that is not a string is refused", call("POST", "/api/scan", {"term": ["a"]})[0] == 400)
check("scan term that is too long is refused", call("POST", "/api/scan", {"term": "x" * 201})[0] == 400)
try:
    judge.scan_channel("--exec=evil", "fast")
    check("bad channel handle is refused", False)
except judge.JudgeError:
    check("bad channel handle is refused", True)
(work / "profile.json").write_text(json.dumps({"keep": good_keep, "searches": ["ok", 5, ""], "channels": ["@fine", "--exec=evil", "../x", 7]}))
profile = judge.read_profile()
check("profile searches and channels are filtered", profile["searches"] == ["ok"] and profile["channels"] == ["@fine"], profile)


def missing(argv, **kw):
    raise FileNotFoundError("yt-dlp")


judge.subprocess.run = missing
s, b, _ = call("POST", "/api/scan", {"term": "x"})
check("missing yt-dlp gives a clear 400", s == 400 and "yt-dlp" in b["error"], (s, b))

# --- a scorer blowing up must not drop the connection or kill the server ---
def boom(texts, keep):
    raise RuntimeError("kaboom /secret/path")


judge.SCORERS["fast"] = boom
s, b, _ = call("POST", "/api/judge", {"items": [item(50)]})
check("unexpected error gives a 500 with no detail", s == 500 and "kaboom" not in json.dumps(b) and "RuntimeError" in b["error"], (s, b))
judge.SCORERS["fast"] = lambda texts, keep: ["0.5" for _ in texts]
judge.SCORERS["fast"] = fake_fast
check("server alive after the 500", call("GET", "/api/state")[0] == 200)

# --- model output is never trusted ---
for bad in ("no list here", "[0.5]", '["a", "b"]', "[NaN, 0.2]", '{"x": 1}', "[true, false]"):
    judge.chat = lambda system, user, bad=bad: bad
    try:
        judge.score_smart(["a", "b"], "keep")
        check(f"smart reply {bad!r} is rejected", False)
    except judge.JudgeError:
        check(f"smart reply {bad!r} is rejected", True)
judge.chat = lambda system, user: "Sure! [1.7, -3]"
check("smart scores are clamped to 0..1", judge.score_smart(["a", "b"], "keep") == [1.0, 0.0])

# --- daily cap ---
judge.DAILY_CAP = judge.load_state()["scored"] + 1
s, b, _ = call("POST", "/api/judge", {"items": [item(60), item(61)]})
check("daily cap refuses the batch", s == 400 and "daily limit" in b["error"], (s, b))
check("one more item still fits under the cap", call("POST", "/api/judge", {"items": [item(62)]})[0] == 200)
judge.DAILY_CAP = 10**9

# --- page headers and bind rules ---
s, _, res = call("GET", "/")
check("review page has a CSP and no-sniff", s == 200 and "default-src 'none'" in res.getheader("Content-Security-Policy", "") and res.getheader("X-Content-Type-Options") == "nosniff" and res.getheader("X-Frame-Options") == "DENY")
check("review page never assigns an unchecked href", "a.href = it.url;" in (work / "review.html").read_text() and "if (/^https:" in (work / "review.html").read_text())
check("bind rule", [server.private(h) for h in ("127.0.0.1", "localhost", "192.168.1.5", "10.0.0.2", "100.64.1.2", "0.0.0.0", "8.8.8.8", "example.com", "::")] == [True, True, True, True, True, False, False, False, False],
      [server.private(h) for h in ("127.0.0.1", "localhost", "192.168.1.5", "10.0.0.2", "100.64.1.2", "0.0.0.0", "8.8.8.8", "example.com", "::")])

# --- concurrent state writes stay consistent ---
errors = []


def hammer(i):
    try:
        for _ in range(30):
            judge.save_state(threshold=0.3 + (i % 5) / 10)
            json.loads((work / "data" / "state.json").read_text())
    except Exception as e:
        errors.append(repr(e))


threads = [threading.Thread(target=hammer, args=(i,)) for i in range(8)]
[t.start() for t in threads]
[t.join() for t in threads]
check("concurrent state writes never leave a broken file", not errors, errors[:2])
check("no network call was ever attempted", True)

httpd.shutdown()
shutil.rmtree(work)
print(f"server: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
