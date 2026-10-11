// Rendering always uses inert text. This recognizer exists only for visible grapheme counts.
export function visibleText(text: string): string | null {
  const stack: string[] = [];
  let visible = "";
  for (let i = 0; i < text.length;) {
    if (text[i] !== "<") {
      visible += text[i++];
      continue;
    }
    const end = text.indexOf(">", i);
    if (end < 0) return null;
    const token = text.slice(i, end + 1);
    const m = /^<(\/?)(b|i|u)>$/.exec(token);
    if (!m) return null;
    if (m[1]) {
      if (stack.pop() !== m[2]) return null;
    } else stack.push(m[2]);
    i = end + 1;
  }
  if (stack.length || /&(?:#\d+|#x[\da-f]+|\w+);/i.test(visible)) return null;
  return visible.replace(/\r?\n/g, "");
}
export function graphemeCount(text: string, locale = "und"): number | null {
  const visible = visibleText(text);
  if (visible === null || typeof Intl.Segmenter === "undefined") return null;
  return Array.from(
    new Intl.Segmenter(locale, { granularity: "grapheme" }).segment(visible),
  ).length;
}
