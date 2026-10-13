"""Native Tern rendering for Code Puppy final responses (TSP over the pty).

Install by explicit copy or symlink into a plugin tier, e.g.
``ln -s <trebol>/tern-plugins/code-puppy/python-plugin ~/.code_puppy/plugins/tern``.
Nothing is installed automatically.

Behaviour:
- Startup probes once for a TSP ``hello`` reply (only under TERM_PROGRAM=tern on
  a real tty, outside tmux/screen/zellij, unless TERN_TSP=0).
- Final agent responses (banner ``agent_response``) are drawn as a read-only
  ``flow`` surface (``listen:false``): Tern sends no events, stdin is untouched.
- Anything else (no TSP, oversize frame, write error, other banners) returns
  nothing, so core Rich output is used.

Not covered: streamed text (printed by the event stream handler before the
final response is known) and tool output. Approvals and tool gating are not
touched; this plugin only draws output.
"""

from __future__ import annotations

import itertools
import json
import os
import re
import select
import sys
import time
from typing import Any

from code_puppy.callbacks import register_callback

ESC = "\x1b"
ST = "\x1b\\"
_ENV_OFF = "TERN_TSP"
_MULTIPLEXER_ENV = ("TMUX", "STY", "ZELLIJ")
_PROBE_TIMEOUT = 1.0
# Under the 65536-byte APC limit. Larger answers stay in Rich rather than chunking.
_MAX_FRAME_BYTES = 60000
_BANNER_CLAIMED = "agent_response"
_DA1_RE = re.compile(rb"\x1b\[\?[0-9;]*c")
_state: dict[str, Any] = {"enabled": False}
_ids = itertools.count(1)


def encode(verb: str, body: Any) -> str:
    """Frame one program -> terminal message: ``ESC _ tsp;<verb>;<json> ESC \\``."""
    payload = json.dumps(body, ensure_ascii=False, separators=(",", ":"))
    return f"{ESC}_tsp;{verb};{payload}{ST}"


def parse_hello_reply(data: bytes) -> bool:
    """True only when a v1 ``hello`` reply arrives BEFORE the DA1 answer."""
    marker = b"\x1b_tsp;r;"
    start = data.find(marker)
    if start < 0:
        return False
    da1 = _DA1_RE.search(data)
    if da1 is None or da1.start() < start:
        return False
    end = data.find(b"\x1b\\", start)
    if end < 0 or end > da1.start():
        return False
    try:
        reply = json.loads(data[start + len(marker) : end].decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return False
    return (
        reply.get("r") == "hello"
        and reply.get("v") in (1, [1])
        and "flow" in reply.get("features", [])
        and "md" in reply.get("kinds", [])
    )


def _candidate() -> bool:
    if os.environ.get(_ENV_OFF) == "0":
        return False
    if os.environ.get("TERM_PROGRAM") != "tern":
        return False
    return not any(os.environ.get(name) for name in _MULTIPLEXER_ENV)


def _probe() -> bool:
    """Raw-mode hello query, read until DA1 or timeout; tty always restored."""
    if not _candidate():
        return False
    try:
        if not (sys.stdin.isatty() and sys.stdout.isatty()):
            return False
        import termios
        import tty

        fd = sys.stdin.fileno()
        saved = termios.tcgetattr(fd)
        buf = b""
        try:
            tty.setraw(fd)
            query = encode(
                "q", {"q": "hello", "v": [1], "app": "code-puppy", "features": []}
            )
            sys.stdout.write(query + f"{ESC}[c")
            sys.stdout.flush()
            deadline = time.monotonic() + _PROBE_TIMEOUT
            while time.monotonic() < deadline:
                ready, _, _ = select.select([fd], [], [], 0.05)
                if not ready:
                    continue
                buf += os.read(fd, 4096)
                if _DA1_RE.search(buf):
                    break
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, saved)
        return parse_hello_reply(buf)
    except Exception:
        # Probing must never break startup; core Rich output remains.
        return False


def build_flow_messages(markdown: str, surface_id: str) -> list[str] | None:
    """Open/frame/close messages for one read-only flow surface, or None if too big."""
    view = {
        "id": "main",
        "k": "col",
        "c": [{"id": "m1", "k": "md", "p": {"text": markdown}}],
    }
    frame_msg = encode(
        "f",
        {"sf": surface_id, "s": 1, "ops": [["add", "main", surface_id, None, view]]},
    )
    if len(frame_msg.encode("utf-8")) > _MAX_FRAME_BYTES:
        return None
    return [
        encode(
            "o",
            {"id": surface_id, "mode": "flow", "listen": False, "title": "code-puppy"},
        ),
        frame_msg,
        encode("x", {"id": surface_id, "keep": True}),
    ]


def _on_startup() -> None:
    _state["enabled"] = _probe()


def _on_render_final_response(
    content: str, *, banner_name: str, banner_text: str
) -> dict[str, bool] | None:
    if banner_name != _BANNER_CLAIMED or not _state["enabled"]:
        return None
    if not content.strip():
        return None
    messages = build_flow_messages(content, f"cp{next(_ids)}")
    if messages is None:
        return None
    try:
        sys.stdout.write("".join(messages))
        sys.stdout.flush()
    except Exception:
        return None
    return {"handled": True}


register_callback("startup", _on_startup)
register_callback("render_final_response", _on_render_final_response)
