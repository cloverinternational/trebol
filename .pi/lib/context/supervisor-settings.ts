import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

export type CredentialMode = "auto" | "provider" | "environment" | "vault";
export interface SupervisorSettings {
  enabled: boolean; audit: boolean; operational: boolean; memoryWorker: boolean;
  cadence: number; stopAudit: boolean; workerTurns: number; workerTimeoutMs: number;
  reviewerModel: string; credentialMode: CredentialMode; provider: string;
  envVar: string; credentialId: string;
}
export interface SupervisorSettingsResult {
  settings: SupervisorSettings;
  origins: Partial<Record<keyof SupervisorSettings, "default" | "global" | "project">>;
  paths: { global: string; project: string };
  diagnostics: string[];
}
export interface SupervisorSettingsOptions { home?: string }

const DEFAULTS: SupervisorSettings = {
  enabled: false, audit: true, operational: true, memoryWorker: true,
  cadence: 5, stopAudit: true, workerTurns: 6, workerTimeoutMs: 90000,
  reviewerModel: "session", provider: "typesafe", envVar: "TYPESAFE_API_KEY",
  credentialId: "typesafe-api-key", credentialMode: "auto",
};
const FIELDS = new Set(Object.keys(DEFAULTS));
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MODES = new Set<CredentialMode>(["auto", "provider", "environment", "vault"]);
type Data = Partial<SupervisorSettings>;

function gitRoot(cwd: string): string | undefined {
  try {
    const raw = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (!raw) return undefined;
    const common = path.resolve(cwd, raw);
    return common;
  } catch { return undefined; }
}
function pathsFor(cwd: string, home?: string) {
  const root = gitRoot(cwd);
  return { global: path.resolve(home ?? os.homedir(), ".swarm/config/supervisor.json"), project: root ? path.join(root, "pi-swarm/supervisor.json") : path.join(cwd, ".swarm/supervisor.json") };
}
function safeAncestors(target: string): boolean {
  const absolute = path.resolve(target);
  let cursor = absolute;
  try {
    while (true) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) return false;
      const parent = path.dirname(cursor); if (parent === cursor) return true; cursor = parent;
    }
  } catch { return false; }
}
function validate(data: unknown): Data {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("configuration is not an object");
  const o = data as Record<string, unknown>;
  if (o.version !== 1) throw new Error("unsupported configuration version");
  for (const key of Object.keys(o)) if (key !== "version" && !FIELDS.has(key)) throw new Error("unknown configuration field");
  const out: Data = {};
  for (const key of FIELDS) if (key in o) {
    const value = o[key];
    if (["enabled", "audit", "operational", "memoryWorker", "stopAudit"].includes(key)) {
      if (typeof value !== "boolean") throw new Error("invalid boolean setting");
      (out as any)[key] = value;
    } else if (["cadence", "workerTurns", "workerTimeoutMs"].includes(key)) {
      if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) throw new Error("invalid numeric setting");
      const range = key === "cadence" ? [1, 50] : key === "workerTurns" ? [1, 6] : [1000, 90000];
      if (value < range[0] || value > range[1]) throw new Error("numeric setting out of bounds");
      (out as any)[key] = value;
    } else if (typeof value !== "string" || value.length === 0 || value.length > 128) throw new Error("invalid string setting");
    else (out as any)[key] = value;
  }
  if (out.credentialMode !== undefined && !MODES.has(out.credentialMode)) throw new Error("invalid credential mode");
  if (out.provider !== undefined && !ID.test(out.provider)) throw new Error("invalid provider id");
  if (out.credentialId !== undefined && !ID.test(out.credentialId)) throw new Error("invalid credential id");
  if (out.envVar !== undefined && !ENV.test(out.envVar)) throw new Error("invalid environment variable");
  if (out.reviewerModel !== undefined && out.reviewerModel !== "session" && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(out.reviewerModel)) throw new Error("invalid reviewer model");
  return out;
}
function readConfig(file: string, diagnostics: string[]): Data {
  if (!fs.existsSync(file)) return {};
  if (!safeAncestors(file)) { diagnostics.push(`unsafe configuration path rejected: ${path.basename(file)}`); return {}; }
  try { if(fs.statSync(file).size>16384)throw new Error("oversized configuration"); return validate(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch (e) { diagnostics.push(`invalid configuration rejected: ${path.basename(file)}`); return {}; }
}
function resolve(cwd: string, options: SupervisorSettingsOptions = {}): SupervisorSettingsResult {
  const paths = pathsFor(cwd, options.home), diagnostics: string[] = [];
  const global = readConfig(paths.global, diagnostics), project = readConfig(paths.project, diagnostics);
  const settings = { ...DEFAULTS, ...global, ...project } as SupervisorSettings;
  // Legacy environment boot flag only when no persisted master setting exists.
  if (!("enabled" in global) && !("enabled" in project) && process.env.PI_SWARM_JEV_AUDIT === "on") settings.enabled=true;
  const origins: SupervisorSettingsResult["origins"] = {};
  for (const key of Object.keys(DEFAULTS) as (keyof SupervisorSettings)[]) origins[key] = key in project ? "project" : key in global ? "global" : "default";
  return { settings, origins, paths, diagnostics };
}
export function loadSupervisorSettings(cwd: string, options?: SupervisorSettingsOptions): SupervisorSettingsResult { return resolve(cwd, options); }

function atomicWrite(file: string, value: Data) {
  if (!safeAncestors(file)) throw new Error("unsafe configuration path rejected");
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.supervisor.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try { fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...value }, null, 2) + "\n", { mode: 0o600, flag: "wx" }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch { /* already renamed */ } }
}
export function saveSupervisorSettings(cwd: string, scope: "global" | "project", patch: Partial<SupervisorSettings>, options?: SupervisorSettingsOptions): SupervisorSettingsResult {
  if(!["global","project"].includes(scope))throw new Error("invalid scope");
  const paths = pathsFor(cwd, options?.home), file = paths[scope];
  const existing = readConfig(file, []);
  if (fs.existsSync(file) && Object.keys(existing).length === 0) { try { validate(JSON.parse(fs.readFileSync(file, "utf8"))); } catch { throw new Error("cannot overwrite invalid configuration"); } }
  const next = validate({ version: 1, ...existing, ...patch }); atomicWrite(file, next);
  return resolve(cwd, options);
}
export function clearSupervisorOverride(cwd: string, options?: SupervisorSettingsOptions): SupervisorSettingsResult {
  const file = pathsFor(cwd, options?.home).project;
  if (!safeAncestors(file)) throw new Error("unsafe configuration path rejected");
  try { fs.unlinkSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return resolve(cwd, options);
}
