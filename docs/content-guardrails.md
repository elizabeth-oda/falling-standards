# Geometry content guardrails

Generation applies the game-content-v1 policy on the server. Typed and voice creation requests use the same checks for legacy v2 assets and v3 race events, in raw-mesh and procedural modes. The policy lives in [content-policy.ts](../apps/server/src/generation/content-policy.ts).

## Policy and enforcement

The game permits cartoon hazards, fantasy creatures, toy/fantasy weapons and non-graphic fictional combat. Its generation instructions prohibit sexual content/nudity, graphic gore, hateful symbols/slurs, targeted abuse, self-harm encouragement and real-world harm instructions.

Live input screening uses OpenAI's `omni-moderation-latest` endpoint. It applies category flags rather than the aggregate `flagged` value: ordinary `violence` alone is allowed for cartoon game context; every other supported category and any newly flagged category blocks. Malformed, missing, incomplete or unexplained results fail closed. Category flags are provider classifications, not calibrated application probabilities. General-audience requirements such as nonsexual nudity and symbol recognition also rely on the model's explicit refusal instructions; text moderation is not a complete classifier for those requirements.

The generation flow is:

1. Validate input, profile and paid-attempt metadata; acquire the existing attempt allowance and single live slot.
2. For voice, transcribe within the separate upload/transcription budget.
3. Screen the input text before design generation. A creation transcript is not streamed until this succeeds.
4. Generate and structurally validate the design.
5. Screen each generated text field as a separate moderation input: name, visual brief, and the legacy description. V3 descriptions come from trusted game presets.
6. Only then emit the design event and send the visual brief to geometry.
7. Apply existing mesh/recipe and assembled-spec validation before emitting completion.

`ContentGuard` is replaceable; `CreationPipeline` never substitutes the mock guard for a missing live guard. `buildPipeline` constructs live moderation only when paid mode was explicitly enabled and a server key is configured. Health/profile reads and previews make no provider calls. The standalone transcription-only tool retains its existing behavior; reusing a transcript as a typed creation goes through input screening.

## Timing, admission and failure behavior

Each screening has a 2.5-second ceiling within the existing 30-second generation deadline. The design model still has at most 8 seconds; geometry receives the remaining overall time, including time spent screening. Guards, generation, and voice cancellation share abort propagation; late approvals cannot release a result even if an adapter ignores cancellation.

A successful live typed attempt makes up to two paid generation calls plus two free moderation requests. Voice adds one paid transcription call. One attempt UUID and allowance reservation cover the entire attempt. Rejection, timeout or cancellation after admission consumes the attempt; there are no retries, repairs, refunds, alternate-model calls or automatically generated replacements.

Content blocks and model refusals use the existing `REFUSED` code and a fixed player message. Screening failures use `PROVIDER_UNAVAILABLE` with a distinct screening message; the overall deadline remains `TIMEOUT`, and user cancellation remains `CANCELLED`. Existing creation versions and stream schemas are unchanged.

The server does not log moderation inputs, scores, provider messages or rejected designs, or add a content audit store. Moderation receives text, never audio. Rejected lab history/export entries remove prompt, transcript, design and spec, retaining failure and timing metadata. Approved lab comparisons retain their existing in-memory data. Audio remains memory-only. Provider-side data handling is governed by the provider, not these application storage rules.

## Free verification

Run `bun run dev` and open the Generation lab. Keep a mock profile selected.

- Submit `blocked mock request`: expect a concise refusal and no new preview. Asset-generation history/export should show `[Content rejected]`.
- Submit `unavailable mock screening`: expect a screening-unavailable error and no new preview.
- Submit a listed fixture prompt: expect the same authored creation.
- Fixtures and replay remain local; pause/reset/navigation still discard pending creation work.

Those two exact phrases are deterministic UX fixtures, not an offline content classifier. They are never used as a live moderation fallback. Custom mock ideas otherwise retain the existing fixture behavior.

Run `bun run build`, `bun run typecheck`, and `bun run test`. Automated coverage uses fake credentials and intercepted transports for moderation, response validation, category mapping, individual output fields, route coverage, aborts, deadlines, request admission, single-slot accounting, client refusal handling and history redaction.

Automated tests use neutral placeholders and mocked moderation flags. They verify enforcement behavior, not classifier recall or false-positive rate. Any live content-quality evaluation should be separately scoped and explicitly authorized; no evaluation prompt corpus is included.

## Limits and next step

The current release screens intent and design text, not rendered geometry. A safe brief may still produce an inappropriate shape; triangle/recipe bounds cannot recognize its meaning. A follow-up should render the exact validated mesh from several angles on the server and screen those views before completion, including targeted symbol/gesture checks beyond generic image moderation. That work needs its own rendering, latency and classifier evaluation; it must fit the same attempt/lifecycle limits. No content filter guarantees perfect detection.

Reference: [OpenAI moderation guide](https://developers.openai.com/api/docs/guides/moderation). The endpoint supports text and image input and is free; supported categories differ by input modality.

## Incident report text

The separate event-report endpoint reuses the same live content guard and admission gate. It screens the creation display name before its one generation call, then screens headline and finding individually before returning them. Both guard requests fit inside the report's 12-second total deadline, with at most 2.5 seconds per screening. Refusal or screening failure retains the client's authored report, consumes an admitted attempt, and never triggers a repair call.

The server derives bounded factual evidence from a strict event-summary schema. The model selects evidence IDs and writes comic framing; the client renders canonical facts and escaped generated text. Neither original prompts nor transcripts/audio enter reporting. Structural checks and valid references do not prove that every implication of a joke is factual; a separately authorized live writing evaluation remains necessary. No report inputs, outputs, or rejected content are added to logs or persistent history. See [incident reports](race-incident-report-proposal.md).
