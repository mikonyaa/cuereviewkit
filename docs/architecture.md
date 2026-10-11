# Architecture

`formats/` reads fatal UTF-8 into immutable original bytes plus concrete fragments, byte/character spans, logical IDs and format diagnostics. `serializeCorrected` replaces only edited fragments and validates the **actual result bytes** by strict reparse and ordinal/count/time/text/identifier agreement.

`alignment/` builds a sweep-line bipartite overlap graph in sorted time/ordinal order, with ending events processed before equal-time starting events. Union-find creates connected components. The materialized-edge and near-candidate budgets cap dense inputs. Exports retain original cue order. Near candidates use mutual unique closest boundary distance; ties stay unmatched/ambiguous. Manual mapping preserves exactly one membership for every cue. Coverage iterates actual edges and merges intervals, avoiding film-wide quadratic all-pairs scans.

`rules/` creates versioned mechanical evidence, separate structural errors and configurable warnings. Overlap runs are grouped. `review/` hashes both originals, the canonical working data, full mapping and rule/alignment/config inputs. Decisions refer to revision and subject hashes. `history/` retains bounded data snapshots for undo and a separate bounded journal.

`workers/` isolates parse/hash/align/rules/package work. Each request and response has requestId and generation revision. `EngineClient` terminates its owned worker on cancellation or replacement; obsolete results are ignored. Store mutation occurs only after a matching completed request, so late results cannot overwrite the active session.

`ui/store.ts` is an external immutable session store consumed through React `useSyncExternalStore`. React components own only view state and unapplied drafts. They are not the source of truth for timings or revision history. Large cue/finding/group sets are paginated. `storage/` completes IndexedDB transactions before showing success and uses an atomic token comparison inside the same transaction to detect competing tabs.

`package/` has a bounded ZIP trust boundary, strict reconstruction and an inert HTML renderer. The static loopback server serves only the built app and refuses traversal/out-of-root symlinks. CI tests the packaged artifact as a consumer and deploys only that app tree. No user scripts, remote imports, video processing or plugin platform.

Design direction: restrained editorial workbench, with timecodes as the visual spine; IBM Plex Sans and IBM Plex Mono bundled under OFL; paper/ink neutrals and one dark green accent. 4/5 impact + 5/5 fit + 5/5 feasibility + 5/5 performance − 4/5 consistency risk = DFII 15. Visual QA is evidence, not a proof of every accessibility property.
