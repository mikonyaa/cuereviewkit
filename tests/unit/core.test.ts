import { describe, it, expect } from "vitest";
import {
  parseDocument,
  serializeCorrected,
} from "../../src/formats/source-document";
import {
  createSession,
  analyze,
  addDecision,
  isDecisionCurrent,
} from "../../src/review/engine";
import { exportPackage, importPackage } from "../../src/package";
import {
  align,
  unionCoverage,
  splitGroup,
  validateMapping,
  mergeGroups,
} from "../../src/alignment";
import { graphemeCount } from "../../src/formats/markup";
import { numberTokens } from "../../src/rules";
import { parseTime } from "../../src/formats/time";
const enc = new TextEncoder();
const srt = (n: string, time: string, text: string) =>
  `${n}\n${time}\n${text}\n\n`;
const sourceText =
  srt("1", "00:00:01,000 --> 00:00:02,000", "Take the tram.") +
  srt("2", "00:00:02,000 --> 00:00:03,000", "Bring 100 tickets.") +
  srt("3", "00:00:05,000 --> 00:00:06,000", "Meet at the entrance.");
const targetText = srt(
  "90",
  "00:00:01,000 --> 00:00:03,000",
  "Садись в трамвай. Возьми 1000 билетов.",
);
async function pair() {
  return createSession(
    await parseDocument(enc.encode(sourceText), "source.srt", "source"),
    await parseDocument(
      enc.encode(targetText),
      "translation.srt",
      "translation",
    ),
  );
}
describe("feasibility gate before UI", () => {
  it("three real source cues → legal merge and uncovered interval, invariant to numbering", async () => {
    const session = await pair();
    const groups = session.analysis.alignment.groups;
    expect(
      groups.map((g) => [g.type, g.source.length, g.translation.length]),
    ).toEqual([
      ["n:1", 2, 1],
      ["unmatched", 1, 0],
    ]);
    expect(
      session.analysis.findings.some(
        (f) => f.ruleId === "number-difference" && f.evidence.includes("1000"),
      ),
    ).toBe(true);
    expect(
      session.analysis.findings.some(
        (f) => f.ruleId === "uncovered-interval" && f.scope.role === "source",
      ),
    ).toBe(true);
    const renumbered = await parseDocument(
      enc.encode(
        sourceText
          .replace(/^1$/m, "800")
          .replace(/^2$/m, "9")
          .replace(/^3$/m, "9"),
      ),
      "source.srt",
      "source",
    );
    expect(
      align(renumbered.cues, session.translation.cues).groups.map(
        (g) => g.type,
      ),
    ).toEqual(groups.map((g) => g.type));
  });
  it("manual approval becomes stale after editing; clean-session package reconstructs identities and original bytes", async () => {
    let session = await pair();
    session = addDecision(
      session,
      session.analysis.alignment.groups[0].id,
      "accepted",
      "Legal merge; verify the number.",
      "Editor",
    );
    const old = session.decisions[0];
    const e = {
      id: session.translation.cues[0].id,
      startMs: 1_000,
      endMs: 3_000,
      text: "Садись в трамвай. Возьми 100 билетов.",
    };
    session = {
      ...session,
      edits: [e],
      analysis: await analyze({ ...session, edits: [e] }),
    };
    expect(isDecisionCurrent(old, session.analysis)).toBe(false);
    const bytes = await exportPackage(session),
      restored = (await importPackage(bytes)).session;
    expect(restored.analysis.revision).toBe(session.analysis.revision);
    expect(restored.source.bytes).toEqual(enc.encode(sourceText));
    expect(restored.translation.bytes).toEqual(enc.encode(targetText));
    expect(restored.analysis.working[0].id).toBe(
      session.translation.cues[0].id,
    );
    expect(restored.analysis.working[0].text).toBe(e.text);
    expect(isDecisionCurrent(restored.decisions[0], restored.analysis)).toBe(
      false,
    );
    expect(await serializeCorrected(session.source, [])).toEqual(
      session.source.bytes,
    );
  });
});
describe("concrete parsing and guarded serialization", () => {
  it.each(["\n", "\r\n"])(
    "preserves BOM and %j bytes; edits preserve NOTE and identifiers",
    async (nl) => {
      const text =
        "\uFEFF" +
        [
          "WEBVTT editorial example",
          "",
          "NOTE this stays exactly",
          "local-only note",
          "",
          "scene-1",
          "00:01.000 --> 00:02.001",
          "<i>你好</i>",
          "Second line",
          "",
          "scene-2",
          "00:03.000 --> 00:04.000",
          "Again",
          "",
        ].join(nl);
      const doc = await parseDocument(
        enc.encode(text),
        "notes.vtt",
        "translation",
      );
      expect(doc.supported).toBe(true);
      expect(doc.cues[0].endMs).toBe(2_001);
      expect(await serializeCorrected(doc, [])).toEqual(doc.bytes);
      const edited = await serializeCorrected(doc, [
        { ...doc.cues[0], text: "Changed\nNext" },
      ]);
      const out = new TextDecoder().decode(edited);
      expect(out).toContain("NOTE this stays exactly" + nl + "local-only note");
      expect(out).toContain("scene-1");
      expect(out).toContain("Changed" + nl + "Next");
    },
  );
  it.each([
    "STYLE\n::cue { color:red }",
    "REGION\nid:top",
    "X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000",
  ])(
    "preserves unsupported block and blocks corrected export: %s",
    async (block) => {
      const doc = await parseDocument(
        enc.encode(`WEBVTT\n\n${block}\n\n00:01.000 --> 00:02.000\nText\n`),
        "style.vtt",
        "translation",
      );
      expect(doc.supported).toBe(false);
      await expect(serializeCorrected(doc, [])).rejects.toThrow("blocked");
      expect(doc.bytes.length).toBeGreaterThan(0);
    },
  );
  it("rejects settings, unsupported tags, malformed timing and non-UTF-8", async () => {
    for (const text of [
      "WEBVTT\n\n00:01.000 --> 00:02.000 position:20%\nHello\n",
      "WEBVTT\n\n00:01.000 --> 00:02.000\n<v Alice>Hello</v>\n",
      srt("1", "00:61:00,000 --> 00:62:00,000", "No"),
    ])
      expect(
        (await parseDocument(enc.encode(text), "bad.srt", "source")).supported,
      ).toBe(false);
    expect(
      (await parseDocument(new Uint8Array([0xc0, 0xaf]), "bad.srt", "source"))
        .diagnostics[0].code,
    ).toBe("invalid-utf8");
  });
  it("retains empty cue and rejects structural payload injection without losing a draft", async () => {
    const doc = await parseDocument(
      enc.encode(
        "1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\nLater\n",
      ),
      "empty.srt",
      "translation",
    );
    expect(doc.cues.length).toBe(2);
    expect(doc.cues[0].text).toBe("");
    expect(
      (
        await parseDocument(
          await serializeCorrected(doc, [
            { ...doc.cues[0], text: "Recovered" },
          ]),
          "empty.srt",
          "translation",
        )
      ).cues[0].text,
    ).toBe("Recovered");
    await expect(
      serializeCorrected(doc, [
        {
          ...doc.cues[1],
          text: "Safe\n\n3\n00:00:05,000 --> 00:00:06,000\nInjected",
        },
      ]),
    ).rejects.toThrow("blank");
  });
  it("time grammar has exact milliseconds, long hours, and half-open boundaries", () => {
    expect(parseTime("25:59:59,999", "srt")).toBe(93_599_999);
    expect(parseTime("00:00:01,01", "srt")).toBe(null);
    expect(parseTime("01:60.000", "vtt")).toBe(null);
  });
});
describe("alignment graph and rule evidence", () => {
  it("shows 1:2, n:m, same words at different times and union coverage without double counting", async () => {
    const a = (
      await parseDocument(
        enc.encode(
          srt("1", "00:00:01,000 --> 00:00:03,000", "Same") +
            srt("2", "00:00:05,000 --> 00:00:07,000", "Same"),
        ),
        "s.srt",
        "source",
      )
    ).cues;
    const b = (
      await parseDocument(
        enc.encode(
          srt("1", "00:00:01,000 --> 00:00:02,500", "A") +
            srt("2", "00:00:02,000 --> 00:00:03,000", "B"),
        ),
        "t.srt",
        "translation",
      )
    ).cues;
    expect(align(a, b).groups.map((g) => g.type)).toEqual(["1:n", "unmatched"]);
    expect(a[0].id).not.toBe(a[1].id);
    expect(unionCoverage(a[0], b)).toBe(2_000);
    const aa = [
      { ...a[0], endMs: 2_600 },
      { ...a[1], startMs: 2_400, endMs: 3_000 },
    ];
    expect(align(aa, b).groups[0].type).toBe("n:m");
  });
  it("zero/reversed and boundary-touch intervals never get fake overlap", async () => {
    const session = await pair();
    const s = [
      { ...session.source.cues[0], startMs: 0, endMs: 0 },
      { ...session.source.cues[1], startMs: 1_000, endMs: 500 },
      session.source.cues[2],
    ];
    const t = [
      { ...session.translation.cues[0], startMs: 6_000, endMs: 7_000 },
    ];
    expect(align(s, t, 0).edgeCount).toBe(0);
  });
  it("near ties remain ambiguous; unique near creates no temporal coverage", async () => {
    const session = await pair(),
      s = [{ ...session.source.cues[0], startMs: 0, endMs: 100 }],
      t = [
        { ...session.translation.cues[0], startMs: 150, endMs: 250 },
        {
          ...session.translation.cues[0],
          id: "other",
          ordinal: 1,
          startMs: 150,
          endMs: 250,
        },
      ];
    expect(
      align(s, t).groups.every((g) => g.type === "unmatched" && g.ambiguous),
    ).toBe(true);
    expect(align(s, t.slice(0, 1)).groups[0].provenance).toBe("automatic-near");
    expect(unionCoverage(s[0], t)).toBe(0);
  });
  it("large chains are explicit and can be split/merged while preserving complete accounting; edge cap stops work", async () => {
    const session = await pair(),
      baseS = session.source.cues[0],
      baseT = session.translation.cues[0];
    const s = Array.from({ length: 12 }, (_, i) => ({
      ...baseS,
      id: "s" + i,
      ordinal: i,
      startMs: i * 1_000,
      endMs: i * 1_000 + 2_000,
    }));
    const t = Array.from({ length: 12 }, (_, i) => ({
      ...baseT,
      id: "t" + i,
      ordinal: i,
      startMs: i * 1_000 + 500,
      endMs: i * 1_000 + 2_500,
    }));
    const automatic = align(s, t);
    expect(automatic.groups).toHaveLength(1);
    expect(automatic.groups[0].requiresManual).toBe(true);
    const split = splitGroup(automatic.groups, 0);
    validateMapping(split, s, t);
    expect(align(s, t, 200, split).groups).toHaveLength(24);
    validateMapping(mergeGroups(split, [0, 12]), s, t);
    expect(() =>
      validateMapping(
        split.map((g, i) =>
          i === 0 ? { ...g, source: [...g.source, ...g.source] } : g,
        ),
        s,
        t,
      ),
    ).toThrow("duplicated");
    expect(align(s, t, 200, null, 5).incomplete).toBe(true);
  });
  it("counts graphemes and localized numbers with explicit uncertainty", () => {
    expect(graphemeCount("<b>e\u0301 👨‍👩‍👧‍👦</b>\n你")).toBe(4);
    expect(graphemeCount("<img src=x>")).toBe(null);
    expect(numberTokens("100")).toEqual({ raw: ["100"], uncertain: false });
    expect(numberTokens("1,000 / 1.000 / ١٠٠")).toEqual({
      raw: ["1,000", "1.000", "١٠٠"],
      uncertain: true,
    });
  });
  it("all config/mapping/track changes invalidate decisions; exact undo revision revalidates", async () => {
    const session = await pair(),
      reviewed = addDecision(
        session,
        session.analysis.alignment.groups[0].id,
        "accepted",
        "merge checked",
        "",
      );
    const decision = reviewed.decisions[0];
    for (const input of [
      { ...reviewed, config: { ...reviewed.config, maxCps: 20 } },
      {
        ...reviewed,
        manualMapping: splitGroup(reviewed.analysis.alignment.groups, 0),
      },
      {
        ...reviewed,
        translation: await parseDocument(
          enc.encode(targetText.replace("1000", "100")),
          "new.srt",
          "translation",
        ),
        edits: [],
      },
    ])
      expect(isDecisionCurrent(decision, await analyze(input))).toBe(false);
    expect(isDecisionCurrent(decision, await analyze(session))).toBe(true);
  });
});
