#!/usr/bin/env python3
"""Local feed filter server. Serves the review page and the API the browser extension calls.

    python3 server.py            # http://127.0.0.1:8953

Binds to loopback unless FEED_HOST is set. Use a private network address, never 0.0.0.0.
There is no login. POSTs must be application/json, which stops other web pages from calling
the API with a plain form post.
"""
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import judge

HOST = os.environ.get("FEED_HOST", "127.0.0.1")
PORT = 8953
STATE_KEYS = {"enabled": bool, "mode": str, "threshold": float, "block_shorts": bool}


def public_state():
    state = judge.load_state()
    return {k: state[k] for k in STATE_KEYS}


def handle_post(path, body):
    state = judge.load_state()
    if path == "/api/judge":
        results = judge.judge(body["items"], state["mode"]) if state["enabled"] and body["items"] else {}
        return {"state": public_state(), "results": results}
    if path == "/api/vote":
        judge.vote(body["id"], body["vote"])
        return {"ok": True}
    if path == "/api/state":
        changes = {k: STATE_KEYS[k](v) for k, v in body.items() if k in STATE_KEYS}
        if changes.get("mode", "fast") not in judge.MODES:
            raise ValueError("mode must be fast or smart")
        state = judge.save_state(**changes)
        if "mode" in changes:
            judge.rescore(state["mode"])
        return public_state()
    if path == "/api/scan":
        if body.get("term"):
            return {"found": len(judge.scan(body["term"], state["mode"]))}
        profile = judge.load_profile()
        found = sum(len(judge.scan(t, state["mode"])) for t in profile["searches"])
        return {"found": found + sum(len(judge.scan_channel(c, state["mode"])) for c in profile["channels"])}
    if path == "/api/refine":
        return judge.refine()
    if path == "/api/keep":
        judge.save_keep(body["keep"])
        judge.save_state(threshold=float(body["threshold"]))
        judge.rescore(state["mode"])
        return {"ok": True}
    return None


class Handler(BaseHTTPRequestHandler):
    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/":
            data = (judge.ROOT / "review.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        elif self.path == "/api/items":
            keep = judge.load_profile()["keep"]
            state = judge.load_state()
            self.send_json(
                {
                    "state": public_state(),
                    "keep": keep,
                    "calibration": judge.calibration(state["mode"]),
                    "items": judge.list_items(state["mode"]),
                }
            )
        elif self.path == "/api/state":
            self.send_json(public_state())
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self.send_json({"error": "application/json required"}, 415)
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            result = handle_post(self.path, body)
        except (judge.JudgeError, subprocess.SubprocessError, KeyError, ValueError) as e:
            return self.send_json({"error": f"{type(e).__name__}: {e}"}, 400)
        if result is None:
            return self.send_json({"error": "not found"}, 404)
        self.send_json(result)

    def log_message(self, fmt, *args):
        print(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}", flush=True)


if __name__ == "__main__":
    print(f"feed filter on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
