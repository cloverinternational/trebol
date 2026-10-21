/** Add mode badges without replacing the shared metrics footer. */
const KEY = Symbol.for("pi-swarm-footer-segments");
export function modeFooter(name: string, enabled: () => boolean) {
  const segments = (): Map<string, () => string | undefined> =>
    ((globalThis as any)[KEY] ??= new Map());
  const key = `${name}-mode`;
  const provider = () => enabled() ? `${name}:on` : undefined;
  return {
    refresh(ctx: any) { segments().set(key, provider); ctx?.ui?.requestRender?.(); },
    clear(ctx: any) {
      // A late shutdown from an old extension must not remove its replacement.
      if (segments().get(key) === provider) segments().delete(key);
      ctx?.ui?.requestRender?.();
    },
  };
}
