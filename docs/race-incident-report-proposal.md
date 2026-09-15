# AI incident reports for created items

Status: implemented in the `codex/race-incident-reports` worktree; mock verification only.

## Player experience

**Incident report** replaces the flat "What happened in the race" summary with a headline, one or two specific facts about racers, and a deadpan Department of Workplace Safety finding. Full activation status and per-racer measurements remain under **Inspection details**.

Examples are illustrative:

> **CREATOR INCLUDED IN PRODUCT TESTING**
>
> Linda activated your Angry Hippos. Steve took four equipment hits; you took two.
>
> **Departmental finding:** Staff who request hippos remain subject to hippos.

> **REPEAT CONTACT HAS BEEN NOTED**
>
> You bounced off your Bouncy Avocado five times. The other racers managed two between them.
>
> **Departmental finding:** This now qualifies as a working relationship.

> **ZERO INCIDENTS. ZERO PARTICIPANTS.**
>
> Every racer passed your Clingy Stapler without collecting it.
>
> **Departmental finding:** Excellent safety record. Insufficient sample size.

The implementation uses authored fallback copy immediately. AI selects evidence and writes fresh framing when enabled. Model-generated findings are labeled, and simulated reports are identified as free mocks. Opening or closing the viewer does not create a request.

## One call when each event ends

Each creation receives its own report after its shared event ends, including a pickup that expires unused. The first request can run while the race continues and before the player lands. A creation that was never placed retains an authored report without a reporting call.

The controller observes the host's retained terminal snapshots at the existing HUD update cadence. It freezes that event's outcome, the run UUID, and the current runtime-racer-ID to character-ID mapping. An active encounter remains provisional even if its creator has landed. If all racers finish before an active encounter's natural duration, use the final snapshot retained by `PracticeRace` and `RaceEventHost`.

There are at most two paid report attempts per run, one for each creation. Each has a separate attempt UUID, creation ID, and fingerprint of the validated input. A result for one event cannot replace the other event's report or enter a subsequent run.

The controller lives outside the viewer and the voice `CreationAttempt`. It owns no simulation clock and never changes movement. Closing the dialog leaves an already-authorized request running. Pause, reset, disposal, and navigation abort pending work and discard late replies. A failed or cancelled report is not retried when play resumes or the viewer reopens.

### Sharing the paid slot with voice

Reports defer their first submission while local voice work is prompted, preparing, recording, transcribing, generating, or waiting to place a result. Reports themselves are serialized.

If the second star is collected while a live report is already running, the saved voice grant waits before opening its speaking window. Reporting therefore does not consume the grant's ten-second prompt window. Once the report settles, the normal host step opens that window. The existing capture, transcription, and generation budgets stay unchanged.

Another tab or client can still claim the server's shared slot first. Busy or exhausted admission retains the authored report; it does not queue or automatically retry a paid request.

## Consent and cost accounting

Live run setup has a separate, default-off option:

**Include an AI incident report when each event ends — up to 2 additional paid calls.**

Voice creation permits two attempts and up to six paid calls without a separate payment checkbox. The incident-report feature retains its own default-off setting. With both features enabled, a run may make up to eight paid calls: six for voice creation and two for reports. Each report also uses the existing input/output content guards, so moderation requests are separate from the count of paid generation calls.

Reports consume the same allowance as voice attempts and use the same `LiveAttempts` object. No additional busy slot or spending pool is created. Local defaults remain three admitted attempts per server start; hosted defaults are 500 per instance. Consequently, the local default cannot fund two full voice attempts and two reports in one server session. Unavailable capacity produces the authored report. Do not restart a live server to replenish it.

Keep explicit local `--live`, production-only hosted enablement, exact origins, preview mock-only operation, server-side keys, and sanitized errors. Keys and report opt-in cannot independently enable a server in mock mode. Normal development and fixture/replay verification make no paid calls. Prepared drills from Play without voice also produce local authored reports, even if Live mode and report consent were selected before that choice.

## Facts and model output

The request contains one compact creation summary, within the existing 4,096-byte body limit:

- Run/creation identity, display name, supported v3 effect or v4 recipe, and final lifecycle outcome.
- Creator and optional triggerer IDs.
- The four-racer character mapping and only the relevant counters or per-racer durations.
- Separate report consent/attempt metadata and the validated input fingerprint.

Audio, transcripts, original prompts, geometry, player positions, and frame history are excluded. The server derives a catalog of at most eight canonical facts from the validated summary. It never accepts arbitrary client-written fact sentences.

Useful highlights include creator contact, repeated bounces, a meaningful imbalance between racers, protection intercepting a hit, useful drafting/current/orbit movement, and unused equipment. Comparisons and quantities are computed by the application. Ties are explicit. Combined racer-seconds are never described as elapsed encounter duration.

The model selects one or two evidence IDs and writes:

```json
{
  "headline": "REPEAT CONTACT HAS BEEN NOTED",
  "finding": "This now qualifies as a working relationship.",
  "evidenceIds": ["event-1:comparison:bounces"]
}
```

The application renders the associated factual sentences itself. Headlines are limited to 70 characters and findings to 180. Validate field limits, exact response identity, unique references belonging to this creation, and membership in its evidence catalog on both server and client. Render generated strings as escaped plain text.

A compact prompt asks for officious, reluctantly approving humor about departmental procedures. It prohibits invented race events, injury, motives, partners, finishing positions, overtakes, time saved, and winners. Bounces or force exposure do not establish harm. An obviously fictional administrative response, such as rejecting a travel allowance, is permitted. Names and other supplied strings are data, never instructions.

Structured Outputs constrain the response shape; they do not prove that a joke's implication is factual. Refusals, incomplete results, and invalid references retain the authored report without a repair call. See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).

The simulation is client-side. Schema checks establish bounds and internal consistency, not proof that an unmodified client produced these outcomes. Reports are descriptive UI, not an authoritative leaderboard.

## API and limits

- `GET /api/race-reports/status`: read-only availability and shared allowance status; no provider call.
- `POST /api/race-reports`: one strict request and one validated JSON response; mock/live mode is explicit.
- One generation call per report, no tools, `store: false`, disabled SDK retries.
- Existing configured design-model settings, with a separate 1,200-output-token cap for reports.
- Twelve-second server deadline: input guard up to 2.5 seconds, generation up to seven seconds, output guard up to 2.5 seconds, all clipped to remaining time.
- Fifteen-second client deadline including delivery.
- A refused, failed, timed-out, or cancelled admitted report consumes its allowance entry. No automatic retries, repairs, alternate models, or refunds.
- Bounded per-instance admission records reject repeated run/creation pairs and more than two reports for a run. Duplicate IDs remain rejected.
- Content/facts/client report state stay in run-local memory. The server retains bounded admission metadata until instance reset. Report text and input are not logged.

These are configured bounds, not measured live latency, price, or writing-quality guarantees. Provider-side handling is distinct from application memory and `store: false`.

Cold starts and multiple hosted instances retain the limitations in [deployment.md](deployment.md): counters and deduplication are not durable, globally shared spending controls.

## Modules

| Module | Responsibility |
| --- | --- |
| [Shared report contracts](../packages/shared/src/race-reports.ts) | Strict summary/output schemas, canonical facts, authored fallback, fingerprint |
| [Report server](../apps/server/src/race-reports/service.ts) | Admission, deadline, screening, generation and validation |
| [Input adapter](../apps/web/src/game/race-report-input.ts) | Copy only terminal event data and the frozen personnel mapping |
| [Client](../apps/web/src/game/race-report-client.ts) | Bounded transport and response parsing |
| [Controller](../apps/web/src/game/race-report-controller.ts) | One request per event, local queue, cancellation and stale-result rejection |
| [Main race](../apps/web/src/game/MovementTest.tsx) | Run setup, opt-in, observation and lifecycle wiring |
| [Voice host](../apps/web/src/game/race-event-host.ts) | Hold a saved second grant while a live report owns the shared slot |
| [Viewer](../apps/web/src/game/RaceCreations.tsx) | Display the report beside the existing model and inspection details |

V1/v2 generation, v3/v4 encounter contracts, movement, collision and generated geometry are unchanged. No persistence or extra relationship telemetry is added.

## Verification

For implementation, run from the worktree root:

```sh
bun run build
bun run typecheck
bun run test
```

Coverage should establish per-event dispatch before race completion, two distinct event/attempt identities, no repeated submission, no live call without separate consent, shared allowance/slot handling, invalid data/references, missing or partial provider output, and cancellation/late replies. Include selected-character mappings, unused/discarded creations, protected interactions, and the second grant's preserved prompt window.

Use free fixtures and mock voice in desktop Chrome or Edge to inspect provisional, pending, completed and failed reports and verify pause/reset during requests. A separately authorized, bounded live evaluation is still needed to assess humor, latency and actual token usage; mocks establish integration only.

## Checks performed

- `bun run build`, `bun run typecheck`, and `bun run test` passed; 528 tests passed, none skipped. The existing Vite large-chunk warning remains.
- Local documentation links and diff whitespace checks passed.
- The isolated preview and its API proxy returned healthy mock-only responses; reporting allowance usage remained zero.
- Desktop Chrome/Edge verification could not complete: the browser connector had no browser available and the fallback browser launch stalled. No visual playthrough or screenshot is claimed. Mock voice and report cancellation are covered by automated tests.
- No paid calls, deployment, or merge were performed.
