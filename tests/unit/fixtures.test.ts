import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  parseDocument,
  serializeCorrected,
} from "../../src/formats/source-document";
import { LIMITS } from "../../src/review/types";
it.each([
  "style.vtt",
  "region.vtt",
  "timestamp-map.vtt",
  "settings.vtt",
  "malformed.srt",
])(
  "actual unsupported fixture %s remains exact and cannot become corrected success",
  async (filename) => {
    const bytes = new Uint8Array(
      await readFile("fixtures/formats/" + filename),
    );
    const doc = await parseDocument(bytes, filename, "translation");
    expect(doc.supported).toBe(false);
    expect(doc.bytes).toEqual(bytes);
    await expect(serializeCorrected(doc, [])).rejects.toThrow("blocked");
  },
);
it("actual NOTE/BOM/CRLF fixture has byte spans and an exact original round trip", async () => {
  const bytes = new Uint8Array(
    await readFile("fixtures/formats/notes-bom-crlf.vtt"),
  );
  const doc = await parseDocument(bytes, "notes.vtt", "translation");
  expect(doc.supported).toBe(true);
  expect(doc.bom).toBe(true);
  expect(doc.newline).toBe("\r\n");
  expect(await serializeCorrected(doc, [])).toEqual(bytes);
  const cue = doc.cues[0];
  expect(
    new TextDecoder().decode(
      bytes.subarray(cue.span.byteStart, cue.span.byteEnd),
    ),
  ).toContain("scene-1\r\n00:01.000");
});
it("rejects byte/cue/payload limits before committing any input", async () => {
  await expect(
    parseDocument(
      new Uint8Array(LIMITS.trackBytes + 1),
      "too-big.srt",
      "source",
    ),
  ).rejects.toThrow("10 MiB");
  const text =
    "1\n00:00:01,000 --> 00:00:02,000\n" +
    "x".repeat(LIMITS.cueChars + 1) +
    "\n";
  await expect(
    parseDocument(new TextEncoder().encode(text), "too-long.srt", "source"),
  ).rejects.toThrow("20,000 character");
  const one = "1\n00:00:01,000 --> 00:00:02,000\nHi\n\n";
  await expect(
    parseDocument(
      new TextEncoder().encode(one.repeat(LIMITS.cues + 1)),
      "too-many.srt",
      "source",
    ),
  ).rejects.toThrow("20,000 cue");
});

it("bounded batch serialization updates all cues in order and stops total output before allocation", async () => {
  const text = Array.from(
    { length: 1000 },
    (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:02,000\nBefore ${i}\n\n`,
  ).join("");
  const doc = await parseDocument(
    new TextEncoder().encode(text),
    "batch.srt",
    "translation",
  );
  const edits = doc.cues.map((c) => ({ ...c, text: "After " + c.ordinal }));
  const updated = await parseDocument(
    await serializeCorrected(doc, edits),
    "batch.srt",
    "translation",
  );
  expect(updated.cues.map((c) => c.text)).toEqual(edits.map((e) => e.text));
  expect(updated.cues.map((c) => c.number)).toEqual(
    doc.cues.map((c) => c.number),
  );
  await expect(
    serializeCorrected(
      doc,
      doc.cues.map((c) => ({ ...c, text: "x".repeat(20000) })),
    ),
  ).rejects.toThrow("10 MiB");
  await expect(
    parseDocument(
      new TextEncoder().encode("\n".repeat(LIMITS.lines + 1)),
      "too-many-lines.srt",
      "source",
    ),
  ).rejects.toThrow("line budget");
});
