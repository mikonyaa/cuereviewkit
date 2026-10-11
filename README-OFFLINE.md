# CueReviewKit offline edition

Review source and translated subtitles before delivery.

Unpack the ZIP. With Node.js 24 LTS installed, run from the unpacked folder:

```sh
node serve.mjs --port 0
```

Open the printed `http://127.0.0.1:<port>/` address. The server listens only on loopback; it needs no npm install and does not upload your files. Port 0 chooses a free port without stopping other processes. Ctrl+C stops this server.

Import `examples/source.srt` and `examples/translation.srt`, or your own UTF-8 SRT / supported WebVTT pair. Inspect temporal groups, accept an intentional merge, check number evidence, edit the translation with Preview → Apply, then export a review package. Earlier decisions become stale after a change. Reopen the package in a clean browser session to continue.

`examples/report.html` opens directly via `file://`. The editor requires local HTTP; opening `app/index.html` directly is not supported. No service worker is installed. Recovery is tied to the browser and origin; changing the port creates a different origin. Download a package before changing ports, deleting browser data, or closing a tab with failed recovery.

SRT: numeric identifiers, millisecond timestamps, multiline payload. WebVTT: header, identifiers, millisecond timestamps and NOTE. UTF-8 with optional BOM, LF/CRLF. Only plain text and balanced `<b>`, `<i>`, `<u>` without attributes. Markup is displayed as inert text. STYLE, REGION, X-TIMESTAMP-MAP, settings, inline timestamps, voice/ruby/classes and malformed fragments block corrected export. Original downloads preserve the exact imported bytes.

Limits: 10 MiB and 20,000 cues per track; 20,000 characters per cue; 400,000 lines and 100,000 diagnostics per track; 200,000 materialized edges; package 30 MiB compressed / 60 MiB actually unpacked; 2,000 characters per comment; last 200 history entries. Large alignment graphs stop with an explicit incomplete result. Translation accuracy, meaningful omissions, numbers in words and universal platform compatibility require human review.

Source and full documentation: https://github.com/mikonyaa/cuereviewkit

MIT software. The examples are original synthetic dialogue, not client subtitles. Dependency licenses and font licenses are in THIRD_PARTY_NOTICES.md.
