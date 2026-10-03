# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Commands

```sh
npm run dev                       # run the CLI from source (./src/cli.js)
npm run typecheck                 # tsc --noEmit
npm test                          # node --test, runs all tests in test/
node --test test/server-startup.test.js   # run a single test file
node --test --test-name-pattern="warmup" test/whiteboard-session.test.js  # filter by test name
npm run build:moonshine-sidecars  # build Python -> single-binary sidecars for macOS arm64+x64
node ./scripts/build-moonshine-sidecars.js darwin-arm64   # build only one target
```

There is no separate lint step. CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run typecheck`, and `npm test` on Node 24.

The `--no-open` flag suppresses auto-launching the browser, which is useful when iterating from a terminal.

## Architecture

The product is a single Node process that serves a static Excalidraw frontend, runs an STT pipeline, and orchestrates an LLM agent that edits the whiteboard via tool calls. The end-to-end loop is:

```
browser mic -> WS audio frames -> transcription provider -> turn queue ->
runWhiteboardAgent (in src/server.js) -> tool call ops -> apply to scene ->
broadcast whiteboard:update over WS -> frontend re-renders Excalidraw
```

### Entry points and wiring

- `src/cli.js` parses args, loads `~/.config/autopreso/settings.json` via `settings-store.js`, resolves an agent provider, then calls `startServer`.
- `src/server.js` is the central hub. It owns the Express + WebSocket server, mounts the static frontend in `public/`, instantiates a `WhiteboardSession`, builds a `TranscriptionManager`, and exposes `runWhiteboardAgent` / `runWhiteboardWarmupOnce` which contain the system prompt and the AI SDK `tool({...})` definitions. `server.js` is large (~1000 LOC) on purpose - keep the agent prompt, message construction, and tool schemas colocated.
- `public/app.js` is the React frontend. It renders Excalidraw, handles mic capture at 24 kHz, sends audio frames over WS, periodically pushes downscaled screenshots back to the server (`whiteboard:screenshot`), and reflects server-pushed scene updates back into Excalidraw. Scene and viewport updates received before Excalidraw is ready are retained and applied when its API arrives. Frontend is plain ES modules loaded via `<script type="importmap">` from esm.sh - no build step.
- `src/session-cost.js` tracks per-session agent token usage and transcription audio seconds. `server.js` records agent usage after warmup/turn calls using SDK `totalUsage` across all tool-call steps (falling back to `usage`), records transcription audio as frames arrive, broadcasts `cost` over WS, and resets the tracker on Start Preso and session reset. OpenAI rates and xAI Streaming STT's $0.20/hour estimate are built in; xAI agent rates come from `src/xai-models.js`.

### Two-mode session model (`src/whiteboard-session.js`)

The session has two modes that are NOT symmetric:

- **`staging`** - client-side scratchpad. The server does not track elements in this mode; the frontend owns them. Used to seed the canvas with reference content before going live.
- **`live`** - the server owns `state.elements` as the source of truth. Audio and screenshots flow into the server, which applies agent edits and broadcasts updates. The frontend syncs user edits only while listening is stopped, using the current Excalidraw scene at send time (including an empty scene after deleting everything); incoming server updates cancel pending user syncs and update the sync hash to avoid echoes.

Transitions: `POST /api/preso/start` builds a "staging primer" message (current scene snapshot + downscaled screenshot when staging is non-empty), extracts staging text/labels as transcription keywords, snapshots saved Agent instructions for the whole preso, resets session cost, and kicks off the warmup loop. `POST /api/preso/back-to-staging` returns to client-owned mode and clears the transcription keywords; `POST /api/session/reset` also clears them and resets session cost.

Audio messages carry a browser-generated `sessionId`; `stop` clears that connection's active audio ID so later frames with the old ID are ignored. It flushes transcription, waits `DEFAULT_STOP_DRAIN_MS` (3500 ms, overridable with `startServer({ stopDrainMs })`), then awaits `state.idle()` so final transcripts and queued agent edits can finish before ending the session. The 3500 ms interval is not a total shutdown deadline. Reset, back-to-staging, and Start Preso invalidate the session token immediately; the delayed stop only ends the token it captured if it is still current. `endSession()` clears pending/buffered transcript chunks and invalidates in-flight tool execution and history updates; cost still records usage already incurred.

### Warmup loop

Before the user speaks, `startWarmupLoop` repeatedly fires the agent against the staging primer and the Agent instructions snapshot with exponential backoff (`DEFAULT_WARMUP_DELAYS`, max 8 attempts). Its purpose is **prompt cache priming**: after the loop ends, `agentHistory` is forced to `[warmup_user_msg, assistant("UNDERSTOOD")]` so every subsequent turn reuses the same prefix bytes. Do not change this primer-then-fixed-history pattern or the per-preso instructions snapshot without understanding the cache implications.

### Transcript turn queue (`src/transcript-turn-queue.js`)

The live session uses a 250 ms queue debounce and a 1200 ms max wait, normalized in `src/transcript-latency.js` and configurable through `settings.latency` or the Latency editor for every STT provider. Debounce is clamped to 0–5000 ms and max wait to 100–10000 ms. OpenAI Realtime uses `src/openai-transcription.js` delta-quiet flushing, Moonshine emits per-chunk commits, and xAI commits final speech segments before they enter this queue.

`isReadyTranscriptTurn` in `whiteboard-session.js` holds short fragments until they have terminal punctuation, a recognized direct canvas command (primarily French), at least eight words, or at least six words across multiple chunks. Max wait force-flushes a batch even if it fails this predicate; `isTrivialTranscript` still skips filler-only turns, including French fillers. While a turn runs, ready batches are buffered and concatenated for the next turn, so only one agent turn is in flight. Max wait bounds batching, not time spent waiting for an active agent or warmup.

The queue's `configure({ debounceMs, maxWaitMs })` updates timing and restarts pending timers; `clear()` drops pending/buffered text and timers without cancelling the running turn; `idle()` force-flushes pending text and waits for all turns. `state.setTranscriptTurnTiming()` applies normalized timing on settings reload without rebuilding transcription.

### Whiteboard edit model (`src/whiteboard-tools.js`)

The agent does not see Excalidraw JSON directly; it sees a **line-numbered text view** of the scene (`formatLineNumberedWhiteboard`) and emits `replace`, `insert_after`, or `delete` operations against line numbers. `applyWhiteboardEditOperations` validates and applies them in order. When changing the agent's contract, update both the tool schema in `server.js` and this applier, and add a test in `test/whiteboard-tools.test.js`.

### Agent providers (`src/agent-provider.js`, `src/codex-auth.js`)

Four providers, all routed through the `@ai-sdk/openai` adapter:

- **openai** - direct API key, with configurable OpenAI-compatible API base URL.
- **xai** - direct xAI API key, using Chat Completions at a configurable base URL (default `https://api.x.ai/v1`), with default model `grok-4.3` and reasoning effort `none`. Its SDK options must use `providerOptions.openai` even though the adapter is named `xai`; this sends `parallel_tool_calls: false` and the resolved `reasoning_effort` on the wire.
- **codex** - reads the user's Codex CLI auth from `~/.codex/auth.json`, then talks to the ChatGPT backend with that bearer token. No API key needed.
- **ollama** - OpenAI-compatible local endpoint (`http://localhost:11434/v1`).

`reasoningEffort` is validated against the set `{none, low, medium, high, xhigh}`. For xAI, `resolveXaiReasoningEffort` then selects the first supported level at or above the request in that order, falling back to the catalog's first supported level if none is high enough. It omits the parameter for unknown models or models with no advertised reasoning control. The built-in catalog maps `grok-4.7`'s `none` to `low` and omits the parameter for `grok-build-0.1` and its listed aliases.

### xAI model catalog (`src/xai-models.js`)

The process-wide, in-memory catalog supplies IDs, aliases, reasoning capabilities, and agent prices. `refreshXaiModelCatalog` fetches `{agent.xai.baseURL}/language-models` using the saved xAI key (or `XAI_API_KEY`) with a 5-second timeout. A successful, non-empty response replaces the catalog; a failed refresh or missing key retains the current list. The built-in list is used until the first successful refresh. Startup refresh is asynchronous and only runs when a settings store selects xAI as the agent, so initial calls can still use the fallback.

`GET /api/agent/xai/models` refreshes the catalog and returns `{ source: "api" | "fallback", models: [{ id, reasoningEfforts }] }`, without prices, aliases, or keys. The xAI Agent editor calls this endpoint on opening/selecting xAI, keeps a saved model selectable if it is absent, and shows the model's advertised reasoning choices. There is no periodic refresh; reopen the editor after saving a changed key or base URL. Pricing fields are converted from xAI's units by dividing by 10,000 to obtain USD per million tokens; missing cached-input prices use the input rate. Cost tracking resolves aliases but does not model context-length pricing tiers.

### Transcription providers

- **Moonshine (default, local)** - `src/moonshine-transcription.js` spawns the platform-specific binary at `@autopreso/moonshine-<platform>/bin/autopreso-moonshine` (declared as **optional** dependencies; the install just skips on unsupported platforms). The binary is built from `scripts/moonshine-sidecar.py` via PyInstaller; only macOS arm64/x64 are currently packaged.
- **OpenAI Realtime** - `src/openai-transcription.js` opens a WSS connection to `wss://api.openai.com/v1/realtime?intent=transcription` and streams PCM frames.
- **xAI Streaming** - `src/xai-transcription.js` connects to `wss://api.x.ai/v1/stt` using the shared xAI key, sends binary PCM16 at 24 kHz after `transcript.created`, and requests interim results with language `en` by default, `smart_turn=0.7`, and a configurable 1200 ms timeout (clamped to 300–5000 ms). Staging keywords become `keyterm` query parameters (up to 100, each capped at 50 characters); changing them detaches the socket so the next connection uses the new context. `transcript.partial` drives captions, `speech_final` commits turns, and `transcript.done` reconciles uncommitted text using audio ranges/word timings or a conservative text-prefix fallback to avoid replay. Stop flushes the latest partial and sends `audio.done`; resumed audio opens a fresh socket. The agent's Base URL does not change this STT endpoint.

The active provider is hot-swappable: `applyCurrent()` in `server.js`'s `createTranscriptionManager` rebuilds the instance when the effective provider, model, active API key, or xAI language/timeout changes, without restarting the server. Unrelated or unchanged settings do not reconnect it. Any active session context is reapplied to the new provider; queue latency changes are applied independently.

### Settings store (`src/settings-store.js`)

Persists to `~/.config/autopreso/settings.json`, including `agentInstructions` validated at 100,000 characters, `agent.xai`, `transcription.xai`, `latency`, and the shared `apiKeys.xai`. Existing files are merged over defaults on load, so older files gain the new fields without reselecting providers. The store's `getSanitized()` strips API keys and reports `hasOpenAIKey` / `hasXAIKey` for saved credentials - always use it for outbound settings payloads.

Provider and latency env vars (`OPENAI_*`, `XAI_*`, `OLLAMA_*`, `CODEX_MODEL`, `CODEX_BASE_URL`, `AUTOPRESO_TRANSCRIPT_TURN_*`) **seed** the file on first run. Agent detection prefers Codex auth, then `OLLAMA_MODEL`, then `XAI_API_KEY`, then OpenAI; STT prefers an OpenAI key, then an xAI key, otherwise Moonshine. Afterward, saved settings win, but empty saved OpenAI/xAI keys still fall back to their environment values at runtime. `CODEX_HOME` continues to locate CLI auth. Settings are cached: use the settings API/UI for live updates, or restart after editing the file. See README for the environment variable reference.

## Testing conventions

Tests use Node's built-in test runner (`node:test`) and live in `test/*.test.js`. They are not bundled into a framework - assertions are `node:assert/strict`, mocks are hand-rolled. Server tests in `test/server-startup.test.js`, `test/staging-mode.test.js`, etc. inject fakes for `generateTextFn`, `streamTextFn`, and `createTranscription` via `startServer({...})` options - prefer this pattern over network-touching tests. For xAI catalog requests inject `fetchFn` and reset the process-wide catalog with `resetXaiModelCatalog()` after tests that change it. `test/xai-wire.test.js` captures SDK request bodies without network access. The Chrome-driven tests (`test/browser-smoke.test.js`, `test/xai-browser.test.js`) boot the real server; the xAI test uses fixture APIs by default. See CONTRIBUTING for browser and opt-in live xAI checks.

Per the user's global instructions, use **TDD** for bug fixes and new features: write the failing test first.

## Whiteboard agent system prompt

The system prompt and tool schemas are defined inline in `src/server.js` (search for `buildWhiteboardAgentMessages` and the `tool({...})` calls). Its structure is `P1-P10` cross-cutting principles + short per-genre stubs. Do **not** append verbose "When the talk is X..." paragraphs - that bloat was already consolidated once. See `scripts/simulate-whiteboard-agent.md` for the full editing rubric and the `simulate-whiteboard-agent.js` harness used for prompt A/B experiments.

The per-turn canvas task also requires a first visual on an empty board for substantive speech. For xAI only, `runWhiteboardAgent` additionally forces `whiteboard_apply` on step 0 when `state.elements` is empty and the transcript is nontrivial; subsequent steps choose tools normally. Warmup is unaffected.

## Release process

This repo uses **release-please** in **monorepo manifest mode** (`.github/workflows/release-please.yml`, `release-please-config.json`, `.release-please-manifest.json`).

Two components version independently:

- **`autopreso`** (root, `.`) - the CLI npm package. Bumps on any conventional commit _except_ those touching the sidecar paths (`packages/moonshine-darwin-*`, `moonshine-sidecar.config.json`, `scripts/moonshine-sidecar.py`, `scripts/build-moonshine-sidecars.js`).
- **`moonshine-sidecars`** (`packages/moonshine-darwin-arm64`) - the platform sidecar npm packages. Bumps **only** when commits touch the sidecar paths above. The arm64 package is the release-please anchor; its version is mirrored into `packages/moonshine-darwin-x64/package.json` and into both `optionalDependencies` entries in the root `package.json` via `extra-files`. The two sidecar packages always share one version.

Workflow consequences:

- A typical change to `src/`, `public/`, or `test/` only bumps autopreso. The publish job for the sidecar group is skipped, so CI never runs the Python/PyInstaller build path on a regular release.
- A change to `moonshine-sidecar.config.json` (e.g. bumping `moonshineVoiceVersion`) bumps the sidecars. CI will then build the Python sidecar binaries on `macos-15` (required by recent `moonshine-voice` wheels, which target `macosx_15_0_universal2`) and publish both `@autopreso/moonshine-darwin-{arm64,x64}` packages.
- A commit that touches both kinds of paths bumps both components in a single release-please PR.

Other notes:

- `CHANGELOG.md` and `.release-please-manifest.json` are auto-generated. Per global rules, never hand-edit them.
- Sidecar binaries are produced by `scripts/build-moonshine-sidecars.js` and must be built on macOS (the script enforces this).
- `scripts/prepare-release-packages.js` is now a verification step: it confirms each sidecar's `package.json` version matches the root `optionalDependencies` entry and that the binary exists. Version writing is owned by release-please's `extra-files`, not this script.
- The published-on-npm sidecar version may lag autopreso; that's by design (pinning the same binary keeps users from re-downloading on every CLI patch).

## Project status (from README)

The project is in **alpha**. The README's prominent warning is intentional - keep the rough-edges framing rather than over-promising stability when editing it.
