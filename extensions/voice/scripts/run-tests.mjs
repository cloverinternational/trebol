import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Resolve the compiler through Node's module resolution instead of assuming this
// directory owns node_modules: inside the Trebol monorepo TypeScript is hoisted to
// the repository root, and the suite still has to run from here.
const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}

const outputDirectory = await mkdtemp(join(process.cwd(), ".pi-voice-test-"));
try {
  await run(process.execPath, [
    tsc,
    "--noEmit",
    "false",
    "--outDir",
    outputDirectory,
  ]);
  // TypeScript doesn't copy the Markdown loaded by the ratings help view.
  await copyFile(
    join(process.cwd(), "src/model-ratings-help.md"),
    join(outputDirectory, "src/model-ratings-help.md"),
  );
  const testDirectory = join(outputDirectory, "test");
  const testFiles = (await readdir(testDirectory))
    .filter((name) => name.endsWith(".test.js"))
    .sort()
    .map((name) => join(testDirectory, name));
  await run(process.execPath, ["--test", ...testFiles]);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
