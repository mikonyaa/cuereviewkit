import { it, expect, describe } from "vitest";
import { readFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { decodeZip, encodeZip } from "../../src/package/zip";
import { importPackage, exportPackage } from "../../src/package";
import { renderReport } from "../../src/package/report";
import { sha256 } from "../../src/review/hash";
import { isDecisionCurrent } from "../../src/review/engine";
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
async function sample() {
  return new Uint8Array(await readFile("examples/sample.cue-review.zip"));
}
async function mutated(
  files: Record<string, Uint8Array>,
  path: string,
  value: Uint8Array,
) {
  files[path] = value;
  const m = JSON.parse(decoder.decode(files["manifest.json"]));
  for (const e of m.files)
    if (e.path === path) {
      e.bytes = value.length;
      e.sha256 = await sha256(value);
    }
  files["manifest.json"] = encoder.encode(JSON.stringify(m));
  return encodeZip(files);
}
describe("package trust boundary", () => {
  it("exports very compressible legitimate data as stored entries so its own ratio limit remains importable", async () => {
    const files = decodeZip(await sample());
    files["report.html"] = new Uint8Array(500_000);
    expect(decodeZip(encodeZip(files))["report.html"]).toHaveLength(500_000);
  });
  it("round trips a current approval with exact original hashes and portable logical IDs", async () => {
    const first = (await importPackage(await sample())).session;
    expect(isDecisionCurrent(first.decisions[0], first.analysis)).toBe(true);
    const second = (await importPackage(await exportPackage(first))).session;
    expect(second.analysis.revision).toBe(first.analysis.revision);
    expect(second.analysis.working.map((c) => c.id)).toEqual(
      first.analysis.working.map((c) => c.id),
    );
  });
  it("ignores even checksum-valid attacking HTML and regenerates an inert report", async () => {
    const files = decodeZip(await sample());
    const hostile = encoder.encode(
      '<html><script>globalThis.ATTACK_EXECUTED=1</script><iframe src="https://example.com"></iframe></html>',
    );
    const imported = await importPackage(
      await mutated(files, "report.html", hostile),
    );
    const report = renderReport(imported.session);
    expect(report).not.toContain("ATTACK_EXECUTED");
    expect(report).not.toContain("<script>");
    expect(report).not.toContain("<iframe");
  });
  it("rejects altered bytes, bases, logical IDs, settings and invalid schema", async () => {
    let files = decodeZip(await sample());
    files["originals/source.srt"][0] ^= 1;
    await expect(importPackage(encodeZip(files))).rejects.toThrow("integrity");
    for (const kind of ["base", "identity", "config", "schema"]) {
      files = decodeZip(await sample());
      const review = JSON.parse(decoder.decode(files["review.json"]));
      if (kind === "base") review.originals[0] = "0".repeat(64);
      if (kind === "identity") review.logicalIds.source[0] = "source:wrong:0";
      if (kind === "config") review.config.maxCps = "25";
      if (kind === "schema") review.schemaVersion = 88;
      await expect(
        importPackage(
          await mutated(
            files,
            "review.json",
            encoder.encode(JSON.stringify(review)),
          ),
        ),
      ).rejects.toThrow();
    }
  });
  it("revision conflict stays visible and cannot import a current acceptance", async () => {
    const files = decodeZip(await sample()),
      review = JSON.parse(decoder.decode(files["review.json"]));
    review.revision = "0".repeat(64);
    const result = await importPackage(
      await mutated(
        files,
        "review.json",
        encoder.encode(JSON.stringify(review)),
      ),
    );
    expect(result.warnings[0]).toContain("stale");
    expect(
      isDecisionCurrent(result.session.decisions[0], result.session.analysis),
    ).toBe(false);
  });
  it("rejects prototype keys, traversal, absolute paths, nested files and excess entries", async () => {
    let files = decodeZip(await sample());
    await expect(
      importPackage(
        await mutated(
          files,
          "review.json",
          encoder.encode('{"__proto__":{"polluted":true}}'),
        ),
      ),
    ).rejects.toThrow("Unsafe JSON key");
    for (const path of ["../report.html", "/report.html", "nested.zip"]) {
      files = decodeZip(await sample());
      files[path] = files["report.html"];
      delete files["report.html"];
      expect(() => decodeZip(encodeZip(files))).toThrow("Unsafe");
    }
    files = decodeZip(await sample());
    files["extra.json"] = encoder.encode("{}");
    expect(() => decodeZip(encodeZip(files))).toThrow("six");
  });
  it("rejects actual zip bomb, declared size lies, symlinks, duplicate names and truncation", async () => {
    const files = decodeZip(await sample());
    files["report.html"] = new Uint8Array(2_000_000);
    expect(() => decodeZip(zipSync(files, { level: 9 }))).toThrow("ratio");
    const original = await sample();
    const names = new TextEncoder().encode("report.html"),
      replacement = new TextEncoder().encode("review.json");
    const duplicate = new Uint8Array(original);
    for (let i = 0; i <= duplicate.length - names.length; i++)
      if (names.every((b, j) => duplicate[i + j] === b))
        duplicate.set(replacement, i);
    expect(() => decodeZip(duplicate)).toThrow("duplicate");
    const symlink = new Uint8Array(original),
      v = new DataView(symlink.buffer);
    for (let i = 0; i < symlink.length - 46; i++)
      if (v.getUint32(i, true) === 0x02014b50) {
        v.setUint32(i + 38, 0xa1ff0000, true);
        break;
      }
    expect(() => decodeZip(symlink)).toThrow("symlink");
    const lied = new Uint8Array(original),
      lv = new DataView(lied.buffer);
    for (let i = 0; i < lied.length - 46; i++)
      if (lv.getUint32(i, true) === 0x02014b50) {
        const off = lv.getUint32(i + 42, true);
        lv.setUint32(i + 24, 0, true);
        lv.setUint32(off + 22, 0, true);
        break;
      }
    expect(() => decodeZip(lied)).toThrow();
    expect(() =>
      decodeZip(original.subarray(0, original.length - 12)),
    ).toThrow();
  });
});
