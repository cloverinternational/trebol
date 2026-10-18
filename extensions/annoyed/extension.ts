import { AnnoyedStore, boundTranscript, type AnnoyedStatus, type AnnoyedSeverity } from "./store.ts";
import { registerAnnoyanceNudgeHook } from "./nudge.ts";
import { withSwarmToolSurface } from "../../.pi/lib/runtime/swarm-tool-surface.ts";
import { wrapToolForHookRows } from "../../.pi/lib/runtime/hook-render-bridge.ts";
import { randomBytes } from "node:crypto";
import { annoyedMarker, annoyedPublicTitle, annoyedRepository, annoyedResultXML, normalizeAnnoyedSeverity, publishAnnoyedIssue, reconcileAnnoyedIssue } from "../../.pi/lib/tools/swarm-annoyed-publish.ts";
import { annoyedProjectFingerprint, runAnnoyedJudge, verifiedProjectRepository, redactAnnoyedReport } from "../../.pi/lib/tools/swarm-annoyed-routing.ts";

const schema = {
  type: "object", required: ["issue"], additionalProperties: false,
  properties: {
    issue: { type: "string", description: "Concrete product friction or defect" },
    title: { type: "string" }, category: { type: "string", description: "hook_false_positive, tool_failure, inefficiency, misleading_error, missing_capability, or other" },
    severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
    observed: { type: "string" }, expected: { type: "string" }, evidence: { type: "array", items: { type: "string" }, maxItems: 32 },
    acceptance_tests: { type: "array", items: { type: "string" }, maxItems: 32 }, tags: { type: "array", items: { type: "string" }, maxItems: 24 },
  },
};
const text = (value: unknown) => typeof value === "string" ? value : "";
const notify = (ctx: any, message: string, level: "info" | "warning" | "error" = "info") => ctx?.ui?.notify?.(message, level);

export default function annoyedExtension(rawPi: any) {
  const pi = withSwarmToolSurface(rawPi);
  registerAnnoyanceNudgeHook(pi);
  const store = new AnnoyedStore();
  pi.registerTool(wrapToolForHookRows({
    name: "annoyed", label: "Annoyed", description: "Record a user-approved product friction report. Non-actionable or uncertain submissions are routed to explicit Trebol triage. Do not change failure nudges into reports of every failure.", parameters: schema,
    async execute(toolCallId: string, params: any, signal: AbortSignal, _onUpdate: unknown, ctx: any) {
      if (signal.aborted) throw new Error("annoyed: cancelled");
      // annoyed.go Run: validate, publish through gh, then the XML result.
      // Pi's local board is a host-side side effect the model never sees.
      const errorId = () => `err_${randomBytes(10).toString("hex")}`;
      const fail = (message: string): never => { throw new Error(`Error executing annoyed: ${message} (error_id=${errorId()})`); };
      const issue = text(params?.issue).trim();
      if (issue === "") return fail("annoyed: issue is required");
      const severity = normalizeAnnoyedSeverity(params?.severity);
      const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
      let projectRepository: string | undefined;
      let projectResolution = "verified";
      try { projectRepository = await verifiedProjectRepository(cwd, signal); if (!projectRepository) projectResolution = "missing or non-GitHub project remote"; }
      catch (e) { if (signal.aborted || (e as Error).message === "cancelled") throw new Error("annoyed: cancelled"); projectResolution = "project remote verification failed"; }
      let harnessRepository: string;
      try { harnessRepository = annoyedRepository(); } catch (e) { return fail((e as Error).message); }
      const entries = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.();
      const conversationId = ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId;
      const fields = { issue: redactAnnoyedReport(issue).slice(0, 1000), category: redactAnnoyedReport(text(params.category)).slice(0, 100), observed: redactAnnoyedReport(text(params.observed)).slice(0, 1500), expected: redactAnnoyedReport(text(params.expected)).slice(0, 1500), evidence: (Array.isArray(params.evidence) ? params.evidence : []).slice(0, 8).map((x: unknown) => redactAnnoyedReport(String(x)).slice(0, 400)), acceptanceTests: (Array.isArray(params.acceptance_tests) ? params.acceptance_tests : []).slice(0, 8).map((x: unknown) => redactAnnoyedReport(String(x)).slice(0, 400)) };
      const fingerprint = annoyedProjectFingerprint(projectRepository, { ...fields, workspaceCwd: cwd });
      const receiptOwner = randomBytes(16).toString("hex");
      let result = await store.reserve({ ...fields, issue: fields.issue, title: redactAnnoyedReport(text(params.title)).slice(0, 240), category: fields.category || "other", severity: params.severity, conversationId, projectCwd: cwd, transcript: Array.isArray(entries) ? boundTranscript(entries.slice(-80)) : undefined, fingerprint, metadata: { toolCallId }, source: "pi-annoyed-tool", receiptOwner });
      const metadata: any = result.issue.metadata ?? {};
      if (metadata.publicationUrl) return { content: [{ type: "text", text: annoyedResultXML(fields.issue, metadata.publicationUrl, metadata.destination, severity, { ...metadata.verdict, reason: metadata.reason, triage: metadata.triage }) }], details: { duplicate: true, publication_url: metadata.publicationUrl, repository: metadata.destination, scope: metadata.verdict?.scope, reason: metadata.verdict?.reason, publication_status: metadata.publicationStatus } };
      if ((metadata.publicationStatus === "posting" || metadata.publicationStatus === "unresolved") && metadata.destination && metadata.marker) {
        try {
          const url = await reconcileAnnoyedIssue(metadata.destination, metadata.marker, signal);
          await store.setMetadata(result.issue.id, { publicationStatus: "confirmed", publicationUrl: url });
          return { content: [{ type: "text", text: annoyedResultXML(fields.issue, url, metadata.destination, severity, { ...metadata.verdict, reason: metadata.reason, triage: metadata.triage }) }], details: { duplicate: true, publication_url: url, repository: metadata.destination, scope: metadata.verdict?.scope, reason: metadata.reason, triage: metadata.triage, publication_status: "confirmed" } };
        } catch (error) { return fail((error as Error).message); }
      }
      if (!result.reserved) return fail("annoyed: report reservation is owned by another invocation; refusing duplicate judge or publication");
      let verdict = metadata.verdict;
      if (!verdict) {
        const fallback = { scope: "uncertain", reason: "Judge interrupted; retained for Trebol triage without repeating consultation" };
        await store.setMetadata(result.issue.id, { verdict: fallback, publicationStatus: "judging" });
        let judged: Awaited<ReturnType<typeof runAnnoyedJudge>>;
        try { judged = await runAnnoyedJudge(pi, { report: fields, project: projectRepository ?? projectResolution, cwd, model: ctx?.model, signal }); }
        catch (e) { await store.setMetadata(result.issue.id, { publicationStatus: "ready" }).catch(() => undefined); throw e; }
        if (judged.cancelled || signal.aborted) {
          await store.setMetadata(result.issue.id, { publicationStatus: "ready" });
          throw new Error("annoyed: cancelled");
        }
        verdict = judged.verdict;
      }
      const triage = verdict.scope !== "harness" && !(verdict.scope === "project" && projectRepository);
      const repository = triage ? harnessRepository : verdict.scope === "harness" ? harnessRepository : projectRepository!;
      const marker = metadata.marker ?? annoyedMarker();
      const destination = repository.toLowerCase();
      const reason = projectRepository ? verdict.reason : `${projectResolution}; ${verdict.reason}`;
      await store.setMetadata(result.issue.id, { verdict, destination, marker, publicationStatus: "reserved", projectResolution, triage, reason, receiptOwner });
      if (signal.aborted) { await store.setMetadata(result.issue.id, { publicationStatus: "ready" }); throw new Error("annoyed: cancelled"); }
      await store.setMetadata(result.issue.id, { publicationStatus: "posting" });
      const clean = (s: string) => redactAnnoyedReport(s).slice(0, 1500);
      const body = [`## Agent report\n\n${clean(fields.issue)}`, `**Scope:** ${verdict.scope} — ${clean(reason)}`, `**Triage:** ${triage ? "Trebol ownership review requested" : "No"}`, `**Report marker:** \`${marker}\``, fields.observed ? `## Observed\n\n${clean(fields.observed)}` : "", fields.expected ? `## Expected\n\n${clean(fields.expected)}` : "", fields.evidence.length ? `## Evidence\n\n${fields.evidence.map((e: string) => `- ${clean(e)}`).join("\n")}` : "", fields.acceptanceTests.length ? `## Acceptance tests\n\n${fields.acceptanceTests.map((e: string) => `- ${clean(e)}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
      let publicationURL: string;
      try { publicationURL = await publishAnnoyedIssue(repository, annoyedPublicTitle(fields.issue, severity), body, undefined, signal); } catch (e) { if (signal.aborted) throw new Error("annoyed: cancelled"); await store.setMetadata(result.issue.id, { publicationStatus: "unresolved", publicationError: redactAnnoyedReport((e as Error).message).slice(0, 500) }); return fail((e as Error).message); }
      await store.setMetadata(result.issue.id, { publicationStatus: "confirmed", publicationUrl: publicationURL });
      return { content: [{ type: "text", text: annoyedResultXML(fields.issue, publicationURL, repository, severity, { scope: verdict.scope, reason, triage }) }], details: { duplicate: !result.reserved, publication_url: publicationURL, repository, scope: verdict.scope, reason, triage, publication_status: "confirmed" } };
    },
  }));
  pi.on?.("session_shutdown", () => store.close());
  return store;
}
