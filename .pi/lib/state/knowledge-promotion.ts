import { openKnowledgeStore } from "./knowledge-store.ts";

/** Trusted command path, never an agent-callable approval boolean. Approval
 * applies only to the reviewed revision; project state is retained unchanged.
 */
export async function promoteGlobalKnowledge(input: {
  cwd: string; scope: "repository" | "worktree"; id: string; namespace?: string;
  root?: string; confirm: (title: string, body: string) => Promise<boolean>;
  isCurrent: () => boolean;
}) {
  const local = openKnowledgeStore(input);
  const record = local.read(input.id);
  if (!record || record.status !== "verified") throw new Error("Only an existing verified record can be promoted");
  if (record.evidence.length >= 32) throw new Error("Promotion needs space for its source-revision citation");
  const body = `This makes the following knowledge readable across projects. Confirm that it is genuinely cross-project and appropriate to share.\n\n${record.text}\n\nEvidence:\n${record.evidence.map(item => item.ref).join("\n")}\n\nSource: ${record.scope}/${record.id}@${record.revision}\nThe project record will remain unchanged.`;
  if (!await input.confirm("Promote knowledge to global scope?", body)) return { status: "declined" as const };
  if (!input.isCurrent()) throw new Error("Session changed during approval; no global write performed");
  if (local.read(record.id)?.revision !== record.revision) throw new Error("Record changed during approval; review it again");
  const global = openKnowledgeStore({ cwd: input.cwd, root: input.root, namespace: input.namespace, scope: "global", allowGlobal: true });
  const saved = global.put({ text: record.text, tags: record.tags, kind: record.kind, status: "verified",
    source: "user-approved-global-promotion",
    evidence: [...record.evidence, { ref: `knowledge:${record.scope}:${record.id}@${record.revision}` }],
  });
  return { status: "promoted" as const, record: saved };
}
