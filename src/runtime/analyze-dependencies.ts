import ts from "typescript";
import type { Cell, CellId, NotebookDocument } from "../model/types";
import type {
  CellDependencyAnalysis,
  DependencyIssue,
  DependencyIssueClassification,
  DependencyIssueCode,
  ExplicitAnnotation,
  NotebookPath,
  NotebookPathHop,
  NotebookPathOriginKind,
  PathResolution,
  SourceSpan,
} from "./analysis-types";
import { resolveNotebookPath } from "./resolve-path";

const CONTEXT_ORIGINS: Record<NotebookPathOriginKind, true> = {
  root: true,
  parent: true,
  self: true,
};
const SCALAR_HANDLE_FIELDS: Record<"id" | "kind" | "name" | "text", true> = {
  id: true,
  kind: true,
  name: true,
  text: true,
};


function sourceSpan(node: ts.Node): SourceSpan {
  return { start: node.getStart(), end: node.getEnd() };
}

function issue(
  classification: DependencyIssueClassification,
  code: DependencyIssueCode,
  message: string,
  span: SourceSpan,
): DependencyIssue {
  return { classification, code, message, span };
}

function addBindingNames(name: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      addBindingNames(element.name, names);
    }
  }
}
function isFunctionWithBody(
  node: ts.Node,
): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function addDirectStatementBindings(
  statements: readonly ts.Statement[],
  names: Set<string>,
): void {
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingNames(declaration.name, names);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
}

function directBlockBindings(block: ts.Block): ReadonlySet<string> {
  const names = new Set<string>();
  addDirectStatementBindings(block.statements, names);
  return names;
}

function directCaseBlockBindings(caseBlock: ts.CaseBlock): ReadonlySet<string> {
  const names = new Set<string>();
  for (const clause of caseBlock.clauses) {
    addDirectStatementBindings(clause.statements, names);
  }
  return names;
}

function functionScopedVarBindings(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();

  const visit = (current: ts.Node): void => {
    if (current !== node && isFunctionWithBody(current)) {
      return;
    }
    if (
      ts.isVariableDeclarationList(current) &&
      (current.flags & ts.NodeFlags.BlockScoped) === 0
    ) {
      for (const declaration of current.declarations) {
        addBindingNames(declaration.name, names);
      }
    }
    ts.forEachChild(current, visit);
  };

  ts.forEachChild(node, visit);
  return names;
}

function withNames(
  inherited: ReadonlySet<string>,
  added: Iterable<string>,
): ReadonlySet<string> {
  const combined = new Set(inherited);
  for (const name of added) {
    combined.add(name);
  }
  return combined;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function pathFromValueRead(
  valueRead: ts.PropertyAccessExpression,
  contexts: ReadonlyMap<string, NotebookPathOriginKind>,
  shadowed: ReadonlySet<string>,
): NotebookPath | undefined {
  const reversedHops: NotebookPathHop[] = [];
  let expression = unwrapExpression(valueRead.expression);

  while (true) {
    if (ts.isPropertyAccessExpression(expression)) {
      if (
        expression.name.text === "value" ||
        Object.hasOwn(SCALAR_HANDLE_FIELDS, expression.name.text)
      ) {
        return undefined;
      }
      reversedHops.push(
        expression.name.text === "children"
          ? { kind: "children", span: sourceSpan(expression.name) }
          : {
              kind: "child",
              name: expression.name.text,
              span: sourceSpan(expression.name),
            },
      );
      expression = unwrapExpression(expression.expression);
      continue;
    }

    if (ts.isElementAccessExpression(expression)) {
      reversedHops.push({
        kind: "dynamic",
        span: expression.argumentExpression
          ? sourceSpan(expression.argumentExpression)
          : sourceSpan(expression),
      });
      expression = unwrapExpression(expression.expression);
      continue;
    }

    if (!ts.isIdentifier(expression) || shadowed.has(expression.text)) {
      return undefined;
    }
    const origin = contexts.get(expression.text);
    if (!origin) {
      return undefined;
    }

    const valueSpan = sourceSpan(valueRead.name);
    return {
      origin: { kind: origin, span: sourceSpan(expression) },
      hops: reversedHops.reverse(),
      valueSpan,
      span: { start: expression.getStart(), end: valueRead.getEnd() },
    };
  }
}

function isContextHandleExpression(
  candidate: ts.Expression,
  contexts: ReadonlyMap<string, NotebookPathOriginKind>,
  shadowed: ReadonlySet<string>,
): boolean {
  let expression = unwrapExpression(candidate);

  while (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    if (
      ts.isPropertyAccessExpression(expression) &&
      (expression.name.text === "value" ||
        Object.hasOwn(SCALAR_HANDLE_FIELDS, expression.name.text))
    ) {
      return false;
    }
    expression = unwrapExpression(expression.expression);
  }

  return (
    ts.isIdentifier(expression) &&
    !shadowed.has(expression.text) &&
    contexts.has(expression.text)
  );
}

function resolutionIssue(resolution: PathResolution): DependencyIssue | undefined {
  switch (resolution.status) {
    case "resolved":
      return undefined;
    case "missing":
      return issue(
        "missing",
        "MISSING_TARGET",
        resolution.at === "parent"
          ? "The context parent does not exist."
          : `No child named ${JSON.stringify(resolution.name)} exists on this path.`,
        resolution.span,
      );
    case "ambiguous":
      return issue(
        "ambiguous",
        "AMBIGUOUS_TARGET",
        resolution.at === "parent"
          ? "The analyzed cell has multiple structural parents."
          : `More than one child named ${JSON.stringify(resolution.name)} exists on this path.`,
        resolution.span,
      );
    case "dynamic":
      return issue(
        "dynamic",
        "DYNAMIC_PATH",
        "Computed notebook paths cannot be resolved statically.",
        resolution.span,
      );
    case "invalid":
      return issue(
        "invalid",
        "INVALID_PATH",
        `The notebook path is invalid: ${resolution.reason}.`,
        resolution.span,
      );
  }
}

function callbackExpression(
  expression: ts.Expression | undefined,
): ts.ArrowFunction | ts.FunctionExpression | undefined {
  if (!expression) {
    return undefined;
  }
  const unwrapped = unwrapExpression(expression);
  return ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)
    ? unwrapped
    : undefined;
}

interface CallbackContext {
  readonly origins: ReadonlyMap<string, NotebookPathOriginKind>;
  readonly issues: readonly DependencyIssue[];
}

function callbackContext(
  callback: ts.ArrowFunction | ts.FunctionExpression,
): CallbackContext {
  const origins = new Map<string, NotebookPathOriginKind>();
  const issues: DependencyIssue[] = [];
  const parameter = callback.parameters[0];
  if (!parameter) {
    return { origins, issues };
  }
  if (!ts.isObjectBindingPattern(parameter.name)) {
    issues.push(
      issue(
        "invalid",
        "INVALID_CONTEXT_PARAMETER",
        "The notebook callback context must use an object binding pattern.",
        sourceSpan(parameter.name),
      ),
    );
    return { origins, issues };
  }

  for (const element of parameter.name.elements) {
    const propertyName = element.propertyName;
    const declaredName = ts.isIdentifier(element.name)
      ? element.name.text
      : undefined;
    const contextName = propertyName
      ? ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)
        ? propertyName.text
        : undefined
      : declaredName;

    if (!contextName || !Object.hasOwn(CONTEXT_ORIGINS, contextName)) {
      continue;
    }
    if (!declaredName || (propertyName && declaredName !== contextName)) {
      issues.push(
        issue(
          "aliased",
          "ALIASED_CONTEXT",
          `Aliasing the ${contextName} context handle is not supported.`,
          sourceSpan(element),
        ),
      );
      continue;
    }
    origins.set(declaredName, contextName as NotebookPathOriginKind);
  }

  return { origins, issues };
}

interface CallbackAnalysis {
  readonly references: CellDependencyAnalysis["references"];
  readonly issues: readonly DependencyIssue[];
}

function analyzeCallback(
  document: NotebookDocument,
  cellId: CellId,
  callback: ts.ArrowFunction | ts.FunctionExpression,
): CallbackAnalysis {
  const context = callbackContext(callback);
  const references: CellDependencyAnalysis["references"][number][] = [];
  const issues = [...context.issues];

  const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
    if (isFunctionWithBody(node) && node !== callback) {
      const localNames = new Set<string>();
      if (node.name && ts.isIdentifier(node.name)) {
        localNames.add(node.name.text);
      }
      for (const parameter of node.parameters) {
        addBindingNames(parameter.name, localNames);
      }
      for (const name of functionScopedVarBindings(node)) {
        localNames.add(name);
      }
      for (const parameter of node.parameters) {
        if (parameter.initializer) {
          visit(parameter.initializer, shadowed);
        }
      }
      if (node.body) {
        visit(node.body, withNames(shadowed, localNames));
      }
      return;
    }

    let scopedNames = shadowed;
    if (ts.isBlock(node)) {
      scopedNames = withNames(scopedNames, directBlockBindings(node));
    } else if (ts.isCaseBlock(node)) {
      scopedNames = withNames(scopedNames, directCaseBlockBindings(node));
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      const catchNames = new Set<string>();
      addBindingNames(node.variableDeclaration.name, catchNames);
      scopedNames = withNames(scopedNames, catchNames);
    } else if (
      ts.isForStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isForOfStatement(node)
    ) {
      const initializer = node.initializer;
      if (initializer && ts.isVariableDeclarationList(initializer)) {
        const loopNames = new Set<string>();
        for (const declaration of initializer.declarations) {
          addBindingNames(declaration.name, loopNames);
        }
        scopedNames = withNames(scopedNames, loopNames);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "value"
    ) {
      const path = pathFromValueRead(node, context.origins, scopedNames);
      if (path) {
        const resolution = resolveNotebookPath(document, cellId, path);
        references.push({ path, resolution });
        const problem = resolutionIssue(resolution);
        if (problem) {
          issues.push(problem);
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      isContextHandleExpression(node.initializer, context.origins, scopedNames)
    ) {
      issues.push(
        issue(
          "aliased",
          "ALIASED_CONTEXT",
          "Notebook handle aliases are not resolved as dependency paths.",
          sourceSpan(node),
        ),
      );
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isContextHandleExpression(node.right, context.origins, scopedNames)
    ) {
      issues.push(
        issue(
          "aliased",
          "ALIASED_CONTEXT",
          "Notebook handle aliases are not resolved as dependency paths.",
          sourceSpan(node),
        ),
      );
    }

    ts.forEachChild(node, (child) => visit(child, scopedNames));
  };

  const initialShadowed = functionScopedVarBindings(callback);
  visit(callback.body, initialShadowed);
  return { references, issues };
}

interface ApiCall {
  readonly call: ts.CallExpression;
  readonly helper: "$" | "md";
}

function findApiCalls(sourceFile: ts.SourceFile): readonly ApiCall[] {
  const calls: ApiCall[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "$" || node.expression.text === "md")
    ) {
      calls.push({ call: node, helper: node.expression.text });
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return calls;
}

export function analyzeCellDependencies(
  document: NotebookDocument,
  cell: Cell,
): CellDependencyAnalysis {
  if (cell.kind === "text") {
    return {
      cellId: cell.id,
      kind: cell.kind,
      dependencies: [],
      references: [],
      issues: [],
    };
  }

  const sourceFile = ts.createSourceFile(
    `${cell.id}.tsx`,
    cell.source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const parsedSourceFile = sourceFile as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  };
  const syntaxIssues = (parsedSourceFile.parseDiagnostics ?? []).map(
    (diagnostic) => {
      const start = diagnostic.start ?? 0;
      const end = start + (diagnostic.length ?? 0);
      return issue(
        "syntax",
        "SYNTAX_ERROR",
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        { start, end },
      );
    },
  );
  if (syntaxIssues.length > 0) {
    return {
      cellId: cell.id,
      kind: cell.kind,
      dependencies: [],
      references: [],
      issues: syntaxIssues,
    };
  }

  const expectedHelper = cell.kind === "markdown" ? "md" : "$";
  const calls = findApiCalls(sourceFile).filter(
    ({ helper }) => helper === expectedHelper,
  );
  if (calls.length === 0) {
    return {
      cellId: cell.id,
      kind: cell.kind,
      dependencies: [],
      references: [],
      issues: [
        issue(
          "invalid",
          "CALLBACK_REQUIRED",
          `Cell source must call ${expectedHelper}() with a callback.`,
          { start: 0, end: cell.source.length },
        ),
      ],
    };
  }

  const issues: DependencyIssue[] = [];
  if (calls.length > 1) {
    const second = calls[1];
    issues.push(
      issue(
        "invalid",
        "MULTIPLE_CALLBACKS",
        `Cell source may call ${expectedHelper}() only once.`,
        second ? sourceSpan(second.call) : { start: 0, end: cell.source.length },
      ),
    );
  }

  const references: CellDependencyAnalysis["references"][number][] = [];
  let annotation: ExplicitAnnotation | undefined;
  for (const { call, helper } of calls) {
    if (helper === "$" && call.typeArguments?.length === 1 && !annotation) {
      const typeNode = call.typeArguments[0];
      if (typeNode) {
        const span = sourceSpan(typeNode);
        annotation = { text: cell.source.slice(span.start, span.end), span };
      }
    }

    const callback = callbackExpression(call.arguments[0]);
    if (!callback) {
      issues.push(
        issue(
          "invalid",
          "INVALID_CALLBACK",
          `${helper}() must receive a callback as its first argument.`,
          sourceSpan(call),
        ),
      );
      continue;
    }
    const callbackAnalysis = analyzeCallback(document, cell.id, callback);
    references.push(...callbackAnalysis.references);
    issues.push(...callbackAnalysis.issues);
  }

  const dependencies: CellId[] = [];
  for (const reference of references) {
    if (
      reference.resolution.status === "resolved" &&
      !dependencies.includes(reference.resolution.targetId)
    ) {
      dependencies.push(reference.resolution.targetId);
    }
  }

  return {
    cellId: cell.id,
    kind: cell.kind,
    dependencies,
    references,
    issues,
    ...(annotation ? { annotation } : {}),
  };
}
