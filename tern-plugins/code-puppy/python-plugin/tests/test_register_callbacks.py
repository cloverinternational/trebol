"""Tern plugin tests: loader integration, claim/fallback, probe gating.

Run from the code_puppy checkout:
  PYTHONPATH=<trebol>/tern-plugins/code-puppy/python-plugin \
    <code_puppy>/.venv/bin/python -m pytest <this dir> -q --no-cov
"""

import io
import json
import pathlib
import shutil
import sys

import pytest
from rich.console import Console

from code_puppy import callbacks
from code_puppy.plugins import _load_user_plugins
from code_puppy.tools import display

PLUGIN_SRC = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture
def clean_phases(monkeypatch):
    for phase in ("startup", "render_final_response"):
        monkeypatch.setitem(callbacks._callbacks, phase, [])
    monkeypatch.setattr(display, "is_subagent", lambda: False)
    monkeypatch.setattr(display, "get_subagent_verbose", lambda: False)
    monkeypatch.setattr(sys, "path", list(sys.path))
    yield


@pytest.fixture
def loaded(tmp_path, monkeypatch, clean_phases):
    """Install the plugin as a user plugin and load it via Code Puppy's loader."""
    user_dir = tmp_path / "plugins"
    shutil.copytree(
        PLUGIN_SRC,
        user_dir / "tern",
        ignore=shutil.ignore_patterns("tests", "__pycache__", "README.md"),
    )
    monkeypatch.delitem(sys.modules, "tern.register_callbacks", raising=False)
    names = _load_user_plugins(user_dir)
    assert names == ["tern"]
    mod = sys.modules["tern.register_callbacks"]
    monkeypatch.setitem(mod._state, "enabled", False)
    return mod


def _hello_reply(**over):
    reply = {"r": "hello", "v": 1, "kinds": ["col", "md"], "features": ["flow"]}
    reply.update(over)
    return f"\x1b_tsp;r;{json.dumps(reply)}\x1b\\\x1b[?62;52;c".encode()


def test_loader_registers_startup_and_render_hook(loaded):
    assert loaded._on_startup in callbacks.get_callbacks("startup")
    assert loaded._on_render_final_response in callbacks.get_callbacks(
        "render_final_response"
    )


def test_parse_hello_reply_requires_order(loaded):
    assert loaded.parse_hello_reply(_hello_reply()) is True
    da1_first = b"\x1b[?62;52;c" + _hello_reply()
    assert loaded.parse_hello_reply(da1_first) is False
    assert loaded.parse_hello_reply(b"\x1b[?62;52;c") is False


def test_parse_hello_reply_requires_flow_and_md(loaded):
    assert loaded.parse_hello_reply(_hello_reply(features=[])) is False
    assert loaded.parse_hello_reply(_hello_reply(kinds=["col"])) is False


@pytest.mark.parametrize(
    ("env", "value"),
    [("TERM_PROGRAM", None), ("TERN_TSP", "0"), ("TMUX", "1"), ("STY", "1")],
)
def test_probe_gated_off(loaded, monkeypatch, env, value):
    monkeypatch.setenv("TERM_PROGRAM", "tern")
    if env == "TERM_PROGRAM":
        monkeypatch.delenv("TERM_PROGRAM")
    else:
        monkeypatch.setenv(env, value)
    assert loaded._probe() is False


def test_probe_is_noop_without_tty(loaded, monkeypatch):
    monkeypatch.setenv("TERM_PROGRAM", "tern")
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.setattr(loaded.sys, "stdin", io.StringIO())
    assert loaded._probe() is False


def test_flow_messages_shape(loaded):
    msgs = loaded.build_flow_messages("# Hi", "cp1")
    assert msgs is not None and len(msgs) == 3
    assert msgs[0].startswith("\x1b_tsp;o;") and '"listen":false' in msgs[0]
    assert msgs[1].startswith("\x1b_tsp;f;")
    assert msgs[2] == '\x1b_tsp;x;{"id":"cp1","keep":true}\x1b\\'


def test_oversize_frame_returns_none(loaded):
    assert loaded.build_flow_messages("x" * 61000, "cp1") is None


def test_claims_agent_response_when_enabled(loaded, monkeypatch, capsys):
    monkeypatch.setitem(loaded._state, "enabled", True)
    result = loaded._on_render_final_response(
        "Hello", banner_name="agent_response", banner_text="AGENT RESPONSE"
    )
    assert result == {"handled": True}
    out = capsys.readouterr().out
    assert "\x1b_tsp;o;" in out and "\x1b_tsp;x;" in out


@pytest.mark.parametrize("banner", ["thinking", "subagent"])
def test_other_banners_not_claimed(loaded, monkeypatch, banner):
    monkeypatch.setitem(loaded._state, "enabled", True)
    assert (
        loaded._on_render_final_response("x", banner_name=banner, banner_text="")
        is None
    )


def test_disabled_falls_back(loaded):
    assert (
        loaded._on_render_final_response(
            "x", banner_name="agent_response", banner_text=""
        )
        is None
    )


def test_empty_content_falls_back(loaded, monkeypatch):
    monkeypatch.setitem(loaded._state, "enabled", True)
    assert (
        loaded._on_render_final_response(
            "   ", banner_name="agent_response", banner_text=""
        )
        is None
    )


def test_write_error_falls_back(loaded, monkeypatch):
    monkeypatch.setitem(loaded._state, "enabled", True)

    class Broken:
        def write(self, _):
            raise OSError("pty gone")

        def flush(self):
            pass

    monkeypatch.setattr(loaded.sys, "stdout", Broken())
    assert (
        loaded._on_render_final_response(
            "x", banner_name="agent_response", banner_text=""
        )
        is None
    )


def test_core_display_claimed_by_plugin_no_duplicate(loaded, monkeypatch, capsys):
    monkeypatch.setitem(loaded._state, "enabled", True)
    console = Console(file=io.StringIO(), width=80)
    display.display_non_streamed_result("# Done", console=console)
    assert console.file.getvalue() == ""
    out = capsys.readouterr().out
    assert out.count("\x1b_tsp;o;") == 1


def test_core_display_falls_back_when_plugin_disabled(loaded):
    console = Console(file=io.StringIO(), width=80)
    display.display_non_streamed_result("Plain", console=console)
    assert "Plain" in console.file.getvalue()
