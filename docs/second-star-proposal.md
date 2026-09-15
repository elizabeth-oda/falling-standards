# Proposal: two independent voice-star opportunities

Status: approved and implemented in the uncommitted investigation worktree. Original investigation based on commit `9796d10`.

## Intended behavior

Every normal voice-enabled run that reaches the second star's location offers a second yellow star, regardless of whether the first star was missed, its request failed or timed out, its generated object remains uncollected, or its effect is active. Rival progress does not control the offer. The player still has to collect the star; two offers do not guarantee two successful creations.

The first star stays at its current position. Choose the second star's position once per run, randomly between 60% and 70% of course depth. Use a separate, injectable random stream so this choice does not alter items, rivals, or generated-event behavior. Reveal it with the existing speed-aware approach distance, aligned to the player's current horizontal position. Its position remains fixed after reveal. A clear HUD cue announces its arrival.

## Why the previous implementation failed

[RaceEventHost](../apps/web/src/game/race-event-host.ts) previously waited for the first generated encounter to disappear, added four recovery seconds, then required 84 seconds of estimated race time remaining. At ordinary speed, that closes the offer after 30% progress. A successful first request adds reveal, travel, and effect time that a failed request skips.

A deterministic reproduction using the real 120 Hz movement, one second before speaking, an eight-second recording, and the mock pipeline's 1.6-second response delay gives these results:

| First request | Second-star outcome before the fix |
| --- | --- |
| Failure | Offered at 22.1 seconds |
| Success and normal collection | Permanently suppressed at 41.7 seconds |

The previous success tests skipped actual first-star travel and recording time, resolved generation immediately, and teleported a racer to the generated object. They did not establish that two opportunities appear during representative play.

## Separate the star grant from the first encounter

Track two run-scoped opportunities independently from generated world objects. Each has a stable identity and can be scheduled, offered, collected, consumed, or missed. Reaching the second star's reveal point does not inspect the first request's success or the shared event's phase.

Collecting the second star saves its grant without resetting the first attempt, deleting its object, or stopping its effect. If capture or generation is still busy, show that the second request is saved. Open its ten-second speaking window when the existing voice work is settled and its grant can be used. A first object that is already collectible or active must not block recording or generation for the second attempt.

Keep at most one recording/provider request in flight. Use a saved grant rather than adding concurrent recording or a queue of audio clips. Retain at most one completed result waiting for the shared world slot; if the first result is still in its reveal buffer, finish that placement before starting another request. A completed second result may wait while the first object or effect remains in the world. All results use distinct run/attempt identities so late callbacks cannot target another attempt or run.

## Replace the late-race admission rule for the second attempt

Removing the star-offer gate alone is insufficient: the existing 70-second recording check would make a star at 60-70% unusable. The proposed change deliberately replaces the second attempt's blanket 84/70/62-second remaining-race checks.

Always offer the authored second star. Permit its recording while the run is active and the capture slot is available. Immediately before dispatch, check that there is still room for an immediately completed creation's reveal, minimum reachable approach, maximum authored effect duration, and finish margin. If even that cannot fit, consume the opportunity with a visible explanation and make no provider call. Do not permanently remove an upcoming star because of a transient speed estimate.

Keep the eight-second capture limit, separate ten-second upload/transcription deadline, thirty-second generation deadline, and final placement checks. Keep all paid-mode gates, per-attempt admission metadata and IDs, allowance limits, the shared live-request slot, schema validation, and no automatic retries. This is an initial dispatch for a collected grant, not a retry of the first attempt.

**Tradeoff:** at 60-70% progress, ordinary-speed remaining time is only 36-48 seconds. This proposal guarantees a second star and its grant, not that every request can produce a playable result before landing. A delayed first request can postpone use of the grant; a slow second request can still run out of time. Finish cancels pending work, and an already dispatched paid attempt remains consumed. Guaranteeing two completed, playable creations would require a separately approved course-length or race-pacing change.

## Lifecycle and feedback

Pause, reset, finish, and navigation abort pending requests and discard queued grants/results under the existing cancellation rules. A pause does not erase a scheduled, uncollected future star; the race clock and its approach stay paused. No additional stars, replacement grants, refunds, or encores are introduced. Voice-disabled runs and manual fixture/replay runs retain their existing behavior.

Show the second-star arrival, a collected grant waiting for voice work, and any failure to use it before landing. Do not leave the HUD showing only the first effect's success when the second opportunity expires.

## Implementation scope and verification

- Put authored placement and timing in [race-event-config.ts](../apps/web/src/game/race-event-config.ts); keep scheduling and opportunity ownership in [race-event-host.ts](../apps/web/src/game/race-event-host.ts).
- Adapt attempt selection, voice controls, and HUD reporting to preserve each attempt independently. Keep movement, provider APIs, v1/v2 compatibility, and v3/v4 world-event rules intact.
- Add deterministic full-run coverage with actual first-star travel, recording duration, response latency, and swept object collection. Require a second offer for first success, failure, timeout, missed star, uncollected object, and active effect. Cover normal speed and boosts.
- Verify that collecting the second star preserves the first request/object, IDs cannot cross attempts, requests stay serialized, and only one generated event is collectible or active. Cover queued grants, waiting results, pause/reset/navigation, late replies, and finish.
- Run `bun run build`, `bun run typecheck`, and `bun run test`. Verify the mock voice path in desktop Chrome or Edge, including success followed by the second star and pause/reset during pending work. No paid test is required.

Do not consider the fix complete solely because existing state-transition tests pass. The key acceptance check is the second star appearing during an ordinary successful first encounter, with representative elapsed time.

## Verification of the implementation

- `bun run build`, `bun run typecheck`, and `bun run test` passed; 403 tests passed with none skipped. The build retains its existing large-bundle warning.
- The in-app browser, using temporary in-memory synthetic audio and the free mock backend, completed the first Angry Hippos creation and confirmed that Greg activated it. The second-star arrival cue appeared later in the same run, followed by Inspection Request 2 / 2.
- Cancellation, saved grants, reset, finish, stale replies, and occupied world slots are covered by the automated tests. Desktop Chrome/Edge and real microphone verification remain outstanding: the Chrome automation launch timed out. No paid calls were made.
- Changes remain uncommitted on `codex/investigate-second-star`, based on `9796d10`.
