import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCES = [
  '../physics/axle.ts',
  '../physics/differential.ts',
  '../physics/soil.ts',
  '../physics/tire.ts',
] as const;

const ALLOCATING_ARRAY_METHODS = new Set([
  'concat', 'filter', 'flat', 'flatMap', 'map', 'reduce', 'slice', 'sort',
]);

describe('marked physics hot loops', () => {
  for (const relative of SOURCES) {
    it(`${relative} contains no direct body allocations`, () => {
      const path = fileURLToPath(new URL(relative, import.meta.url));
      const text = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const failures: string[] = [];
      for (const statement of source.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.body || !statement.name) continue;
        const leading = text.slice(statement.getFullStart(), statement.getStart(source));
        if (!leading.includes('@hotloop')) continue;
        inspectBody(statement.body, statement.name.text, source, failures);
      }
      expect(failures).toEqual([]);
    });
  }
});

function inspectBody(
  body: ts.Block,
  functionName: string,
  source: ts.SourceFile,
  failures: string[],
): void {
  const visit = (node: ts.Node): void => {
    let reason: string | null = null;
    if (ts.isArrayLiteralExpression(node)) reason = 'array literal';
    else if (ts.isObjectLiteralExpression(node)) reason = 'object literal';
    else if (ts.isNewExpression(node)) reason = 'new expression';
    else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) reason = 'callback/function expression';
    else if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) reason = 'spread';
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ALLOCATING_ARRAY_METHODS.has(node.expression.name.text)) {
      reason = `.${node.expression.name.text}()`;
    }
    if (reason) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`${functionName}:${position.line + 1}:${position.character + 1} ${reason}`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
}
