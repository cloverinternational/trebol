# Rule-conflict review: trebol Forge vs Modes (GENERIC.MD @ 79df187)
Done before any scored run. Line numbers: Forge = prompts/swarm-system-prompt.md (product b4dc9bc), Modes = GENERIC.MD.

| # | Forge | Modes | Conflict | In FM? |
|---|---|---|---|---|
| 1 | L18 "Be concise and avoid repetition"; L174 concise headings | L29 "Output the FULL, UPDATED PLAN in each response"; L52/63/151/549 "excessive context" | verbosity | no: FM keeps Forge brevity |
| 2 | L104-105 ask one question via ask_user_question when judgment is needed | L70 "YOU DO NOT ASK THE USER FOR ANY INPUTS" (AUTO) | interaction | no: FM is silent on asking |
| 3 | L26-41 TaskManage "VERY frequently" | L289-400 own TODO template, immutable TODOs (L540), stored via update_project_context | task system | M maps to TaskManage; FM omits TODOs |
| 4 | completion only with evidence (L174) | L72 "DO NOT STOP - KEEP GOING", L78 "KEEP FINDING THINGS TO DO" | stopping | no: FM omits never-stop |
| 5 | none | L140-151 think/explain/expect/explain-again before every tool call | per-call ceremony | FM keeps one line: expectation before, check after |
| 6 | L3 e2e tests only | L306/367 test coverage in TODOs | testing | M lacks the testing contract (it is a Forge section) |
| 7 | memory guidance only in the appended `<memory_workflow>` | L172-202 query the database at the start of EVERY task; prefer it over file reads | recall priority | FM keeps "search memory at start" (2-3 keywords) + record durable facts |

Prediction (written before runs): M will be slower/noisier (rules 1,4,5) and will use memory more (rule 7). FM's only plausible gains are recall use (7) and DEBUG discipline on fix tasks.
