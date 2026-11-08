import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import ts from "typescript";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

it("local agents' transitive source graph does not load optional daemon dependencies or build outputs", () => {
  const seen = new Set<string>();
  function visit(path: string) {
    if (seen.has(path)) return;
    seen.add(path);
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    function walk(node: ts.Node) {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") ? node.arguments[0] : undefined;
      if (specifier && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        expect(name).not.toMatch(/absurd|experimental|runtime-contracts|(?:^|\/)dist(?:\/|$)|^pg(?:\/|$)/);
        if (name.startsWith(".")) {
          const target = resolve(dirname(path), name);
          const candidate = [target.replace(/\.js$/, ".ts"), target, `${target}.ts`].find(existsSync);
          expect(candidate, `unresolved source import ${name} from ${path}`).toBeDefined();
          visit(candidate!);
        }
      }
      ts.forEachChild(node, walk);
    }
    walk(source);
  }
  visit(resolve(root, "packages/tools/agents/src/index.ts"));
});

it.each([undefined, "postgres://unused:unused@localhost/unused"])("never passes a placeholder database integration check (URL=%s)", url => {
  const env = { ...process.env };
  delete env.PI_SWARM_POSTGRES_URL;
  delete env.ABSURD_DATABASE_URL;
  if (url) env.PI_SWARM_POSTGRES_URL = env.ABSURD_DATABASE_URL = url;
  const result = spawnSync(process.execPath, [resolve(root, "tools/integration/run-postgres-integration.mjs")], { env, encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("NOT IMPLEMENTED");
});
