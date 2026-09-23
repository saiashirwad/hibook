import ts from "typescript";
import type { CellKind } from "../model/types";

export type CellSyntax = "bindings" | "expression" | "template";

export function singleExpression(sourceFile: ts.SourceFile): ts.Expression | undefined {
  const statement = sourceFile.statements[0];
  return sourceFile.statements.length === 1 && statement && ts.isExpressionStatement(statement)
    ? statement.expression
    : undefined;
}

export function cellSyntax(sourceFile: ts.SourceFile, kind: CellKind): CellSyntax {
  if (kind === "markdown") {
    return "template";
  }
  return singleExpression(sourceFile) ? "expression" : "bindings";
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isBindingElement(element) ? bindingNames(element.name) : [],
  );
}

export function topLevelBindings(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        names.push(...bindingNames(declaration.name));
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name
    ) {
      names.push(statement.name.text);
    }
  }
  return names;
}
