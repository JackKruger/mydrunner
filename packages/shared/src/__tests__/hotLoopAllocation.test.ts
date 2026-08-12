import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCES = [
  '../physics/axle.ts',
  '../physics/differential.ts',
  '../physics/engine.ts',
  '../physics/soil.ts',
  '../physics/solidAxleVehicle.ts',
  '../physics/tire.ts',
  '../physics/tireCarcass.ts',
  '../physics/util.ts',
  '../physics/wheelContact.ts',
] as const;

/** Every method the owner tick runs at 60 Hz, so a rename or a dropped mark
 *  is a failing test rather than a silently unguarded phase. */
const REQUIRED_MARKS: Record<string, readonly string[]> = {
  '../physics/solidAxleVehicle.ts': [
    'phaseBegin',
    'phaseContact',
    'phaseSuspension',
    'phaseWater',
    'phaseEngine',
    'phaseDriveline',
    'phaseTyreSoil',
  ],
};

const ALLOCATING_ARRAY_METHODS = new Set([
  'concat', 'filter', 'flat', 'flatMap', 'map', 'reduce', 'slice', 'sort',
]);

describe('marked physics hot loops', () => {
  for (const relative of SOURCES) {
    it(`${relative} contains no direct body allocations`, () => {
      const { source, text } = parse(relative);
      const failures: string[] = [];
      for (const fn of markedFunctions(source, text)) {
        inspectBody(fn.body, fn.name, source, failures);
      }
      expect(failures).toEqual([]);
    });
  }

  it('marks every phase of the owner tick', () => {
    for (const [relative, required] of Object.entries(REQUIRED_MARKS)) {
      const { source, text } = parse(relative);
      const marked = new Set(markedFunctions(source, text).map((fn) => fn.name));
      for (const name of required) {
        expect(marked, `${relative}: ${name} is missing its @hotloop mark`).toContain(name);
      }
    }
  });

  it('detects an allocation in a marked class method', () => {
    // The guard grew from free functions to methods; this pins that it still
    // looks inside a class rather than passing vacuously on a file of them.
    const text = [
      'class Probe {',
      '  /** @hotloop */',
      '  step(): void {',
      '    const scratch = { x: 0 };',
      '    void scratch;',
      '  }',
      '}',
    ].join('\n');
    const source = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const failures: string[] = [];
    for (const fn of markedFunctions(source, text)) {
      inspectBody(fn.body, fn.name, source, failures);
    }
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('object literal');
  });
});

function parse(relative: string): { source: ts.SourceFile; text: string } {
  const path = fileURLToPath(new URL(relative, import.meta.url));
  const text = readFileSync(path, 'utf8');
  return {
    source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    text,
  };
}

interface MarkedFunction {
  name: string;
  body: ts.Block;
}

/** Free functions and class methods alike, anywhere in the file. `@hotloop`
 *  is read from the declaration's leading trivia, so it works from a JSDoc
 *  block or a plain comment line above either form. */
function markedFunctions(source: ts.SourceFile, text: string): MarkedFunction[] {
  const found: MarkedFunction[] = [];
  const visit = (node: ts.Node): void => {
    const declaration = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      ? node
      : null;
    if (declaration?.body && declaration.name) {
      const leading = text.slice(declaration.getFullStart(), declaration.getStart(source));
      if (leading.includes('@hotloop')) {
        found.push({
          name: declaration.name.getText(source),
          body: declaration.body as ts.Block,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

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
