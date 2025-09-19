# DesktopTranscriber

DesktopTranscriber is an Electron-based macOS app that captures audio from the microphone, transcribes it with OpenAI Whisper models, and automatically answers any questions detected in the transcript. Live transcription runs while you speak and each finished recording is saved to a scrollable history for quick reference.

## Features

- One-click recording with live transcription streamed via OpenAI Realtime (automatic fallback to chunk polling)
- Final transcript persisted locally with timestamps and titles
- Automatic question detection and concise answers via OpenAI Responses API, enriched with an optional 25k-character knowledge base
- Export saved transcripts to text or JSON and re-run answers with the latest knowledge
- In-app API key management stored safely on the device (localStorage)
- macOS bundle packaging via `@electron/packager`

## Getting Started

```bash
# install dependencies
npm install

# run in development mode
npm start

# build a macOS .app bundle
npm run package:mac
```

Set your OpenAI key either as an environment variable before launching:

```bash
export OPENAI_API_KEY="sk-..."
```

or paste it into the app's API key field after the window loads. You can also paste up to 25,000 characters of
background material into the Knowledge Base panel so follow-up answers leverage your notes. Export your transcript
history from the Saved Transcripts section if you need to archive or share results.

## Packaging Output

The packaging script writes to `dist/DesktopTranscriber-darwin-<arch>/DesktopTranscriber.app`. Copy that `.app` anywhere on your system to distribute builds.

## License

MIT
