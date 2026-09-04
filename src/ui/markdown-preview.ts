import { HighlightStyle, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const hidden = Decoration.replace({});
const headingLines = [1, 2, 3, 4, 5, 6].map((level) =>
  Decoration.line({ class: `cm-md-heading cm-md-h${level}` }),
);
const INLINE_MARKS = new Set([
  "EmphasisMark",
  "CodeMark",
  "StrikethroughMark",
  "LinkMark",
]);

function activeLines(view: EditorView): ReadonlySet<number> {
  const { doc, selection } = view.state;
  const lines = new Set<number>();
  for (const range of selection.ranges) {
    const from = doc.lineAt(range.from).number;
    const to = doc.lineAt(range.to).number;
    for (let line = from; line <= to; line += 1) lines.add(line);
  }
  return lines;
}

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const editing = activeLines(view);
  const inactive = (position: number): boolean =>
    !editing.has(doc.lineAt(position).number);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const level =
          node.name.startsWith("ATXHeading") || node.name.startsWith("SetextHeading")
            ? Number(node.name.at(-1))
            : 0;
        if (level > 0) {
          const line = doc.lineAt(node.from);
          builder.add(line.from, line.from, headingLines[level - 1]!);
          return;
        }
        if (!inactive(node.from)) return;
        if (node.name === "HeaderMark" && node.node.parent?.name.startsWith("ATX")) {
          const trailing = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
          builder.add(node.from, node.to + trailing, hidden);
        } else if (INLINE_MARKS.has(node.name)) {
          builder.add(node.from, node.to, hidden);
        } else if (
          (node.name === "URL" || node.name === "LinkTitle") &&
          node.node.parent?.name === "Link"
        ) {
          builder.add(node.from, node.to, hidden);
        }
      },
    });
  }
  return builder.finish();
}

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.selectionSet ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = decorate(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: "var(--ink-strong)", fontWeight: "620" },
  { tag: tags.strong, fontWeight: "620" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  {
    tag: tags.monospace,
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    color: "var(--ink-strong)",
  },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--ink-muted)" },
  { tag: tags.processingInstruction, color: "var(--ink-faint)" },
  { tag: tags.quote, color: "var(--ink-muted)" },
  { tag: tags.labelName, color: "var(--ink-faint)" },
  { tag: tags.contentSeparator, color: "var(--ink-faint)" },
]);

const livePreviewTheme = EditorView.theme({
  ".cm-md-heading": { lineHeight: "1.3", padding: "0.35em 0 0.15em" },
  ".cm-md-h1": { fontSize: "1.5em" },
  ".cm-md-h2": { fontSize: "1.3em" },
  ".cm-md-h3": { fontSize: "1.12em" },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontSize: "1em" },
  ".cm-md-heading:first-child": { paddingTop: "0" },
});

export const markdownLivePreview: Extension = [livePreviewPlugin, livePreviewTheme];
