import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  parseDocument,
  serializeCorrected,
} from "../../src/formats/source-document";
import { createSession } from "../../src/review/engine";
it("independent expected manifest: own demo has 240/239 cues, merge, split, omission interval and 100→1000 evidence", async () => {
  const expected = JSON.parse(await readFile("examples/expected.json", "utf8"));
  const s = await parseDocument(
      new Uint8Array(await readFile("examples/source.srt")),
      "source.srt",
      "source",
    ),
    t = await parseDocument(
      new Uint8Array(await readFile("examples/translation.srt")),
      "translation.srt",
      "translation",
    );
  const session = await createSession(s, t);
  expect(s.cues).toHaveLength(expected.sourceCount);
  expect(t.cues).toHaveLength(expected.translationCount);
  const ord = (ids: string[], role: "source" | "translation") =>
    ids.map(
      (id) =>
        (role === "source" ? s : t).cues.find((c) => c.id === id)!.ordinal,
    );
  const merge = session.analysis.alignment.groups.find(
      (g) => g.type === "n:1",
    )!,
    split = session.analysis.alignment.groups.find((g) => g.type === "1:n")!;
  expect(ord(merge.source, "source")).toEqual(expected.merge.sourceOrdinals);
  expect(ord(merge.translation, "translation")).toEqual(
    expected.merge.translationOrdinals,
  );
  expect(ord(split.source, "source")).toEqual(expected.split.sourceOrdinals);
  expect(ord(split.translation, "translation")).toEqual(
    expected.split.translationOrdinals,
  );
  expect(
    session.analysis.alignment.groups
      .filter((g) => g.type === "unmatched")
      .flatMap((g) => ord(g.source, "source")),
  ).toEqual(expected.unmatchedSourceOrdinals);
  expect(
    session.analysis.findings.find((f) => f.ruleId === "number-difference")!
      .evidence,
  ).toContain("100 → translation: 1000");
});
it("ten corpus pairs have >=1,000 cues and every unedited file round trips byte-for-byte", async () => {
  const manifest: {
    prefix: string;
    sourceCount: number;
    translationCount: number;
    invalidTranslationOrdinal?: number;
    fastTranslationOrdinal?: number;
    numberUncertaintyOrdinal?: number;
    shortOrdinal?: number;
    partialOrdinal?: number;
  }[] = JSON.parse(await readFile("fixtures/corpus/expected.json", "utf8"));
  expect(manifest.length).toBeGreaterThanOrEqual(10);
  let total = 0;
  for (const expected of manifest) {
    const docs = await Promise.all(
      (["source", "translation"] as const).map(async (role) =>
        parseDocument(
          new Uint8Array(
            await readFile(`fixtures/corpus/${expected.prefix}-${role}.srt`),
          ),
          role + ".srt",
          role,
        ),
      ),
    );
    const [s, t] = docs;
    expect(s.cues).toHaveLength(expected.sourceCount);
    expect(t.cues).toHaveLength(expected.translationCount);
    total += s.cues.length + t.cues.length;
    for (const d of docs)
      expect(await serializeCorrected(d, [])).toEqual(d.bytes);
    const session = await createSession(s, t);
    for (const [key, rule] of [
      ["invalidTranslationOrdinal", "invalid-interval"],
      ["fastTranslationOrdinal", "reading-speed"],
      ["numberUncertaintyOrdinal", "number-uncertainty"],
      ["shortOrdinal", "short-duration"],
      ["partialOrdinal", "partial-coverage"],
    ] as const) {
      const n = expected[key];
      if (n !== undefined)
        expect(
          session.analysis.findings.some(
            (f) =>
              f.ruleId === rule &&
              f.scope.cueIds.includes(
                (key === "partialOrdinal" ? s : t).cues[n].id,
              ),
          ),
        ).toBe(true);
    }
  }
  expect(total).toBeGreaterThanOrEqual(1000);
});
