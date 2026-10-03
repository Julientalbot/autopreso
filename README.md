<h1 align="center">autopreso</h1>

<p align="center">
  <a href="https://github.com/kunchenguid/autopreso/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/autopreso/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/kunchenguid/autopreso/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/kunchenguid/autopreso/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://www.npmjs.com/package/autopreso"><img alt="npm" src="https://img.shields.io/npm/v/autopreso?style=flat-square" /></a>
  <a href="https://img.shields.io/badge/platform-macOS-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS-blue?style=flat-square" /></a>
  <a href="https://x.com/kunchenguid"><img alt="X" src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square" /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"><img alt="Discord" src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord" /></a>
</p>

<h3 align="center">Let the whiteboard whiteboard itself.</h3>

<p align="center">
  <img src="https://raw.githubusercontent.com/kunchenguid/autopreso/main/assets/autopreso.png" alt="autopreso whiteboard hero screenshot" width="960" />
</p>

> [!WARNING]
> autopreso is in **alpha** and under active development. Expect rough edges, breaking changes, and the occasional weird drawing. Bug reports welcome.

You wanted to give the talk, not build the deck.

autopreso runs a local web app with a live Excalidraw canvas and a listening agent.
You speak; transcripts stream to a model; the model draws, labels, and rearranges the whiteboard in real time.
Stage a few seed elements, hit start, and present.

- **Hands free** - your speech drives an agent that edits an Excalidraw scene as you talk, no clicking required.
- **Bring your own model** - use your OpenAI or xAI API key, or your Codex subscription. Auto Preso itself is completely free and open source.
- **Can run locally** - use Moonshine for transcription and Ollama for the agent and you get a fully local setup.

## Quick Start

```sh
$ npx autopreso              # boots the server, opens the browser
autopreso listening at http://127.0.0.1:3210

# In the browser:
# 1. Drop reference materials onto the staging canvas (title, agenda, etc).
# 2. Pick your microphone, transcription model, agent model, and optional Agent instructions.
# 3. Click "Start Preso", then "Start Talking" when warmup finishes.
```

## Install

**npm (recommended)**

```sh
npm install -g autopreso
autopreso
```

**npx (no install)**

```sh
npx autopreso
```

**From source**

```sh
git clone https://github.com/kunchenguid/autopreso.git
cd autopreso
npm install
npm start
```

## How It Works

```
  ┌──────────┐   audio    ┌──────────────┐   text   ┌──────────────┐
  │   mic    │──────────► │     STT      │────────► │  whiteboard  │
  │ (browser)│   24kHz    │ Moonshine /  │ chunks   │    agent     │
  └──────────┘            │ OpenAI WS /  │          │ (OpenAI /    │
                          │ xAI STT      │          │  xAI / Codex │
                          └──────────────┘          │  / Ollama)   │
                                                    └──────┬───────┘
                                                           │ tool calls
                                                           ▼
                                                  ┌────────────────┐
                                                  │   Excalidraw   │
                                                  │  scene (live)  │
                                                  └────────────────┘
```

- **Two modes** - "staging" lets you sketch seed content client-side; "live" hands the canvas over to the agent, biases OpenAI Realtime or xAI Streaming transcription toward staging text and labels, and starts streaming transcripts.
- **Local server** - the Express + WebSocket server binds to 127.0.0.1; the browser endpoint is only reachable on your machine.
- **Persistent settings** - models, API keys, STT engine choices, and Agent instructions live in `~/.config/autopreso/settings.json` and survive restarts.
- **Warmup loop** - after you hit start the agent primes itself against your staging content and Agent instructions so the first sentence you say doesn't get a cold model.
- **Stop listening** - Stop ends microphone capture, then the server allows 3.5 seconds for final transcripts and waits for queued agent turns to finish. The canvas can still update during this drain; returning to staging or resetting cancels the old session's pending edits.

## CLI Reference

| Command        | Description                                  |
| -------------- | -------------------------------------------- |
| `autopreso`    | Start the local server and open the browser. |
| `autopreso -h` | Show help.                                   |

### Flags

| Flag         | Description                                   |
| ------------ | --------------------------------------------- |
| `--no-open`  | Start the server without opening the browser. |
| `-h, --help` | Show help.                                    |

## Configuration

Settings persist at `~/.config/autopreso/settings.json` and are managed from the in-app status panel.
Agent instructions are saved automatically from staging, can be up to 100,000 characters, and take effect on the next Start Preso.
The live Session cost card estimates agent token costs across all tool-call steps and warmup attempts, plus cloud transcription audio costs for the current presentation, resetting on Start Preso or session reset.
OpenAI prices use the built-in June 2026 rate table. xAI agent prices use the model catalog described below; xAI Streaming STT uses a separate built-in estimate of $0.20 per hour of audio sent. Local providers show `$0.0000`, Codex shows token volume because it routes through your subscription, and unknown models show `n/a`.

### xAI agent and transcription

For a new installation, set `XAI_API_KEY` before launching `npx autopreso`. For an existing installation, select **xAI** in the Agent row and/or **xAI Streaming** in the STT engine row, then enter the key and save. Both use the same saved `apiKeys.xai` key, but the two providers are selected independently. The agent defaults to `grok-4.3`; STT defaults to language `en`, which you can change in its Language selector (for example, `fr`). The agent Base URL defaults to `https://api.x.ai/v1` and also controls model discovery; STT always connects to `wss://api.x.ai/v1/stt`.

The xAI model list, agent prices, and supported reasoning levels come from `{agent.xai.baseURL}/language-models`. The server refreshes the catalog in the background at startup when xAI is the saved agent provider, and when the xAI Agent editor opens. Reopen that editor after saving a new key or Base URL to refresh the list.

Until a refresh succeeds, it uses a built-in catalog of `grok-4.3`, `grok-4.7`, and `grok-build-0.1` (including aliases such as `grok-code-fast-1`). A failed refresh keeps the last successful in-memory catalog, or the built-in catalog if none has succeeded. Newly discovered models appear without a code change, and the saved model remains selectable even if absent from the catalog. Cost estimates use the catalog's base token rates without modeling context-length pricing tiers.

`agent.xai.reasoningEffort` defaults to `none` for low latency. The Reasoning selector offers the selected model's advertised levels and hides when none are advertised. Before sending a request, the server adjusts an unsupported choice using the catalog; with the built-in catalog, `grok-4.7` maps `none` to `low`, while `grok-build-0.1` and unknown models omit `reasoning_effort` entirely.

### Latency

The Latency row saves these settings and applies them without restarting the server:

| Control | Settings field | Default | Range | Effect |
| ------- | -------------- | ------- | ----- | ------ |
| STT timeout (ms) | `transcription.xai.smartTurnTimeoutMs` | `1200` | `300`–`5000` | xAI's end-of-turn timeout; only shown for xAI STT. Saving a changed value reconnects STT. |
| Debounce (ms) | `latency.transcriptTurnDebounceMs` | `250` | `0`–`5000` | Coalesces bursts of committed transcript chunks for every STT provider. `0` removes the debounce delay. |
| Max wait (ms) | `latency.transcriptTurnMaxWaitMs` | `1200` | `100`–`10000` | Flushes an accumulated transcript even when it is too short to pass the readiness check. |

Values are rounded to whole milliseconds and clamped to these ranges when applied. Short, unfinished fragments may wait for more content even with debounce set to `0`; filler-only turns are skipped. Max wait bounds transcript batching, not STT processing or model response time: only one agent turn runs at a time, so a busy agent can add more delay.

### Defaults on first run

When no settings file exists, autopreso picks providers based on what it finds in your environment:

| You have...                                | Agent provider                 | Transcription              |
| ------------------------------------------ | ------------------------------ | -------------------------- |
| Nothing                                    | OpenAI `gpt-5.5` (needs a key) | Moonshine `medium` (macOS) |
| `OPENAI_API_KEY` in env                    | OpenAI `gpt-5.5`               | OpenAI Realtime            |
| `XAI_API_KEY` in env                       | xAI `grok-4.3`                 | xAI Streaming STT          |
| Codex CLI signed in (`~/.codex/auth.json`) | Codex `gpt-5.5-fast`           | Moonshine `medium`         |
| Codex CLI signed in + `OPENAI_API_KEY`     | Codex `gpt-5.5-fast`           | OpenAI Realtime            |
| `OLLAMA_MODEL` set                         | Ollama (your model)            | Moonshine `medium`         |

Auto-detection precedence: **Codex CLI auth wins over `OLLAMA_MODEL` wins over `XAI_API_KEY` wins over `OPENAI_API_KEY`** for the agent. Transcription flips to OpenAI Realtime any time an OpenAI key is present, otherwise xAI Streaming STT when an xAI key is present, otherwise Moonshine. After first run, this auto-detection no longer applies - change providers from the in-app status panel.

### Environment variables

Provider and latency variables seed `settings.json` on first run. Once the file exists, saved settings win; use the in-app panel, or edit the file and restart. `OPENAI_API_KEY` and `XAI_API_KEY` also serve as runtime fallbacks when the corresponding saved key is empty, without changing the selected providers. `PORT`, `CODEX_HOME`, and log path variables are read on each process start.

| Variable               | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| `PORT`                 | Port to listen on. Default: `3210`.                   |
| `OPENAI_API_KEY`       | Seeds the OpenAI key for both agent and Realtime STT. |
| `OPENAI_MODEL`         | Seeds the OpenAI agent model.                         |
| `OPENAI_BASE_URL`      | Seeds the OpenAI agent API base URL.                  |
| `OPENAI_REASONING_EFFORT` | Seeds the OpenAI reasoning effort (also used by Codex): `none`, `low`, `medium`, `high`, or `xhigh`. Default: `low`. |
| `XAI_API_KEY`          | Seeds the xAI key for both agent and Streaming STT.   |
| `XAI_MODEL`            | Seeds the xAI agent model.                            |
| `XAI_BASE_URL`         | Seeds the xAI agent and model catalog API base URL. Default: `https://api.x.ai/v1`; does not change the STT endpoint. |
| `XAI_REASONING_EFFORT` | Seeds the xAI agent reasoning effort: `none`, `low`, `medium`, `high`, or `xhigh`. Default: `none`; adjusted or omitted using the model catalog before sending. |
| `XAI_STT_LANGUAGE`     | Seeds the xAI STT language code. Default: `en`.       |
| `XAI_STT_SMART_TURN_TIMEOUT_MS` | Seeds xAI STT end-of-turn timeout. Default: `1200`. |
| `AUTOPRESO_TRANSCRIPT_TURN_DEBOUNCE_MS` | Seeds transcript-to-agent debounce. Default: `250`. |
| `AUTOPRESO_TRANSCRIPT_TURN_MAX_WAIT_MS` | Seeds transcript-to-agent max wait. Default: `1200`. |
| `CODEX_MODEL`          | Seeds the Codex model.                                |
| `CODEX_BASE_URL`       | Seeds the Codex backend URL. Default: `https://chatgpt.com/backend-api/codex`. |
| `CODEX_HOME`           | Codex CLI auth directory. Default: `~/.codex`.         |
| `OLLAMA_MODEL`         | Seeds the Ollama model.                               |
| `OLLAMA_BASE_URL`      | Seeds the Ollama API base URL. Default: `http://localhost:11434/v1`. |
| `AUTOPRESO_CACHE_LOG`  | Cache usage log path. Default: `~/.config/autopreso/logs/cache.log`. |
| `AUTOPRESO_DEBUG_LOG`  | Agent debug log path. Default: `~/.config/autopreso/logs/debug.log`. |

Local Moonshine transcription ships as an optional native sidecar for `darwin-arm64` and `darwin-x64`. On other platforms, choose OpenAI Realtime or xAI Streaming in the STT panel.

## Credits

- [Excalidraw](https://github.com/excalidraw/excalidraw) - the whiteboard canvas, scene model, and rendering.
- [Moonshine](https://github.com/moonshine-ai/moonshine) the local speech-to-text model that makes the offline path possible.
- [xAI](https://docs.x.ai/) - Grok text models and streaming speech-to-text.
- [Vercel AI SDK](https://github.com/vercel/ai) - tool-calling agent loop and provider abstraction.

## Development

```sh
npm install                       # install deps
npm run dev                       # run the CLI from source
npm run typecheck                 # tsc --noEmit
npm test                          # node --test
npm run build:moonshine-sidecars  # build the Python sidecar binaries
```
