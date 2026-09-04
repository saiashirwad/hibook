import type { PreparedCell, PreparedGraph, PreparedNotebook } from "../compiler/protocol";
import { revisionForDocument } from "../compiler/protocol";
import type { CellId, NotebookDocument } from "../model/types";
import { isPlainRecord } from "../model/validate";

export const NOTEBOOK_CACHE_RECORD_VERSION = 1;
export const NOTEBOOK_CACHE_COMPATIBILITY =
  "hibook:typescript-5.9.3:notebook-schema-1:runtime-1:cache-1";
export const NOTEBOOK_CACHE_REVISION_LIMIT = 8;

export type JsonSafeValue =
  | null
  | string
  | boolean
  | number
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

export interface NotebookCacheRecord {
  readonly version: typeof NOTEBOOK_CACHE_RECORD_VERSION;
  readonly compatibility: typeof NOTEBOOK_CACHE_COMPATIBILITY;
  readonly revision: string;
  readonly savedAt: number;
  readonly prepared: PreparedNotebook;
  readonly values: Readonly<Record<CellId, JsonSafeValue>>;
}

export type JsonSafeCopyResult =
  | { readonly ok: true; readonly value: JsonSafeValue }
  | { readonly ok: false };

function copyJsonSafeUnchecked(
  value: unknown,
  ancestors: ReadonlySet<object>,
): JsonSafeCopyResult {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false };
  }
  if (typeof value !== "object") return { ok: false };
  if (ancestors.has(value)) return { ok: false };

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)),
      )
    ) {
      return { ok: false };
    }
    const copy: JsonSafeValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return { ok: false };
      }
      const item = copyJsonSafeUnchecked(descriptor.value, nextAncestors);
      if (!item.ok) return item;
      copy.push(item.value);
    }
    return { ok: true, value: copy };
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return { ok: false };
  }
  const copy: Record<string, JsonSafeValue> =
    prototype === null ? Object.create(null) : {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return { ok: false };
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      return { ok: false };
    }
    const property = copyJsonSafeUnchecked(descriptor.value, nextAncestors);
    if (!property.ok) return property;
    Object.defineProperty(copy, key, {
      value: property.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { ok: true, value: copy };
}

export function copyJsonSafeValue(value: unknown): JsonSafeCopyResult {
  try {
    return copyJsonSafeUnchecked(value, new Set());
  } catch {
    return { ok: false };
  }
}


function keysExactly(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && required.every((key) => Object.hasOwn(value, key));
}

function isStringArray(
  value: unknown,
  allowed?: ReadonlySet<string>,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) => typeof item === "string" && (allowed?.has(item) ?? true),
    ) &&
    new Set(value).size === value.length
  );
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validSpan(value: unknown, sourceLength: number): boolean {
  return (
    isPlainRecord(value) &&
    keysExactly(value, ["start", "end"]) &&
    Number.isInteger(value.start) &&
    Number.isInteger(value.end) &&
    (value.start as number) >= 0 &&
    (value.end as number) >= (value.start as number) &&
    (value.end as number) <= sourceLength
  );
}

function validPath(value: unknown, sourceLength: number): boolean {
  if (!isPlainRecord(value) || !keysExactly(value, ["origin", "hops", "valueSpan", "span"])) {
    return false;
  }
  const origin = value.origin;
  if (
    !isPlainRecord(origin) ||
    !keysExactly(origin, ["kind", "span"]) ||
    !["root", "parent", "self"].includes(String(origin.kind)) ||
    !validSpan(origin.span, sourceLength) ||
    !Array.isArray(value.hops) ||
    !validSpan(value.valueSpan, sourceLength) ||
    !validSpan(value.span, sourceLength)
  ) {
    return false;
  }
  return value.hops.every((hop) => {
    if (!isPlainRecord(hop) || !validSpan(hop.span, sourceLength)) return false;
    if (hop.kind === "child") {
      return keysExactly(hop, ["kind", "name", "span"]) && typeof hop.name === "string";
    }
    return (
      (hop.kind === "children" || hop.kind === "dynamic") &&
      keysExactly(hop, ["kind", "span"])
    );
  });
}

function validResolution(
  value: unknown,
  sourceLength: number,
  ids: ReadonlySet<string>,
): boolean {
  if (!isPlainRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "resolved") {
    return keysExactly(value, ["status", "targetId"]) && typeof value.targetId === "string" && ids.has(value.targetId);
  }
  if (value.status === "dynamic") {
    return keysExactly(value, ["status", "span"]) && validSpan(value.span, sourceLength);
  }
  if (value.status === "invalid") {
    return (
      keysExactly(value, ["status", "reason", "span"]) &&
      ["analyzed-cell-missing", "root-missing", "children-segment-without-name", "cell-children-invalid"].includes(String(value.reason)) &&
      validSpan(value.span, sourceLength)
    );
  }
  if (value.status !== "missing" && value.status !== "ambiguous") return false;
  const required = value.status === "missing"
    ? ["status", "at", "span"]
    : ["status", "at", "span", "candidateIds"];
  const optional = ["fromId", "name"];
  const keys = Object.keys(value);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
    (value.at !== "parent" && value.at !== "child") ||
    !validSpan(value.span, sourceLength)
  ) {
    return false;
  }
  if (value.fromId !== undefined && (typeof value.fromId !== "string" || !ids.has(value.fromId))) return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  return value.status === "missing" || isStringArray(value.candidateIds, ids);
}

function validIssue(value: unknown, sourceLength: number): boolean {
  return (
    isPlainRecord(value) &&
    keysExactly(value, ["classification", "code", "message", "span"]) &&
    ["syntax", "missing", "ambiguous", "dynamic", "invalid", "aliased"].includes(String(value.classification)) &&
    ["SYNTAX_ERROR", "CALLBACK_REQUIRED", "MULTIPLE_CALLBACKS", "INVALID_CALLBACK", "INVALID_CONTEXT_PARAMETER", "ALIASED_CONTEXT", "MISSING_TARGET", "AMBIGUOUS_TARGET", "DYNAMIC_PATH", "INVALID_PATH"].includes(String(value.code)) &&
    typeof value.message === "string" &&
    validSpan(value.span, sourceLength)
  );
}

function validAnalysis(
  value: unknown,
  cellId: string,
  kind: string,
  sourceLength: number,
  ids: ReadonlySet<string>,
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const keys = ["cellId", "kind", "dependencies", "references", "issues"];
  if (Object.hasOwn(value, "annotation")) keys.push("annotation");
  if (
    !keysExactly(value, keys) ||
    value.cellId !== cellId ||
    value.kind !== kind ||
    !isStringArray(value.dependencies, ids) ||
    !Array.isArray(value.references) ||
    !Array.isArray(value.issues) ||
    !value.issues.every((issue) => validIssue(issue, sourceLength))
  ) {
    return false;
  }
  if (Object.hasOwn(value, "annotation")) {
    const annotation = value.annotation;
    if (
      !isPlainRecord(annotation) ||
      !keysExactly(annotation, ["text", "span"]) ||
      typeof annotation.text !== "string" ||
      !validSpan(annotation.span, sourceLength)
    ) {
      return false;
    }
  }
  const resolved = new Set<string>();
  for (const reference of value.references) {
    if (
      !isPlainRecord(reference) ||
      !keysExactly(reference, ["path", "resolution"]) ||
      !validPath(reference.path, sourceLength) ||
      !validResolution(reference.resolution, sourceLength, ids)
    ) {
      return false;
    }
    if (isPlainRecord(reference.resolution) && reference.resolution.status === "resolved") {
      resolved.add(reference.resolution.targetId as string);
    }
  }
  return equalJson([...resolved], value.dependencies);
}

function documentOrder(document: NotebookDocument): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const visit = (cellId: string): void => {
    if (visited.has(cellId) || !Object.hasOwn(document.cells, cellId)) return;
    visited.add(cellId);
    order.push(cellId);
    for (const childId of document.cells[cellId]?.children ?? []) visit(childId);
  };
  visit(document.rootId);
  for (const cellId of Object.keys(document.cells)) visit(cellId);
  return order;
}

function stronglyConnectedGroups(
  order: readonly string[],
  dependencies: Readonly<Record<string, readonly string[]>>,
): string[][] {
  const indexById = new Map<string, number>();
  const lowById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const groups: string[][] = [];
  let nextIndex = 0;
  const connect = (cellId: string): void => {
    const index = nextIndex++;
    indexById.set(cellId, index);
    lowById.set(cellId, index);
    stack.push(cellId);
    onStack.add(cellId);
    for (const dependencyId of dependencies[cellId] ?? []) {
      if (!indexById.has(dependencyId)) {
        connect(dependencyId);
        lowById.set(cellId, Math.min(lowById.get(cellId) ?? index, lowById.get(dependencyId) ?? index));
      } else if (onStack.has(dependencyId)) {
        lowById.set(cellId, Math.min(lowById.get(cellId) ?? index, indexById.get(dependencyId) ?? index));
      }
    }
    if (lowById.get(cellId) !== indexById.get(cellId)) return;
    const group: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      group.push(member);
      if (member === cellId) break;
    }
    if (group.length > 1 || (dependencies[group[0] ?? ""] ?? []).includes(group[0] ?? "")) groups.push(group);
  };
  for (const cellId of order) if (!indexById.has(cellId)) connect(cellId);
  const position = new Map(order.map((cellId, index) => [cellId, index]));
  for (const group of groups) group.sort((a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0));
  groups.sort((a, b) => (position.get(a[0] ?? "") ?? 0) - (position.get(b[0] ?? "") ?? 0));
  return groups;
}

function expectedGraph(
  order: readonly string[],
  dependencies: Readonly<Record<string, readonly string[]>>,
): PreparedGraph {
  const dependents: Record<string, string[]> = Object.create(null);
  for (const cellId of order) dependents[cellId] = [];
  for (const cellId of order) {
    for (const dependencyId of dependencies[cellId] ?? []) dependents[dependencyId]?.push(cellId);
  }
  const cycleGroups = stronglyConnectedGroups(order, dependencies);
  const cycleSet = new Set(cycleGroups.flat());
  const processed = new Set<string>();
  const remaining = new Set(order.filter((cellId) => !cycleSet.has(cellId)));
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const layer = order.filter(
      (cellId) => remaining.has(cellId) && (dependencies[cellId] ?? []).every((dependencyId) => processed.has(dependencyId)),
    );
    if (layer.length === 0) break;
    layers.push(layer);
    for (const cellId of layer) {
      remaining.delete(cellId);
      processed.add(cellId);
    }
  }
  return {
    order: [...order],
    dependencies,
    dependents,
    layers,
    cycleGroups,
    cycleMembers: order.filter((cellId) => cycleSet.has(cellId)),
    blockedByCycles: order.filter((cellId) => remaining.has(cellId)),
  };
}

function validPreparedCell(
  value: unknown,
  document: NotebookDocument,
  ids: ReadonlySet<string>,
  cycleBlocked: ReadonlySet<string>,
): value is PreparedCell {
  if (!isPlainRecord(value) || typeof value.cellId !== "string") return false;
  const cell = document.cells[value.cellId];
  if (!cell) return false;
  const base = ["ok", "cellId", "kind", "source", "dependencies", "analysis", "issues", "type", "status"];
  const shape = value.ok === true ? [...base, "code"] : value.ok === false ? [...base, "error"] : [];
  if (
    shape.length === 0 ||
    !keysExactly(value, shape) ||
    value.kind !== cell.kind ||
    value.source !== cell.source ||
    typeof value.type !== "string" ||
    !["text", "explicit", "inferred", "invalid", "cycle"].includes(String(value.status)) ||
    !validAnalysis(value.analysis, cell.id, cell.kind, cell.source.length, ids) ||
    !isStringArray(value.dependencies, ids) ||
    !equalJson(value.dependencies, value.analysis.dependencies) ||
    !Array.isArray(value.issues) ||
    !equalJson(value.issues, value.analysis.issues)
  ) {
    return false;
  }
  if (cell.kind === "text") {
    return value.ok === true && value.code === "" && value.status === "text";
  }
  if (value.ok === true) {
    if (typeof value.code !== "string") return false;
  } else {
    const error = value.error;
    if (
      !isPlainRecord(error) ||
      !keysExactly(error, ["code", "message"]) ||
      !["INVALID_TYPESCRIPT", "IMPORT_UNSUPPORTED", "MODULE_SYNTAX_UNSUPPORTED", "TOP_LEVEL_AWAIT_UNSUPPORTED"].includes(String(error.code)) ||
      typeof error.message !== "string" ||
      value.status !== "invalid"
    ) {
      return false;
    }
    return true;
  }
  if (cycleBlocked.has(cell.id)) return value.status === "cycle";
  if ((value.issues as unknown[]).length > 0) return value.status === "invalid";
  if (value.status === "cycle" || value.status === "text") return false;
  if (Object.hasOwn(value.analysis, "annotation")) {
    return value.status === "explicit";
  }
  return value.status === "inferred" || value.status === "invalid";
}

function validPrepared(
  value: unknown,
  document: NotebookDocument,
  revision: string,
  requireZeroTimings: boolean,
): value is PreparedNotebook {
  if (!isPlainRecord(value) || !keysExactly(value, ["revision", "cells", "graph", "timings"]) || value.revision !== revision || !Array.isArray(value.cells)) return false;
  const order = documentOrder(document);
  const ids = new Set(order);
  const graph = value.graph;
  if (!isPlainRecord(graph) || !keysExactly(graph, ["order", "dependencies", "dependents", "layers", "cycleGroups", "cycleMembers", "blockedByCycles"])) return false;
  const graphDependencies = graph.dependencies;
  if (!equalJson(graph.order, order) || !isPlainRecord(graphDependencies)) return false;
  if (!keysExactly(graphDependencies, order)) return false;
  const dependencies: Record<string, string[]> = Object.create(null);
  for (const cellId of order) {
    const entry = graphDependencies[cellId];
    if (!isStringArray(entry, ids)) return false;
    dependencies[cellId] = entry;
  }
  const expected = expectedGraph(order, dependencies);
  const graphDependents = graph.dependents;
  if (
    !isPlainRecord(graphDependents) ||
    !keysExactly(graphDependents, order) ||
    !order.every(
      (cellId) =>
        equalJson(graphDependencies[cellId], expected.dependencies[cellId]) &&
        equalJson(graphDependents[cellId], expected.dependents[cellId]),
    ) ||
    !equalJson(graph.order, expected.order) ||
    !equalJson(graph.layers, expected.layers) ||
    !equalJson(graph.cycleGroups, expected.cycleGroups) ||
    !equalJson(graph.cycleMembers, expected.cycleMembers) ||
    !equalJson(graph.blockedByCycles, expected.blockedByCycles)
  ) {
    return false;
  }
  const blocked = new Set([...expected.cycleMembers, ...expected.blockedByCycles]);
  if (
    value.cells.length !== order.length ||
    !value.cells.every((cell, index) => isPlainRecord(cell) && cell.cellId === order[index] && validPreparedCell(cell, document, ids, blocked))
  ) {
    return false;
  }
  const timings = value.timings;
  return (
    isPlainRecord(timings) &&
    keysExactly(timings, ["totalMs", "analysisMs", "transpileMs", "cellCount", "reusedCells", "transpiledCells"]) &&
    [timings.totalMs, timings.analysisMs, timings.transpileMs].every(
      (timing) => Number.isFinite(timing) && (timing as number) >= 0,
    ) &&
    (!requireZeroTimings ||
      (timings.totalMs === 0 &&
        timings.analysisMs === 0 &&
        timings.transpileMs === 0)) &&
    [timings.cellCount, timings.reusedCells, timings.transpiledCells].every((counter) => Number.isInteger(counter) && (counter as number) >= 0) &&
    timings.cellCount === order.length
  );
}
function validatePreparedNotebookUnchecked(
  input: unknown,
  document: NotebookDocument,
  requireZeroTimings = false,
): PreparedNotebook | undefined {
  const copied = copyJsonSafeValue(input);
  if (!copied.ok || !isPlainRecord(copied.value)) return undefined;
  const revision = revisionForDocument(document);
  return validPrepared(copied.value, document, revision, requireZeroTimings)
    ? (copied.value as unknown as PreparedNotebook)
    : undefined;
}
export function validatePreparedNotebook(
  input: unknown,
  document: NotebookDocument,
  requireZeroTimings = false,
): PreparedNotebook | undefined {
  try {
    return validatePreparedNotebookUnchecked(
      input,
      document,
      requireZeroTimings,
    );
  } catch {
    return undefined;
  }
}



function validateNotebookCacheRecordUnchecked(
  input: unknown,
  document: NotebookDocument,
): NotebookCacheRecord | undefined {
  const copied = copyJsonSafeValue(input);
  if (!copied.ok || !isPlainRecord(copied.value)) return undefined;
  const value = copied.value;
  const revision = revisionForDocument(document);
  if (
    !keysExactly(value, ["version", "compatibility", "revision", "savedAt", "prepared", "values"]) ||
    value.version !== NOTEBOOK_CACHE_RECORD_VERSION ||
    value.compatibility !== NOTEBOOK_CACHE_COMPATIBILITY ||
    value.revision !== revision ||
    !Number.isFinite(value.savedAt) ||
    (value.savedAt as number) < 0 ||
    !validPrepared(value.prepared, document, revision, true) ||
    !isPlainRecord(value.values)
  ) {
    return undefined;
  }
  for (const [cellId, cachedValue] of Object.entries(value.values)) {
    if (!Object.hasOwn(document.cells, cellId) || !copyJsonSafeValue(cachedValue).ok) return undefined;
  }
  return value as unknown as NotebookCacheRecord;
}
export function validateNotebookCacheRecord(
  input: unknown,
  document: NotebookDocument,
): NotebookCacheRecord | undefined {
  try {
    return validateNotebookCacheRecordUnchecked(input, document);
  } catch {
    return undefined;
  }
}


function persistedPrepared(prepared: PreparedNotebook): PreparedNotebook {
  const copied = copyJsonSafeValue(prepared);
  if (!copied.ok || !isPlainRecord(copied.value)) throw new Error("Prepared notebook is not JSON-safe");
  const clone = copied.value as unknown as PreparedNotebook;
  return {
    ...clone,
    timings: {
      ...clone.timings,
      totalMs: 0,
      analysisMs: 0,
      transpileMs: 0,
    },
  };
}

export function createNotebookCacheRecord(
  document: NotebookDocument,
  prepared: PreparedNotebook,
  runtimeValues: Iterable<readonly [CellId, unknown]>,
  savedAt: number,
): NotebookCacheRecord {
  if (!Number.isFinite(savedAt) || savedAt < 0) throw new Error("Cache timestamp must be finite and non-negative");
  const revision = revisionForDocument(document);
  const values: Record<CellId, JsonSafeValue> = Object.create(null);
  for (const [cellId, value] of runtimeValues) {
    if (!Object.hasOwn(document.cells, cellId)) continue;
    const copied = copyJsonSafeValue(value);
    if (copied.ok) values[cellId] = copied.value;
  }
  const candidate: NotebookCacheRecord = {
    version: NOTEBOOK_CACHE_RECORD_VERSION,
    compatibility: NOTEBOOK_CACHE_COMPATIBILITY,
    revision,
    savedAt,
    prepared: persistedPrepared(prepared),
    values,
  };
  const validated = validateNotebookCacheRecord(candidate, document);
  if (!validated) throw new Error("Cannot cache malformed or revision-mismatched prepared output");
  return validated;
}
