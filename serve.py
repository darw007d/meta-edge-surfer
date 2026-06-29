#!/usr/bin/env python3
"""Meta-Edge Surfer static-PWA server — hardened wrapper around
``python3 -m http.server``.

Why a wrapper instead of just ``python3 -m http.server 8089``:

* **ThreadingHTTPServer** so a single misbehaving request (slow client,
  connection reset, protocol violation) doesn't block the whole event
  loop — each request is isolated to its own thread.
* **Explicit handling of network-noise exceptions** at the request-
  handler level. Production hit (2026-05-13 07:41 UTC): an internet
  scanner sent malformed TLS bytes against the HTTP port, which raised
  uncaught exceptions inside ``handle_one_request`` and the process
  died. Subclassing the handler with broad-except on the network-error
  classes lets the server log + continue instead of crashing.
* **Connection-error silencing.** ``BrokenPipeError`` /
  ``ConnectionResetError`` / ``TimeoutError`` are normal facts of life
  on a public-facing static-file port. Log them once at INFO level
  and move on — not noise, not stacktraces.
* **systemd-friendly signal handling.** Plain ``KeyboardInterrupt`` /
  SIGTERM exits cleanly with rc=0 so the unit doesn't loop-restart on
  shutdown.

Pairs with ``systemd/meta-edge-surfer.service`` which sets ``Restart=
on-failure`` + ``RestartSec=5`` for the (now-rare) case where this
wrapper itself dies on something we didn't anticipate.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

log = logging.getLogger("meta-edge-surfer")

# Exception classes that count as "remote peer being annoying" — we log a
# one-line INFO and continue. Subclasses of OSError; ssl.SSLError lands
# here too when scanners speak TLS at our plain-HTTP port.
_QUIET_NET_ERRORS: tuple[type[BaseException], ...] = (
    BrokenPipeError,
    ConnectionResetError,
    ConnectionAbortedError,
    TimeoutError,
)


class HardenedHandler(SimpleHTTPRequestHandler):
    """Static-file handler that swallows network-noise exceptions.

    Overrides ``handle_one_request`` to wrap the parent's logic in a
    try/except that downgrades connection-class errors to INFO logs and
    re-raises anything else. Also overrides ``log_error`` to keep noise
    out of the journal — scanner garbage shouldn't masquerade as real
    server problems.
    """

    server_version = "MetaEdgeSurfer/1.0"

    def _spa_rewrite(self) -> None:
        """SPA fallback: a client-routed navigation (e.g. ``/join?invite=…``) maps
        to ``index.html`` so the app boots and reads the invite from the address
        bar. Only EXTENSIONLESS paths that don't map to a real file are rewritten —
        a missing asset (``/foo.png``) still 404s, and the query string is left on
        the browser URL untouched (the server only swaps which file it serves).
        In production nginx does this fallback; this keeps the static dev server
        and the live front behaving the same."""
        path = urlparse(self.path).path
        last = path.rsplit("/", 1)[-1]
        if "." in last:
            return  # looks like a concrete asset — leave 404 behavior intact
        candidate = self.translate_path(self.path)
        if not os.path.exists(candidate):
            self.path = "/index.html"

    def do_GET(self) -> None:  # noqa: D401
        self._spa_rewrite()
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: D401
        self._spa_rewrite()
        super().do_HEAD()

    def handle_one_request(self) -> None:  # noqa: D401
        try:
            super().handle_one_request()
        except _QUIET_NET_ERRORS as exc:
            log.info(
                "quiet network error from %s: %s: %s",
                self.address_string(), type(exc).__name__, exc,
            )
            self.close_connection = True
        except Exception as exc:  # pragma: no cover — defensive only
            # Last-resort guard: log + drop the connection, don't kill
            # the server. If this fires repeatedly on the same trigger,
            # the journal will tell us; that's the right level to debug
            # at, not "process died and systemd respawned" at the
            # operator level.
            log.warning(
                "unhandled handler exception from %s: %s: %s",
                self.address_string(), type(exc).__name__, exc,
            )
            self.close_connection = True

    def log_error(self, format_: str, *args: object) -> None:  # noqa: D401
        # Default log_error sends 400/404/500 lines to stderr. Most of
        # them on a public HTTP port are scanners, not real bugs. Demote
        # to INFO so the journal stays readable.
        log.info("client error: " + format_, *args)

    def log_message(self, format_: str, *args: object) -> None:  # noqa: D401
        # Keep the request-log line at INFO level (vs. default stderr
        # print) so systemd's StandardOutput= captures it cleanly.
        log.info(format_, *args)


def _install_signal_handlers() -> None:
    """Map SIGTERM (systemd stop) + SIGINT (Ctrl-C) to clean rc=0 exit."""

    def _graceful(signum: int, _frame: object) -> None:
        log.info("received signal %d — shutting down", signum)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _graceful)
    signal.signal(signal.SIGINT, _graceful)


def serve(bind: str, port: int) -> int:
    _install_signal_handlers()

    # ThreadingHTTPServer is the stdlib threading variant — one request
    # per thread, so slow/broken clients don't block siblings. The
    # handler subclass above handles its own exception cases; this
    # server's role is just "fan requests out."
    handler_class = partial(HardenedHandler, directory=".")

    try:
        httpd = ThreadingHTTPServer((bind, port), handler_class)
    except OSError as exc:
        log.error("could not bind %s:%d: %s", bind, port, exc)
        return 1

    sock_info = httpd.socket.getsockname()
    log.info(
        "meta-edge-surfer listening on http://%s:%d (PID %d)",
        sock_info[0], sock_info[1], _pid(),
    )

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log.info("KeyboardInterrupt — shutdown")
    finally:
        httpd.server_close()
    return 0


def _pid() -> int:
    import os
    return os.getpid()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="serve.py",
        description="Static-file server for Meta-Edge Surfer PWA, "
                    "with connection-error tolerance.",
    )
    parser.add_argument("--bind", default="0.0.0.0",
                        help="Address to bind (default: 0.0.0.0).")
    parser.add_argument("--port", type=int, default=8089,
                        help="Port to listen on (default: 8089).")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    # Suppress noisy DEBUG from urllib3 et al if anyone imports them later.
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    return serve(args.bind, args.port)


if __name__ == "__main__":
    raise SystemExit(main())
