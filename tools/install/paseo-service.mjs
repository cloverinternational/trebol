#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const unitName = "paseo.service";
const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
const unitPath = join(unitDir, unitName);
const node = process.execPath;
const cli = join(root, "vendor", "paseo", "packages", "cli", "dist", "index.js");
const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
const listen = process.env.PASEO_LISTEN || "127.0.0.1:6767";

// A newline in an interpolated value would end the directive and let the rest of
// the string inject arbitrary systemd settings, so refuse control characters
// outright rather than trying to escape them.
function quote(value) {
  const text = String(value);
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error(`unit values must not contain control characters: ${JSON.stringify(text)}`);
  if (/^[A-Za-z0-9_./:@=-]+$/.test(text)) return text;
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

// Tailscale is not always in /usr/bin (nix, Homebrew, /usr/local/bin). Resolve it
// at render time so ExecStartPre cannot fail every start on a valid install.
export function resolveTailscale(env = process.env) {
  const dirs = (env.PATH || "/usr/bin").split(delimiter).filter(Boolean);
  for (const dir of [...dirs, "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]) {
    const candidate = join(dir, "tailscale");
    try { readFileSync(candidate, { flag: "r" }); return candidate; } catch { /* keep looking */ }
  }
  return "/usr/bin/tailscale";
}

export function renderUnit(values = {}) {
  const { node: nodeBin = node, cli: cliPath = cli, root: rootDir = root, paseoHome: home = paseoHome, listen: addr = listen, tailscale = resolveTailscale() } = values;
  return `[Unit]
Description=Paseo daemon (Pi-Swarm)
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=5min
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=${quote(rootDir)}
Environment=PASEO_HOME=${quote(home)}
Environment=PASEO_LISTEN=${quote(addr)}
Environment=CI=1
ExecStartPre=${quote(tailscale)} status --json
ExecStart=${quote(nodeBin)} --disable-warning=DEP0040 ${quote(cliPath)} daemon start --foreground
Restart=on-failure
RestartSec=10s
KillMode=control-group
TimeoutStopSec=30s
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=default.target
`;
}

async function main() {
  const command = process.argv[2] || "install";
  if (command === "render") {
    process.stdout.write(renderUnit());
    return;
  }
  if (command === "uninstall") {
    // Removing only the unit file leaves the enablement symlink behind, so the
    // daemon can keep running and restart at next login. Stop and disable first.
    spawnSync("systemctl", ["--user", "disable", "--now", unitName], { stdio: "inherit" });
    try { unlinkSync(unitPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    console.log(`Removed ${unitPath}`);
    return;
  }
  if (command !== "install") throw new Error("usage: paseo-service.mjs [install|uninstall|render]");
  if (!readFileSync(cli, { encoding: "utf8", flag: "r" }).length) throw new Error(`Paseo CLI is empty: ${cli}`);
  mkdirSync(unitDir, { recursive: true, mode: 0o700 });
  writeFileSync(unitPath, renderUnit(), { mode: 0o600 });
  console.log(`Installed ${unitPath}`);
  console.log("Next steps:");
  console.log("  systemctl --user daemon-reload");
  console.log("  systemctl --user enable --now paseo.service");
  console.log("  systemctl --user status paseo.service");
}

// argv[1] is a plain path while import.meta.url is a percent-encoded URL, so a
// string compare silently skips main() for paths containing spaces or '#'.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
