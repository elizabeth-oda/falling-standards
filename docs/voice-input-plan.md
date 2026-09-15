# Voice: setup, testing, and troubleshooting

Main-race voice now produces [v4 safety drills](safety-drills.md): the request chooses appearance and supported behavior. The v3 `/api/voice/events` endpoint remains compatible.

Use this guide to try the microphone in the game or Generation lab. For the code's overall structure, start with [how the game works](architecture.md). Voice is implemented in the main race; the older creation demo remains simulated regression code.

## Choose how you want to play

| Mode | What happens | What you need |
| --- | --- | --- |
| Play without voice | A race with ordinary items and the selected prepared safety drill waiting ahead for any racer to activate. Both yellow voice stars are removed. | A supported desktop browser and keyboard. No microphone or AI calls. |
| Mock | The microphone records, but a selected prepared transcript determines the creation. Your spoken words are not recognized. | Microphone permission and the local mock API. No key or paid calls. |
| Live AI | The recording is transcribed, then its words drive the design and geometry stages. | A configured live server, microphone permission, and a deliberately recorded request. |

Desktop Chrome and Edge are the initial target. Use localhost or HTTPS for microphone access. Spoken prompts are English-first and must contain one to ten whitespace-separated words, at most 200 characters.

## Try the game without spending credits

Run `bun install --frozen-lockfile` and `bun run dev` from the repository root, then open [the local game](http://localhost:5173).

1. Select a character and choose **Begin as [name]**.
2. Keep **Mock** selected in the pre-flight setup and choose a prepared prompt.
3. Click **Enable microphone** and allow access. The main race keeps that input open so repeat checks and both voice stars can reuse it without reopening the device. No clip is recorded until you hold Space, and enabling the microphone does not call a provider. Pause, restart, leaving, or finishing releases the input and clears microphone readiness. Enable it again in setup or the pause menu before using voice; the race never silently reopens a released device at a star. In development, reload the page after microphone code changes so Fast Refresh cannot retain an old recorder instance. Opening the device has a separate 10-second timeout; if it stalls, check browser permission and your selected input device, then try the check again. The lab retains its separate open/release capture behavior.
4. Choose the **Start with prepared hazard** or **Start with Live AI** button. Staying at the starting horizontal position lets you reach the yellow star at 180 m depth.
5. After collecting it, hold Space, speak, and release. The HUD shows the simulated transcript and creation progress.
6. Keep racing and follow the radar to the generated object. It appears later in the course, not immediately beside you. Fly through its glowing halo; the first racer to reach it activates the effect.

To play without a microphone, select a prepared prompt and choose **Race without voice** instead of enabling the microphone. The setup names the selected drill beside that button, even if Live AI is selected. The drill uses normal course placement and shared activation, with no recording, transcription, generation, or payment opt-in. Follow its radar and glowing halo; ordinary items remain available.

You have 10 gameplay seconds after a collected grant becomes available to start speaking. Recording auto-submits after 8 seconds. Each normal voice-enabled run offers two stars if you reach their locations, with one fresh attempt per star; failure, cancellation, or missing a star consumes that opportunity. Restart returns to setup and resets the two-attempt run counter. **Race without voice** skips all microphone setup and includes one prepared safety drill.

The second yellow star has a fixed depth chosen randomly between 60% and 70% of the course at the start of each run. It appears with at least 120 m of approach, or four seconds at your current fall speed when that needs more distance. At reveal it aligns with your current horizontal position, then stays fixed. The HUD announces its arrival. The first star's outcome, a waiting generated object, an active effect, and rival progress never suppress this offer. Rivals can activate generated objects, but cannot collect your yellow voice stars.

Collecting the second star saves its grant while the first recording or request finishes. Its ten-second speaking window begins once that voice work settles and any first result finishes its reveal buffer. The first generated object may remain collectible or active while you record and generate the second request. Only one recording or provider request runs at a time; a saved grant is not a saved audio clip.

Main-race objects have a 10 m collection radius and a fitted 12 m model diameter. Normal v3 placement is roughly eight seconds ahead of the player (240 m at normal fall speed), with room left for collection and the effect before the finish. A completed result waits two gameplay seconds before appearing, and longer if the current shared event is still active; it is not announced as spawned until placed. Contact size comes from the game, independently of the generated mesh. See [placement details](race-events-handoff.md#placement-and-lifecycle).

The first attempt retains its full capture, transcription, generation, reveal, approach, and effect admission checks at recording and submission. The second star is offered independently of those estimates, and its collected grant permits recording during an active run. Before dispatching the second request, the host requires at least 17 seconds of estimated race time: two seconds to reveal an immediately completed creation, three seconds of reachable approach, the maximum ten-second effect, and a two-second finish margin. If even that cannot fit, the opportunity is consumed with a message and no provider call.

The second attempt still has the separate 8/10/30-second budgets. Braking does not inflate the time estimate; slow generation or later boosts can leave a completed creation too late to place. Such results are discarded with a message, not retried or carried into another run. Two star offers do not guarantee two playable creations before landing. There is no encore or in-run reuse.

## Try the Generation lab

Open [the local lab](http://localhost:5173/#/dev/generation). It is available during `bun run dev` and excluded from production builds.

- **Race events** tests the same v3 creations used by the main race, with simplified racers for inspecting effects. Select a prepared event prompt and mock profile to try recorded input without spending credits. Fixture selection, simulation, and replay work without microphone capture.
- **Asset generation** is the v2 text/voice-to-3D comparison tool. Select **Voice**, keep **Mock two-stage pipeline**, choose a comparison prompt, enable the microphone, then hold and release the record button. **Speak and create** makes a preview; **Transcribe only** returns the simulated text without generation.

In Asset generation, **Use transcript as typed input** copies the recognized or simulated text into the text form without submitting it. The lab shows words, timings, stages, errors, and the last valid visual. Comparison exports can include transcripts and generated specs, but never audio. History lasts only while the page is mounted.

## Enable live AI locally

Skip this section for normal development or mock testing. One server-side key serves transcription, design, and geometry.

1. If `apps/server/.env` does not exist, copy the root `.env.example` there. Leave an existing file intact. In WSL, you can use:

   ```sh
   cp -n .env.example apps/server/.env
   chmod 600 apps/server/.env
   ```

2. Open `apps/server/.env` in your editor and set `OPENAI_API_KEY`. The file is ignored by Git. Do not put the key in frontend code, `VITE_` variables, chat, or terminal commands/history.
3. Stop the default development process with Ctrl+C, then run:

   ```sh
   bun run dev:live
   ```

4. In race setup, enable the microphone, select **Live AI**, and choose the **Start with prepared hazard** or **Start with Live AI** button. After collecting a star, deliberately hold Space to record. The run offers at most two paid voice attempts (up to six API calls total). In the lab, choose a live profile and record or submit the prompt. Voice and generation have no separate payment opt-in checkbox; the optional incident-report feature retains its own setting.

`bun run dev`, builds, tests, and the ordinary server start keep paid mode disabled even if a key is present. Starting `dev:live` exposes the paid option; it does not itself make a provider call. Refreshing profiles reports local configuration, not whether the provider accepts your key or model.

Live development binds to localhost and does not restart the backend on file changes. Restart it deliberately after editing server code. For a hosted game, use [the Vercel guide](deployment.md) instead of these local enablement steps.

### Calls and allowance

| Action | Maximum provider calls |
| --- | --- |
| Typed creation | 2: design and geometry |
| Transcription only | 1: speech |
| Spoken creation | 3: speech, design, and geometry |

Local live mode defaults to **3 dispatched attempts per server start**, shared across the race, lab, profiles, and browser tabs. `LIVE_MAX_ATTEMPTS` accepts 1-500. Only one paid attempt runs at a time per server instance, and repeat attempt IDs are rejected. Restarting resets the count. Failed or cancelled dispatched work consumes the allowance and may still incur charges; there are no automatic retries.

In the main race, each run permits up to two fresh voice attempts. Each deliberately started live attempt consumes one run opportunity and receives its own UUID; collecting a star, selecting Live AI, and enabling the microphone never dispatch automatically. Reset starts a fresh run counter; changing profiles or prompts does not replenish used opportunities. Lab submissions also create a fresh attempt ID automatically. Server allowance is checked independently and may run out before the second race attempt. Missing or invalid request metadata is rejected before dispatch. If a paid transcription returns empty or overlong text, the attempt is consumed and generation does not start.

The configured transcription model comes from `TRANSCRIPTION_MODEL` in the server environment; its default is `gpt-transcribe`. Generation profiles and output limits are documented in [the lab guide](prompt-to-mesh-pipeline.md#models-and-budgets).

## Understand timing and cancellation

The budgets run in sequence:

```text
Record: up to 8 s
  -> upload and transcribe: up to 10 s
  -> design and geometry together: up to 30 s
```

Design has an 8-second cap inside the generation window. If design takes 6 seconds, geometry has about 24 seconds left. A total voice attempt longer than 30 seconds can therefore be expected even when generation stays within its own budget.

In the race, pausing, losing focus, restarting, finishing, or leaving cancels pending work (including a saved second-star grant and a ready result awaiting placement), releases the microphone, and rejects late results. A pause preserves an uncollected future star and freezes its approach with the race clock. An already spawned shared object remains available to racers still falling. Pausing freezes its effect time; resetting clears it. The HUD reports an unusable or discarded second opportunity independently of the first effect's status.

In the lab, losing focus cancels microphone capture. After submission, requests can continue in the background. Explicit cancellation or leaving the page aborts pending requests. Audio stays in memory only for capture and the request; it is never written to files, logs, or comparison history.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| It always creates the same thing | Check **Mock** versus **Live AI**. Mock mode uses the selected prepared transcript, regardless of what you say. |
| Space does nothing | Collect the yellow star first, start within the speaking window, and check that voice is enabled and the race is unpaused. |
| Microphone unavailable | Check browser permission and input device. Use desktop Chrome/Edge on localhost or HTTPS. You can still play without voice. |
| Checking or preparing the microphone stalls | Opening the input device times out after 10 seconds, before recording or any API request. The HUD distinguishes opening the input, initializing the recorder, initializing its level meter, and starting recording; the device-opening timeout does not cover a browser call that blocks JavaScript. Main-race setup and both stars reuse the prepared input during an uninterrupted run, including after a generation failure. Check browser permission and the selected device if the initial open fails. An in-race startup failure consumes that star’s attempt; it never automatically retries. Pause/reset cancels startup and releases the input; any late stream is immediately stopped. |
| Live AI unavailable locally | Check the server is running through `bun run dev:live` and a key is configured in the server environment, then refresh availability. |
| Live AI unavailable on Vercel | Follow [hosted diagnostics](deployment.md#troubleshooting); an API startup failure can look like disabled AI. |
| `TRANSCRIPTION_TIMEOUT` | Upload/transcription exceeded its separate budget. Generation may not have started. |
| `TIMEOUT` in design or geometry | The design cap or shared 30-second generation deadline was reached. See [latency testing](prompt-to-mesh-pipeline.md#testing-against-the-30-second-limit). |
| Object generated, but no effect yet | The object is waiting for a racer to collect it. Follow the radar and glowing halo. |
| Attempt consumed after a failure | Each star grants one attempt. Watch for the second star at 60–70% of the course regardless of the first outcome; paid dispatched failures still count. |

Reusing a recognized transcript in the typed lab avoids another transcription call, but a new live generation still requires a separate paid attempt.

## HTTP and adapter reference

`GET /api/lab/profiles` returns generation profiles, transcription availability/model, and shared usage counters. It contains no credentials and makes no provider call.

All three voice POST routes accept multipart form data with exactly two parts:

1. `audio`: one nonempty file, at most 1 MiB, with MIME `audio/webm`, `audio/mp4`, or `audio/wav`. The server checks the container signature; the provider decodes audio.
2. `options`: JSON matching the strict shared `VoiceRequestSchema`. For an event mock:

   ```json
   {"profileId":"mock","geometryMode":"primitives","captureMs":1200,"mockText":"hungry purple planet"}
   ```

`captureMs` is finite in [0, 8000] and reports browser capture time; it is not server-verified duration. `geometryMode` is `primitives` or `mesh`; omission retains the raw-mesh default. `mockText` is ignored by live transcription. The low-level mock speech provider defaults to `giant rubber duck` when omitted; event clients must supply a supported event prompt, as the game's UI does.

Live options retain `paidAttempt: {id: <new UUID>, confirmed: true}` for API compatibility. Clients create it automatically on deliberate submission; `confirmed` no longer corresponds to a payment checkbox. No keys or model overrides belong in request metadata. Text is validated rather than silently shortened.

| Route | Result |
| --- | --- |
| `POST /api/voice/drills` | Main-race v4 drill workflow, streamed as `SafetyDrillVoiceEventSchema`. |
| `POST /api/voice/events` | Retained v3 event workflow, streamed as `RaceEventVoiceEventSchema`. |
| `POST /api/voice/creations` | Asset lab's v2 workflow, streamed as `VoiceEventSchema`. |
| `POST /api/voice/transcriptions` | JSON `{text, metric}` only; no design or geometry. |

Both generation streams report `transcribing`, `transcript`, nested `generation` progress, then an outer `complete` or `failed`. The outer terminal event decides success; HTTP 200 alone does not. A completed result includes the validated spec, transcript metric, and elapsed time. The browser validates every event and final spec.

Pre-stream failures return `{error:{code,message,provider?}}` with safe allowlisted diagnostics. Statuses are 400 for invalid input or attempt metadata, 403 for disabled mode or foreign origin, 409 for busy/repeated attempts, 429 for exhausted allowance, 503 for missing configuration, and 502 for other provider/deadline failures. Raw provider errors are never forwarded.

The upload deadline starts on handler entry. A stalled upload closes without dispatching transcription. Client deadlines are 15 seconds for transcription-only and 45 seconds for the combined workflow, including delivery grace; capture precedes these request budgets.

| Responsibility | Location |
| --- | --- |
| Recording, permission, meter, cleanup | `apps/web/src/voice/recorder.ts`, `RecorderControls.tsx` |
| Race setup and attempt admission | `apps/web/src/voice/RaceVoiceControls.tsx` |
| Main-race audio adapter | `apps/web/src/voice/race-event-voice-client.ts` |
| v3 text/audio streaming client | `apps/web/src/race-events/client.ts` |
| v2 and transcription-only client | `apps/web/src/voice/voice-client.ts` |
| Shared audio and event contracts | `packages/shared/src/voice.ts`, `race-event-pipeline.ts` |
| Uploads and transcription providers | `apps/server/src/voice/routes.ts`, `transcription.ts` |
| Paid admission and generation | `apps/server/src/generation/pipeline.ts` |
| Current race attempt and spawn lifecycle | `apps/web/src/game/creation-attempt.ts`, `race-event-host.ts` |

The recorder captures audio; transcription returns words; generation returns validated data. `RaceEventHost` connects that work to pickups without moving the player. Legacy `CreationLoop` and `RaceCreationHost` retain the older v2 adapter behavior; they do not define current shared race effects.

## Verify a change

Run [the contributor checks](../CONTRIBUTING.md#check-your-work), then try the mock game flow above in Chrome or Edge. Tests use fake media devices, canned uploads, and intercepted provider responses. They cover recording cleanup, attempt admission, deadlines, invalid input, and stale results without real credentials. Second-star checks advance the actual 120 Hz race through first-star travel, recording, and response delay; they cover success, failure, timeout, missed pickups, uncollected objects, active effects, boosts, saved grants, and cancellation. In Chrome or Edge, verify a successful first mock encounter followed by the second star, plus pause/reset during pending voice work.

A real microphone/live quality test is a separate deliberate action. Record the browser, selected profile, recognized text, timings, and outcome; never include audio or keys in a report.

## Optional incident reports

In the Live AI setup step, **Include an AI incident report after the race — 1 additional paid call** is off by default. This option is independent of the two voice attempts. One report request covers both creations after all racers have landed and voice work has been cleaned up. No successful creations means no report request.

The maximum with reporting enabled is six voice/generation calls plus one report generation call, and up to two additional content-screening requests. Reporting consumes one more entry from the existing server allowance; local default 3 and hosted default 500 remain unchanged. A busy or exhausted server leaves the authored report available without retrying.

Opening or closing the creation viewer never dispatches a request. Pause, reset, and navigation abort reporting and reject late responses. Prepared drills, replay, and mock runs use free authored findings. Report payloads exclude audio, transcripts, prompts, and geometry. See [the incident-report guide](race-incident-report-proposal.md).
