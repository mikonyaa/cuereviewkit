import {
  ALIGNMENT_VERSION,
  RULE_VERSION,
  DEFAULT_CONFIG,
  type ReviewInput,
  type Analysis,
  type Session,
  type Decision,
  type Config,
  LIMITS,
} from "./types";
import { canonical, hashCues, sha256 } from "./hash";
import { align } from "../alignment";
import { runRules } from "../rules";
export function validateConfig(config: Config): void {
  for (const key of [
    "toleranceMs",
    "minDurationMs",
    "maxDurationMs",
    "maxCps",
    "minCoverage",
  ] as const)
    if (!Number.isFinite(config[key]))
      throw new Error("Rule preset must contain finite numbers.");
  if (
    config.toleranceMs < 0 ||
    config.toleranceMs > 2_000 ||
    config.minDurationMs < 0 ||
    config.maxDurationMs < config.minDurationMs ||
    config.maxDurationMs > 3_600_000 ||
    config.maxCps <= 0 ||
    config.maxCps > 1_000 ||
    config.minCoverage < 0 ||
    config.minCoverage > 1 ||
    typeof config.locale !== "string" ||
    config.locale.length > 40
  )
    throw new Error("Rule preset is outside supported bounds.");
  try {
    new Intl.Segmenter(config.locale);
  } catch {
    throw new Error("Invalid locale preset.");
  }
}
export async function analyze(input: ReviewInput): Promise<Analysis> {
  validateConfig(input.config);
  const edits = new Map(input.edits.map((e) => [e.id, e]));
  if (
    edits.size !== input.edits.length ||
    input.edits.length > input.translation.cues.length
  )
    throw new Error("Invalid edit list.");
  const ids = new Set(input.translation.cues.map((c) => c.id));
  if (
    input.edits.some(
      (e) =>
        !ids.has(e.id) ||
        typeof e.text !== "string" ||
        e.text.length > LIMITS.cueChars ||
        !Number.isSafeInteger(e.startMs) ||
        !Number.isSafeInteger(e.endMs) ||
        e.startMs < 0 ||
        e.endMs < 0,
    )
  )
    throw new Error("Invalid translation edit.");
  const working = await hashCues(
    input.translation.cues.map((c) => ({ ...c, ...edits.get(c.id) })),
  );
  const alignment = align(
    input.source.cues,
    working,
    input.config.toleranceMs,
    input.manualMapping,
  );
  const findings = runRules(
    input.source.cues,
    working,
    alignment,
    input.config,
  );
  const fullMapping = alignment.groups.map((g) => ({
    source: g.source,
    translation: g.translation,
    provenance: g.provenance,
  }));
  const revision = await sha256(
    canonical({
      originals: [input.source.byteHash, input.translation.byteHash],
      working: working.map((c) => ({
        id: c.id,
        startMs: c.startMs,
        endMs: c.endMs,
        text: c.text,
        contentHash: c.contentHash,
      })),
      mapping: fullMapping,
      alignmentVersion: ALIGNMENT_VERSION,
      ruleVersion: RULE_VERSION,
      config: input.config,
    }),
  );
  const subjectHashes: Record<string, string> = Object.create(null);
  const cueHashes = new Map(
    [...input.source.cues, ...working].map((c) => [c.id, c.contentHash]),
  );
  for (let i = 0; i < alignment.groups.length; i += 64)
    await Promise.all(
      alignment.groups.slice(i, i + 64).map(async (group) => {
        subjectHashes[group.id] = await sha256(
          canonical({
            group,
            cueHashes: [...group.source, ...group.translation].map((id) =>
              cueHashes.get(id),
            ),
          }),
        );
      }),
    );
  for (let i = 0; i < findings.length; i += 64)
    await Promise.all(
      findings.slice(i, i + 64).map(async (f) => {
        subjectHashes[f.id] = await sha256(canonical(f));
      }),
    );
  return {
    working,
    alignment,
    findings,
    revision,
    subjectHashes,
    supported: input.source.supported && input.translation.supported,
  };
}
export async function createSession(
  source: ReviewInput["source"],
  translation: ReviewInput["translation"],
): Promise<Session> {
  const input: ReviewInput = {
    source,
    translation,
    edits: [],
    manualMapping: null,
    config: { ...DEFAULT_CONFIG },
  };
  const analysis = await analyze(input);
  return {
    ...input,
    analysis,
    id: crypto.randomUUID(),
    decisions: [],
    history: [
      {
        at: new Date().toISOString(),
        action: "Imported original pair",
        revision: analysis.revision,
      },
    ],
  };
}
export function isDecisionCurrent(
  decision: Decision,
  analysis: Analysis,
): boolean {
  return (
    decision.reviewRevision === analysis.revision &&
    decision.subjectHash === analysis.subjectHashes[decision.subject]
  );
}
const decisionIndexes = new WeakMap<Decision[], Map<string, Decision>>();
export function decisionFor(
  session: Session,
  subject: string,
): Decision | undefined {
  let index = decisionIndexes.get(session.decisions);
  if (!index) {
    index = new Map(session.decisions.map((d) => [d.subject, d]));
    decisionIndexes.set(session.decisions, index);
  }
  return index.get(subject);
}
export function addDecision(
  session: Session,
  subject: string,
  status: Decision["status"],
  comment: string,
  reviewer: string,
): Session {
  if (
    session.analysis.alignment.incomplete ||
    !session.analysis.subjectHashes[subject]
  )
    throw new Error("Cannot review an unknown or incomplete subject.");
  if (
    (subject.startsWith("g:") && status === "waived") ||
    (subject.startsWith("f:") && status === "accepted")
  )
    throw new Error(
      "Accept a translation group; waive a mechanical warning separately.",
    );
  if (comment.length > LIMITS.comment || reviewer.length > 100)
    throw new Error("Comment or reviewer name is too long.");
  const d: Decision = {
    subject,
    subjectHash: session.analysis.subjectHashes[subject],
    reviewRevision: session.analysis.revision,
    status,
    comment,
    reviewer,
    at: new Date().toISOString(),
  };
  const decisions = [
    ...session.decisions.filter(
      (old) =>
        old.subject !== subject || old.reviewRevision !== d.reviewRevision,
    ),
    d,
  ].slice(-LIMITS.decisions);
  return {
    ...session,
    decisions,
    history: [
      ...session.history,
      {
        at: d.at,
        action: `${status}: ${subject}`.slice(0, 2_000),
        revision: d.reviewRevision,
      },
    ].slice(-LIMITS.history),
  };
}
