# 十日 zehntage-reactor

The minimalist local player that turns anime into your Anki deck.

![screenshot placeholder](docs/screenshot.png)

## Features

- Local library of your video files — nothing leaves your machine except AI lookups
- Hover/click any subtitle word for an instant AI lookup with reading and notes
- One-click Anki cards with video frame, sentence audio, and i+1 example lines
- Whisper-generated Japanese subtitles for raw video, streamed live while transcribing
- AI translation of any track into a synced secondary (blurred-until-hover) line
- Furigana on unknown kanji, with Kanjium pitch-accent marks
- Smart autopause: stop only on lines that contain unknown words
- Pre-study panel: bulk-add the unknown words of the next N minutes
- Hard mode, shadowing loops, per-cue replay, subtitle sync nudging
- Difficulty heat strip on the seek bar, OP/ED skip, condensed-audio export
- Reading mode, full-text transcript search, jimaku.cc subtitle search
- Stats: activity grid, watch time, mining pace, per-episode word coverage

## Hotkeys (short list)

| key | action |
| --- | --- |
| space / f | play–pause / fullscreen |
| ← → / Tab | seek / next dialogue line |
| Shift+→ / Shift+← | next / previous episode |
| a / s | replay cue / shadowing loop |
| u | toggle autopause |
| h / b | hard mode / unblur translation |
| k / x | mark word known / blacklist |
| w / l | pre-study panel / cue sidebar |
| [ ] \\ | subtitle offset −/+/reset |

The Home page in the app lists the full set.

## Install & run

```sh
bun install
bun run build:web
bun run start /path/to/your/library   # opens http://localhost:8417
```

Optional tooling for subtitle generation: `ffmpeg` and `whisper-cli`
(model at `~/models/ggml-medium.bin`), plus a running Anki with AnkiConnect.

## Environment (~/.env)

- `GEMINI_API_KEY` — word lookups, sentence explanations, translation
- `JIMAKU_API_KEY` — optional, jimaku.cc subtitle search
- `ANKICONNECT_URL` — optional, defaults to the local AnkiConnect
- `PORT` — optional server port

## Attribution

- Pitch accent data: [Kanjium](https://github.com/mifunetoshiro/kanjium) (Uros O.), CC BY-SA 4.0
- Word frequency list: Leeds corpus, CC BY
- Icons: [Lucide](https://lucide.dev), ISC
