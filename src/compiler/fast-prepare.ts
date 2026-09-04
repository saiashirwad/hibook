import ts from "typescript";
import type { Cell, CellId, NotebookDocument } from "../model/types";
import type {
  CellDependencyAnalysis,
  NotebookGraphResult,
} from "../runtime/analysis-types";
import { buildNotebookDependencyGraph } from "../runtime/dependency-graph";
import type {
  CellPreparationErrorCode,
  PreparedCell,
  PreparedCellStatus,
  PreparedGraph,
  PreparedNotebook,
} from "./protocol";
import { revisionForDocument } from "./protocol";

export const INVALID_TYPESCRIPT_ERROR =
  "Cell has invalid TypeScript and was not executed";
export const IMPORTS_UNSUPPORTED_ERROR = "Imports are not supported yet";
export const MODULE_SYNTAX_UNSUPPORTED_ERROR =
  "Module syntax is not supported yet";
export const TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR =
  "Top-level await is not supported yet";

interface TranspiledCellCacheEntry {
  readonly cellId: CellId;
  readonly kind: Cell["kind"];
  readonly source: string;
  readonly code: string;
}

interface AnalyzedCellCacheEntry {
  readonly kind: Cell["kind"];
  readonly source: string;
  readonly analysis: CellDependencyAnalysis;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

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

function provisionalType(
  cell: Cell,
  analysis: CellDependencyAnalysis,
  status: PreparedCellStatus,
): string {
  if (status === "invalid" || status === "cycle") {
    return "unknown";
  }
  if (cell.kind === "text") {
    return "string";
  }
  return analysis.annotation?.text ?? "unknown";
}

function successfulPreparation(
  cell: Cell,
  analysis: CellDependencyAnalysis,
  code: string,
  status: PreparedCellStatus,
): PreparedCell {
  return {
    ok: true,
    cellId: cell.id,
    kind: cell.kind,
    source: cell.source,
    code,
    analysis,
    dependencies: [...analysis.dependencies],
    issues: [...analysis.issues],
    type: provisionalType(cell, analysis, status),
    status,
  };
}

function rejectedPreparation(
  cell: Cell,
  analysis: CellDependencyAnalysis,
  code: CellPreparationErrorCode,
  message: string,
): PreparedCell {
  return {
    ok: false,
    cellId: cell.id,
    kind: cell.kind,
    source: cell.source,
    analysis,
    dependencies: [...analysis.dependencies],
    issues: [...analysis.issues],
    type: "unknown",
    status: "invalid",
    error: { code, message },
  };
}

function structureFingerprint(document: NotebookDocument): string {
  const parts = [document.rootId];
  for (const [cellId, cell] of Object.entries(document.cells)) {
    parts.push(`${cellId}\u0000${cell.name ?? ""}\u0000${cell.children.join("\u0002")}`);
  }
  return parts.join("\u0001");
}

function serializeGraph(graph: NotebookGraphResult): PreparedGraph {
  return {
    order: [...graph.order],
    dependencies: Object.fromEntries(
      graph.order.map((cellId) => [cellId, [...(graph.dependencies.get(cellId) ?? [])]]),
    ),
    dependents: Object.fromEntries(
      graph.order.map((cellId) => [cellId, [...(graph.dependents.get(cellId) ?? [])]]),
    ),
    layers: graph.layers.map((layer) => [...layer]),
    cycleGroups: graph.cycleGroups.map((group) => [...group.cellIds]),
    cycleMembers: [...graph.cycleMembers],
    blockedByCycles: [...graph.blockedByCycles],
  };
}

export class FastPreparationCore {
  readonly #transpiled = new Map<CellId, TranspiledCellCacheEntry>();
  readonly #analyzed = new Map<CellId, AnalyzedCellCacheEntry>();
  #structure: string | undefined;

  prepare(
    document: NotebookDocument,
    revision: string = revisionForDocument(document),
  ): PreparedNotebook {
    const startedAt = now();
    const analysisStartedAt = now();
    const graph = buildNotebookDependencyGraph(
      document,
      this.#reusableAnalyses(document),
    );
    this.#rememberAnalyses(document, graph.analyses);
    const analysisMs = now() - analysisStartedAt;
    const cycleBlocked = new Set([
      ...graph.cycleMembers,
      ...graph.blockedByCycles,
    ]);
    const nextTranspiled = new Map<CellId, TranspiledCellCacheEntry>();
    const preparedCells: PreparedCell[] = [];
    let transpileMs = 0;
    let reusedCells = 0;
    let transpiledCells = 0;

    for (const cellId of graph.order) {
      const cell = document.cells[cellId];
      const analysis = graph.analyses.get(cellId);
      if (!cell || !analysis) {
        continue;
      }
      if (cell.kind === "text") {
        preparedCells.push(successfulPreparation(cell, analysis, "", "text"));
        continue;
      }

      const cached = this.#transpiled.get(cellId);
      let code: string | undefined;
      if (
        cached?.cellId === cell.id &&
        cached.kind === cell.kind &&
        cached.source === cell.source
      ) {
        code = cached.code;
        reusedCells += 1;
      } else {
        const transpileStartedAt = now();
        const sourceFile = ts.createSourceFile(
          `${cell.id}.tsx`,
          cell.source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TSX,
        );
        let errorCode: CellPreparationErrorCode | undefined;
        let errorMessage: string | undefined;
        if (syntaxDiagnostics(sourceFile).length > 0) {
          errorCode = "INVALID_TYPESCRIPT";
          errorMessage = INVALID_TYPESCRIPT_ERROR;
        } else if (hasImport(sourceFile)) {
          errorCode = "IMPORT_UNSUPPORTED";
          errorMessage = IMPORTS_UNSUPPORTED_ERROR;
        } else if (hasUnsupportedModuleSyntax(sourceFile)) {
          errorCode = "MODULE_SYNTAX_UNSUPPORTED";
          errorMessage = MODULE_SYNTAX_UNSUPPORTED_ERROR;
        } else if (hasTopLevelAwait(sourceFile)) {
          errorCode = "TOP_LEVEL_AWAIT_UNSUPPORTED";
          errorMessage = TOP_LEVEL_AWAIT_UNSUPPORTED_ERROR;
        }

        if (errorCode && errorMessage) {
          transpileMs += now() - transpileStartedAt;
          preparedCells.push(
            rejectedPreparation(cell, analysis, errorCode, errorMessage),
          );
          continue;
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
        if (
          (transpiled.diagnostics ?? []).some(
            (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
          )
        ) {
          transpileMs += now() - transpileStartedAt;
          preparedCells.push(
            rejectedPreparation(
              cell,
              analysis,
              "INVALID_TYPESCRIPT",
              INVALID_TYPESCRIPT_ERROR,
            ),
          );
          continue;
        }
        code = transpiled.outputText;
        transpileMs += now() - transpileStartedAt;
        transpiledCells += 1;
      }

      if (code === undefined) {
        throw new Error(`Missing transpiled output for cell: ${cellId}`);
      }
      const cacheEntry = { cellId: cell.id, kind: cell.kind, source: cell.source, code };
      nextTranspiled.set(cellId, cacheEntry);
      const status: PreparedCellStatus = cycleBlocked.has(cellId)
        ? "cycle"
        : analysis.issues.length > 0
          ? "invalid"
          : analysis.annotation
            ? "explicit"
            : "inferred";
      preparedCells.push(successfulPreparation(cell, analysis, code, status));
    }

    this.#transpiled.clear();
    for (const [cellId, entry] of nextTranspiled) {
      this.#transpiled.set(cellId, entry);
    }

    return {
      revision,
      cells: preparedCells,
      graph: serializeGraph(graph),
      timings: {
        totalMs: now() - startedAt,
        analysisMs,
        transpileMs,
        cellCount: preparedCells.length,
        reusedCells,
        transpiledCells,
      },
    };
  }

  #reusableAnalyses(
    document: NotebookDocument,
  ): ReadonlyMap<CellId, CellDependencyAnalysis> {
    const structure = structureFingerprint(document);
    if (structure !== this.#structure) {
      this.#analyzed.clear();
      this.#structure = structure;
    }
    const reusable = new Map<CellId, CellDependencyAnalysis>();
    for (const [cellId, entry] of this.#analyzed) {
      const cell = document.cells[cellId];
      if (cell?.kind === entry.kind && cell.source === entry.source) {
        reusable.set(cellId, entry.analysis);
      }
    }
    return reusable;
  }

  #rememberAnalyses(
    document: NotebookDocument,
    analyses: ReadonlyMap<CellId, CellDependencyAnalysis>,
  ): void {
    this.#analyzed.clear();
    for (const [cellId, analysis] of analyses) {
      const cell = document.cells[cellId];
      if (cell) {
        this.#analyzed.set(cellId, {
          kind: cell.kind,
          source: cell.source,
          analysis,
        });
      }
    }
  }
}

export function prepareExecution(document: NotebookDocument): PreparedNotebook {
  return new FastPreparationCore().prepare(document);
}
