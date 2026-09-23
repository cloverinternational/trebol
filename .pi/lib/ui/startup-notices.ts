export type StartupNotice = { message: string; level: string };
const KEY = Symbol.for("pi-swarm-startup-notices");

function state(): { notices: StartupNotice[]; render?: () => void } {
  const root = globalThis as typeof globalThis & { [KEY]?: { notices: StartupNotice[]; render?: () => void } };
  return root[KEY] ?? (root[KEY] = { notices: [] });
}

export function setStartupNoticeRender(render?: () => void): void { state().render = render; }
export function pushStartupNotice(message: string, level = "info"): void {
  const s = state();
  s.notices.push({ message, level });
  if (s.notices.length > 8) s.notices.shift();
  s.render?.();
}
export function startupNotices(): readonly StartupNotice[] { return state().notices; }
