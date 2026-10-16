# Code Puppy Python plugin: native Tern rendering of final responses

Status: implemented and tested. Final agent responses are drawn as a read-only
Tern Surface Protocol (TSP) `flow` surface when the terminal is Tern. Everything
else stays on Code Puppy's normal Rich output.

## Install

Nothing is installed automatically. Link the plugin into a user plugin tier:

    ln -s <trebol>/tern-plugins/code-puppy/python-plugin ~/.code_puppy/plugins/tern

Code Puppy's loader (`code_puppy/plugins/__init__.py`, `_load_user_plugins`)
imports `register_callbacks.py` from that directory at startup.

## How it works

- Core seam: `on_render_final_response` in `code_puppy/callbacks.py`, called
  from `code_puppy/tools/display.py` (`display_non_streamed_result`) and from
  `RichConsoleRenderer._render_agent_response` (the `AgentResponseMessage`
  bus route used by the interactive and headless CLI paths). A callback claims
  a render by returning `{"handled": True}`. Other results, or an exception,
  leave Rich output in place. The first claim wins, so output is never drawn
  twice.
- Startup: `on_startup` runs a one-time TSP `hello` probe. It runs only when
  `TERM_PROGRAM=tern`, stdin and stdout are TTYs, and `TMUX`, `STY` and `ZELLIJ`
  are unset. `TERN_TSP=0` disables it. The probe puts the tty in raw mode for at
  most about 1 s and restores it in `finally`. A `hello` reply counts only if it
  arrives before the DA1 reply.
- Render: the plugin writes three APC messages, `o` (open flow surface,
  `listen:false`), `f` (one `md` frame) and `x` (close, keep). Tern sends no
  events, so stdin, prompt_toolkit and approvals are not touched.
- Claims only the `agent_response` banner with non-empty content.

## Limits (not implemented)

- Streamed text, tool output, diffs, thinking and sub-agent output stay Rich.
  Streamed text is printed before the final response is known, so the final
  render is not a parity replacement for the streamed view.
- A response whose frame exceeds 60 000 bytes falls back to Rich. Responses are
  not chunked.
- Multiplexers (tmux, screen, zellij) are excluded because they swallow APC.
- The probe is not verified against a real multi-byte input split.

## Verification

- Core: `tests/test_render_final_response_hook.py` (15 tests) covers the hook
  contract, fallback, exception isolation, subagent suppression, and both the
  `display` and `AgentResponseMessage` routes.
- Plugin: `tests/test_register_callbacks.py` (18 tests) installs the plugin into
  a temp user dir and loads it with `_load_user_plugins`. It covers
  registration, the hello-order rule, probe gating, claim and fallback,
  and no duplicate output through the core display path.
- Live smoke: `tern -e` pane, real loader, `TERM_PROGRAM=tern`, both stdio TTYs.
  The probe returned enabled, startup took about 0.11 s, and a claimed response
  wrote 0 Rich bytes. No provider was called.

Run the plugin tests from the Code Puppy checkout:

    PYTHONPATH=<trebol>/tern-plugins/code-puppy/python-plugin \
      <code_puppy>/.venv/bin/python -m pytest <this dir>/tests -q --no-cov
