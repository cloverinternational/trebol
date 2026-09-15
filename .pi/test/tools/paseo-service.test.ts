import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderUnit } from "../../../tools/install/paseo-service.mjs";

describe("Paseo systemd service", () => {
  it("starts after networking and restarts with bounded backoff", () => {
    const unit = renderUnit({ node: "/opt/node", cli: "/opt/paseo.js", root: "/opt/pi swarm", paseoHome: "/home/user/.paseo", listen: "127.0.0.1:6767" });
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain('WorkingDirectory="/opt/pi swarm"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=10s");
    expect(unit).toContain("StartLimitBurst=10");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("resolves tailscale instead of assuming /usr/bin", () => {
    const unit = renderUnit({ node: "/opt/node", cli: "/opt/paseo.js", root: "/opt/pi", paseoHome: "/home/user/.paseo", listen: "127.0.0.1:6767", tailscale: "/usr/local/bin/tailscale" });
    expect(unit).toContain("ExecStartPre=/usr/local/bin/tailscale status --json");
  });

  it("refuses control characters that would inject extra unit directives", () => {
    expect(() => renderUnit({ node: "/opt/node", cli: "/opt/paseo.js", root: "/opt/pi", listen: "127.0.0.1:6767", paseoHome: "/home/user/.paseo\nExecStartPre=/bin/rm -rf /" })).toThrow(/control characters/);
  });

  it("runs main when invoked through a path that needs URL encoding", () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo svc "));
    const script = join(dir, "paseo-service.mjs");
    copyFileSync(fileURLToPath(new URL("../../../tools/install/paseo-service.mjs", import.meta.url)), script);
    expect(execFileSync(process.execPath, [script, "render"], { encoding: "utf8" })).toContain("[Unit]");
  });
});
