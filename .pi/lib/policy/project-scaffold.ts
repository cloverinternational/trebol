import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultPolicy, serializePolicy, writeFileAtomic, type ProjectTier, type StructurePolicy } from "./project-structure.ts";

export interface ProjectAnswers {
  name: string;
  summary: string;
  tier: ProjectTier;
  language: string;
  /** Non-secret variable names only; values are never captured. */
  envVars: string[];
  iac: "none" | "docker" | "terraform";
  ci: boolean;
  knowledge: boolean;
}

export interface Artifact { path: string; content: string; }
export type WriteMode = "create" | "overwrite";
export interface PlannedArtifact extends Artifact { exists: boolean; identical: boolean; }

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateName(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "Project name is required.";
  if (name.length > 64) return "Project name must be 64 characters or fewer.";
  if (!NAME_PATTERN.test(name)) return "Project name must be kebab-case (lowercase letters, digits, single hyphens).";
  return undefined;
}

export function validateSummary(value: string): string | undefined {
  const summary = value.trim();
  if (!summary) return "One-line summary is required; it becomes the README and manifest description.";
  if (summary.length > 200) return "Summary must be 200 characters or fewer.";
  if (summary.includes("\n")) return "Summary must be a single line.";
  return undefined;
}

const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function parseEnvVars(value: string): { names: string[]; invalid: string[] } {
  const entries = value.split(/[,\s]+/).map(entry => entry.trim()).filter(Boolean);
  const names = [...new Set(entries.filter(entry => ENV_VAR_PATTERN.test(entry)))].sort();
  const invalid = [...new Set(entries.filter(entry => !ENV_VAR_PATTERN.test(entry)))];
  return { names, invalid };
}

const heading = (name: string, summary: string) => `# ${name}\n\n${summary}\n`;

function readme(a: ProjectAnswers): string {
  const layout = ["docs/ — documentation index and references", "src/ — implementation", "tests/ — automated tests"];
  if (a.tier !== "demo") layout.push("scripts/ — repeatable maintenance entry points");
  if (a.iac !== "none") layout.push("infra/ — infrastructure definitions");
  if (a.knowledge) layout.push("knowledge/ — durable domain knowledge");
  return [
    heading(a.name, a.summary),
    `## Status\n\nTier: **${a.tier}**. Primary language: **${a.language}**.\n`,
    `## Layout\n\n${layout.map(line => `- ${line}`).join("\n")}\n`,
    "## Getting started\n\nDocument the exact commands to install, run, and test here. Replace this paragraph before the first release.\n",
    ...(a.envVars.length ? [`## Configuration\n\nCopy \`.env.example\` to \`.env\` and set every variable it lists. No secret values belong in this repository.\n`] : []),
    `## Structure policy\n\nThis project's directory layout is enforced by \`.project/structure.json\`. Creating a path outside that policy is blocked; widen the policy in a reviewable commit instead of working around it.\n`,
  ].join("\n");
}

function agents(a: ProjectAnswers): string {
  return [
    `# ${a.name} — agent guide\n\n${a.summary}\n`,
    `## Scope\n\nTier **${a.tier}**, ${a.language}. ${a.tier === "demo" ? "This is a demo: favour the shortest correct path and do not add speculative infrastructure." : a.tier === "product" ? "This is a maintained product: changes need tests and a changelog entry." : "This is a platform: changes need tests, a changelog entry, documented interfaces, and an explicit rollback path."}\n`,
    "## Rules\n\n- Every new path must satisfy `.project/structure.json`; the structure guard blocks violations before the write happens.\n- Documentation lives under `docs/`, starting at `docs/index.md`. Do not create top-level Markdown files that are not in the root allowlist.\n- Record decisions as ADRs under `docs/decisions/`, numbered and immutable once merged.\n- Keep the root directory minimal. If a file has no home, the correct fix is a directory, not a root file.\n",
    `## Verification\n\nState the exact commands used to verify a change and their outcomes. Never report a pass that was not observed.\n`,
  ].join("\n");
}

function docsIndex(a: ProjectAnswers): string {
  const rows = [
    "| Document | Purpose |",
    "| --- | --- |",
    "| [decisions/](decisions/) | Architecture decision records, numbered and append-only |",
    "| [reference/](reference/) | Contracts, inventories, and operational references |",
  ];
  if (a.envVars.length) rows.push("| [reference/configuration.md](reference/configuration.md) | Every environment variable and its contract |");
  return [heading(`${a.name} documentation`, "Start here. Every document in this project is reachable from this index."), `## Index\n\n${rows.join("\n")}\n`].join("\n");
}

const adrTemplate = [
  "# ADR 0001: Record architecture decisions\n",
  "## Status\n\nAccepted\n",
  "## Context\n\nDecisions made in conversation are lost. This project needs a durable, reviewable record of why the architecture is the way it is.\n",
  "## Decision\n\nEvery architecturally significant decision is recorded here as a numbered ADR. An ADR is immutable once merged; a later ADR supersedes it and says so explicitly.\n",
  "## Consequences\n\nReviewers can reconstruct intent without the original author. Each ADR adds a small, bounded writing cost.\n",
].join("\n");

function configurationDoc(a: ProjectAnswers): string {
  const rows = a.envVars.map(name => `| \`${name}\` | yes | Describe what this controls and its accepted values. |`);
  return [
    heading("Configuration", `Every variable ${a.name} reads from the environment. Values are never committed.`),
    `## Variables\n\n| Variable | Required | Meaning |\n| --- | --- | --- |\n${rows.join("\n")}\n`,
    "## Rules\n\n- `.env.example` lists every variable with an empty or non-secret placeholder value and is committed.\n- `.env` holds real values and is never committed.\n- Adding a variable means updating this table and `.env.example` in the same change.\n",
  ].join("\n");
}

const envExample = (a: ProjectAnswers) => `${["# Copy to .env and fill in. Never commit real values.", ...a.envVars.map(name => `${name}=`)].join("\n")}\n`;

function gitignore(a: ProjectAnswers): string {
  const entries = ["# Local environment", ".env", ".env.local", "", "# Dependencies and build output", "node_modules/", "dist/", "build/", "target/", "", "# Tooling noise", ".DS_Store", "*.log", "*.tmp", "*.bak", "*.orig", "*.rej"];
  if (a.iac === "terraform") entries.push("", "# Terraform", ".terraform/", "*.tfstate", "*.tfstate.*", "*.tfvars");
  return `${entries.join("\n")}\n`;
}

const editorconfig = "root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\nindent_style = space\nindent_size = 2\ninsert_final_newline = true\ntrim_trailing_whitespace = true\n\n[*.md]\ntrim_trailing_whitespace = false\n";

const changelog = (a: ProjectAnswers) => `# Changelog\n\nAll notable changes to ${a.name} are recorded here. This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n## [Unreleased]\n\n### Added\n\n- Project initialised with an enforced structure policy.\n`;

const contributing = (a: ProjectAnswers) => [
  heading("Contributing", `How to make a change to ${a.name} that will be accepted.`),
  "## Before you write code\n\n1. Read `AGENTS.md` and `.project/structure.json`.\n2. Confirm the change has a home in the existing layout. If it does not, propose a structure policy change first.\n",
  "## Every change\n\n- Add or update tests alongside the code.\n- Add a `CHANGELOG.md` entry under Unreleased.\n- Update `docs/index.md` if you added a document.\n- Record an ADR under `docs/decisions/` for architecturally significant choices.\n",
].join("\n");

const security = (a: ProjectAnswers) => [
  heading("Security policy", `How to report a vulnerability in ${a.name}.`),
  "## Reporting\n\nReport privately to the maintainers. Do not open a public issue for an unpatched vulnerability. State the affected version, the impact, and a reproduction.\n",
  "## Handling\n\nSecrets never enter the repository. Credentials are supplied through the environment and documented by name only in `docs/reference/configuration.md`.\n",
].join("\n");

const dockerfile = (a: ProjectAnswers) => `# ${a.name} — replace the base image and build steps for ${a.language}.\nFROM scratch\n\n# Build inputs belong in src/; runtime configuration comes from the environment\n# documented in docs/reference/configuration.md.\n`;

const terraformMain = (a: ProjectAnswers) => `# ${a.name} infrastructure.\n# State backend and providers are deliberately unset: declare them explicitly\n# before the first apply, and never commit *.tfvars or state files.\n\nterraform {\n  required_version = ">= 1.6.0"\n}\n`;

const ciWorkflow = (a: ProjectAnswers) => `name: ci\n\non:\n  push:\n    branches: [main]\n  pull_request:\n\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@v4\n      # Replace with the real build and test commands for ${a.language}.\n      - name: Verify\n        run: echo "define the verification command for ${a.name}"\n`;

const knowledgeIndex = (a: ProjectAnswers) => [
  heading("Knowledge base", `Durable domain knowledge for ${a.name}: facts that outlive any single change.`),
  "## What belongs here\n\n- Domain terminology and invariants\n- External system behaviour discovered the hard way\n- Constraints that are not visible from the code\n\n## What does not\n\n- Task status or progress logs\n- Anything reconstructible by reading the code\n- Secrets of any kind\n",
].join("\n");

/** Machine-readable project identity; stable key order so repeat runs are byte-identical. */
const manifest = (a: ProjectAnswers) => `${JSON.stringify({
  version: 1,
  name: a.name,
  summary: a.summary,
  tier: a.tier,
  language: a.language,
  env: [...a.envVars].sort(),
  iac: a.iac,
  ci: a.ci,
  knowledge: a.knowledge,
}, null, 2)}\n`;

export function policyFor(a: ProjectAnswers): StructurePolicy {
  const extraRootFiles: string[] = [];
  const extraRootDirs: string[] = [];
  if (a.iac === "docker") extraRootFiles.push("Dockerfile");
  if (a.iac !== "none") extraRootDirs.push("infra");
  if (a.ci) extraRootDirs.push(".github");
  if (a.knowledge) extraRootDirs.push("knowledge");
  if (a.envVars.length) extraRootFiles.push(".env.example");
  return defaultPolicy(a.tier, { extraRootFiles, extraRootDirs });
}

/** Deterministic: the same answers always produce the same artifact list, in the same order. */
export function planArtifacts(input: ProjectAnswers): Artifact[] {
  const a: ProjectAnswers = { ...input, envVars: [...new Set(input.envVars)].sort() };
  const artifacts: Artifact[] = [
    { path: ".project/structure.json", content: serializePolicy(policyFor(a)) },
    { path: ".project/project.json", content: manifest(a) },
    { path: "README.md", content: readme(a) },
    { path: ".gitignore", content: gitignore(a) },
    { path: ".editorconfig", content: editorconfig },
    { path: "docs/index.md", content: docsIndex(a) },
    { path: "docs/decisions/0001-record-architecture-decisions.md", content: adrTemplate },
  ];
  if (a.tier !== "demo") {
    artifacts.push({ path: "AGENTS.md", content: agents(a) });
    artifacts.push({ path: "CHANGELOG.md", content: changelog(a) });
  }
  if (a.tier === "platform") {
    artifacts.push({ path: "CONTRIBUTING.md", content: contributing(a) });
    artifacts.push({ path: "SECURITY.md", content: security(a) });
  }
  if (a.envVars.length) {
    artifacts.push({ path: ".env.example", content: envExample(a) });
    artifacts.push({ path: "docs/reference/configuration.md", content: configurationDoc(a) });
  }
  if (a.iac === "docker") artifacts.push({ path: "Dockerfile", content: dockerfile(a) });
  if (a.iac === "terraform") artifacts.push({ path: "infra/main.tf", content: terraformMain(a) });
  if (a.ci) artifacts.push({ path: ".github/workflows/ci.yml", content: ciWorkflow(a) });
  if (a.knowledge) artifacts.push({ path: "knowledge/index.md", content: knowledgeIndex(a) });
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export function planWithState(root: string, a: ProjectAnswers): PlannedArtifact[] {
  return planArtifacts(a).map(artifact => {
    const absolute = join(root, artifact.path);
    const exists = existsSync(absolute);
    let identical = false;
    if (exists) { try { identical = readFileSync(absolute, "utf8") === artifact.content; } catch { identical = false; } }
    return { ...artifact, exists, identical };
  });
}

export interface ApplyResult { written: string[]; skipped: string[]; unchanged: string[]; }

/**
 * Write the planned artifacts. `create` never touches an existing file, so a
 * repeat run is idempotent and cannot clobber hand-written content. Each file
 * is written atomically; a mid-run failure leaves already-written files intact
 * and reports which ones they were.
 */
export function applyArtifacts(root: string, a: ProjectAnswers, mode: WriteMode = "create"): ApplyResult {
  const result: ApplyResult = { written: [], skipped: [], unchanged: [] };
  for (const artifact of planWithState(root, a)) {
    if (artifact.identical) { result.unchanged.push(artifact.path); continue; }
    if (artifact.exists && mode === "create") { result.skipped.push(artifact.path); continue; }
    writeFileAtomic(join(root, artifact.path), artifact.content);
    result.written.push(artifact.path);
  }
  return result;
}
