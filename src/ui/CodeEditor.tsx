import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { createEffect, onSettled } from "solid-js";
import type { CellKind } from "../model/types";

interface CodeEditorProps {
  readonly source: string;
  readonly kind: CellKind;
  readonly ariaLabel: string;
  readonly focused?: boolean;
  readonly onChange: (source: string) => void;
  readonly onRun: () => void;
  readonly onBlur?: () => void;
}

const editorTheme = EditorView.theme({
  "&": {
    width: "100%",
    color: "var(--ink)",
    backgroundColor: "transparent",
    fontSize: "inherit",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    fontFamily: "inherit",
    lineHeight: "inherit",
  },
  ".cm-content": {
    minHeight: "1lh",
    padding: "0",
    caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection)",
  },
  ".cm-gutters": {
    border: "0",
    color: "var(--ink-faint)",
    backgroundColor: "transparent",
  },
  ".cm-activeLine, .cm-activeLineGutter": {
    backgroundColor: "var(--accent-soft)",
  },
});

function languageFor(kind: CellKind): Extension {
  return kind === "text" ? markdown() : javascript({ typescript: true });
}

export default function CodeEditor(props: CodeEditorProps) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let applyingExternalChange = false;

  createEffect(
    () => props.source,
    (source) => {
      if (!view || source === view.state.doc.toString()) return;

      applyingExternalChange = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: source },
        });
      } finally {
        applyingExternalChange = false;
      }
    },
  );

  createEffect(
    () => props.focused ?? false,
    (focused) => {
      if (focused && view && !view.hasFocus) view.focus();
    },
  );

  onSettled(() => {
    if (!host) return;

    const runCurrentCell = () => {
      props.onRun();
      return true;
    };
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      highlightSpecialChars(),
      indentOnInput(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      languageFor(props.kind),
      EditorView.lineWrapping,
      editorTheme,
      keymap.of([
        { key: "Mod-Enter", run: runCurrentCell },
        { key: "Ctrl-Enter", run: runCurrentCell },
        {
          key: "Escape",
          run(editor) {
            editor.contentDOM.blur();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.contentAttributes.of({ "aria-label": props.ariaLabel }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternalChange) {
          props.onChange(update.state.doc.toString());
        }
      }),
      EditorView.domEventHandlers({
        blur() {
          props.onBlur?.();
          return false;
        },
      }),
    ];

    if (props.kind !== "text") {
      extensions.push(
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
      );
    }

    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: props.source, extensions }),
    });
    if (props.focused) view.focus();

    return () => {
      view?.destroy();
      view = undefined;
    };
  });

  return (
    <div
      ref={(element) => {
        host = element;
      }}
    />
  );
}
