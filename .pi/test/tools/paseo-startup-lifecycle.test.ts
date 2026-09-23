import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("../../lib/tools/paseo-setup.ts", () => ({
  paseoStart: state.start, defaultListen: vi.fn(), paseo: {}, paseoBuild: vi.fn(),
  paseoPair: vi.fn(), paseoSetup: vi.fn(), paseoStatus: vi.fn(), paseoStop: vi.fn(), paseoUpdate: vi.fn(),
}));
import extension from "../../extensions/30-tools/paseo.ts";
import { startupNotices } from "../../lib/ui/startup-notices.ts";

it("does not access expired UI after delayed startup resolves", async () => {
  let resolve!: (value: any) => void;
  state.start.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const handlers = new Map<string, any>();
  extension({ on: (name, handler) => { handlers.set(name, handler); } });
  const ui = vi.fn(() => { throw new Error("stale context"); });
  await handlers.get("session_start")({}, { get ui() { return ui(); } });
  handlers.get("session_shutdown")();
  resolve({ success: true, listen: "fixture:1234" });
  await new Promise(r => setImmediate(r));
  expect(ui).not.toHaveBeenCalled();
});
it("still reports startup failure while the session is active", async () => {
  state.start.mockResolvedValueOnce({ success: false, error: "fixture failure" });
  const handlers = new Map<string, any>(); const notify = vi.fn();
  extension({ on: (name, handler) => { handlers.set(name, handler); } });
  await handlers.get("session_start")({}, { ui: { notify } });
  await new Promise(r => setImmediate(r));
  // Startup failures go to the startup notice buffer rather than ctx.ui.notify,
  // which survives the UI not being ready yet during session_start.
  expect(startupNotices().at(-1)).toEqual({ message: "Paseo auto-start skipped: fixture failure", level: "warning" });
});
