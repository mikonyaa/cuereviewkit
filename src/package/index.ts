import {
  VERSION,
  ALIGNMENT_VERSION,
  RULE_VERSION,
  LIMITS,
  type Session,
  type Edit,
  type Mapping,
  type Decision,
  type HistoryEntry,
  type Config,
} from "../review/types";
import { sha256 } from "../review/hash";
import { parseDocument, serializeCorrected } from "../formats/source-document";
import { analyze } from "../review/engine";
import { encodeZip, decodeZip } from "./zip";
import { renderReport } from "./report";
const enc = new TextEncoder(),
  dec = new TextDecoder("utf-8", { fatal: true });
interface FileEntry {
  path: string;
  bytes: number;
  sha256: string;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error("Invalid package string.");
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("Invalid or oversized package array.");
  return value;
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > max
  )
    throw new Error("Invalid package integer.");
  return value;
}
function hash(value: unknown) {
  const s = string(value, 64);
  if (!/^[a-f0-9]{64}$/.test(s)) throw new Error("Invalid SHA-256.");
  return s;
}
function ids(value: unknown) {
  return array(value, LIMITS.cues).map((x) => string(x, 100));
}
function parseJson(bytes: Uint8Array, max: number): Record<string, unknown> {
  if (bytes.length > max) throw new Error("Package JSON exceeds its limit.");
  let value: unknown;
  try {
    value = JSON.parse(dec.decode(bytes));
  } catch {
    throw new Error("Malformed UTF-8 JSON in package.");
  }
  let count = 0;
  const scan = (v: unknown, depth: number) => {
    if (++count > 700_000 || depth > 16)
      throw new Error("Package JSON complexity limit exceeded.");
    if (v && typeof v === "object")
      for (const [k, child] of Object.entries(v)) {
        if (["__proto__", "constructor", "prototype"].includes(k))
          throw new Error("Unsafe JSON key.");
        scan(child, depth + 1);
      }
  };
  scan(value, 0);
  return object(value);
}
export async function exportPackage(session: Session): Promise<Uint8Array> {
  const workingBytes = session.translation.supported
    ? await serializeCorrected(session.translation, session.edits)
    : session.translation.bytes;
  if (!session.translation.supported && session.edits.length)
    throw new Error("Unsupported edited translation cannot be packaged.");
  const sourcePath = `originals/source.${session.source.format}`,
    translationPath = `originals/translation.${session.translation.format}`,
    workingPath = `working/translation.${session.translation.format}`;
  const review = {
    schemaVersion: 1,
    originals: [session.source.byteHash, session.translation.byteHash],
    alignmentVersion: ALIGNMENT_VERSION,
    ruleVersion: RULE_VERSION,
    logicalIds: {
      source: session.source.cues.map((c) => c.id),
      translation: session.translation.cues.map((c) => c.id),
    },
    edits: session.edits,
    manualMapping: session.manualMapping,
    config: session.config,
    decisions: session.decisions,
    history: session.history,
    revision: session.analysis.revision,
  };
  const payload: Record<string, Uint8Array> = {
    [sourcePath]: session.source.bytes,
    [translationPath]: session.translation.bytes,
    [workingPath]: workingBytes,
    "review.json": enc.encode(JSON.stringify(review)),
    "report.html": enc.encode(renderReport(session)),
  };
  const entries: FileEntry[] = await Promise.all(
    Object.entries(payload).map(async ([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: await sha256(bytes),
    })),
  );
  if (entries.reduce((n, e) => n + e.bytes, 0) > LIMITS.unpackedBytes - 32_768)
    throw new Error(
      "Review package exceeds the 60 MiB unpacked limit. Export originals separately.",
    );
  const manifest = {
    schemaVersion: 1,
    creatorVersion: VERSION,
    sourceFilename: session.source.filename,
    translationFilename: session.translation.filename,
    sourcePath,
    translationPath,
    workingPath,
    files: entries,
  };
  payload["manifest.json"] = enc.encode(JSON.stringify(manifest, null, 2));
  const zip = encodeZip(payload);
  if (zip.length > LIMITS.packageBytes)
    throw new Error("Review package exceeds 30 MiB compressed.");
  return zip;
}
export async function importPackage(
  bytes: Uint8Array,
): Promise<{ session: Session; warnings: string[]; creatorVersion: string }> {
  const files = decodeZip(bytes),
    manifest = parseJson(files["manifest.json"], 32_768);
  if (manifest.schemaVersion !== 1)
    throw new Error("Unsupported review package schema version.");
  const creatorVersion = string(manifest.creatorVersion, 40),
    sourcePath = string(manifest.sourcePath, 100),
    translationPath = string(manifest.translationPath, 100),
    workingPath = string(manifest.workingPath, 100);
  if (
    !/^originals\/source\.(srt|vtt)$/.test(sourcePath) ||
    !/^originals\/translation\.(srt|vtt)$/.test(translationPath) ||
    workingPath !== translationPath.replace("originals/", "working/")
  )
    throw new Error("Invalid manifest track paths.");
  const entries = array(manifest.files, 5);
  if (entries.length !== 5) throw new Error("Expected five payload entries.");
  const seen = new Set<string>();
  for (const entry of entries) {
    const e = object(entry),
      path = string(e.path, 100);
    if (seen.has(path) || path === "manifest.json" || !files[path])
      throw new Error("Invalid manifest file list.");
    seen.add(path);
    if (
      integer(e.bytes, LIMITS.unpackedBytes) !== files[path].length ||
      hash(e.sha256) !== (await sha256(files[path]))
    )
      throw new Error(`Package integrity conflict: ${path}.`);
  }
  if (
    ![
      sourcePath,
      translationPath,
      workingPath,
      "review.json",
      "report.html",
    ].every((p) => seen.has(p))
  )
    throw new Error("Manifest is missing required payloads.");
  const source = await parseDocument(
      files[sourcePath],
      string(manifest.sourceFilename, 240),
      "source",
    ),
    translation = await parseDocument(
      files[translationPath],
      string(manifest.translationFilename, 240),
      "translation",
    );
  if (
    sourcePath !== `originals/source.${source.format}` ||
    translationPath !== `originals/translation.${translation.format}`
  )
    throw new Error("Manifest format does not match original bytes.");
  const review = parseJson(files["review.json"], 20 * 1024 ** 2);
  if (
    review.schemaVersion !== 1 ||
    review.alignmentVersion !== ALIGNMENT_VERSION ||
    review.ruleVersion !== RULE_VERSION
  )
    throw new Error("Unsupported review engine/schema version.");
  const base = array(review.originals, 2);
  if (
    base.length !== 2 ||
    base[0] !== source.byteHash ||
    base[1] !== translation.byteHash
  )
    throw new Error("Original base hash conflict.");
  const logical = object(review.logicalIds);
  if (
    JSON.stringify(ids(logical.source)) !==
      JSON.stringify(source.cues.map((c) => c.id)) ||
    JSON.stringify(ids(logical.translation)) !==
      JSON.stringify(translation.cues.map((c) => c.id))
  )
    throw new Error("Logical cue identity conflict.");
  const edits: Edit[] = array(review.edits, LIMITS.cues).map((value) => {
    const e = object(value);
    return {
      id: string(e.id, 100),
      startMs: integer(e.startMs),
      endMs: integer(e.endMs),
      text: string(e.text, LIMITS.cueChars),
    };
  });
  const manualMapping: Mapping[] | null =
    review.manualMapping === null
      ? null
      : array(review.manualMapping, LIMITS.cues * 2).map((value) => {
          const m = object(value);
          if (m.provenance !== "manual")
            throw new Error("Explicit mapping must have manual provenance.");
          return {
            source: ids(m.source),
            translation: ids(m.translation),
            provenance: "manual",
          };
        });
  const c = object(review.config);
  const config: Config = {
    toleranceMs: Number(c.toleranceMs),
    minDurationMs: Number(c.minDurationMs),
    maxDurationMs: Number(c.maxDurationMs),
    maxCps: Number(c.maxCps),
    minCoverage: Number(c.minCoverage),
    locale: string(c.locale, 40),
  };
  if (
    Object.values(c).some(
      (x) => typeof x !== "number" && typeof x !== "string",
    ) ||
    [
      "toleranceMs",
      "minDurationMs",
      "maxDurationMs",
      "maxCps",
      "minCoverage",
    ].some((k) => typeof c[k] !== "number")
  )
    throw new Error("Invalid rule config schema.");
  const decisions: Decision[] = array(review.decisions, LIMITS.decisions).map(
    (value) => {
      const d = object(value);
      if (!["accepted", "needs-change", "waived"].includes(String(d.status)))
        throw new Error("Invalid decision status.");
      const subject = string(d.subject, 6_000_000);
      if (
        (subject.startsWith("g:") && d.status === "waived") ||
        (subject.startsWith("f:") && d.status === "accepted") ||
        !/^[gf]:/.test(subject)
      )
        throw new Error("Invalid decision subject/status.");
      return {
        subject,
        subjectHash: hash(d.subjectHash),
        reviewRevision: hash(d.reviewRevision),
        status: d.status as Decision["status"],
        comment: string(d.comment, LIMITS.comment),
        reviewer: string(d.reviewer, 100),
        at: string(d.at, 50),
      };
    },
  );
  const history: HistoryEntry[] = array(review.history, LIMITS.history).map(
    (value) => {
      const e = object(value);
      return {
        at: string(e.at, 50),
        action: string(e.action, 2_000),
        revision: hash(e.revision),
      };
    },
  );
  const input = { source, translation, edits, manualMapping, config };
  const analysis = await analyze(input),
    revision = hash(review.revision),
    warnings: string[] = [];
  if (revision !== analysis.revision)
    warnings.push(
      "Saved revision differs from recomputed data. Decisions are stale/conflicted; review again.",
    );
  const expected = translation.supported
    ? await serializeCorrected(translation, edits)
    : translation.bytes;
  if (
    (!translation.supported && edits.length) ||
    (await sha256(expected)) !== (await sha256(files[workingPath]))
  )
    throw new Error(
      "Working translation bytes do not match original cue edits.",
    );
  // Imported HTML is deliberately never read/rendered. A new report uses our renderer.
  return {
    session: {
      ...input,
      analysis,
      id: crypto.randomUUID(),
      decisions:
        revision === analysis.revision
          ? decisions
          : decisions.map((d) => ({ ...d, reviewRevision: revision })),
      history,
    },
    warnings,
    creatorVersion,
  };
}
