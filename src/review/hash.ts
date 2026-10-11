const encoder = new TextEncoder();
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
}
export const contentHash = (cue: {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  identifier?: string;
  number?: string;
}) =>
  sha256(
    canonical({
      id: cue.id,
      startMs: cue.startMs,
      endMs: cue.endMs,
      text: cue.text,
      identifier: cue.identifier ?? "",
      number: cue.number ?? "",
    }),
  );
export async function hashCues<T extends Parameters<typeof contentHash>[0]>(
  cues: T[],
): Promise<(T & { contentHash: string })[]> {
  const result: (T & { contentHash: string })[] = [];
  for (let i = 0; i < cues.length; i += 64)
    result.push(
      ...(await Promise.all(
        cues
          .slice(i, i + 64)
          .map(async (c) => ({ ...c, contentHash: await contentHash(c) })),
      )),
    );
  return result;
}
