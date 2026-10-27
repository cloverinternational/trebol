# Runs the Pi Tern runner on a real pty and prints (as JSON) the first bytes it writes, up to and including its
# TSP hello query, then kills it. Used by native-edit.test.ts to check the hello the runner actually sends.
import json, os, pty, re, select, signal, sys, time

env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "STY", "ZELLIJ", "TERN_TSP")}
env["PI_TERN_FRESH"] = "1"
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("node", ["node", "--experimental-strip-types", sys.argv[1]], env)
out = b""
deadline = time.time() + float(sys.argv[2] if len(sys.argv) > 2 else 30)
hello = re.compile(rb"\x1b_tsp;q;[^\x1b]*\"hello\"[^\x1b]*\x1b\\")
try:
    while time.time() < deadline and not hello.search(out):
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                out += os.read(fd, 65536)
            except OSError:
                break
finally:
    # The pty child leads its own session: kill the whole group, so a native-pi fallback cannot outlive it.
    for kill in (lambda: os.killpg(pid, signal.SIGKILL), lambda: os.kill(pid, signal.SIGKILL)):
        try:
            kill()
        except (ProcessLookupError, PermissionError):
            pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
print(json.dumps(out.decode("utf-8", "replace")))
