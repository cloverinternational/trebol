/** Model-facing contracts for the tools registered by this module. */
import type { ToolContract } from "../runtime/tool-contract.ts";

export const APPLY_PATCH_CONTRACT: ToolContract = {
  description: "Edit files with a V4A patch. Use it for creating, updating, deleting, or moving files.\n\n*** Begin Patch\n*** Update File: relative/or/absolute/path\n[*** Move to: new/path]\n@@ optional anchor (class/function line) to disambiguate\n context line (space prefix)\n-removed line\n+added line\n context line\n*** Add File: new/file (every body line starts with '+')\n*** Delete File: old/file\n*** End Patch\n\nRules: 3 lines of context around each change; use @@ anchors when context repeats; no line numbers. Multiple files may be combined — the patch applies atomically (all operations succeed or none are written).",
  parameters: {"properties":{"cwd":{"description":"Optional directory that relative paths in the patch resolve against. Use this to edit a linked git worktree of the same repository when the conversation workspace is pinned to a different checkout. Absolute paths are still permitted when they fall inside that worktree.","type":"string"},"input":{"description":"The full patch, from '*** Begin Patch' to '*** End Patch'.","type":"string"}},"required":["input"],"type":"object"},
};

export const UNDO_CONTRACT: ToolContract = {
  description: "Reverts a file to its previous state.\n\nUsage:\n- path: The absolute path of the file to revert\n\nThis tool reverts a file to its previous state using a snapshot.\nSnapshots are automatically created before edits.",
  parameters: {"properties":{"path":{"description":"The absolute path of the file to revert","type":"string"}},"required":["path"],"type":"object"},
};

export const READ_CONTRACT: ToolContract = {
  description: "Views an image file so you can actually see it.\n\nThis tool handles IMAGES ONLY (.jpg, .jpeg, .png, .gif, .webp). It returns the\nvisual content directly, which the shell cannot do.\n\nFor every other kind of file, use the shell instead:\n  - whole file:   cat FILE\n  - a slice:      sed -n 'START,ENDp' FILE\n  - with numbers: nl -ba FILE | sed -n 'START,ENDp'\n  - first/last:   head -n N FILE  /  tail -n N FILE\n  - search:       rg PATTERN        (add -n for line numbers, -t go to filter)\n  - find files:   rg --files -g 'PATTERN'",
  parameters: {"properties":{"file_path":{"description":"Absolute path to the image file (.jpg, .jpeg, .png, .gif, .webp).","type":"string"}},"required":["file_path"],"type":"object"},
};

export const CONTRACTS: Record<string, ToolContract> = {
  apply_patch: APPLY_PATCH_CONTRACT,
  Undo: UNDO_CONTRACT,
  Read: READ_CONTRACT,
};
