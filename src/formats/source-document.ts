import {
  LIMITS,
  type SourceDocument,
  type Cue,
  type Role,
  type Format,
  type Diagnostic,
  type Edit,
} from "../review/types";
import { hashCues, sha256 } from "../review/hash";
import { parseTime, formatTime } from "./time";
import { visibleText } from "./markup";
interface Line {
  text: string;
  start: number;
  end: number;
  byteStart: number;
  byteEnd: number;
  newline: string;
  line: number;
}
function lines(raw: string): Line[] {
  const result: Line[] = [];
  const enc = new TextEncoder();
  let pos = 0,
    byte = 0;
  while (pos < raw.length) {
    const n = raw.indexOf("\n", pos),
      boundary = n < 0 ? raw.length : n;
    const crlf = boundary > pos && raw[boundary - 1] === "\r";
    const text = raw.slice(pos, crlf ? boundary - 1 : boundary),
      nl = n < 0 ? "" : crlf ? "\r\n" : "\n";
    const size = enc.encode(text).length;
    result.push({
      text,
      start: pos,
      end: pos + text.length,
      byteStart: byte,
      byteEnd: byte + size,
      newline: nl,
      line: result.length + 1,
    });
    pos = boundary + (n < 0 ? 0 : 1);
    byte += size + nl.length;
  }
  return result;
}
export async function parseDocument(
  bytes: Uint8Array,
  filename: string,
  role: Role,
  mime = "",
): Promise<SourceDocument> {
  if (bytes.length > LIMITS.trackBytes)
    throw new Error("Track exceeds the 10 MiB limit. Current review was kept.");
  const bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
  const byteHash = await sha256(bytes);
  const diagnostics: Diagnostic[] = [];
  const diagnose = (diagnostic: Diagnostic) => {
    if (diagnostics.length >= LIMITS.diagnostics)
      throw new Error(
        "Format diagnostic limit exceeded. Current review was kept.",
      );
    diagnostics.push(diagnostic);
  };
  let raw = "";
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
  } catch {
    diagnose({
      code: "invalid-utf8",
      severity: "unsupported",
      message:
        "Only valid UTF-8 is supported. Convert a separate copy to UTF-8; original bytes remain downloadable.",
    });
  }
  const format: Format =
    /^WEBVTT(?:[ \t]|$)/.test(raw.split(/\r?\n/)[0]) || /\.vtt$/i.test(filename)
      ? "vtt"
      : "srt";
  let lineCount = 1;
  for (let at = 0; at < raw.length; at++)
    if (raw.charCodeAt(at) === 10 && ++lineCount > LIMITS.lines)
      throw new Error(
        "Track exceeds the 400,000 line budget. Current review was kept.",
      );
  const ls = lines(raw);
  const newline = ls.find((l) => l.newline)?.newline || "\n";
  if (raw.includes("\r") && ls.some((l) => l.text.includes("\r")))
    diagnose({
      code: "unsupported-newline",
      severity: "unsupported",
      message: "Lone CR line endings are unsupported; use LF or CRLF.",
    });
  const pending: Cue[] = [];
  let i = 0;
  if (format === "vtt") {
    if (
      !ls[0] ||
      !/^WEBVTT(?:[ \t].*)?$/.test(ls[0].text) ||
      ls[0].text.includes("-->")
    )
      diagnose({
        code: "vtt-header",
        severity: "error",
        message: "Expected a WEBVTT header.",
      });
    i = 1;
    if (ls[i]?.text !== "")
      diagnose({
        code: "vtt-header-separator",
        severity: "error",
        message: "The WEBVTT header requires a blank separator line.",
      });
  }
  const numbers = new Set<string>();
  let previousNumber: number | null = null;
  while (i < ls.length) {
    if (ls[i].text === "") {
      i++;
      continue;
    }
    const start = i;
    while (i < ls.length && ls[i].text !== "") i++;
    const block = ls.slice(start, i),
      first = block[0];
    if (format === "vtt" && /^NOTE(?:[ \t]|$)/.test(first.text)) continue;
    if (
      format === "vtt" &&
      /^(?:STYLE|REGION|X-TIMESTAMP-MAP)(?:[ \t=]|$)/.test(first.text)
    ) {
      diagnose({
        code: "vtt-unsupported-block",
        severity: "unsupported",
        line: first.line,
        message: `${first.text.split(/[ =]/)[0]} blocks are preserved but unsupported. Corrected export is blocked.`,
      });
      continue;
    }
    let ti = 0;
    let number: string | undefined, identifier: string | undefined;
    if (format === "srt") {
      if (!/^\d+$/.test(first.text)) {
        diagnose({
          code: "srt-number",
          severity: "error",
          line: first.line,
          message: "Unsupported fragment: expected a numeric cue number.",
        });
        continue;
      }
      number = first.text;
      ti = 1;
    } else if (!first.text.includes("-->")) {
      identifier = first.text;
      ti = 1;
    }
    const timeLine = block[ti];
    const match =
      timeLine && /^(\S+)[ \t]+-->[ \t]+(\S+)(.*)$/.exec(timeLine.text);
    const startMs = match ? parseTime(match[1], format) : null,
      endMs = match ? parseTime(match[2], format) : null;
    if (!match || startMs === null || endMs === null) {
      diagnose({
        code: "invalid-timing",
        severity: "error",
        line: timeLine?.line ?? first.line,
        message:
          "Invalid timing syntax. Minutes/seconds must be 00–59 and precision exactly milliseconds.",
      });
      continue;
    }
    const ordinal = pending.length;
    if (match[3].trim())
      diagnose({
        code: "unsupported-settings",
        severity: "unsupported",
        ordinal,
        line: timeLine.line,
        message:
          "Cue positioning/settings are preserved but unsupported; corrected export is blocked.",
      });
    const payload = block
      .slice(ti + 1)
      .map((l) => l.text)
      .join(newline);
    if (payload.length > LIMITS.cueChars)
      throw new Error(
        "Cue exceeds the 20,000 character limit. Current review was kept.",
      );
    if (visibleText(payload) === null)
      diagnose({
        code: "unsupported-markup",
        severity: "unsupported",
        ordinal,
        message:
          "Only plain text and balanced b/i/u tags without attributes are supported. Payload stays inert; CPS is not computable.",
      });
    if (!payload)
      diagnose({
        code: "empty-cue",
        severity: "warning",
        ordinal,
        message: "Empty cue payload; it can be edited.",
      });
    if (number !== undefined) {
      const n = Number(number);
      if (numbers.has(number))
        diagnose({
          code: "duplicate-number",
          severity: "warning",
          ordinal,
          message: "Repeated SRT number; numbers are not cue identity.",
        });
      if (previousNumber !== null && n !== previousNumber + 1)
        diagnose({
          code: "number-gap",
          severity: "warning",
          ordinal,
          message: "Non-consecutive SRT numbers; export preserves them.",
        });
      numbers.add(number);
      previousNumber = n;
    }
    const last = block[block.length - 1];
    pending.push({
      id: `${role}:${byteHash}:${ordinal}`,
      ordinal,
      number,
      identifier,
      startMs,
      endMs,
      text: payload,
      contentHash: "",
      span: {
        start: first.start,
        end: last.end,
        byteStart: first.byteStart + (bom ? 3 : 0),
        byteEnd: last.byteEnd + (bom ? 3 : 0),
      },
      prefixRaw: ti ? first.text + first.newline : "",
      timingRaw: timeLine.text,
      newline: timeLine.newline || newline,
    });
    if (pending.length > LIMITS.cues)
      throw new Error(
        "Track exceeds the 20,000 cue limit. Current review was kept.",
      );
  }
  return {
    role,
    format,
    filename: filename.slice(0, 240),
    mime: mime.slice(0, 100),
    bytes: new Uint8Array(bytes),
    byteHash,
    raw,
    bom,
    newline,
    diagnostics,
    cues: await hashCues(pending),
    supported: !diagnostics.some(
      (d) => d.severity === "error" || d.severity === "unsupported",
    ),
  };
}
export async function serializeCorrected(
  doc: SourceDocument,
  edits: Edit[],
): Promise<Uint8Array> {
  if (!doc.supported)
    throw new Error(
      "Corrected export is blocked by unsupported or malformed input. Download the untouched original.",
    );
  const byId = new Map(edits.map((e) => [e.id, e]));
  const cueIds = new Set(doc.cues.map((c) => c.id));
  if (byId.size !== edits.length || edits.some((e) => !cueIds.has(e.id)))
    throw new Error("Unknown or duplicate edited cue.");
  const fragments: string[] = [],
    encoder = new TextEncoder();
  let cursor = 0,
    outputBytes = doc.bom ? 3 : 0;
  const append = (fragment: string) => {
    outputBytes += encoder.encode(fragment).length;
    if (outputBytes > LIMITS.trackBytes)
      throw new Error("Corrected copy exceeds 10 MiB.");
    fragments.push(fragment);
  };
  for (const c of doc.cues) {
    const e = byId.get(c.id);
    if (!e) continue;
    if (
      !Number.isSafeInteger(e.startMs) ||
      !Number.isSafeInteger(e.endMs) ||
      e.startMs < 0 ||
      e.endMs < 0
    )
      throw new Error("Use non-negative integer millisecond times.");
    if (
      e.text.length > LIMITS.cueChars ||
      /\r(?!\n)/.test(e.text) ||
      (/(?:^|\n)[ \t]*(?:\r?\n|$)/.test(e.text) && e.text !== "")
    )
      throw new Error(
        "Payload cannot contain blank separator lines or leading/trailing newlines. Draft was kept.",
      );
    if (visibleText(e.text) === null)
      throw new Error(
        "Unsupported markup in draft. Use plain text or balanced b/i/u tags.",
      );
    const timing =
      e.startMs === c.startMs && e.endMs === c.endMs
        ? c.timingRaw
        : `${formatTime(e.startMs, doc.format)} --> ${formatTime(e.endMs, doc.format)}`;
    const payload = e.text.replace(/\r?\n/g, c.newline);
    const fragment =
      c.prefixRaw + timing + (payload ? c.newline + payload : "");
    append(doc.raw.slice(cursor, c.span.start));
    append(fragment);
    cursor = c.span.end;
  }
  append(doc.raw.slice(cursor));
  const bytes = encoder.encode((doc.bom ? "\uFEFF" : "") + fragments.join(""));
  if (bytes.length > LIMITS.trackBytes)
    throw new Error("Corrected copy exceeds 10 MiB.");
  const reparsed = await parseDocument(bytes, doc.filename, doc.role, doc.mime);
  if (!reparsed.supported || reparsed.cues.length !== doc.cues.length)
    throw new Error(
      "Serialized bytes failed strict reparse: structure changed. Draft was kept.",
    );
  for (let i = 0; i < doc.cues.length; i++) {
    const c = doc.cues[i],
      expected = byId.get(c.id) ?? c,
      actual = reparsed.cues[i];
    if (
      actual.number !== c.number ||
      actual.identifier !== c.identifier ||
      actual.startMs !== expected.startMs ||
      actual.endMs !== expected.endMs ||
      actual.text.replace(/\r\n/g, "\n") !==
        expected.text.replace(/\r\n/g, "\n")
    )
      throw new Error(
        "Serialized cue order or content changed unexpectedly. Draft was kept.",
      );
  }
  return bytes;
}
