import { autocompletion } from "@codemirror/autocomplete";
import type { Completion } from "@codemirror/autocomplete";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { setDiagnostics } from "@codemirror/lint";
import type { Diagnostic } from "@codemirror/lint";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightSpecialChars,
  hoverTooltip,
  keymap,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { createEffect, onSettled } from "solid-js";
import type { CellKind } from "../model/types";
import type {
  SemanticCompletionResult,
  SemanticDiagnostic,
  SemanticQuickInfo,
} from "../compiler/semantic-protocol";
import { markdownHighlightStyle, markdownLivePreview } from "./markdown-preview";

interface CodeEditorProps {
  readonly source: string;
  readonly kind: CellKind;
  readonly ariaLabel: string;
  readonly focused?: boolean;
  readonly onChange: (source: string) => void;
  readonly onRun: () => void;
  readonly onCreateAfter?: () => void;
  readonly onBlur?: () => void;
  readonly diagnostics?: readonly SemanticDiagnostic[] | undefined;
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
    overflow: "visible",
    fontFamily: "inherit",
    lineHeight: "inherit",
  },
  ".cm-content": {
    minHeight: "1lh",
    padding: "0",
    caretColor: "var(--accent)",
  },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--selection)",
  },
  ".cm-matchingBracket": {
    backgroundColor: "var(--accent-soft)",
    outline: "none",
  },
  ".cm-tooltip": {
    border: "1px solid var(--line)",
    borderRadius: "6px",
    backgroundColor: "var(--canvas-raised)",
    color: "var(--ink)",
    boxShadow: "0 4px 16px rgb(20 24 34 / 0.08)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.78rem",
    maxHeight: "16rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "0.15rem 0.5rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--selection)",
    color: "var(--ink-strong)",
  },
  ".cm-tooltip .cm-completionDetail": {
    color: "var(--ink-faint)",
    fontStyle: "normal",
    marginLeft: "0.6rem",
  },
  ".cm-tooltip.cm-tooltip-lint": { padding: "0" },
  ".cm-diagnostic": {
    padding: "0.3rem 0.55rem",
    fontSize: "0.78rem",
    borderLeft: "0",
  },
  ".cm-diagnostic-error": { boxShadow: "inset 2px 0 var(--danger)" },
  ".cm-diagnostic-warning": { boxShadow: "inset 2px 0 var(--syntax-type)" },
  ".cm-lintRange-error": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--danger)",
    textDecorationSkipInk: "none",
  },
  ".cm-lintRange-warning": {
    backgroundImage: "none",
    textDecoration: "underline wavy var(--syntax-type)",
    textDecorationSkipInk: "none",
  },
  ".cm-quick-info": {
    maxWidth: "min(44rem, 80vw)",
    padding: "0.45rem 0.6rem",
    fontFamily: "var(--font-mono)",
    fontSize: "0.76rem",
    lineHeight: "1.5",
    whiteSpace: "pre-wrap",
  },
  ".cm-quick-info-doc": {
    marginTop: "0.4rem",
    paddingTop: "0.4rem",
    borderTop: "1px solid var(--line)",
    color: "var(--ink-muted)",
    fontFamily: "var(--font-ui)",
    fontSize: "0.78rem",
  },
  ".cm-quick-info [data-part='keyword']": { color: "var(--syntax-keyword)" },
  ".cm-quick-info [data-part='stringLiteral']": { color: "var(--syntax-string)" },
  ".cm-quick-info [data-part='numericLiteral']": { color: "var(--syntax-number)" },
  ".cm-quick-info [data-part='punctuation'], .cm-quick-info [data-part='operator']": {
    color: "var(--syntax-operator)",
  },
  ".cm-quick-info [data-part='text']": { color: "var(--ink-muted)" },
  [[
    "propertyName",
    "methodName",
    "functionName",
    "localName",
    "parameterName",
    "aliasName",
    "enumMemberName",
  ]
    .map((kind) => `.cm-quick-info [data-part='${kind}']`)
    .join(", ")]: { color: "var(--syntax-name)" },
  [[
    "className",
    "interfaceName",
    "typeParameterName",
    "enumName",
    "moduleName",
    "typeName",
  ]
    .map((kind) => `.cm-quick-info [data-part='${kind}']`)
    .join(", ")]: { color: "var(--syntax-type)" },
});

const codeHighlightStyle = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "var(--syntax-keyword)" },
  { tag: [tags.definitionKeyword, tags.controlKeyword], color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "var(--syntax-number)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syntax-type)" },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: "var(--syntax-name)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syntax-name)" },
  { tag: [tags.definition(tags.variableName)], color: "var(--ink-strong)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [tags.operator, tags.punctuation], color: "var(--syntax-operator)" },
  { tag: tags.invalid, color: "var(--danger)" },
]);

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

const NO_DIAGNOSTICS: readonly SemanticDiagnostic[] = [];

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

function quickInfoDom(quickInfo: SemanticQuickInfo): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "cm-quick-info";
  for (const part of quickInfo.parts) {
    const span = document.createElement("span");
    span.dataset.part = part.kind;
    span.textContent = part.text;
    dom.append(span);
  }
  if (quickInfo.documentation) {
    const doc = document.createElement("div");
    doc.className = "cm-quick-info-doc";
    doc.textContent = quickInfo.documentation;
    dom.append(doc);
  }
  return dom;
}

function languageExtensions(kind: CellKind): Extension[] {
  if (kind === "text") {
    return [
      markdown({
        base: markdownLanguage,
        codeLanguages: (info) =>
          /^(js|javascript|ts|typescript)$/i.test(info) ? javascriptLanguage : null,
      }),
      syntaxHighlighting(markdownHighlightStyle),
      syntaxHighlighting(codeHighlightStyle),
      markdownLivePreview,
      keymap.of(markdownKeymap),
    ];
  }
  return [
    javascript({ typescript: true }),
    syntaxHighlighting(codeHighlightStyle),
    bracketMatching(),
    indentOnInput(),
  ];
}

export default function CodeEditor(props: CodeEditorProps) {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let applyingExternalChange = false;
  let appliedDiagnostics = NO_DIAGNOSTICS;

  const applyDiagnostics = (diagnostics: readonly SemanticDiagnostic[]) => {
    if (!view || diagnostics === appliedDiagnostics) return;
    appliedDiagnostics = diagnostics;
    view.dispatch(setDiagnostics(view.state, codeMirrorDiagnostics(diagnostics)));
  };

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
    () => props.diagnostics ?? NO_DIAGNOSTICS,
    (diagnostics) => applyDiagnostics(diagnostics),
  );

  onSettled(() => {
    if (!host) return;

    const runCurrentCell = () => {
      props.onRun();
      return true;
    };
    const createCellAfter = () => {
      props.onCreateAfter?.();
      return true;
    };
    const extensions: Extension[] = [
      history(),
      drawSelection(),
      highlightSpecialChars(),
      ...languageExtensions(props.kind),
      EditorView.lineWrapping,
      editorTheme,
      keymap.of([
        { key: "Mod-Enter", run: runCurrentCell },
        { key: "Ctrl-Enter", run: runCurrentCell },
        { key: "Shift-Enter", run: createCellAfter },
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
              if (!quickInfo || quickInfo.parts.length === 0) return null;
              return {
                pos: quickInfo.from,
                end: quickInfo.to,
                above: true,
                create: () => ({ dom: quickInfoDom(quickInfo) }),
              };
            } catch {
              return null;
            }
          },
          { hideOnChange: true, hoverTime: 250 },
        ),
      );
    }

    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: props.source, extensions }),
    });
    applyDiagnostics(props.diagnostics ?? NO_DIAGNOSTICS);
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
