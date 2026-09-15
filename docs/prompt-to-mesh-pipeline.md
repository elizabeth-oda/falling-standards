# Prompt-to-3D generation lab

Use the Generation lab to inspect a creation, compare visual methods, and diagnose a failed request without playing a whole race. It runs locally under `bun run dev`; its page and code are excluded from production builds.

The lab opens on **Safety drills**, which uses the same v4 recipes as the main game. Read [the safety-drill guide](safety-drills.md) to test Stampede and Sky Rapids. V3 fixtures remain in a legacy disclosure. Select **Asset generation** for the v2 comparison tool described below. Both use the same design-to-geometry pipeline, a 30-second generation deadline, and one effect per generated object.

For a first microphone test or API key setup, start with [the voice guide](voice-input-plan.md). For the bigger picture, see [the architecture tour](architecture.md).

## Start and try the mock

Run `bun install`, then `bun run dev`. Open [the local Generation lab](http://localhost:5173/#/dev/generation) and select **Asset generation**.

1. Keep **Procedural parts** and **Mock two-stage pipeline** selected.
2. Choose any of the twelve comparison presets, such as **giant rubber duck**, **red rocket with fins**, or **spiky pink shield**.
3. Click **Load mock example** to see its design, completed visual, effect, and timing.
4. Inspect it at 7, 15, or 30 meters; rotation and **Spin preview** are viewer controls.
5. Switch to **Raw mesh · experimental** to exercise the original vertex/face path.

Every listed procedural prompt has its own authored model. Selection also accepts an exact display name and ignores letter case and repeated whitespace. Unsupported custom ideas return an explicit error; they never silently fall back to a duck. Use a live profile for arbitrary requests. Mock raw geometry always returns the original wind crystal. This validates the pipeline and rendering, not the models' interpretation or latency.

The final procedural visual is baked into one render mesh. Its short appearance animation and optional preview spin are authored lab presentation; they do not modify the spec or execute gameplay effects.

## Enable live testing

Follow [the local live AI setup](voice-input-plan.md#enable-live-ai-locally) to save a server-side key and start `bun run dev:live`. The local allowance defaults to three dispatched attempts per server start; key presence alone does not enable spending.

In **Asset generation**, select a live profile and visual method, then enter a short prompt. Click **Generate · up to 2 paid calls**. The selected live profile and deliberate submission create fresh attempt metadata automatically; there is no separate payment opt-in checkbox. Every comparison is a separate deliberate attempt; there is no automatic paid batch, retry, or repair call.

Adding a key, refreshing profiles, loading a fixture, and editing prompts make no provider calls. Availability reports configuration only, not verified model/account access. Legacy raw-spec endpoints stay mocked. For hosted game settings and the separate 500-attempt per-instance default, use [the deployment guide](deployment.md).

## Run a comparison

The lab supplies 12 varied prompts and supports custom text up to ten whitespace-separated words / 200 characters. Run the same prompt once per method with the same model profile. Each button submission is a separate attempt; there is no automatic paid batch.

Rate recognizable silhouette and requested features as Clear, Partial, or Unclear. Check multiple angles and the distance selector. Its 45-degree camera is an inspection aid, not a reproduction of the race camera.

**Compare attempts** retains the last 60 attempts, including failures and cancellations. Summaries separate model configurations, visual methods, and mock/live transport. Median successful time excludes unsuccessful attempts; the ready/attempt count includes all attempts. Missing token usage is displayed as unavailable, not zero.

**Export comparison JSON** creates a visible, selectable JSON snapshot and a download link. Copy the text if the browser does not support downloads. It includes prompts, full profile settings, methods, events, specs, ratings, timing and outcomes. Export before navigating away, reloading, or editing code during development; history is component memory only.

Keep 30 seconds as the failure ceiling. A 5–10 second typical result is an evaluation target, not a measured guarantee. Retain both methods until live samples establish recognizable-result rate, latency, and usage. Single-call generation, additional shapes, material presets, and generated animation are future experiments.

## Content screening

Live requests and generated design text are screened before geometry. Refusals make no creation and consume the admitted attempt. The two free moderation requests share the 30-second generation deadline; no extra paid generation calls are added. See [content guardrails](content-guardrails.md) for policy, mock rejection fixtures, privacy, and limitations.

## Models and budgets

Server profiles in `apps/server/src/generation/pipeline-config.ts`:
- `mock`: deterministic two-stage transport.
- `sol-direct`: Sol for both stages with `reasoning: none`, an explicit latency-testing alternative.
- `sol-astra`: Sol design → Astra visuals.
- `sol-sol`: Sol for both stages.
- `configured`: environment-selected models and output budgets.

| Variable | Default |
| --- | --- |
| LIVE_MAX_ATTEMPTS | 3 (integer 1–500) |
| DESIGN_MODEL | gpt-5.6-sol |
| DESIGN_REASONING | low |
| DESIGN_MAX_OUTPUT_TOKENS | 2048 |
| GEOMETRY_MODEL | gpt-6-astra |
| GEOMETRY_REASONING | low |
| GEOMETRY_MAX_OUTPUT_TOKENS | 12000 |

Both visual methods use the selected geometry-stage settings. Supported IDs remain gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, and gpt-5.6-luna. Reasoning is none, low, medium, or high (Astra rejects none); output budgets are integers 256–16000. Budgets include reasoning tokens. Incomplete responses fail.

Calls use the official Responses API with strict Structured Outputs, no tools, store:false and maxRetries:0. Stage one has at most 8 seconds; stage two receives the remaining overall time. Geometry receives only the validated visual brief, never the original prompt or gameplay effect. Failed validation consumes the attempt; no silent fallback is applied to live results.

## Visual contracts and rendering

CreationSpec v2 already supports both representations, so no new game-spec version is introduced. The generated-result schema accepts either appearance with exactly one supported effect. Legacy v1 and broader v2 contracts remain compatible.

**Procedural parts**

The model wire recipe is `{parts: [...]}`. Each part contains:
- type: box, sphere, cylinder, or cone.
- position, rotation, scale: named `{x,y,z}` coordinates.
- color: exactly #RRGGBB.

The server validates this recipe and converts coordinates into the existing v2 tuples:

```ts
{
  version: 2,
  appearance: {
    type: 'primitives',
    primitives: [
      {type: 'sphere', position: [0,0,0], rotation: [0,0,0], scale: [2,1,2], color: '#ffcc32'}
    ]
  },
  // id, displayName, description, and exactly one effect are assembled separately.
}
```

Recipes contain 1–24 parts. Position axes are [-3,3] meters, rotation axes [-π,π] radians, and scale axes [0.05,4] meters. Numbers must be finite. Coordinates are right-handed: +X right, +Y up, +Z toward the object's front. Transforms apply scale, XYZ Euler rotation, then translation. Box size is 1×1×1; sphere diameter is 1; cylinder/cone diameter and height are 1 along Y, with the cone tip at +Y. All base shapes are centered.

These match existing primitive semantics. They bound part transforms rather than imposing the raw mesh's six-meter total cube. Prompts target a compact visual roughly three meters across.

The trusted browser compiler fixes sphere resolution to 16×12 segments and cylinder/cone radial resolution to 16. It bakes transformed positions, normals and per-part colors into one geometry with one material, capped at 10,000 triangles. Even 24 spheres fit this bound. Temporary geometries are disposed during compilation; R3F owns the final geometry and material. No model-provided tessellation, scripts, modifiers, colliders, material settings or animation fields are accepted.

**Raw mesh**

The existing model wire format is vertices `{x,y,z}` and faces `{a,b,c,color}`. Limits remain 256 vertices, 512 triangles, coordinates [-3,3], distinct existing integer indices, nondegenerate faces, and one #RRGGBB color per face. This budget is independent of trusted procedural compilation. Valid geometry can still have a poor silhouette, holes, or disconnected surfaces.

## HTTP contract

- GET /api/lab/profiles: public profiles, availability, budgets, and `liveUsage: {enabled,maxAttempts,attemptsUsed,attemptsRemaining,busy}`. No provider call or credential is included.
- POST /api/lab/creations:

```json
{
  "text":"giant rubber duck",
  "profileId":"sol-astra",
  "geometryMode":"primitives",
  "paidAttempt":{"id":"861f3264-c7cf-4e5e-8a95-8bf5e7388b79","confirmed":true}
}
```

`geometryMode` is `primitives` or `mesh`. Omission retains the existing raw-mesh behavior; the lab explicitly defaults to primitives. Unknown request fields and methods are rejected.

`paidAttempt` is required for live profiles only. Use a fresh UUID for each deliberate submission. A dispatched UUID cannot be reused, even after failure/cancellation. This is an accidental-spend control, not user authentication.

Invalid input, profile or missing/invalid paid-attempt metadata returns HTTP 400 with `{error:{code,message}}`; disabled paid mode or a foreign browser origin returns 403; a live-enabled but unconfigured profile returns 503. Accepted attempts stream application/x-ndjson:

```text
stage(design)
design(validated design + metric)
stage(geometry)
geometry(metric)
stage(validation)
complete(validated spec + metrics + total elapsed)
```

The stage name `geometry` remains stable for both methods. A failure replaces remaining events with `failed(stage,error,metrics,elapsedMs)`. Inspect the terminal event after HTTP 200. Live gate failures in the stream use CONSENT_REQUIRED, DUPLICATE_ATTEMPT, LIVE_BUSY, or LIVE_LIMIT_REACHED and dispatch no model call. Error codes also include LIVE_DISABLED, INVALID_RECIPE, INVALID_MESH, INVALID_DESIGN, TIMEOUT, CANCELLED, REFUSED, INCOMPLETE, and PROVIDER_ERROR. Provider internals are not exposed.

Disconnect/cancellation aborts active work and prevents later stages. It cannot guarantee that already-started provider work incurs no usage. The client validates every stream event. Partial recipes and mesh fragments are never rendered.

POST /api/creations still returns a raw spec and defaults to the pipeline's mock raw-mesh method. It never silently enables live calls.

## Testing against the 30-second limit

If transcription succeeds but design + geometry sum to roughly 30 seconds, generation reached its real shared deadline. For example, 6.61 seconds of design leaves about 23.39 seconds for geometry. A voice total of 33.5 seconds can include 2.3 seconds of capture and 0.82 seconds of transcription before that generation window.

For the next deliberate comparison, try **Procedural parts** with **Sol direct · no reasoning**. It uses Sol for design and geometry with reasoning disabled, retaining the same validation, token caps, 30-second ceiling, and paid-attempt controls. This is a candidate for reducing latency, not a measured speed or quality guarantee. The existing Sol/Astra and Sol/Sol profiles retain low reasoning for comparison. No automatic fallback or retry is added.

Sol supports `reasoning.effort: none`; Astra's lowest supported setting is `low`. Configuration rejects Astra + none before an API call. See [Sol settings](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and [Astra settings](https://developers.openai.com/api/docs/models/gpt-6-astra). Smaller outputs are another possible improvement; increasing the output-token cap does not make an existing request faster. See [latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization).

Use **Use transcript as typed input** to compare generation with the already-recognized words, saving another transcription call. A new typed submission uses its own fresh attempt ID and the selected profile. Restart `bun run dev:live` deliberately to load the new backend profile, then Refresh profiles. Restarting resets the in-memory allowance.

## Diagnosing a live failure

Restart `bun run dev:live` after backend changes; live mode has no server watcher. Refresh the page before another deliberate attempt.

The lab now shows the failing stage plus a specific category: PROVIDER_AUTH, MODEL_UNAVAILABLE, PROVIDER_PERMISSION, PROVIDER_QUOTA, PROVIDER_RATE_LIMIT, PROVIDER_SCHEMA, PROVIDER_REQUEST, PROVIDER_UNAVAILABLE, PROVIDER_CONNECTION, or PROVIDER_TIMEOUT. TIMEOUT identifies our own design/attempt deadline. A geometry-stage failure means the design was already validated; do not assume every provider error means the key is invalid.

**API error details** show the requested model, HTTP status, and recognized provider code, network timeout code, request parameter and request ID when available. These also survive in the event inspector and comparison export. Only allowlisted metadata is copied. API messages, arbitrary headers/fields, prompts echoed by a provider, and credentials are never forwarded or logged. A failed Responses object returned with HTTP 200 is distinguished from incomplete output.

- TIMEOUT: the design stage exceeded its 8-second allowance or the whole attempt exhausted 30 seconds. Design time is included in the total; for example, 5.72 seconds of design leaves at most 24.28 seconds for geometry and validation.
- PROVIDER_TIMEOUT: the SDK or underlying network timed out independently, or OpenAI returned HTTP 408, possibly before 30 seconds. `UND_ERR_CONNECT_TIMEOUT` identifies connection establishment; `UND_ERR_HEADERS_TIMEOUT` identifies waiting for headers; `UND_ERR_BODY_TIMEOUT` identifies reading the response body; `ETIMEDOUT` is a generic network timeout. When no recognized code is available, the precise source is unknown. No automatic retry is made.

The pipeline measures elapsed time with `performance.now()` and aborts both the SDK fetch and response-body read at its deadline. The SDK retains its longer default timeout as a fallback, rather than another 30-second timer: the installed SDK computes response-body time remaining with `Date.now()`, which can jump when the host clock is synchronized. This change does not extend the game's 30-second budget. Real network/provider failures can still end an attempt earlier.

- MODEL_UNAVAILABLE: confirm project access and the model ID. The existing Sol → Sol profile can be chosen explicitly if Astra is unavailable; there is no automatic model fallback.
- PROVIDER_QUOTA: inspect the provider code for credit balance, project/organization spend, or usage limits. Avoid repeat attempts until the account issue is resolved.
- PROVIDER_RATE_LIMIT: inspect that model's request/token limits and the configured output budget.
- PROVIDER_SCHEMA / PROVIDER_REQUEST: fix the API request or named parameter before another attempt.

Previous generic PROVIDER_ERROR events cannot be reconstructed: their provider reason was discarded by the older server. No diagnostic check calls OpenAI automatically. See [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes).

## Game integration boundary

The main game supports voice-to-shared-drill creation through `RaceEventHost` and `/api/voice/drills`. The lab's **Safety drills** panel uses the same v4 contract, including text generation through `/api/lab/drills`. The v3 `/api/voice/events` and `/api/lab/events` endpoints remain available for compatibility. This Asset generation comparison retains v2 results; do not feed them into the race by casting types.

The player collects an authored Voice Power Up, speaks once while falling, and keeps racing while generation completes. A validated object spawns ahead, and the first racer to collect it activates its shared effect. Appearance does not determine collision size, and materialization visuals do not activate an effect early. See [the race integration](race-events-handoff.md).

The older `CreationDemoPage` remains simulated regression code and is not mounted by the current `GamePage`. Controls, movement, collision, and effect timing stay separate from provider requests.

## Implementation and verification

- shared `creation.ts`, `pipeline.ts`, `procedural.ts`: versioned contracts, recipe adapter, and events.
- shared `procedural-fixtures.ts`: twelve examples and evaluation prompts, derived from the same catalog.
- server `generation/pipeline.ts`, `visual-output.ts`: orchestration and validation.
- server `generation/model-schemas.ts`, `stage-transport.ts`: prompts, wire schemas, SDK/mock calls.
- web `generation/compile-primitives.ts`: bounded single-mesh compilation.
- web `pages/GenerationLabPage.tsx`, `generation/LabPreview.tsx`, `LabHistory.tsx`: testing UI.

Run `bun run build`, `bun run typecheck`, and `bun run test`. Automated tests use fixtures and intercepted SDK responses, never paid calls. Coverage includes recipe bounds, one-effect output, handoff isolation, raw API compatibility, cancellation/deadlines, compiler transforms and budgets, comparison accounting, existing game/race tests, paid-mode gates, attempt metadata, duplicate submissions, shared concurrency/allowance, and secret-free status/errors.

References: [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization), [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra).

## Voice integration

The Generation lab also accepts recorded input, and the main race shares its voice client and server coordinator. See [voice testing and API contracts](voice-input-plan.md). Typed generation remains two stages; voice adds a separately budgeted transcription stage and reserves the same paid allowance once for the entire workflow. The legacy simulated creation demo remains independent.
