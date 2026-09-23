import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cloverRows } from "../../lib/ui/clover-layout.ts";
import { gitPanel } from "../../lib/ui/git-panel-layout.ts";
import { setStartupNoticeRender, startupNotices } from "../../lib/ui/startup-notices.ts";

const exec = promisify(execFile);
const MAX_OUTPUT_BYTES = 12000;
const MAX_LINES = 32;

type StartupData = { cwd: string; branch: string; added: number; removed: number; commits: string[] };

function padVisible(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n… diff truncated` : value;
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await exec("git", args, {
      cwd,
      timeout: 800,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return clip(result.stdout.trim(), MAX_OUTPUT_BYTES);
  } catch {
    return undefined;
  }
}

async function collect(cwd: string): Promise<StartupData> {
  const [branch, numstat, commits] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["diff", "--no-color", "--numstat"]),
    git(cwd, ["log", "-3", "--pretty=format:%h  %s"]),
  ]);
  let added = 0;
  let removed = 0;
  for (const line of numstat?.split("\n") ?? []) {
    const [a, d] = line.split("\t");
    if (/^\d+$/.test(a ?? "")) added += Number(a);
    if (/^\d+$/.test(d ?? "")) removed += Number(d);
  }
  return {
    cwd,
    branch: branch || "(detached HEAD or not a git repository)",
    added,
    removed,
    commits: commits?.split("\n").filter(Boolean) ?? ["no commits"],
  };
}

export function lines(data: StartupData, theme: any, width: number, height = MAX_LINES): string[] {
  const green = (text: string) => theme?.fg?.("success", text) ?? `\x1b[32m${text}\x1b[0m`;
  const left = cloverRows(width, height).map(green);
  const gap = "    ";
  const leftWidth = Math.max(...left.map((line) => visibleWidth(line)));
  const split = width >= leftWidth + gap.length + 26;
  const right = gitPanel(data, Math.max(24, width - leftWidth - gap.length));
  const rows = split ? Math.max(left.length, right.length) : left.length + right.length;
  const output = Array.from({ length: rows }, (_, i) => {
    const stacked = !split && i >= left.length;
    const l = stacked ? "" : left[i] ?? "";
    const r = right[i] ?? "";
    const row = split ? padVisible(l, leftWidth) + gap + r : stacked ? r : l;
    // TuiMainScreen treats each returned string as one terminal row and
    // rejects rows wider than the current viewport. This is especially easy
    // to hit with long branch names and commit subjects.
    return truncateToWidth(row, Math.max(0, width), "…");
  }).slice(0, Math.min(MAX_LINES, Math.max(1, height)));
  return output.slice(0, Math.max(1, height));
}

export default function cloverStartupExtension(pi: any) {
  let shown = false;
  let generation = 0;
  let activeCtx: any;
  pi.on?.("session_start", async (event: any, ctx: any) => {
    const own = ++generation;
    activeCtx = ctx;
    shown = false;
    if (shown || ctx?.mode === "print" || ctx?.mode === "json" || ctx?.hasUI === false) return;
    if (event?.reason && event.reason !== "startup") return;
    shown = true;
    const data = await collect(typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd());
    if (own !== generation || activeCtx !== ctx) return;
    setStartupNoticeRender(() => ctx.ui?.requestRender?.());
    ctx.ui?.requestRender?.();
    ctx.ui?.setHeader?.((_tui: any, theme: any) => ({
      render: (width: number) => {
        const height = Number((_tui as any)?.height) || MAX_LINES;
        const base = lines(data, theme, width, height);
        const notices = startupNotices().slice(-3).map((notice) => {
          const color = notice.level === "error" || notice.level === "warning" ? "error" : "dim";
          return truncateToWidth(theme?.fg?.(color, `! ${notice.message}`) ?? `! ${notice.message}`, Math.max(0, width), "…");
        });
        return [...notices, ...base].slice(0, Math.max(1, height));
      },
      invalidate() {},
    }));
  });
  pi.on?.("session_shutdown", () => {
    generation++;
    activeCtx = undefined;
    shown = false;
    setStartupNoticeRender(undefined);
  });
}
