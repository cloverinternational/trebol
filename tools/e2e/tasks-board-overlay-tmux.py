#!/usr/bin/env python3
"""Real Pi terminal journey: /tasks overlay toggles list -> board, shows Hoja columns, and closes on Escape. No model turns."""
import json, os, pathlib, re, shlex, subprocess, tempfile, time
repo = pathlib.Path(__file__).resolve().parents[2]
name = f'trebol-tasks-board-{os.getpid()}'
def tmux(*args):
    return subprocess.check_output(['tmux', *args], text=True)
def pane():
    return tmux('capture-pane', '-pt', name, '-S', '-200')
def wait_for(text):
    deadline = time.monotonic() + 40
    last = ''
    while time.monotonic() < deadline:
        last = pane()
        if text in last:
            return last
        time.sleep(.2)
    raise AssertionError(f'Timed out waiting for {text!r}:\n{last}')
def overlay():
    lines = pane().splitlines()
    head = next((i for i, line in enumerate(lines) if '┌' in line and '┐' in line), -1)
    assert head >= 0, 'task overlay missing'
    foot = next((i for i in range(head + 1, len(lines)) if '└' in lines[i] and '┘' in lines[i]), -1)
    assert foot > head, 'task overlay bottom border missing'
    return lines[head:foot + 1]
def task_ids(lines):
    return re.findall(r'#([1-4])(?:\s|$)', '\n'.join(lines))
def assert_width(width):
    tmux('resize-window', '-t', name, '-x', str(width), '-y', '42')
    time.sleep(.4)
    lines = overlay()
    assert all(len(line) <= width for line in lines), f'overlay exceeds {width} columns:\n' + '\n'.join(lines)
    return '\n'.join(lines)
import shutil
class _Temp:
    def __enter__(self):
        self.path = tempfile.mkdtemp(prefix='trebol-tasks-board-')
        return self.path
    def __exit__(self, *exc):
        shutil.rmtree(self.path, ignore_errors=True)
with _Temp() as temp:
    temp_path = pathlib.Path(temp)
    session = temp_path / 'session.jsonl'
    seed = temp_path / 'seed.mjs'
    seed.write_text(f'''
import {{ SessionManager }} from "{repo}/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const m = SessionManager.create("{temp}", "{temp}");
m.appendCustomEntry("pi-swarm-task-state", {{ schemaVersion: 2, revision: 1, savedAt: "2026-01-01T00:00:00Z", nextId: 4, keys: {{}}, tasks: [
  {{ id: "1", subject: "Plan board model", status: "pending", priority: "medium", dependsOn: [], notes: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", questions: [] }},
  {{ id: "2", subject: "Render kanban", status: "in_progress", active: true, priority: "medium", dependsOn: [], notes: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", questions: [] }},
  {{ id: "3", subject: "Ship board", status: "completed", priority: "medium", dependsOn: [], notes: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", questions: [] }}] }});
m.appendMessage({{ role: "user", content: [{{ type: "text", text: "seed" }}], timestamp: Date.now() }});
m.appendMessage({{ role: "assistant", content: [{{ type: "text", text: "ok" }}], api: "openai-completions", provider: "local", model: "script", usage: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }} }}, stopReason: "stop", timestamp: Date.now() }});
console.log(m.getSessionFile());
''')
    sess_path = subprocess.check_output(['node', '--experimental-strip-types', str(seed)], text=True, cwd=repo).strip().splitlines()[-1]
    agent = temp_path / 'agent'
    agent.mkdir()
    (agent / 'settings.json').write_text(json.dumps({'packages': [str(repo)]}))
    command = f'PI_CODING_AGENT_DIR={shlex.quote(str(agent))} pi --session {shlex.quote(sess_path)}'
    tmux('new-session', '-d', '-s', name, '-x', '140', '-y', '42', '-c', temp, command)
    try:
        wait_for('IDLE')
        tmux('send-keys', '-t', name, '-l', '/tasks')
        tmux('send-keys', '-t', name, 'Enter')
        list_pane = wait_for('TASKS')
        assert '#2' in list_pane and '[in_progress]' in list_pane, list_pane
        # Cycle open -> blocked -> completed -> all; both views must show the same live tasks.
        for _ in range(3):
            tmux('send-keys', '-t', name, '-l', 'f')
        wait_for('ALL  ·  read only')
        list_ids = task_ids(overlay())
        assert sorted(list_ids) == ['1', '2', '3'], list_ids
        tmux('send-keys', '-t', name, 'Up')
        time.sleep(.2)
        assert '▶ #2' in '\n'.join(overlay()), 'list Up did not move selection'
        tmux('send-keys', '-t', name, 'Down')
        time.sleep(.2)
        assert '▶ #3' in '\n'.join(overlay()), 'list Down did not move selection'
        tmux('send-keys', '-t', name, '-l', 'v')
        board_pane = wait_for('BOARD')
        for column in ['Todo', 'In Progress', 'Done']:
            assert column in board_pane, f'missing column {column}:\n{board_pane}'
        assert '#2 Render kanban' in board_pane, board_pane
        board_ids = task_ids(overlay())
        assert sorted(board_ids) == sorted(list_ids), (list_ids, board_ids)
        assert 'Todo' in assert_width(140) and 'Done' in pane()
        narrow = assert_width(65)
        assert 'BOARD' in narrow and 'Done' in narrow and '▸ #3' in narrow, narrow
        tmux('send-keys', '-t', name, 'Left')
        time.sleep(.3)
        assert 'In Progress' in assert_width(65) and '▸ #2' in pane(), 'left arrow did not select In Progress'
        tmux('send-keys', '-t', name, 'Left')
        time.sleep(.3)
        assert 'Todo' in assert_width(65) and '▸ #1' in pane(), 'left arrow did not select Todo'
        tmux('send-keys', '-t', name, '-l', 'v')
        wait_for('ALL  ·  read only')
        assert sorted(task_ids(overlay())) == sorted(list_ids), 'tasks changed after board/list toggle'
        tmux('send-keys', '-t', name, 'Escape')
        time.sleep(1)
        assert 'TASKS' not in pane(), 'overlay did not close on Escape'
        print('PASS /tasks overlay: list/board task parity, 65/140-column bounds, selection, Escape')
    finally:
        subprocess.run(['tmux', 'kill-session', '-t', name], capture_output=True)
