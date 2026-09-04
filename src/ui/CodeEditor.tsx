import { autocompletion } from "@codemirror/autocomplete";
import type { Completion } from "@codemirror/autocomplete";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { setDiagnostics } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { createEffect, onSettled } from "solid-js";
import type { CellKind } from "../model/types";
import type {
  SemanticCompletionResult,
  SemanticDiagnostic,
  SemanticQuickInfo,
} from "../compiler/semantic-protocol";

interface CodeEditorProps {
  readonly source: string;
  readonly kind: CellKind;
  readonly ariaLabel: string;
  readonly focused?: boolean;
  readonly onChange: (source: string) => void;
  readonly onRun: () => void;
  readonly onBlur?: () => void;
  readonly diagnostics?: readonly SemanticDiagnostic[];
  readonly onComplete?: (position: number) => Promise<SemanticCompletionResult>;
  readonly onQuickInfo?: (position: number) => Promise<SemanticQuickInfo | undefined>;
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

const COMPLETION_TYPE_BY_KIND: Readonly<Record<string, Completion["type"]>> = {
  class: "class",
  const: "constant",
  enum: "enum",
  function: "function",
  interface: "interface",
  keyword: "keyword",
  let: "variable",
  memberFunctionElement: "method",
  memberGetAccessorElement: "property",
  memberSetAccessorElement: "property",
  memberVariableElement: "property",
  method: "method",
  module: "namespace",
  property: "property",
  type: "type",
  var: "variable",
};

function codeMirrorDiagnostics(
  diagnostics: readonly SemanticDiagnostic[],
): readonly Diagnostic[] {
  return diagnostics.map((diagnostic) => ({
    from: diagnostic.from,
    to: diagnostic.to,
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: "TypeScript",
  }));
}

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

  createEffect(
    () => props.diagnostics ?? [],
    (diagnostics) => {
      if (!view) return;
      view.dispatch(setDiagnostics(view.state, codeMirrorDiagnostics(diagnostics)));
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
      if (props.onComplete) {
        extensions.push(
          autocompletion({
            activateOnTyping: false,
            override: [
              async (context) => {
                if (!context.explicit) return null;
                try {
                  const completion = await props.onComplete?.(context.pos);
                  if (!completion || context.aborted) return null;
                  return {
                    from: completion.from,
                    to: completion.to,
                    options: completion.items.map((item) => {
                      const type = COMPLETION_TYPE_BY_KIND[item.kind];
                      return {
                        label: item.label,
                        ...(type === undefined ? {} : { type }),
                        ...(item.detail ? { detail: item.detail } : {}),
                        apply: item.applyText,
                      };
                    }),
                  };
                } catch {
                  return null;
                }
              },
            ],
          }),
        );
      }
      if (props.onQuickInfo) {
        extensions.push(
          hoverTooltip(
            async (_editor, position) => {
              try {
                const quickInfo = await props.onQuickInfo?.(position);
                if (!quickInfo) return null;
                return {
                  pos: quickInfo.from,
                  end: quickInfo.to,
                  above: true,
                  create() {
                    const dom = document.createElement("div");
                    dom.className = "cm-semantic-hover";
                    dom.textContent = quickInfo.text;
                    return { dom };
                  },
                };
              } catch {
                return null;
              }
            },
            { hideOnChange: true },
          ),
        );
      }

    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: props.source, extensions }),
    });
    view.dispatch(
      setDiagnostics(
        view.state,
        codeMirrorDiagnostics(props.diagnostics ?? []),
      ),
    );
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
