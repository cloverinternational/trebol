#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const unitName = "paseo.service";
const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
const unitPath = join(unitDir, unitName);
const node = process.execPath;
const cli = join(root, "vendor", "paseo", "packages", "cli", "dist", "index.js");
const paseoHome = process.env.PASEO_HOME || join(homedir(), ".paseo");
const listen = process.env.PASEO_LISTEN || "127.0.0.1:6767";

function quote(value) {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function renderUnit(values = { node, cli, root, paseoHome, listen }) {
  return `[Unit]
Description=Paseo daemon (Pi-Swarm)
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=5min
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=${quote(values.root)}
Environment=PASEO_HOME=${quote(values.paseoHome)}
Environment=PASEO_LISTEN=${quote(values.listen)}
Environment=CI=1
ExecStartPre=/usr/bin/tailscale status --json
ExecStart=${quote(values.node)} --disable-warning=DEP0040 ${quote(values.cli)} daemon start --foreground
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
    try { unlinkSync(unitPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    console.log(`Removed ${unitPath}`);
    console.log("Run: systemctl --user daemon-reload");
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

if (import.meta.url === `file://${process.argv[1]}`) await main();
