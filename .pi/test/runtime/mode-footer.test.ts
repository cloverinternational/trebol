import { afterEach, expect, it, vi } from "vitest";
import { modeFooter } from "../../lib/runtime/mode-footer.ts";
const key = Symbol.for("pi-swarm-footer-segments");
afterEach(() => { delete (globalThis as any)[key]; });
it("shows active modes, hides inactive ones and requests repaint", () => {
  let on = true;
  const ctx = { ui: { requestRender: vi.fn() } };
  const footer = modeFooter("claw", () => on);
  footer.refresh(ctx);
  expect((globalThis as any)[key].get("claw-mode")()).toBe("claw:on");
  on = false;
  footer.refresh(ctx);
  expect((globalThis as any)[key].get("claw-mode")()).toBeUndefined();
  expect(ctx.ui.requestRender).toHaveBeenCalledTimes(2);
  footer.clear(ctx);
  expect((globalThis as any)[key].size).toBe(0);
});
it("keeps both badges and does not let stale reload cleanup remove replacements", () => {
  const old = modeFooter("claw", () => true);
  old.refresh(undefined);
  const next = modeFooter("claw", () => true);
  next.refresh(undefined);
  modeFooter("hoja", () => true).refresh(undefined);
  old.clear(undefined);
  expect([...(globalThis as any)[key].values()].map((f: () => string) => f())).toEqual(["claw:on", "hoja:on"]);
});
