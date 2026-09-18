# One Supervisor panel

`/supervisor` opens native Pi select/input controls and a compact status widget.
One settings owner combines global defaults and project overrides with explicit
field provenance. The panel changes real session adapters; no UI-only toggles.
Only the Supervisor command is registered; old Jev/worker commands are removed.

Controls: master pause/on, source scope, credential references, reviewer model,
audit/supervisor/worker toggles, audit interval and stop audit, worker turn/time
limits, connection test, audit now, status/origins, clear project override.
Global skill mutation is explicitly unavailable, not implied by enabled review.

Credentials are resolved by Pi's named provider auth mechanism when configured,
not by reusing the current chat provider key. Reviewer model alone may inherit
session model. Explicit source failures do not silently fall back. Auto fallback
is provider -> configured environment name -> configured vault ID. Settings store
references only; fixed TypeSafe endpoint prevents arbitrary URL key forwarding.

Pause clears queued review and aborts active work. Worker limits remain host-capped;
existing writes before cancellation are not undone. Runtime settings apply only
to current session; other sessions load changed global/project settings on restart.
The widget uses setWidget, not setFooter. Headless status uses the notification
surface; a dedicated machine-readable supervisor tool is not added here.

Verification:154 context/state/UI tests pass,6 opt-in tests skipped. Installed-Pi
scripted supervisor-loop smoke still proves real fork-review-parent task dispatch.
UI selection tested through native API mocks; full interactive keyboard/viewport
render smoke remains unverified. Headless fork compaction proof is separate.
