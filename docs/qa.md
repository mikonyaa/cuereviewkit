# Local release gates and QA

Verified on 2026-10-12 (Asia/Almaty), macOS, Apple M4 with 16 GiB RAM; Node 24.21.0 LTS. Fresh browser profiles/contexts and port-0 loopback servers were owned by this task. No ordinary browser profile, unrelated process, existing repository or global security configuration was changed.

## Gates exercised

- Clean `npm ci`, strict TypeScript, ESLint and production Vite build pass.
- 34 unit tests: precise syntax/spans/byte round trips and NOTE preservation; unsupported format fixtures; 1:n/n:1/n:m, near ties, boundary-touch, zero/reversed duration and union coverage; explicit manual mapping; number/grapheme evidence; all-data stale revisions; current/stale package reconstruction; integrity/schema/base/identity rejection; hostile HTML/JSON, ZIP traversal/bombs/duplicates/symlinks/size lies; request/revision races and actual worker termination.
- 21 real E2E scenarios: 7 shared flows across **Chromium 156.0.8078.4**, **Firefox 157.0**, **Playwright WebKit 27.2**. Includes corrected downloads, closing the original page, clean-context package reopening, standalone file reports, hostile HTML, rejected malformed packages preserving active work, blocked corrected export for STYLE, invalid edit drafts, keyboard, mapping/config changes, two-tab conflicts, forced quota/transaction failure, successful recovery, empty pairs and RTL/CJK/long text at 1440/1024/390 px.
- Final production ZIP is unpacked in a fresh OS temp directory outside the source workspace. Its own `serve.mjs` starts with Node alone. Path traversal is rejected; a `/cuereviewkit/` mount hard refresh works; import → legal merge → number edit → stale → export → clean-context reopen → file report passes. No source code or node_modules are inside that ZIP. CI repeats these artifact checks; the release manifest identifies the exact successful push run and archive hash.
- Original synthetic demo has independent expected ordinals and 240/239 cue arithmetic. Additional corpus: 10 pairs, 1,500 source + 1,400 target cues. These are fixtures, not external human validation.

## Measured local performance

Single runs of synthetic pairs; these numbers are not a general browser benchmark:

| Cues | Case | Import/analysis/render elapsed | Largest main-thread timer gap | Approximate main-thread JS heap | Result |
| --- | --- | --- | --- | --- | --- |
| 5,000 + 5,000 | separate intervals | 853 ms | 63.3 ms | 15.9 MiB | complete |
| 20,000 + 20,000 | separate intervals | 1351 ms | 120.4 ms | 69.8 MiB | complete |
| 20,000 + 20,000 | fully overlapping | 1842 ms | 137.8 ms | 97.9 MiB | incomplete, edge cap |

The dense case creates no more than 200,000 overlap edges. Opening the giant component took 102 ms and materialized 60 cue blocks with explicit pagination. Cancel during a heavy track replacement retained the previous imported translation and terminated the owned worker. The interval monitor remained active during computation. `performance.memory` is a non-standard Chromium estimate of main-thread JS heap, **not total browser or worker memory/RSS**. [Raw measurement/method](qa/performance.json).

## Real visual evidence

[Desktop/RTL 1440](qa/screenshots/rtl-chromium-1440.png), [1024](qa/screenshots/rtl-chromium-1024.png), [mobile/RTL 390](qa/screenshots/rtl-chromium-390.png), [long mobile text](qa/screenshots/long-chromium-390.png), [actual parsing error](qa/screenshots/parsing-error-1440.png). Screenshots were captured from the real production app and inspected. No screenshot was synthesized. The UI keeps timecodes left-to-right, isolates directional text and has visible focus/explicit status labels.

The real Chromium recording is approximately 22 seconds and shows import, intentional merge approval, unmatched interval, 100→1000 evidence and report export: [video](demo/review-flow.webm), [frames/method](demo/sequence.json), [downloaded demo report](demo/reviewer-report.html).

## Practical limits

Playwright WebKit is not physical Safari, and no physical iOS/Android device was tested. No complete WCAG certification, external translator pilot, semantic precision, time saved or customer feedback is claimed. No video playback, ASS/SSA, semantic grading, translation generation or collaborative history merge. Unsupported input and resource limits remain visible instead of silently changing files. Public CI/Pages/Release availability is established by the live release checks and manifest, rather than this local QA note alone.
