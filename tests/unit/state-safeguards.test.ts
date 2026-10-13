import { expect, it } from "vitest";
import {
  parseDocument,
  serializeCorrected,
} from "../../src/formats/source-document";
import { addDecision, createSession } from "../../src/review/engine";
import { exportPackage, importPackage } from "../../src/package";
import { decodeZip } from "../../src/package/zip";
import { renderReport } from "../../src/package/report";
import { LIMITS } from "../../src/review/types";
const enc = new TextEncoder();

it("an edited BOM/CRLF SRT preserves repeated/gapped numbering and untouched spans", async () => {
  const raw =
    "\uFEFF9\r\n00:00:01,000 --> 00:00:03,000\r\nBefore.\r\n\r\n9\r\n00:00:04,000 --> 00:00:06,000\r\nUntouched.\r\n\r\n20\r\n00:00:07,000 --> 00:00:09,000\r\nLast.\r\n";
  const bytes = enc.encode(raw);
  const doc = await parseDocument(bytes, "own.srt", "translation");
  const edited = await serializeCorrected(doc, [
    { ...doc.cues[0], text: "After." },
  ]);
  expect(edited).toEqual(enc.encode(raw.replace("Before.", "After.")));
  expect(doc.bytes).toEqual(bytes);
  const reparsed = await parseDocument(
    edited,
    "own.corrected.srt",
    "translation",
  );
  expect(reparsed.supported).toBe(true);
  expect(reparsed.cues.map((c) => c.number)).toEqual(["9", "9", "20"]);
});

it("an edited WebVTT preserves NOTE, identifiers, BOM and unchanged CRLF blocks", async () => {
  const raw =
    "\uFEFFWEBVTT own fixture\r\n\r\nNOTE own context\r\nKept note.\r\n\r\nscene-a\r\n00:01.000 --> 00:03.000\r\nBefore.\r\n\r\nscene-b\r\n00:04.000 --> 00:06.000\r\nUntouched.\r\n";
  const bytes = enc.encode(raw);
  const doc = await parseDocument(bytes, "own.vtt", "translation");
  const edited = await serializeCorrected(doc, [
    { ...doc.cues[0], text: "After." },
  ]);
  const expected = raw.replace("Before.", "After.");
  expect(edited).toEqual(enc.encode(expected));
  expect(doc.bytes).toEqual(bytes);
  expect(
    (await parseDocument(edited, "copy.vtt", "translation")).supported,
  ).toBe(true);
  await expect(
    serializeCorrected(doc, [{ ...doc.cues[0], text: "Unsafe\n\nblock" }]),
  ).rejects.toThrow();
  expect(doc.bytes).toEqual(bytes);
});

async function ownPackage() {
  const raw = enc.encode(
    "1\n00:00:01,000 --> 00:00:03,000\nOwn package cue.\n\n",
  );
  const session = await createSession(
    await parseDocument(raw, "own-source.srt", "source"),
    await parseDocument(raw, "own-target.srt", "translation"),
  );
  return exportPackage(session);
}
function firstCentral(zip: Uint8Array) {
  const view = new DataView(zip.buffer);
  for (let i = 0; i < zip.length - 46; i++)
    if (view.getUint32(i, true) === 0x02014b50)
      return { view, central: i, local: view.getUint32(i + 42, true) };
  throw new Error("No ZIP directory");
}

it.each(["CRC", "method", "encrypted"])(
  "rejects %s mutations before trusting review state",
  async (kind) => {
    const zip = await ownPackage();
    const { view, central, local } = firstCentral(zip);
    if (kind === "CRC") {
      view.setUint32(central + 16, 0, true);
      view.setUint32(local + 14, 0, true);
    } else if (kind === "method") {
      view.setUint16(central + 10, 99, true);
      view.setUint16(local + 8, 99, true);
    } else {
      view.setUint16(central + 8, 1, true);
      view.setUint16(local + 6, 1, true);
    }
    await expect(importPackage(zip)).rejects.toThrow();
  },
);

it("rejects the compressed byte bound before opening ZIP entries", () => {
  expect(() => decodeZip(new Uint8Array(LIMITS.packageBytes + 1))).toThrow();
});

it("hostile cue and decision text remains escaped in regenerated report", async () => {
  const raw = enc.encode(
    '1\n00:00:01,000 --> 00:00:03,000\n<img src=x onerror="attack()">\n\n',
  );
  const session = await createSession(
    await parseDocument(raw, "source.srt", "source"),
    await parseDocument(raw, "target.srt", "translation"),
  );
  const reviewed = addDecision(
    session,
    session.analysis.alignment.groups[0].id,
    "accepted",
    "<script>attack()</script>",
    "<b>name</b>",
  );
  const report = renderReport(reviewed);
  expect(report).toContain("&lt;img");
  expect(report).toContain("&lt;script&gt;");
  expect(report).not.toContain("<script>");
  expect(report).not.toContain("<img");
});
