#!/usr/bin/env python3
"""Local dev server: serves the site and proxies /adsb/lol/* and /adsb/fi/* to the ADS-B feeds,
exactly what the Amplify reverse-proxy rules (infra/custom-rules.json) do in production.
    python3 test/dev-server.py [port]     ->  http://localhost:8765/  (add ?demo=1 for pretend planes)"""
import http.server, os, sys, urllib.error, urllib.request

PROXY = {'/adsb/lol/': 'https://api.adsb.lol/', '/adsb/fi/': 'https://opendata.adsb.fi/'}
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def do_GET(self):
        for prefix, base in PROXY.items():
            if self.path.startswith(prefix):
                return self.proxy(base + self.path[len(prefix):])
        super().do_GET()

    def proxy(self, url):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'whats-that-plane dev-server'})
            with urllib.request.urlopen(req, timeout=15) as r:
                body = r.read()
                self.send_response(r.status)
                self.send_header('Content-Type', r.headers.get('Content-Type', 'application/json'))
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_error(e.code, f'upstream {e}')
        except Exception as e:  # noqa: BLE001
            self.send_error(502, f'upstream {e}')

    def log_message(self, fmt, *args):
        if '/adsb/' in self.path:          # only log proxy traffic (and its errors); static files are noise
            super().log_message(fmt, *args)


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    print(f'http://localhost:{port}/   (proxying {", ".join(PROXY)})')
    http.server.ThreadingHTTPServer(('', port), Handler).serve_forever()
