# zehntage-reactor — design

Language Reactor-style local video player for language learning (primarily JP),
companion to the zehntage-chrome extension. `zehntage-reactor file.mkv` → local
server → Chrome tab with the player.

## User story

1. `zehntage-reactor file.mkv` in a terminal.
2. Chrome tab opens: minimal player UI + settings page + media collection
   (files in the launch directory, recursive).
3. Video plays; target-language (JP) subtitles shown above the video bottom,
   each word a hoverable span; words currently being learned highlighted
   (red → green gradient by Anki learning progress when available).
4. Hover over a word → floating panel (zehntage-chrome style): translation,
   notes, Add-to-Anki. The Anki card includes the current video frame
   (small, ~320px wide), sentence context, Gemini notes, episode+timestamp.
5. Below: known-language (RU/EN) subtitle line, blurred; unblurs on hover.
6. `zehntage-reactor subtitle ja file.mkv` — generate JP subs via whisper-cli
   and save sidecar SRT. `zehntage-reactor subtitle ja ru file.mkv` — also
   produce RU track by Gemini-translating the JP transcript (batch-cheap).
   In-player: same generation available on demand ("on the fly"), with
   progressive display as whisper emits segments.

## Decisions (from user)

- Stack: Bun + TypeScript + React + shadcn/ui, black-and-white clean default
  style. Project at ~/dev/zehntage-reactor, installable bin (`bun link` +
  install step).
- MKV streams directly: Chrome plays h264+Vorbis Matroska via plain HTTP
  Range requests (verified on the user's machine). ffprobe each file; if
  codecs unsupported (Hi10P/HEVC) fall back to on-the-fly ffmpeg remux
  (`-c:v copy`/transcode to fMP4, seek via `?t=` server-side like Jellyfin).
- Subtitles NEVER burned in: extracted/parsed server-side, rendered as HTML.
- Secrets from `~/.env` (GEMINI_API_KEY, ZEHNTAGE_ANKI_URL, ZEHNTAGE_ANKI_KEY)
  — server reads them and proxies; never asked for in the browser.
- Words go to the same anki-mcp `/zehntage/*` endpoints (mixed DE/JP list is
  fine). Progress-gradient via new `/zehntage/progress` endpoint (separate
  background agent is designing the server patch; falls back gracefully).
- JP tokenization client-side or server-side with a kuromoji-class analyzer;
  each token becomes a span. Gemini prompt adapted from zehntage-chrome
  background.js: drop article, add `reading` (kana) field; translations into
  Russian (matching the extension's convention).
- Collection = launch directory, recursive.

## Architecture

```
bin/zehntage-reactor (Bun)         — CLI: parse args, start server, open tab
server/ (Bun.serve)
  GET  /                            player SPA (built React)
  GET  /api/library                 video files under launch dir
  GET  /media/<id>                  Range-served raw mkv (or ffmpeg remux)
  GET  /api/subs/<id>               available sub tracks (embedded+sidecar)
  GET  /api/subs/<id>/<track>       parsed cues as JSON [{start,end,text}]
  POST /api/whisper/<id>            start whisper job; SSE progress with
                                    partial cues; saves sidecar .srt
  POST /api/translate/<id>/<track>  Gemini-translate cues → new track (saved)
  POST /api/lookup                  word+context → Gemini (prompts ported)
  POST /api/anki/add                + grabs frame via ffmpeg at timestamp,
                                    downscales (~320px), uploads, adds card
  GET  /api/anki/words              proxied /zehntage/list (+progress merge)
  GET/POST /api/settings            UI prefs (~/.config/zehntage-reactor/)
web/ (React+shadcn, Vite or Bun bundler)
  Player page: <video> + sub overlay (token spans, gradient highlight,
    hover panel) + blurred secondary sub line
  Library page, Settings page
```

Subtitle parsing: ffmpeg extracts embedded tracks → SRT; sidecar .srt/.ass/.vtt
parsed to cues (ASS: text+basic tags only). Active cue lookup by binary search
on the client against the JSON cue list (no <track> element).

Frame capture: server runs `ffmpeg -ss <t> -i file -frames:v 1 -vf scale=320:-1`
at Add time — frame never round-trips through the browser.

Whisper: same ggml-medium model at ~/models/ggml-medium.bin; one job at a time
(12 threads); jobs queued; cancelable.

## Testing

Unit tests (bun test) for cue parsing, tokenizer wrapping, library scan,
.env loading. Manual end-to-end in Chrome deferred until the user is around
(Chrome automation needs their permission); a smoke script curls every
endpoint against a real mkv from the Hyouka directory.
