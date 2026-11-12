# Voice (builtin)

Speech-to-text for Pi, carried in the Trebol extension pack as a builtin
extension. Press a keyboard shortcut, talk, and the transcript is put straight
into your chat. The microphone is captured locally at 16 kHz mono; the PCM is
sent to the Clover GPU workstation ("spark") for transcription. Audio goes to
spark over the LAN or Tailscale, never to a public cloud. Set
`PI_VOICE_ASR=local` to use the bundled local model instead.

The code is MIT-licensed; its `LICENSE` ships beside this file unchanged. Trebol
carries it as first-party source under `extensions/voice/`, with no Git remote,
submodule or package-publish identity.

## Install

Nothing to install. The extension is part of the pack and loads from the root
manifest's `pi.extensions` list. Its runtime dependencies are declared in this
directory's `package.json` and installed at the repository root (`npm install`).

## Usage

The extension registers:

- a configurable terminal shortcut (`Ctrl+Space` by default) to start and stop recording;
- `/voice`, which does the same as the shortcut. While recording, `Space` also stops and transcribes, and `Escape` discards;
- a `transcribe_file` tool that the agent can use to transcribe local audio or video files;
- `/voice-settings` for preferred languages, model, transcription language, microphone, and shortcut settings.

`/transcribe` remains available as a compatibility alias for `/voice-settings`.

Settings live in `pi-voice.json` in Pi's agent directory, the debug log in
`pi-voice.log` beside it.

## Remote transcription (spark)

Dictation uses spark's Parakeet ASR by default. The local `transcribe-cpp` model
is not loaded in this mode, so transcription does not compete with the
microphone or the laptop's GPU.

| Setting | Default | Meaning |
|---|---|---|
| `PI_VOICE_ASR` | `remote` | `local` restores the previous local backend |
| `PI_VOICE_ASR_LAN_URL` | `http://172.31.1.198:8001` | first endpoint |
| `PI_VOICE_ASR_TAILSCALE_URL` | `http://100.84.178.124:8001` | fallback endpoint |
| `PI_VOICE_ASR_MODEL` | `nvidia/parakeet-tdt-0.6b-v3` | model field for the OpenAI-compatible route |
| `PI_VOICE_ASR_TOKEN` | unset | optional bearer token; the server currently ignores it |
| `PI_VOICE_ASR_PROBE_TIMEOUT_MS` | `5000` | TCP connect budget per endpoint |
| `PI_VOICE_ASR_REQUEST_TIMEOUT_MS` | `120000` | transcription budget per endpoint |

Each endpoint is checked with a plain TCP connect to its host and port, then the
WAV is sent. That connect is deliberately not a `GET /health` gate: the server
answers `/health` only after its GPU work is free, so a healthy but busy server
looked dead. Measured on spark while it admitted one request at a time,
`/health` took p95 1.5 s and over 3 s while transcriptions queued, while a
connect still completed in 55 ms idle and under 1.8 s with the link saturated
by uploads — hence the 5 s budget. An
endpoint that fails moves behind a healthy one and is retried after a backoff
starting at 30 s and doubling to 5 minutes, so an unreachable LAN address costs
its budget once instead of on every take, and a recovered endpoint is preferred
again automatically. A pinned language (`transcriptionLanguage` other than
`auto`) then posts the WAV to `/v1/audio/transcriptions` with `file`, `model`,
`language`, and `response_format=json`. Automatic language uses the native
`/transcribe` route, which detects the language and returns
`{text, words, elapsed_s}`. A failed check or request moves to the next
endpoint. If both fail, the take reports one error naming both attempts; there
is no silent local fallback.

**Network reality:** spark is on `172.31.1.0/24` (LAN `172.31.1.198`), while
this laptop is on `192.168.0.0/24`. The LAN connect therefore fails today; after
one attempt it cools down and every take uses Tailscale. Once the laptop is on
spark's LAN (or a route exists), the same code prefers LAN with no change.
Verify the path with
`node tools/e2e/asr-remote.mjs /tmp/asr16.wav`. The file must be 16 kHz mono
16-bit (the microphone's format); an existing recording can be converted with
`ffmpeg -i input.wav -ar 16000 -ac 1 -c:a pcm_s16le /tmp/asr16.wav`.

The server lives at `/home/swarm/Local/nemo-asr` on spark. It is bound only to
the LAN and tailnet addresses (not `0.0.0.0`) and exposes `/health`,
`/transcribe`, `/v1/audio/transcriptions`, and `/tts`; this plugin uses only the
transcription routes. The working image is `nemo-asr:tts-nltk` (the `nltk`
dependency is needed by the server's TTS route, not by ASR).
The server admits up to `NEMO_MAX_CONCURRENT=10` requests and batches up to 10
queued clips into one lock-held NeMo call (`NEMO_ASR_BATCH_MAX`,
`NEMO_ASR_BATCH_WINDOW_MS=30`), because NeMo's `transcribe()` is not
thread-safe. Batched throughput is only ~1.2–1.4x serial; the gain is that
bursts are admitted and finish together instead of queueing one at a time.

## Tern

In a Tern pane the recording meter, the status line and `/voice` work: Tern's
extension UI accepts the plain-text widget lines this extension paints.
`/voice-settings`, onboarding and the model pickers are `ctx.ui.custom` panels,
which need Pi's own terminal UI, so run them with `pi -nt` (or reuse an existing
`pi-voice.json`). The repository's `AGENTS.md` records the Tern dictation-surface
contract.

## File transcription and FFmpeg

The agent can call `transcribe_file` for local audio or video files. Decoded audio is limited to 512 MiB (about 2.3 hours). File decoding requires the `ffmpeg` executable. Install FFmpeg with your system package manager if you don't already have it installed

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# Windows with winget
winget install Gyan.FFmpeg
```

If FFmpeg is installed outside `PATH`, point the extension at it before starting Pi:

```bash
export PI_VOICE_FFMPEG_PATH=/path/to/ffmpeg
```

The legacy `PI_TRANSCRIBE_FFMPEG_PATH` variable remains supported when `PI_VOICE_FFMPEG_PATH` is not set.

When FFmpeg is unavailable, `transcribe_file` reports platform-specific guidance to the agent. The agent should ask before running a package-manager command. Model setup is still explicit: run `/voice-settings` once in an interactive TUI to choose and, after confirmation, download a local model.

## Working on this extension

```bash
cd extensions/voice
npm run check     # tsc --noEmit over src/ and test/
npm test          # type-check, then the vendored suite via scripts/run-tests.mjs
```

`PI_VOICE_DEBUG=1` turns on the debug log and registers `/voice-onboarding`, which
replays setup.
