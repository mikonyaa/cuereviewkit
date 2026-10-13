# Review-state fixes: local verification, 2026-10-14

The isolated branch fixes CR-1 through CR-4 against audited main `d57fa8acbe2436268233e1e3199cd8fb9e29c238`. No parser/alignment rewrite, package schema change, dependency upgrade or external service was introduced. Public release/tag/Pages assets were not changed.

## Decision and draft policy

The acceptance shortcut activates the same mounted button as pointer acceptance: both save the visible comment/reviewer draft. Omitted command arguments preserve the latest saved field; an explicit empty string clears it. Waivers remain warning-only and acceptance remains group-only.

A UI-only session epoch increments atomically with pair/demo import, track replacement, package confirmation and recovery restore. Editor ownership combines epoch, semantic revision and subject ID. This uses [React's documented key-based state reset](https://react.dev/learn/preserving-and-resetting-state). Ordinary decision/autosave/export rerenders keep the draft. Group navigation discards unapplied drafts. Revision changes reload the saved decision as visibly stale context, without silently committing it. The package schema still generates a fresh runtime session ID on import; a browser harness also verifies repeated runtime IDs by changing only that metadata field in genuine worker results.

Undo peeks at the top data snapshot and consumes it only after successful analysis with a matching generation and expected snapshot. Cancel, error and stale completion keep the stack available. History remains bounded at 30 data snapshots and 200 journal entries.

Queue pages are clamped during render, then the stored page is normalized. Selection is taken from the visible page, and keyboard/page navigation focuses that row. Material replacement resets selection/pages/checks. Nested cues/findings remain paginated at 50 items and reset with the authoring context. Real empty filters display the existing explicit empty state.

## Executed checks

- Baseline: 34 unit tests, 7 Chromium flows and build passed. Six browser regressions failed on a separate pristine baseline: saved reasoning, pair replacement, package reopen, queue replacement, cancelled Undo and nested revision paging. Store regressions independently failed for cancel/error/stale Undo and omitted-field semantics.
- Final: `npm run typecheck`, `npm run lint`, `npm run test:unit` (49), `npm run build`, `npm run test:e2e` (51: 17 each on Chromium/Firefox/WebKit).
- Genuine worker tests hold a calculated response to control interleaving; they do not replace the analyzer with a fabricated response. Injected worker failure is labelled synthetic.
- Consumer: dependency-free ZIP unpacked outside source, own synthetic pair, manual split/merge, comment/reviewer acceptance and shortcut, numeric correction, stale decision, exact original/working bytes, package export, fresh-context reopen, IndexedDB recovery and an offline `file:` report with escaped hostile comment.
- Safety suites retain strict UTF-8/SRT/limited VTT, NOTE/BOM/newlines/untouched spans, edited-payload rejection, malformed/unsupported output blocking, ZIP tampering/traversal/duplicate/absolute/nested/CRC/compression/encryption/size/ratio guards, recovery CAS conflicts, grapheme/numeric evidence and incomplete-graph rejection. [WebVTT](https://www.w3.org/TR/webvtt1/) remains broader than the supported editor subset.
- New 1440/390 screenshots cover normal, long, RTL, session replacement and restored Undo on all three engines. Browser assertions check horizontal overflow, page errors, dialog focus/Tab/Shift+Tab/Escape and absence of unexpected network/upload requests.

## Measured budgets

Three fresh Node processes per corpus/tree, alternating baseline and fix with identical synthetic input hashes. Values below are medians in milliseconds and MiB. Parsing includes both tracks; alignment includes rules and review hashes; package includes strict working serialization. Full repeat data, corrected/reopen timing and input hashes accompany the local report.

| Tree | Cues per track / layout | Parse | Alignment/rules | Report | Package | Peak process RSS |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 5,000 / sparse | 121.3 | 240.0 | 36.6 | 230.9 | 346.2 |
| cuereviewkit | 5,000 / sparse | 104.9 | 262.5 | 33.1 | 284.4 | 352.4 |
| baseline | 20,000 / sparse | 343.7 | 797.9 | 90.3 | 790.2 | 677.6 |
| cuereviewkit | 20,000 / sparse | 368.4 | 870.1 | 83.7 | 812.4 | 714.8 |
| baseline | 20,000 / dense | 350.5 | 951.2 | 136.5 | 749.2 | 939.6 |
| cuereviewkit | 20,000 / dense | 385.4 | 948.1 | 143.4 | 708.7 | 949.1 |

20,000 dense cues reach the 200,000-edge cap, remain explicitly incomplete and block decisions. Reports and packages remain exportable. The bounds were preserved. Peak RSS is the high-water value for the whole Node core-pipeline process, including runtime, measured via [process.resourceUsage().maxRSS](https://nodejs.org/api/process.html#processresourceusage); it is not total browser/worker RAM. Dense-case memory approaches 1 GiB, so no low-memory-device readiness is claimed. The core pipeline was unchanged; timing variation under parallel user work is not evidence of a speedup.

Real heavy-worker cancellation used three fresh Chromium contexts with 20,000 dense replacement cues. Programmatic button click to DOM acknowledgement: 1.1, 1.0, 1.1 ms. The original track survived each cancellation. This excludes gesture/automation latency and OS resource reclamation time.

Toolchain: Node v26.9.0, npm 11.19.1, macOS 26.7.1 (25G241), Darwin 25.6.0, arm64, Apple M4. Browsers: Chromium 156.0.8078.4, Firefox 157.0, Playwright WebKit 27.2. Exact library versions are preserved in the lockfile and local tools manifest.

## Unverified gates

No physical Safari/touch-device validation, assistive-technology workflow, independent translator/editor pilot, Windows/Linux execution, fresh Node 24 run, full WebVTT conformance or semantic-accuracy claim. The measured Node peak does not verify total browser memory on low-RAM devices. This is a locally verified state-fix candidate; it is not a new public release or an unconditional 10/10 claim.
