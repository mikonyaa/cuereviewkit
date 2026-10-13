# Changelog

## Unreleased

- Acceptance shortcut uses the same visible draft as the button; omitted fields preserve saved reasoning and explicit empty fields can clear it.
- Decision drafts reset on material/session replacement and semantic revision, including repeated package identities, without resetting on ordinary rerenders.
- Undo consumes history only after a successful current analysis; cancellation, worker errors and stale results preserve retry/history counts.
- Queue selection stays on the visible bounded page; imports reset pagination, shrinking mappings/filters clamp it, and nested cue/finding pages reset with their authoring context.
- Added store and real-worker browser regressions, and expanded the final ZIP consumer flow to verify comments, original/corrected bytes, recovery and offline report safety.

## 0.1.0 — 2026-10-12

Initial experimental release: immutable UTF-8 originals, strict SRT/limited WebVTT, bounded temporal many-to-many matching, explicit unmatched/ambiguous components, mechanical evidence, manual correspondence and decisions, previewed translation corrections, conservative stale revisions, undo/recovery/conflict handling, portable verified review packages, safe standalone reports and a dependency-free offline web ZIP.

Includes original synthetic 240/239 demonstration, 10 corpus pairs with 2,900 cues, real browser recording, Chromium/Firefox/WebKit acceptance flows and artifact consumer testing. Translation accuracy, human usability improvement and physical-device Safari/mobile compatibility are not certified.
