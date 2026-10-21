/** Model-facing contracts for the tools registered by this module. */
import type { ToolContract } from "../runtime/tool-contract.ts";

export const APPLY_PATCH_CONTRACT: ToolContract = {
  description: "Edit files with a V4A patch. Use it for creating, updating, deleting, or moving files.\n\n*** Begin Patch\n*** Update File: relative/or/absolute/path\n[*** Move to: new/path]\n@@ optional anchor line: the chunk is searched for after the first line matching it\n context line (space prefix)\n-removed line\n+added line\n context line\n*** Add File: new/file (every body line starts with '+')\n*** Delete File: old/file\n*** End Patch\n\nRules: 3 lines of context around each change; no line numbers. When context repeats, the first match after the previous chunk is used, so add an @@ anchor line to select the intended location. Multiple files may be combined. The whole patch is validated before any write (parse errors, missing update/delete sources, unmatched context, duplicate source paths): a validation failure changes nothing. Operations then run in order; if one fails, earlier operations remain written and the error lists them without rolling them back. Undo reverts one file to its last snapshot.",
  parameters: {"properties":{"cwd":{"description":"Optional directory that relative paths in the patch resolve against. Use this to edit a linked git worktree of the same repository when the conversation workspace is pinned to a different checkout. Absolute paths are still permitted when they fall inside that worktree.","type":"string"},"input":{"description":"The full patch, from '*** Begin Patch' to '*** End Patch'.","type":"string"}},"required":["input"],"type":"object"},
};

export const UNDO_CONTRACT: ToolContract = {
  description: "Reverts a file to its previous state.\n\nUsage:\n- path: The absolute path of the file to revert\n\nThis tool reverts a file to its previous state using a snapshot.\nSnapshots are automatically created before edits.",
  parameters: {"properties":{"path":{"description":"The absolute path of the file to revert","type":"string"}},"required":["path"],"type":"object"},
};

export const READ_CONTRACT: ToolContract = {
  description: "Views an image, SVG or PDF file so you can actually see it.\n\nSupported: .jpg, .jpeg, .png, .gif, .webp (returned as pictures); .svg (returned as\nits source text); .pdf (page 1 returned as a picture). Every result ends with a\n`Cite as:` line: cite that path, plus `#page=1` for a PDF.\n\nFor every other kind of file, use the shell instead:\n  - whole file:   cat FILE\n  - a slice:      sed -n 'START,ENDp' FILE\n  - with numbers: nl -ba FILE | sed -n 'START,ENDp'\n  - first/last:   head -n N FILE  /  tail -n N FILE\n  - search:       rg PATTERN        (add -n for line numbers, -t go to filter)\n  - find files:   rg --files -g 'PATTERN'",
  parameters: {"properties":{"file_path":{"description":"Absolute path to the image file (.jpg, .jpeg, .png, .gif, .webp).","type":"string"}},"required":["file_path"],"type":"object"},
};

export const CONTRACTS: Record<string, ToolContract> = {
  apply_patch: APPLY_PATCH_CONTRACT,
  Undo: UNDO_CONTRACT,
  Read: READ_CONTRACT,
};
