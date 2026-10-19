/**
 * Lightweight proto formatter: normalize indentation by braces, keep blank lines.
 * Not a full clang-format replacement, but enough for day-to-day editing.
 */
export function formatProto(source: string): string {
  const nl = source.includes("\r\n") ? "\r\n" : "\n";
  const rawLines = source.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let depth = 0;
  let inBlockComment = false;

  for (const raw of rawLines) {
    const line = raw.replace(/\t/g, "  ").replace(/\s+$/g, "");
    const trimmed = line.trim();
    if (!trimmed) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }

    if (inBlockComment) {
      out.push(indent(depth) + trimmed);
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      out.push(indent(depth) + trimmed);
      inBlockComment = true;
      continue;
    }

    const opens = countCharOutside(trimmed, "{");
    const closes = countCharOutside(trimmed, "}");
    const startsWithClose = trimmed.startsWith("}");
    const lineDepth = startsWithClose ? Math.max(0, depth - 1) : depth;
    out.push(indent(lineDepth) + trimmed);
    depth = Math.max(0, depth + opens - closes);
  }

  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join(nl) + nl;
}

function indent(depth: number): string {
  return "  ".repeat(Math.max(0, depth));
}

function countCharOutside(text: string, ch: string): number {
  let count = 0;
  let inString = false;
  let stringQuote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === stringQuote) inString = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringQuote = c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") break;
    if (c === ch) count++;
  }
  return count;
}
