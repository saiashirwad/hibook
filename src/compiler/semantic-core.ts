import ts from "typescript";
import type { Cell, CellId } from "../model/types";
import { preparedDownstreamClosure, revisionForDocument } from "./protocol";
import { BUNDLED_TYPESCRIPT_LIBS } from "./semantic-libs";
import type {
  SemanticCellResult,
  SemanticCellStatus,
  SemanticCompletionItem,
  SemanticCompletionResult,
  SemanticDiagnostic,
  SemanticDiagnosticSeverity,
  SemanticNotebookResult,
  SemanticProjectInput,
  SemanticQuickInfo,
} from "./semantic-protocol";

export const NOTEBOOK_SCHEMA_PATH = "/notebook-schema.d.ts";

export function encodedCellId(cellId: CellId): string {
  return encodeURIComponent(cellId);
}

export function contextPathForCell(cellId: CellId): string {
  return `/context-${encodedCellId(cellId)}.d.ts`;
}

export function sourcePathForCell(cellId: CellId): string {
  return `/cell-${encodedCellId(cellId)}.ts`;
}

interface VirtualFile {
  readonly source: string;
  readonly version: number;
}

export interface VfsCounters {
  readonly writes: number;
  readonly skips: number;
}

export class ContentAwareVfs {
  readonly #files = new Map<string, VirtualFile>();
  #writes = 0;
  #skips = 0;
  #projectVersion = 0;

  constructor(seed: ReadonlyMap<string, string> = new Map()) {
    for (const [path, source] of seed) {
      this.#files.set(path, { source, version: 0 });
    }
  }

  write(path: string, source: string): boolean {
    const current = this.#files.get(path);
    if (current?.source === source) {
      this.#skips += 1;
      return false;
    }
    this.#files.set(path, {
      source,
      version: (current?.version ?? -1) + 1,
    });
    this.#writes += 1;
    this.#projectVersion += 1;
    return true;
  }

  read(path: string): string | undefined {
    return this.#files.get(path)?.source;
  }

  has(path: string): boolean {
    return this.#files.has(path);
  }

  version(path: string): string {
    return String(this.#files.get(path)?.version ?? 0);
  }

  projectVersion(): string {
    return String(this.#projectVersion);
  }

  counters(): VfsCounters {
    return { writes: this.#writes, skips: this.#skips };
  }
}

interface SourceMapping {
  readonly cellId: CellId;
  readonly path: string;
  readonly sourceStart: number;
  readonly sourceLength: number;
}

interface CachedCellState {
  readonly fingerprint: string;
  readonly result: SemanticCellResult;
}

export type SemanticClock = () => number;

const DEFAULT_CLOCK: SemanticClock = () =>
  typeof performance === "undefined" ? Date.now() : performance.now();

const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowImportingTsExtensions: true,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  noUncheckedIndexedAccess: true,
  skipLibCheck: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
};

function parentIds(input: SemanticProjectInput): ReadonlyMap<CellId, CellId> {
  const parents = new Map<CellId, CellId>();
  for (const cell of Object.values(input.document.cells)) {
    for (const childId of cell.children) {
      if (!parents.has(childId)) parents.set(childId, cell.id);
    }
  }
  return parents;
}

function cellFingerprint(cell: Cell): string {
  return `${cell.kind}\u0000${cell.source}`;
}

function executable(cell: Cell): boolean {
  return cell.kind !== "text";
}

function affectedCells(input: SemanticProjectInput): ReadonlySet<CellId> {
  if (input.changedCellIds === undefined) {
    return new Set(input.prepared.graph.order);
  }
  return new Set(
    preparedDownstreamClosure(
      input.prepared.graph,
      input.changedCellIds.filter((cellId) =>
        Object.hasOwn(input.document.cells, cellId),
      ),
    ),
  );
}

function diagnosticSeverity(category: ts.DiagnosticCategory): SemanticDiagnosticSeverity {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "hint";
    case ts.DiagnosticCategory.Message:
      return "info";
  }
}

function analysisResult(
  cellId: CellId,
  status: SemanticCellStatus,
  type: string,
  diagnostics: readonly SemanticDiagnostic[] = [],
): SemanticCellResult {
  return {
    cellId,
    authoritative: true,
    type,
    status,
    diagnostics,
  };
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function propertyName(name: string): string {
  return quoted(name);
}

function contextSource(
  input: SemanticProjectInput,
  cellId: CellId,
  parents: ReadonlyMap<CellId, CellId>,
): string {
  const parentId = parents.get(cellId);
  const parentType = parentId
    ? `NotebookHandle<${quoted(parentId)}>`
    : "undefined";
  return [
    `import type { NotebookHandle } from ${quoted(NOTEBOOK_SCHEMA_PATH.slice(0, -5))};`,
    "export interface NotebookContext {",
    `  readonly root: NotebookHandle<${quoted(input.document.rootId)}>;`,
    `  readonly parent: ${parentType};`,
    `  readonly self: NotebookHandle<${quoted(cellId)}>;`,
    "}",
    "",
  ].join("\n");
}

function schemaSource(
  input: SemanticProjectInput,
  results: ReadonlyMap<CellId, SemanticCellResult>,
): string {
  const cellIds = input.prepared.graph.order.filter((cellId) =>
    Object.hasOwn(input.document.cells, cellId),
  );
  const idUnion = cellIds.length > 0 ? cellIds.map(quoted).join(" | ") : "never";
  const lines = [
    `export type NotebookCellId = ${idUnion};`,
    "export interface NotebookCellValues {",
  ];
  for (const cellId of cellIds) {
    lines.push(
      `  readonly ${propertyName(cellId)}: ${results.get(cellId)?.type ?? "unknown"};`,
    );
  }
  lines.push("}", "export interface NotebookCellChildren {");
  for (const cellId of cellIds) {
    const cell = input.document.cells[cellId];
    const children = cell?.children
      .map((childId) => input.document.cells[childId])
      .filter((child): child is Cell => child !== undefined && child.name !== undefined)
      .map(
        (child) =>
          `readonly ${propertyName(child.name!)}: NotebookHandle<${quoted(child.id)}>` ,
      );
    lines.push(
      `  readonly ${propertyName(cellId)}: { ${children?.join("; ") ?? ""} };`,
    );
  }
  lines.push(
    "}",
    "export type NotebookHandle<Id extends NotebookCellId> = {",
    "  readonly id: Id;",
    "  readonly name: string | undefined;",
    "  readonly kind: \"text\" | \"javascript\" | \"markdown\";",
    "  readonly text: string;",
    "  readonly value: NotebookCellValues[Id];",
    "  readonly peek: () => NotebookCellValues[Id];",
    "  readonly children: NotebookCellChildren[Id];",
    "} & NotebookCellChildren[Id];",
    "",
  );
  return lines.join("\n");
}

function wrappedSource(cell: Cell): { readonly source: string; readonly offset: number } {
  const contextModule = contextPathForCell(cell.id).slice(0, -5);
  const prefix = [
    `import type { NotebookContext } from ${quoted(contextModule)};`,
    "declare const $: <T>(callback: (context: NotebookContext) => T) => T;",
    "declare const md: (callback: (context: NotebookContext) => string) => string;",
    "export const __hibookResult = (",
  ].join("\n");
  const sourcePrefix = `${prefix}\n`;
  return {
    source: `${sourcePrefix}${cell.source}\n);\n`,
    offset: sourcePrefix.length,
  };
}

function unusableType(type: ts.Type): boolean {
  return (
    (type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Never |
        ts.TypeFlags.TypeParameter)) !==
    0
  );
}

function normalizeType(checker: ts.TypeChecker, type: ts.Type): string {
  if (unusableType(type)) return "unknown";
  const printed = checker.typeToString(
    type,
    undefined,
    ts.TypeFormatFlags.NoTruncation |
      ts.TypeFormatFlags.InTypeAlias |
      ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
  );
  if (!printed || printed === "any" || printed === "never" || printed === "unknown") {
    return "unknown";
  }
  return printed;
}

function sourceWordRange(source: string, position: number): { from: number; to: number } {
  const safePosition = Math.max(0, Math.min(position, source.length));
  let from = safePosition;
  while (from > 0 && /[$\p{ID_Continue}]/u.test(source[from - 1] ?? "")) from -= 1;
  let to = safePosition;
  while (to < source.length && /[$\p{ID_Continue}]/u.test(source[to] ?? "")) to += 1;
  return { from, to };
}

export class SemanticProjectCore {
  readonly #vfs: ContentAwareVfs;
  readonly #clock: SemanticClock;
  readonly #languageService: ts.LanguageService;
  readonly #startupMs: number;
  readonly #sourceMappings = new Map<CellId, SourceMapping>();
  #rootFiles: readonly string[] = [];
  #lastRevision: string | undefined;
  #lastResult: SemanticNotebookResult | undefined;
  #cellStates = new Map<CellId, CachedCellState>();

  constructor(
    clock: SemanticClock = DEFAULT_CLOCK,
    libs: ReadonlyMap<string, string> = BUNDLED_TYPESCRIPT_LIBS,
  ) {
    const startedAt = clock();
    this.#clock = clock;
    this.#vfs = new ContentAwareVfs(libs);
    const moduleHost: ts.ModuleResolutionHost = {
      fileExists: (path) => this.#vfs.has(path),
      readFile: (path) => this.#vfs.read(path),
    };
    const host: ts.LanguageServiceHost = {
      fileExists: (path) => this.#vfs.has(path),
      getCompilationSettings: () => COMPILER_OPTIONS,
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: () => "/lib.es2022.full.d.ts",
      getNewLine: () => "\n",
      getProjectVersion: () => this.#vfs.projectVersion(),
      getScriptFileNames: () => [...this.#rootFiles],
      getScriptSnapshot: (path) => {
        const source = this.#vfs.read(path);
        return source === undefined ? undefined : ts.ScriptSnapshot.fromString(source);
      },
      getScriptVersion: (path) => this.#vfs.version(path),
      readFile: (path) => this.#vfs.read(path),
      resolveModuleNames: (moduleNames, containingFile) =>
        moduleNames.map((moduleName) => {
          const generatedDeclaration = moduleName.startsWith("/")
            ? `${moduleName}.d.ts`
            : undefined;
          if (
            generatedDeclaration !== undefined &&
            this.#vfs.has(generatedDeclaration)
          ) {
            return {
              resolvedFileName: generatedDeclaration,
              extension: ts.Extension.Dts,
              isExternalLibraryImport: false,
            };
          }
          return ts.resolveModuleName(
            moduleName,
            containingFile,
            COMPILER_OPTIONS,
            moduleHost,
          ).resolvedModule;
        }),
      useCaseSensitiveFileNames: () => true,
    };
    this.#languageService = ts.createLanguageService(
      host,
      ts.createDocumentRegistry(true, "/"),
    );
    this.#startupMs = clock() - startedAt;
  }

  infer(input: SemanticProjectInput, revision = revisionForDocument(input.document)): SemanticNotebookResult {
    this.#assertRevision(input, revision);
    if (this.#lastRevision === revision && this.#lastResult) return this.#lastResult;

    const startedAt = this.#clock();
    const countersBefore = this.#vfs.counters();
    let syncMs = 0;
    let programBuilds = 0;
    let reusedCells = 0;
    const affected = affectedCells(input);
    const results = new Map<CellId, SemanticCellResult>();
    const reused = new Set<CellId>();
    const preparedById = new Map(
      input.prepared.cells.map((cell) => [cell.cellId, cell] as const),
    );

    if (input.changedCellIds !== undefined) {
      for (const cellId of input.prepared.graph.order) {
        if (affected.has(cellId)) continue;
        const cell = input.document.cells[cellId];
        const cached = this.#cellStates.get(cellId);
        if (cell && cached?.fingerprint === cellFingerprint(cell)) {
          results.set(cellId, cached.result);
          reused.add(cellId);
          reusedCells += 1;
        }
      }
    }

    for (const cellId of input.prepared.graph.order) {
      if (results.has(cellId)) continue;
      const cell = input.document.cells[cellId];
      const prepared = preparedById.get(cellId);
      if (!cell || !prepared) continue;
      const analysisDiagnostics = prepared.issues.map((issue) => ({
        from: issue.span.start,
        to: issue.span.end,
        severity: "error" as const,
        message: issue.message,
      }));
      if (prepared.status === "cycle") {
        results.set(cellId, analysisResult(cellId, "cycle", "unknown", analysisDiagnostics));
      } else if (!prepared.ok || prepared.status === "invalid") {
        const diagnostics = prepared.ok
          ? analysisDiagnostics
          : [
              ...analysisDiagnostics,
              {
                from: 0,
                to: cell.source.length,
                severity: "error" as const,
                message: prepared.error.message,
              },
            ];
        results.set(cellId, analysisResult(cellId, "invalid", "unknown", diagnostics));
      } else if (cell.kind === "text") {
        results.set(cellId, analysisResult(cellId, "text", "string"));
      } else if (prepared.analysis.annotation) {
        results.set(
          cellId,
          analysisResult(cellId, "explicit", prepared.analysis.annotation.text),
        );
      }
    }

    const sync = (callback: () => void): void => {
      const syncStartedAt = this.#clock();
      callback();
      syncMs += this.#clock() - syncStartedAt;
    };
    this.#rootFiles = input.prepared.graph.order
      .map((cellId) => input.document.cells[cellId])
      .filter((cell): cell is Cell => cell !== undefined && executable(cell))
      .map((cell) => sourcePathForCell(cell.id));
    const parents = parentIds(input);
    sync(() => this.#vfs.write(NOTEBOOK_SCHEMA_PATH, schemaSource(input, results)));

    const synchronizedCells = new Set<CellId>();
    const synchronizeCells = (cellIds: readonly CellId[]): void => {
      sync(() => {
        for (const cellId of cellIds) {
          if (synchronizedCells.has(cellId)) continue;
          const cell = input.document.cells[cellId];
          if (!cell || !executable(cell)) continue;
          this.#vfs.write(contextPathForCell(cellId), contextSource(input, cellId, parents));
          const wrapped = wrappedSource(cell);
          const path = sourcePathForCell(cellId);
          this.#vfs.write(path, wrapped.source);
          this.#sourceMappings.set(cellId, {
            cellId,
            path,
            sourceStart: wrapped.offset,
            sourceLength: cell.source.length,
          });
          synchronizedCells.add(cellId);
        }
      });
    };

    for (const layer of input.prepared.graph.layers) {
      synchronizeCells(layer);
      const checkable = layer.filter((cellId) => {
        const cell = input.document.cells[cellId];
        const prepared = preparedById.get(cellId);
        return (
          cell !== undefined &&
          executable(cell) &&
          prepared?.ok === true &&
          prepared.status !== "invalid" &&
          !reused.has(cellId)
        );
      });
      if (checkable.length === 0) continue;

      const program = this.#languageService.getProgram();
      programBuilds += 1;
      for (const cellId of checkable) {
        const mapping = this.#sourceMappings.get(cellId);
        const sourceFile = mapping ? program?.getSourceFile(mapping.path) : undefined;
        const current = results.get(cellId);
        if (!mapping || !sourceFile || !program) {
          if (!current) results.set(cellId, analysisResult(cellId, "invalid", "unknown"));
          continue;
        }
        const diagnostics = this.#diagnosticsFromProgram(program, sourceFile, mapping);
        if (current?.status === "explicit") {
          results.set(cellId, { ...current, diagnostics });
          continue;
        }
        const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
        const declaration = sourceFile.statements
          .filter(ts.isVariableStatement)
          .flatMap((statement) => [...statement.declarationList.declarations])
          .find(
            (candidate) =>
              ts.isIdentifier(candidate.name) && candidate.name.text === "__hibookResult",
          );
        if (hasErrors || !declaration?.initializer) {
          results.set(cellId, analysisResult(cellId, "invalid", "unknown", diagnostics));
          continue;
        }
        const checker = program.getTypeChecker();
        const type = normalizeType(checker, checker.getTypeAtLocation(declaration.initializer));
        results.set(
          cellId,
          analysisResult(
            cellId,
            type === "unknown" ? "invalid" : "inferred",
            type,
            diagnostics,
          ),
        );
      }
      sync(() => this.#vfs.write(NOTEBOOK_SCHEMA_PATH, schemaSource(input, results)));
    }

    synchronizeCells(input.prepared.graph.order);
    sync(() => this.#vfs.write(NOTEBOOK_SCHEMA_PATH, schemaSource(input, results)));

    const orderedResults = input.prepared.graph.order.flatMap((cellId) => {
      const result = results.get(cellId);
      return result ? [result] : [];
    });
    const inferenceFinishedAt = this.#clock();
    const countersAfter = this.#vfs.counters();
    const result: SemanticNotebookResult = {
      revision,
      cells: orderedResults,
      timings: {
        workerStartupMs: this.#startupMs,
        projectSyncMs: syncMs,
        inferenceMs: inferenceFinishedAt - startedAt - syncMs,
        totalMs: inferenceFinishedAt - startedAt,
        counters: {
          vfsWrites: countersAfter.writes - countersBefore.writes,
          vfsSkips: countersAfter.skips - countersBefore.skips,
          layers: input.prepared.graph.layers.length,
          programBuilds,
          reusedCells,
        },
      },
    };
    this.#cellStates = new Map(
      orderedResults.flatMap((cellResult) => {
        const cell = input.document.cells[cellResult.cellId];
        return cell
          ? [[cell.id, { fingerprint: cellFingerprint(cell), result: cellResult }] as const]
          : [];
      }),
    );
    this.#lastRevision = revision;
    this.#lastResult = result;
    return result;
  }

  completions(
    input: SemanticProjectInput,
    cellId: CellId,
    position: number,
    revision = revisionForDocument(input.document),
  ): { readonly semantic: SemanticNotebookResult; readonly completion: SemanticCompletionResult } {
    const semantic = this.infer(input, revision);
    const cell = input.document.cells[cellId];
    const mapping = this.#sourceMappings.get(cellId);
    if (!cell || !mapping || !executable(cell)) {
      return { semantic, completion: { from: position, to: position, items: [] } };
    }
    const fallbackRange = sourceWordRange(cell.source, position);
    const virtualPosition = mapping.sourceStart + Math.max(0, Math.min(position, cell.source.length));
    const completions = this.#languageService.getCompletionsAtPosition(
      mapping.path,
      virtualPosition,
      {
        includeCompletionsForImportStatements: false,
        includeCompletionsWithInsertText: true,
      },
    );
    if (!completions) {
      return { semantic, completion: { ...fallbackRange, items: [] } };
    }
    const firstSpan = completions.entries.find((entry) => entry.replacementSpan)?.replacementSpan;
    const range = firstSpan
      ? this.#sourceRange(mapping, firstSpan.start, firstSpan.length)
      : fallbackRange;
    const items: SemanticCompletionItem[] = completions.entries.map((entry) => {
      const details = this.#languageService.getCompletionEntryDetails(
        mapping.path,
        virtualPosition,
        entry.name,
        undefined,
        entry.source,
        undefined,
        entry.data,
      );
      const detailText = details
        ? ts.displayPartsToString(details.displayParts)
        : entry.source ?? entry.kindModifiers;
      return {
        label: entry.name,
        kind: entry.kind,
        ...(detailText ? { detail: detailText } : {}),
        applyText: entry.insertText ?? entry.name,
      };
    });
    return { semantic, completion: { ...range, items } };
  }

  diagnostics(
    input: SemanticProjectInput,
    cellId: CellId,
    revision = revisionForDocument(input.document),
  ): { readonly semantic: SemanticNotebookResult; readonly diagnostics: readonly SemanticDiagnostic[] } {
    const semantic = this.infer(input, revision);
    const mapping = this.#sourceMappings.get(cellId);
    const program = this.#languageService.getProgram();
    const sourceFile = mapping ? program?.getSourceFile(mapping.path) : undefined;
    const diagnostics =
      mapping && program && sourceFile
        ? this.#diagnosticsFromProgram(program, sourceFile, mapping)
        : semantic.cells.find((cell) => cell.cellId === cellId)?.diagnostics ?? [];
    return { semantic, diagnostics };
  }

  quickInfo(
    input: SemanticProjectInput,
    cellId: CellId,
    position: number,
    revision = revisionForDocument(input.document),
  ): { readonly semantic: SemanticNotebookResult; readonly quickInfo: SemanticQuickInfo | null } {
    const semantic = this.infer(input, revision);
    const cell = input.document.cells[cellId];
    const mapping = this.#sourceMappings.get(cellId);
    if (!cell || !mapping || !executable(cell)) return { semantic, quickInfo: null };
    const virtualPosition =
      mapping.sourceStart + Math.max(0, Math.min(position, cell.source.length));
    const info = this.#languageService.getQuickInfoAtPosition(
      mapping.path,
      virtualPosition,
    );
    if (!info) return { semantic, quickInfo: null };
    const range = this.#sourceRange(mapping, info.textSpan.start, info.textSpan.length);
    return {
      semantic,
      quickInfo: {
        ...range,
        parts: (info.displayParts ?? []).map(({ text, kind }) => ({ text, kind })),
        documentation: ts.displayPartsToString(info.documentation),
      },
    };
  }

  dispose(): void {
    this.#languageService.dispose();
    this.#sourceMappings.clear();
    this.#cellStates.clear();
    this.#lastResult = undefined;
    this.#lastRevision = undefined;
  }

  #assertRevision(input: SemanticProjectInput, revision: string): void {
    if (
      revision !== revisionForDocument(input.document) ||
      input.prepared.revision !== revision
    ) {
      throw new Error("Semantic project input does not match its document revision");
    }
  }

  #diagnosticsFromProgram(
    program: ts.Program,
    sourceFile: ts.SourceFile,
    mapping: SourceMapping,
  ): readonly SemanticDiagnostic[] {
    return [
      ...program.getSyntacticDiagnostics(sourceFile),
      ...program.getSemanticDiagnostics(sourceFile),
    ].flatMap((diagnostic) => {
      const start = diagnostic.start;
      if (start === undefined) return [];
      const range = this.#sourceRange(mapping, start, diagnostic.length ?? 0);
      const virtualEnd = start + (diagnostic.length ?? 0);
      const sourceEnd = mapping.sourceStart + mapping.sourceLength;
      if (virtualEnd < mapping.sourceStart || start > sourceEnd) return [];
      return [
        {
          ...range,
          severity: diagnosticSeverity(diagnostic.category),
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        },
      ];
    });
  }

  #sourceRange(
    mapping: SourceMapping,
    virtualStart: number,
    virtualLength: number,
  ): { from: number; to: number } {
    const from = Math.max(
      0,
      Math.min(mapping.sourceLength, virtualStart - mapping.sourceStart),
    );
    const to = Math.max(
      from,
      Math.min(
        mapping.sourceLength,
        virtualStart + virtualLength - mapping.sourceStart,
      ),
    );
    return { from, to };
  }
}
