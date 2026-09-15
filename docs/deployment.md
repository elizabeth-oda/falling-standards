# Deploy the game to Vercel

This repository deploys the browser game and Fastify API together. The Generation lab stays local and is excluded from production bundles. No database is required.

You will need access to the GitHub repository and a Vercel project. An API key is optional for the first deployment: start with mock mode and add live AI after the game and API work.

## 1. Check the release locally

From the repository root:

```sh
bun install --frozen-lockfile
bun run build:deploy
bun run typecheck
bun run test
```

`build:deploy` builds the shared package, backend, and game-only frontend. It does not upload anything, start a live server, or call an AI provider. Ordinary production builds also omit the lab.

## 2. Connect the repository

1. Import the GitHub repository into Vercel.
2. Set **Root Directory to the repository root** (leave the field empty). Do not choose `apps/web`: Vercel needs the root `vercel.json` and all three workspaces.
3. Use the checked-in **Services** configuration. Keep install/build/output settings in the individual services as defined in `vercel.json`; do not add a project-wide build-command override.
4. Deploy with no key and paid mode disabled.

The configuration builds the web service from `apps/web` and API from `apps/server`. It routes `/api/*` to Fastify and other requests to the frontend. The API starts through `src/vercel.ts`; character models are static web assets. See [Vercel Services](https://vercel.com/docs/services) for the hosting model.

Keep `/api/lab/profiles` and the event APIs: the game needs them even though the lab page is absent.

Automatic Git deployments are disabled for `main` by `git.deploymentEnabled` in `vercel.json`. Other branches still create automatic preview deployments. To release new code, push or merge it to `main`, then open **Deployments > Create Deployment** in Vercel and select the latest `main` commit. See [Vercel Git deployment controls](https://vercel.com/docs/project-configuration/git-configuration#git.deploymentEnabled) and [creating a deployment from a Git reference](https://vercel.com/docs/git#creating-a-deployment-from-a-git-reference).

## 3. Check the mock deployment

Open the production URL in Chrome or Edge and check:

- The personnel screen, character models, and a race load over HTTPS.
- `GET /api/health` returns `{"status":"ok","mode":"mock"}`.
- `GET /api/lab/profiles` returns JSON showing mock availability.
- Mock voice can complete its pickup-to-creation-to-effect flow. It uses a prepared transcript, not speech recognition.
- Pausing/restarting cancels pending requests, and the local-only Generation lab cannot be opened.

Health and profile requests never call OpenAI. If either API endpoint fails, fix that before testing a paid request. Health reports the configured mode; it does not validate a provider key or report remaining attempts.

For invited live testers, configure **Vercel Authentication** with **All Deployments** and verify protection on both the production domain and direct deployment URLs, including API requests. Share access only with intended testers. Available access and sharing options depend on the account; consult [Deployment Protection](https://vercel.com/docs/deployment-protection). Origin checks in game code are not a substitute for access control.

## 4. Add optional live AI

In the project's **Environment Variables** screen, add these for **Production**:

| Name | Type | Value |
| --- | --- | --- |
| `OPENAI_API_KEY` | Secret | Paste the key directly into Vercel. |
| `HOSTED_LIVE_ENABLED` | Config | `true` when you deliberately want live AI available; `false` disables it. |
| `APP_ORIGIN` | Config | The exact production origin, such as `https://your-game.vercel.app`, without a trailing slash. |
| `LIVE_MAX_ATTEMPTS` | Config, optional | `500`, or leave unset for the hosted default of 500 per server instance. Accepts 1-500. |

Do not copy the whole local `.env` into Vercel: its local allowance defaults to 3. Optional model and token settings are listed in the root `.env.example`.

The host must identify the deployment as production (`VERCEL_ENV=production`), the enable flag must be true, and the configured origin must match. Preview deployments always remain mock-only. Players select Live AI and deliberately record a request; there is no separate payment opt-in checkbox. The client attaches a fresh attempt ID and compatibility metadata automatically. Adding the key, opening the site, or selecting a mode does not start generation.

### Where the key lives

Vercel stores environment variables encrypted at rest. Choose **Secret** so the value is write-only after saving; executing server/build code can still access it. See [Vercel environment variables](https://vercel.com/docs/environment-variables).

Our provider reads `process.env.OPENAI_API_KEY` in server modules. The key is never sent as client configuration or included in game requests. Do not add a `VITE_` prefix, print environment variables, or download production secrets for a local check. Locally, use the ignored `apps/server/.env` file.

## 5. Redeploy after changing a variable

Saving a variable does not update an existing deployment. In Vercel:

1. Open the project and choose **Deployments** in the left sidebar.
2. Find the production deployment you want to rebuild.
3. Open that deployment's **...** menu and select **Redeploy**.
4. Confirm the production environment and redeploy.
5. Wait for Ready, then reload the canonical game URL matching `APP_ORIGIN`.

These steps rebuild the selected commit. To include code changes, first push those commits to the connected production branch (currently `main`), then use **Create Deployment** to deploy the latest `main` commit; pushes to `main` do not deploy automatically. Redeploying an old commit will not pick up newer code. See [Vercel's redeployment guide](https://vercel.com/docs/deployments/managing-deployments#redeploy-a-project).

Verify health/profiles again. When you intentionally want a paid test, select Live AI, enable the microphone, and try one short prompt after collecting a star. The free checks above do not test provider credentials or model access.

## What the 500-attempt allowance means

Each server instance holds its own count, used attempt IDs, and one live-request slot in memory. A voice attempt holds that slot across speech, design, and geometry and may make up to three paid calls. Failed or cancelled dispatched work counts; there are no automatic provider retries.

**This is not a global spending cap.** Several Vercel instances can each accept attempts. Cold starts and redeployments reset their counts and duplicate-ID history. The remaining count can change between requests depending on which instance answers. No database persists or coordinates it.

The app keeps its separate budgets: 8 seconds capture, 10 seconds upload/transcription, and 30 seconds generation. Cancellation does not guarantee already-dispatched provider work is free.

## Web Analytics

The web app mounts `@vercel/analytics/react` once at the app root to count visitors and page views. Vite development runs use Analytics development mode; production builds use production mode.

Enable **Web Analytics** in the Vercel project's **Analytics** tab, then deploy this change and visit the site. Check the dashboard for page views; content blockers can prevent collection. See the [Vercel Web Analytics quickstart](https://vercel.com/docs/analytics/quickstart).

## Troubleshooting

| Symptom | Check or fix |
| --- | --- |
| `framework is set to services, but no services are declared` | Root Directory must be the repository root, where `vercel.json` declares both services. Then redeploy the current commit. |
| `Cannot use import statement outside a module` in `/var/task/app.js` | Deploy the config containing API `entrypoint: "src/vercel.ts"` and `outputDirectory: "."`. This keeps Vercel from mistaking the compiled app factory for the handler. |
| `/api/health` hangs, then fails with `INTERNAL_FUNCTION_INVOCATION_FAILED` | Check the deployment includes the non-blocking listener in `apps/server/src/vercel.ts`. A top-level `await app.listen(...)` deadlocks Vercel's load-then-listen adapter. |
| Game loads, but AI is unavailable | Open health/profiles and inspect function logs first. A crashed API can look like disabled AI. Then check Production-scoped variables and whether you redeployed after saving them. |
| Live request rejected for origin | Use the canonical URL and check `APP_ORIGIN` matches exactly, without a trailing slash. Direct deployment URLs can have a different origin. |
| Preview remains mock-only | Expected: live AI is restricted to production. |
| Provider error after a paid attempt | Use the safe error category and stage in the UI. See [generation diagnostics](prompt-to-mesh-pipeline.md#diagnosing-a-live-failure); do not repeatedly spend attempts to test a configuration error. |

The API's `outputDirectory: "."` is intentional. Vercel CLI 59.11.7 otherwise discovered the TypeScript `dist` folder, selected `app.js`, and relocated it away from its ES-module metadata. Local TypeScript builds still write to `dist`. The checked-in function configuration uses Node 22 through the server package, a 60-second limit, and cancellation support.

## Disable AI, rotate a key, or roll back

Set `HOSTED_LIVE_ENABLED=false` and redeploy to disable live AI on the new deployment. Old deployments retain their old variables; keep their URLs protected. Revoke the provider key if you need to stop new calls across old deployments too. Already-dispatched work may finish and incur charges.

To rotate a key, save its replacement as a Secret, redeploy, then revoke the old key. For rollback, choose a known-good mock-only deployment. Never paste keys or raw provider errors into reports.

## Incident-report operation

The game release also serves `POST /api/race-reports` and `GET /api/race-reports/status`. The status route is a free configuration read. Default and preview environments cannot dispatch live reports, even when keys exist.

Players may separately enable **Include an AI incident report after the race — 1 additional paid call** before a live run. A single request batches one or two final voice creations after every racer lands. It shares the existing live-request slot and consumes one allowance entry. The maximum is six voice calls plus one report generation call per run; reports also use up to two content-screening requests. Failed, cancelled, or rejected work after admission consumes its entry and is not retried.

Optional `REPORT_MODEL` and `REPORT_REASONING` override the configured design model for reports. The output cap is fixed at 1,200 tokens. The server deadline is 12 seconds (up to 2.5 seconds input screening, 7 seconds generation, and 2.5 seconds output screening), with a 15-second client timeout. Requests use `store: false`, no tools, and no SDK retries.

The same in-memory admission gate records report run IDs, attempt IDs, and input fingerprints to reject duplicate runs or changed attempts. This metadata is bounded by the per-instance allowance. Cold starts and separate instances retain the limitations above. Report text and race facts are not persisted or logged by the application. Before a paid writing-quality evaluation, obtain separate authorization; free checks establish integration, not live joke quality.
