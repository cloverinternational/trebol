#!/usr/bin/env python3
"""Installed OMP output-latency probe; synthetic input, isolated HOME, no prompt submission.
This measures PTY output, not a host window repaint. It terminates only its own child.
"""
import fcntl, json, os, pty, re, select, struct, subprocess, tempfile, termios, time

root = tempfile.mkdtemp(prefix="trebol362-omp-")
config = os.path.join(root, "bench.yml")
with open(config, "w") as f:
    f.write("startup:\n  setupWizard: false\n  showSplash: false\npaste:\n  largeMenuThreshold: 0\n")
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
env = {k: v for k, v in os.environ.items() if k in ["PATH", "LANG"]}
env.update(HOME=root, TERM="xterm-256color", XDG_CONFIG_HOME=root, OMP_PROFILE="paste-bench")
child = subprocess.Popen(["/home/robert/.local/bin/omp", "--config", config,
    "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools",
    "--no-lsp", "--no-title"], cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
ansi = re.compile(rb"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07)")
def read_for(seconds):
    out = b""; until = time.monotonic() + seconds
    while time.monotonic() < until and child.poll() is None:
        if select.select([master], [], [], .01)[0]:
            data = os.read(master, 65536); out += data
            if b"\x1b[c" in data: os.write(master, b"\x1b[?1;2c")
    return out
try:
    startup = read_for(8)
    assert b"\x1b[?2004h" in startup, "OMP did not enable bracketed paste"
    print(json.dumps({"startupBytes": len(startup), "bracketedEnabled": b"\x1b[?2004h" in startup,
        "tail": ansi.sub(b"", startup).decode("utf8", "replace")[-1200:]}))
    fixtures = {"small": "hello world", "large": "x" * 10000,
                "multiline": "first\nsecond\nthird", "unicode": "á漢🙂" * 100}
    for name, text in fixtures.items():
        # Clear draft only, never press Enter. A fresh draft each fixture.
        os.write(master, b"\x03"); read_for(.3)
        wire = ("\x1b[200~" + text + "\x1b[201~").encode()
        start = time.monotonic()
        for at in range(0, len(wire), 256): os.write(master, wire[at:at+256])
        out = b""; first = None
        while time.monotonic() - start < 1:
            if select.select([master], [], [], .005)[0]:
                data = os.read(master, 65536); out += data
                if first is None: first = (time.monotonic() - start) * 1000
        plain = ansi.sub(b"", out).decode("utf8", "replace")
        expected = {"small": ["hello world"], "large": ["#1", "10000"],
                    "multiline": ["first", "second", "third"], "unicode": ["á漢🙂"]}[name]
        assert all(token in plain for token in expected), (name, "draft output not observed")
        assert "�" not in plain, (name, "invalid UTF-8 in output")
        print(json.dumps({"fixture": name, "firstOutputMs": first, "outputBytes": len(out),
            "synchronizedFrames": out.count(b"\x1b[?2026h"), "draftOutputObserved": True,
            "outputTail": plain[-900:]}, ensure_ascii=False))
finally:
    child.terminate(); child.wait(timeout=10); os.close(master)
