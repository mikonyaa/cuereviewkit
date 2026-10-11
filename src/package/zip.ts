import {
  Unzip,
  UnzipInflate,
  zipSync,
  deflateSync,
  type Zippable,
} from "fflate";
import { LIMITS } from "../review/types";
const decoder = new TextDecoder("utf-8", { fatal: true });
const allowed =
  /^(?:manifest\.json|review\.json|report\.html|originals\/(?:source|translation)\.(?:srt|vtt)|working\/translation\.(?:srt|vtt))$/;
export function encodeZip(files: Record<string, Uint8Array>): Uint8Array {
  const safe: Zippable = Object.create(null);
  for (const [name, bytes] of Object.entries(files)) {
    const compressed = deflateSync(bytes, { level: 6 });
    safe[name] = [
      bytes,
      {
        level:
          bytes.length / Math.max(1, compressed.length) > LIMITS.ratio ? 0 : 6,
      },
    ];
  }
  return zipSync(safe, { level: 6 });
}
interface Entry {
  name: string;
  size: number;
  compressed: number;
  method: number;
  crc: number;
  dataStart: number;
  dataEnd: number;
}
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function inspect(data: Uint8Array): Entry[] {
  if (data.length > LIMITS.packageBytes || data.length < 22)
    throw new Error("Package must be a ZIP of at most 30 MiB.");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--)
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0 || eocd + 22 + v.getUint16(eocd + 20, true) !== data.length)
    throw new Error("Invalid ZIP directory.");
  const count = v.getUint16(eocd + 10, true),
    directory = v.getUint32(eocd + 16, true),
    directorySize = v.getUint32(eocd + 12, true);
  if (
    v.getUint16(eocd + 4, true) ||
    v.getUint16(eocd + 6, true) ||
    count !== v.getUint16(eocd + 8, true) ||
    count !== LIMITS.entries ||
    directory + directorySize !== eocd
  )
    throw new Error(
      "Expected one ZIP volume and exactly six package files; ZIP64 is unsupported.",
    );
  let pos = directory,
    total = 0;
  const names = new Set<string>(),
    entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > eocd || v.getUint32(pos, true) !== 0x02014b50)
      throw new Error("Malformed ZIP entry.");
    const flags = v.getUint16(pos + 8, true),
      method = v.getUint16(pos + 10, true),
      compressed = v.getUint32(pos + 20, true),
      size = v.getUint32(pos + 24, true),
      nl = v.getUint16(pos + 28, true),
      el = v.getUint16(pos + 30, true),
      cl = v.getUint16(pos + 32, true),
      offset = v.getUint32(pos + 42, true),
      mode = v.getUint32(pos + 38, true) >>> 16;
    if (pos + 46 + nl + el + cl > eocd)
      throw new Error("ZIP entry exceeds directory.");
    const name = decoder.decode(data.subarray(pos + 46, pos + 46 + nl));
    if (
      !allowed.test(name) ||
      names.has(name) ||
      flags & ~0x800 ||
      ![0, 8].includes(method) ||
      (mode & 0xf000) === 0xa000 ||
      v.getUint16(pos + 34, true)
    )
      throw new Error(
        "Unsafe/duplicate ZIP path, encrypted entry, symlink, or unsupported compression.",
      );
    names.add(name);
    total += size;
    if (
      total > LIMITS.unpackedBytes ||
      size > LIMITS.unpackedBytes ||
      size / Math.max(1, compressed) > LIMITS.ratio
    )
      throw new Error("ZIP unpacked size or compression ratio exceeds limits.");
    if (
      offset + 30 > directory ||
      v.getUint32(offset, true) !== 0x04034b50 ||
      v.getUint16(offset + 6, true) !== flags ||
      v.getUint16(offset + 8, true) !== method ||
      v.getUint32(offset + 18, true) !== compressed ||
      v.getUint32(offset + 22, true) !== size ||
      v.getUint32(offset + 14, true) !== v.getUint32(pos + 16, true)
    )
      throw new Error("ZIP local and directory headers disagree.");
    const localNl = v.getUint16(offset + 26, true),
      localEl = v.getUint16(offset + 28, true),
      dataStart = offset + 30 + localNl + localEl,
      dataEnd = dataStart + compressed;
    if (
      dataEnd > directory ||
      decoder.decode(data.subarray(offset + 30, offset + 30 + localNl)) !== name
    )
      throw new Error("ZIP local name or extent mismatch.");
    entries.push({
      name,
      size,
      compressed,
      method,
      crc: v.getUint32(pos + 16, true),
      dataStart,
      dataEnd,
    });
    pos += 46 + nl + el + cl;
  }
  if (
    pos !== eocd ||
    !names.has("manifest.json") ||
    !names.has("review.json") ||
    !names.has("report.html") ||
    entries.filter((e) => e.name.startsWith("originals/")).length !== 2 ||
    entries.filter((e) => e.name.startsWith("working/")).length !== 1
  )
    throw new Error("Incomplete or invalid package file list.");
  const ranges = [...entries].sort((a, b) => a.dataStart - b.dataStart);
  let end = 0;
  for (const e of ranges) {
    const header = e.dataStart - 30 - new TextEncoder().encode(e.name).length;
    if (header < end) throw new Error("Overlapping ZIP entries.");
    end = e.dataEnd;
  }
  return entries;
}
export function decodeZip(data: Uint8Array): Record<string, Uint8Array> {
  const entries = inspect(data),
    metadata = new Map(entries.map((e) => [e.name, e]));
  const result: Record<string, Uint8Array> = Object.create(null),
    seen = new Set<string>();
  let actualTotal = 0;
  const unzip = new Unzip((file) => {
    const info = metadata.get(file.name);
    if (!info || seen.has(file.name))
      throw new Error("Unexpected streaming ZIP entry.");
    seen.add(file.name);
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      actualTotal += chunk.length;
      if (
        size > info.size ||
        actualTotal > LIMITS.unpackedBytes ||
        size / Math.max(1, info.compressed) > LIMITS.ratio
      ) {
        file.terminate();
        throw new Error("Actual decompression exceeds package limits.");
      }
      chunks.push(chunk);
      if (final) {
        if (size !== info.size)
          throw new Error("Actual ZIP size differs from its header.");
        const bytes = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.length;
        }
        if (crc32(bytes) !== info.crc) throw new Error("ZIP CRC mismatch.");
        result[file.name] = bytes;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < data.length; i += 4_096)
    unzip.push(data.subarray(i, i + 4_096), i + 4_096 >= data.length);
  if (Object.keys(result).length !== entries.length)
    throw new Error("Truncated ZIP payload.");
  return result;
}
