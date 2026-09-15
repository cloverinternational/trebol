import { describe, expect, it } from "vitest";
import { renderUnit } from "../../../tools/install/paseo-service.mjs";

describe("Paseo systemd service", () => {
  it("starts after networking and restarts with bounded backoff", () => {
    const unit = renderUnit({ node: "/opt/node", cli: "/opt/paseo.js", root: "/opt/pi swarm", paseoHome: "/home/user/.paseo", listen: "127.0.0.1:6767" });
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("ExecStartPre=/usr/bin/tailscale status --json");
    expect(unit).toContain('WorkingDirectory="/opt/pi swarm"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=10s");
    expect(unit).toContain("StartLimitBurst=10");
    expect(unit).toContain("WantedBy=default.target");
  });
});
