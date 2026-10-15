#!/usr/bin/env python3
"""Serve chop chop locally with the same security headers as production.

The headers (including the Content-Security-Policy) are read from vercel.json,
so anything that would break in production also breaks here.

    python3 tools/serve.py          # http://localhost:8000
    python3 tools/serve.py 8080     # another port
"""
import http.server
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

with open(os.path.join(ROOT, 'vercel.json')) as f:
    HEADERS = json.load(f)['headers'][0]['headers']


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        for h in HEADERS:
            self.send_header(h['key'], h['value'])
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    print(f'chop chop → http://localhost:{PORT}  (Ctrl+C to stop)')
    http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
