#!/usr/bin/env python3
"""Local feed filter server. Serves the review page and the API the browser extension calls.

    python3 server.py            # http://127.0.0.1:8953

Binds to loopback unless FEED_HOST is set. There is no login, so it only binds to a private
address, and it only answers requests addressed to itself by name (which stops other web
pages reaching it through DNS rebinding) that come from its own page or a browser extension.
"""
import ipaddress
import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import judge

HOST = os.environ.get("FEED_HOST", "127.0.0.1")
PORT = int(os.environ.get("FEED_PORT", "8953"))
MAX_BODY = 1_000_000
MAX_ITEMS = 60
HOSTS = {f"{HOST}:{PORT}", f"localhost:{PORT}", f"127.0.0.1:{PORT}"} | {h.strip() for h in os.environ.get("FEED_ALLOWED_HOSTS", "").split(",") if h.strip()}
ITEM_ID = re.compile(r"^[a-z]{1,4}:[\w-]{1,60}$")
# source -> (id prefix, origin its links must start with). Mirrors extension/sites.js.
SOURCES = {
    "youtube": ("yt", "https://www.youtube.com"),
    "x": ("x", "https://x.com"),
    "reddit": ("rd", "https://www.reddit.com"),
    "hackernews": ("hn", "https://news.ycombinator.com"),
    "bluesky": ("bs", "https://bsky.app"),
    "threads": ("th", "https://www.threads.com"),
    "facebook": ("fb", "https://www.facebook.com"),
    "linkedin": ("li", "https://www.linkedin.com"),
}
PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'"


class BadRequest(Exception):
    pass


def public_state():
    state = judge.load_state()
    return {k: state[k] for k in ("enabled", "mode", "threshold", "block_shorts")}


def clean_items(items):
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise BadRequest(f"items must be a list of at most {MAX_ITEMS}")
    out = []
    for it in items:
        ok = (
            isinstance(it, dict)
            and isinstance(it.get("source"), str) and it["source"] in SOURCES
            and isinstance(it.get("id"), str) and ITEM_ID.match(it["id"]) and it["id"].startswith(SOURCES[it["source"]][0] + ":")
            and isinstance(it.get("url"), str) and it["url"].startswith(SOURCES[it["source"]][1] + "/")
            and isinstance(it.get("text"), str) and it["text"].strip()
        )
        if ok:
            out.append({"id": it["id"], "source": it["source"], "text": it["text"][:600], "url": it["url"][:300]})
    return out


def state_changes(body):
    changes = {}
    if isinstance(body.get("enabled"), bool):
        changes["enabled"] = body["enabled"]
    if isinstance(body.get("block_shorts"), bool):
        changes["block_shorts"] = body["block_shorts"]
    if "mode" in body:
        if body["mode"] not in judge.MODES:
            raise BadRequest("mode must be fast or smart")
        changes["mode"] = body["mode"]
    if "threshold" in body:
        changes["threshold"] = threshold(body["threshold"])
    return changes


def threshold(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value < 1:
        raise BadRequest("threshold must be a number between 0 and 1")
    return float(value)


def handle_post(path, body):
    if not isinstance(body, dict):
        raise BadRequest("body must be a JSON object")
    state = judge.load_state()
    if path == "/api/judge":
        items = clean_items(body.get("items"))
        before = judge.load_state()["scored"]
        results = judge.judge(items, state["mode"]) if state["enabled"] and items else {}
        return {"state": public_state(), "results": results, "meta": {"scored": max(0, judge.load_state()["scored"] - before), "cost": 0}}
    if path == "/api/vote":
        if not isinstance(body.get("id"), str) or body.get("vote") not in (1, -1, None) or isinstance(body.get("vote"), bool):
            raise BadRequest("vote must be 1, -1 or null")
        judge.vote(body["id"], body["vote"])
        return {"ok": True}
    if path == "/api/state":
        changes = state_changes(body)
        state = judge.save_state(**changes)
        if "mode" in changes:
            judge.rescore(state["mode"])
        return public_state()
    if path == "/api/scan":
        term = body.get("term")
        if term is not None:
            if not isinstance(term, str) or not 0 < len(term.strip()) <= 200:
                raise BadRequest("term must be a short string")
            return {"found": len(judge.scan(term.strip(), state["mode"]))}
        profile = judge.load_profile()
        found = sum(len(judge.scan(t, state["mode"])) for t in profile["searches"])
        return {"found": found + sum(len(judge.scan_channel(c, state["mode"])) for c in profile["channels"])}
    if path == "/api/refine":
        return judge.refine()
    if path == "/api/keep":
        judge.save_keep(body.get("keep"))
        if "threshold" in body:
            judge.save_state(threshold=threshold(body["threshold"]))
        judge.rescore(state["mode"])
        return {"ok": True}
    return None


class Handler(BaseHTTPRequestHandler):
    timeout = 30  # seconds a client may take to send its request

    def send_json(self, obj, status=200):
        self.send_bytes(json.dumps(obj).encode(), "application/json", status)

    def send_bytes(self, data, content_type, status=200, extra=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        for name, value in extra:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def refused(self):
        """True (after answering 403) unless the request is addressed to us and comes from our page or an extension."""
        origin = self.headers.get("Origin")
        ok = self.headers.get("Host") in HOSTS and (
            origin is None or origin.startswith("chrome-extension://") or origin in {f"http://{h}" for h in HOSTS}
        )
        if not ok:
            self.send_json({"error": "forbidden"}, 403)
        return not ok

    def answer(self, work):
        try:
            result = work()
        except (BadRequest, judge.JudgeError) as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:  # never drop the connection without an answer
            print(f"error handling {self.path}: {type(e).__name__}: {e}", flush=True)
            return self.send_json({"error": f"server error ({type(e).__name__})"}, 500)
        if result is None:
            return self.send_json({"error": "not found"}, 404)
        self.send_json(result)

    def do_GET(self):
        if self.refused():
            return
        if self.path == "/":
            return self.send_bytes(
                (judge.ROOT / "review.html").read_bytes(), "text/html; charset=utf-8",
                extra=[("Content-Security-Policy", PAGE_CSP), ("X-Frame-Options", "DENY"), ("Referrer-Policy", "no-referrer")],
            )

        def work():
            if self.path == "/api/items":
                keep = judge.load_profile()["keep"]
                state = judge.load_state()
                return {"state": public_state(), "keep": keep, "calibration": judge.calibration(state["mode"]), "items": judge.list_items(state["mode"])}
            if self.path == "/api/state":
                return public_state()
            return None

        self.answer(work)

    def do_POST(self):
        if self.refused():
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
            return self.send_json({"error": "application/json required"}, 415)
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            length = -1
        if not 0 <= length <= MAX_BODY:
            return self.send_json({"error": "bad or missing Content-Length"}, 413)

        def work():
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                raise BadRequest("body is not valid JSON") from None
            return handle_post(self.path, body)

        self.answer(work)

    def log_message(self, fmt, *args):
        print(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}", flush=True)


def private(host):
    """Loopback, private-range and carrier-grade-NAT (VPN/tailnet) addresses are fine to bind without a login."""
    if host == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.is_unspecified:  # 0.0.0.0 and :: mean "every interface", including public ones
        return False
    return ip.is_loopback or ip.is_private or (ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10"))


if __name__ == "__main__":
    if not private(HOST) and os.environ.get("FEED_ALLOW_PUBLIC") != "1":
        raise SystemExit(f"refusing to bind {HOST}: this server has no login. Use a private address, or set FEED_ALLOW_PUBLIC=1 if you are sure.")
    print(f"feed filter on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
