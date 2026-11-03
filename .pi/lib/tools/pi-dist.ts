// Files inside the installed Pi package that its root export does not expose (the built-in extension list,
// the `pi mcp` CLI). Found the way Node finds the package: the nearest node_modules copy above this file,
// which is the copy `import "@earendil-works/pi-coding-agent"` loads here.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function piDistUrl(relative: string): string {
	const target = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", relative);
	for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
		if (existsSync(join(dir, target))) return pathToFileURL(join(dir, target)).href;
		if (dirname(dir) === dir) throw new Error(`Pi's ${relative} was not found next to @earendil-works/pi-coding-agent`);
	}
}
