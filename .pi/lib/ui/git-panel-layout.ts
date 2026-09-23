export type GitPanelData = { cwd: string; branch: string; added: number; removed: number; commits: string[] };
const ANSI = /\x1b\[[0-9;]*m/g;

export function fitCell(value: string, width: number): string {
  const plain = value.replace(ANSI, "");
  const safe = plain.length > width ? `${plain.slice(0, Math.max(0, width - 1))}…` : plain;
  return safe.padEnd(width);
}

export function gitPanel(data: GitPanelData, width: number): string[] {
  const panelWidth = Math.max(4, Math.min(52, width));
  const inner = panelWidth - 2;
  if (inner < 10) return [`┌${"─".repeat(inner)}┐`, `│${fitCell("git", inner)}│`, `└${"─".repeat(inner)}┘`].map((row) => row.slice(0, panelWidth).padEnd(panelWidth));
  const body = [`pwd     ${data.cwd}`, `branch  ${data.branch}`, `diff    +${data.added}  -${data.removed}`, "", "last commits", ...data.commits.slice(0, 3)];
  const fullWidth = panelWidth;
  const rows = [`┌${"─".repeat(fullWidth - 2)}┐`, ...body.map((row) => `│ ${fitCell(row, fullWidth - 4)} │`), `└${"─".repeat(fullWidth - 2)}┘`];
  return rows.map((row) => row.slice(0, fullWidth).padEnd(fullWidth));
}
