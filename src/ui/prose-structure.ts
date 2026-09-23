export interface ProseSplit {
  readonly before: string;
  readonly after: string;
}

const PARAGRAPH_BREAK = /\n[ \t]*\n/;

/**
 * Split prose at a cursor. A cursor inside a paragraph keeps both sides.
 * A cursor on the blank gap between paragraphs gives each paragraph to its
 * own cell, so the new note does not open with an empty line.
 */
export function splitProse(source: string, cursor: number): ProseSplit {
  const at = Math.max(0, Math.min(cursor, source.length));
  const before = source.slice(0, at);
  const after = source.slice(at);
  const trailing = /(?:[ \t]*\n[ \t]*)+$/u.exec(before)?.[0] ?? "";
  const leading = /^(?:[ \t]*\n)*/u.exec(after)?.[0] ?? "";
  if (!PARAGRAPH_BREAK.test(trailing + leading)) return { before, after };
  return {
    before: before.slice(0, before.length - trailing.length),
    after: after.slice(leading.length),
  };
}

/** The executable program a prose passage becomes, without inventing a calculation. */
export function proseProgram(kind: "javascript" | "markdown", prose: string): string {
  const body = prose.trim();
  if (kind === "javascript") {
    return body === "" ? "const value = 0" : `const value = ${JSON.stringify(body)}`;
  }
  const literal = body.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `md\`${literal}\``;
}
