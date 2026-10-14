/**
 * OSC 7501 program-status reporting for Trebol sessions.
 *
 * Emits terminal-native status reports (idle / working / blocked / done /
 * error / clear) over stderr so terminals, multiplexers, and agentic inboxes
 * can show what Trebol is doing without scraping the screen. Unknown OSC
 * sequences are ignored by terminals that do not implement the protocol, so
 * this is safe to leave on everywhere; `TREBOL_PROGRAM_STATUS=0` disables it.
 *
 * Lifecycle mapping:
 *   session_start / session_switch -> idle      (at rest, awaiting input)
 *   before_agent_start / turn_start -> working  (running on the user's task)
 *   ask_user_question tool_call     -> blocked  (kind=question, needs an answer)
 *   agent_before_settle completed   -> done     (piece of work finished)
 *   agent_before_settle otherwise   -> error    (aborted / failed)
 *   session_shutdown                -> clear    (drop our record)
 */

import { ProgramStatusReporter } from "../../.pi/lib/runtime/program-status.ts";

const seen = new WeakSet<object>();
const ASK_TOOL = "ask_user_question";

function firstLine(text: unknown, maxLength = 160): string {
  const line = String(text ?? "").split(/\r?\n/)[0].trim();
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

function askQuestionText(event: any): string {
  const questions = event?.input?.questions;
  const text = Array.isArray(questions) ? firstLine(questions[0]?.text) : "";
  return text || "Waiting for your answer";
}

export default function swarmProgramStatus(pi: any): void {
  if (seen.has(pi)) return;
  seen.add(pi);

  let reporter: ProgramStatusReporter | null = null;
  let lastWorkingMsg = "Working";

  const status = (): ProgramStatusReporter =>
    (reporter ??= new ProgramStatusReporter({ app: "trebol", title: "Trebol" }));

  // Status reporting is best-effort and cosmetic: a failure here must never
  // disturb the agent loop or the TUI event handlers.
  const emit = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* unreachable in practice — ProgramStatusReporter.report never throws */
    }
  };

  const markWorking = (msg: string) => {
    lastWorkingMsg = msg;
    emit(() => status().working(msg));
  };

  pi.on("session_start", () => {
    reporter = null;
    lastWorkingMsg = "Working";
    emit(() => status().idle("Ready"));
  });

  pi.on("session_switch", () => {
    emit(() => status().idle("Ready"));
  });

  pi.on("before_agent_start", (event: any) => {
    const prompt = firstLine(event?.prompt);
    markWorking(prompt ? `Working: ${prompt}` : "Working");
  });

  pi.on("turn_start", () => {
    emit(() => status().working(lastWorkingMsg));
  });

  pi.on("tool_call", (event: any) => {
    if (event?.toolName === ASK_TOOL) {
      emit(() => status().blocked("question", askQuestionText(event)));
    }
  });

  pi.on("tool_result", (event: any) => {
    if (event?.toolName === ASK_TOOL && !event?.isError) {
      // Answer received; the agent resumes work.
      emit(() => status().working(lastWorkingMsg));
    }
  });

  pi.on("agent_before_settle", (event: any) => {
    if (event?.continue) {
      // Auto mode / goal loop continues: keep the working record fresh.
      emit(() => status().working(lastWorkingMsg));
      return;
    }
    if (event?.outcome === "completed") {
      emit(() => status().done("Finished"));
    } else {
      const outcome = firstLine(event?.outcome) || "unknown";
      emit(() => status().error(`Stopped: ${outcome}`));
    }
  });

  pi.on("session_shutdown", () => {
    try {
      status().clear();
    } finally {
      reporter = null;
    }
  });
}
