# Voice (builtin)

Local speech-to-text for Pi, carried in the Trebol extension pack as a builtin
extension. Press a keyboard shortcut, talk, and the transcript is put straight
into your chat. Audio never leaves the machine: the model runs locally through
`transcribe-cpp`.

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
