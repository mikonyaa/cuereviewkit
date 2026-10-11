export function parseTime(raw: string, format: "srt" | "vtt"): number | null {
  const pattern =
    format === "srt"
      ? /^(\d{2,}):([0-5]\d):([0-5]\d),(\d{3})$/
      : /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
  const m = pattern.exec(raw);
  if (!m) return null;
  const value =
    Number(m[1] ?? 0) * 3_600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1_000 +
    Number(m[4]);
  return Number.isSafeInteger(value) ? value : null;
}
export function formatTime(ms: number, format: "srt" | "vtt" = "srt"): string {
  if (!Number.isSafeInteger(ms) || ms < 0)
    throw new Error(
      "Time must be a non-negative safe integer in milliseconds.",
    );
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1_000) % 60)}${format === "srt" ? "," : "."}${pad(ms % 1_000, 3)}`;
}
export const displayTime = (ms: number) => formatTime(ms, "vtt");
