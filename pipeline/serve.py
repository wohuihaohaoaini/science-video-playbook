"""Quiet static file server for the render workers.

`python -m http.server` keeps the default listen backlog of 5; with 7 headless browsers requesting
fonts, photos and scripts at once, connections get refused and film.js may never load
("filmReady is not defined"). This server raises the backlog and threads every request.
"""
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Server(ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


if __name__ == '__main__':
    port, root = int(sys.argv[1]), sys.argv[2]
    Server(('127.0.0.1', port), partial(Handler, directory=root)).serve_forever()
