import ts from "typescript";
import type { Cell, CellId, NotebookDocument } from "../model/types";
import type { CellDependencyAnalysis } from "./analysis-types";
import { analyzeCellDependencies } from "./analyze-dependencies";

export const INVALID_TYPESCRIPT_ERROR =
  "Cell has invalid TypeScript and was not executed";
export const IMPORTS_UNSUPPORTED_ERROR = "Imports are not supported yet";
export const MODULE_SYNTAX_UNSUPPORTED_ERROR =
  "Module syntax is not supported yet";
export const TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR =
  "Top-level await is not supported yet";

export type CellPreparationErrorCode =
  | "INVALID_TYPESCRIPT"
  | "IMPORT_UNSUPPORTED"
  | "MODULE_SYNTAX_UNSUPPORTED"
  | "TOP_LEVEL_AWAIT_UNSUPPORTED";

export interface CellPreparationError {
  readonly code: CellPreparationErrorCode;
  readonly message: string;
}

interface PreparedCellBase {
  readonly cellId: CellId;
  readonly kind: Cell["kind"];
  readonly source: string;
  readonly analysis: CellDependencyAnalysis;
}

export type PreparedCell =
  | (PreparedCellBase & {
      readonly ok: true;
      readonly code: string;
    })
  | (PreparedCellBase & {
      readonly ok: false;
      readonly error: CellPreparationError;
    });

export type CellPreparer = (
  document: NotebookDocument,
  cell: Cell,
  analysis: CellDependencyAnalysis,
) => PreparedCell;

function syntaxDiagnostics(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (
    sourceFile as ts.SourceFile & {
      readonly parseDiagnostics?: readonly ts.Diagnostic[];
    }
  ).parseDiagnostics ?? [];
}

function hasImport(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isImportTypeNode(node) ||
      (ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function hasUnsupportedModuleSyntax(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    const hasExportModifier =
      ts.canHaveModifiers(node) &&
      ts
        .getModifiers(node)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isImportMeta =
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword &&
      node.name.text === "meta";
    if (
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node) ||
      ts.isNamespaceExportDeclaration(node) ||
      hasExportModifier ||
      isImportMeta
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function hasTopLevelAwait(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (
      ts.isAwaitExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier !== undefined)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function rejectedPreparation(
  cell: Cell,
  analysis: CellDependencyAnalysis,
  code: CellPreparationErrorCode,
  message: string,
): PreparedCell {
  return Object.freeze({
    ok: false,
    cellId: cell.id,
    kind: cell.kind,
    source: cell.source,
    analysis,
    error: Object.freeze({ code, message }),
  });
}

export const prepareCellSynchronously: CellPreparer = (
  document,
  cell,
  analysis,
) => {
  void document;
  if (cell.kind === "text") {
    return Object.freeze({
      ok: true,
      cellId: cell.id,
      kind: cell.kind,
      source: cell.source,
      analysis,
      code: "",
    });
  }

  const sourceFile = ts.createSourceFile(
    `${cell.id}.tsx`,
    cell.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  if (syntaxDiagnostics(sourceFile).length > 0) {
    return rejectedPreparation(
      cell,
      analysis,
      "INVALID_TYPESCRIPT",
      INVALID_TYPESCRIPT_ERROR,
    );
  }
  if (hasImport(sourceFile)) {
    return rejectedPreparation(
      cell,
      analysis,
      "IMPORT_UNSUPPORTED",
      IMPORTS_UNSUPPORTED_ERROR,
    );
  }
  if (hasUnsupportedModuleSyntax(sourceFile)) {
    return rejectedPreparation(
      cell,
      analysis,
      "MODULE_SYNTAX_UNSUPPORTED",
      MODULE_SYNTAX_UNSUPPORTED_ERROR,
    );
  }
  if (hasTopLevelAwait(sourceFile)) {
    return rejectedPreparation(
      cell,
      analysis,
      "TOP_LEVEL_AWAIT_UNSUPPORTED",
      TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR,
    );
  }

  const transpiled = ts.transpileModule(cell.source, {
    fileName: `${cell.id}.tsx`,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.Preserve,
      isolatedModules: true,
    },
  });
  if ((transpiled.diagnostics ?? []).some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    return rejectedPreparation(
      cell,
      analysis,
      "INVALID_TYPESCRIPT",
      INVALID_TYPESCRIPT_ERROR,
    );
  }

  return Object.freeze({
    ok: true,
    cellId: cell.id,
    kind: cell.kind,
    source: cell.source,
    analysis,
    code: transpiled.outputText,
  });
};

export function prepareNotebookSynchronously(
  document: NotebookDocument,
): ReadonlyMap<CellId, PreparedCell> {
  const prepared = new Map<CellId, PreparedCell>();
  for (const cell of Object.values(document.cells)) {
    const analysis = analyzeCellDependencies(document, cell);
    prepared.set(
      cell.id,
      prepareCellSynchronously(document, cell, analysis),
    );
  }
  return prepared;
}
