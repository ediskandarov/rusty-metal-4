#!/usr/bin/env python3
"""Serve the WASM build with isolation headers required by PsyZ's SDL threads."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

    def do_GET(self):
        if self.path == '/favicon.ico':
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--directory', type=Path,
                        default=Path(__file__).resolve().parents[2] / 'build/web/site')
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port),
                                 partial(Handler, directory=str(args.directory)))
    print(f'Open http://localhost:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
