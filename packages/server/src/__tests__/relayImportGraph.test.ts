import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * "The server does not simulate vehicles" should be true of the dependency
 * graph, not just of behaviour. The relay imports `@mydrunner/shared/relay`,
 * whose `Physics` namespace is the Rapier-free barrel; this walks every
 * static value import reachable from the server entry point and fails if any
 * path arrives at Rapier, printing the chain that did.
 *
 * Deliberately strict: only a wholesale `import type` / `export type` is
 * skipped. `import { type X }` still counts, because whether that survives
 * transpilation depends on compiler settings this test should not assume.
 */

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '../index.ts');
const sharedRoot = resolve(here, '../../../shared');
const FORBIDDEN = '@dimforge/rapier3d-compat';

function sharedExport(subpath: string): string {
  const pkg = JSON.parse(readFileSync(resolve(sharedRoot, 'package.json'), 'utf8')) as { exports: Record<string, string> };
  const target = pkg.exports[subpath === '' ? '.' : `./${subpath}`];
  if (!target) throw new Error(`@mydrunner/shared has no export for "${subpath}"`);
  return resolve(sharedRoot, target);
}

/** Resolved file for a workspace specifier, or null for an external package. */
function resolveSpecifier(from: string, spec: string): string | null {
  if (spec.startsWith('.')) {
    const base = resolve(dirname(from), spec);
    for (const candidate of [base.replace(/\.js$/, '.ts'), `${base}.ts`, resolve(base, 'index.ts')]) {
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(`cannot resolve ${spec} from ${from}`);
  }
  if (spec === '@mydrunner/shared' || spec.startsWith('@mydrunner/shared/')) {
    return sharedExport(spec.slice('@mydrunner/shared'.length).replace(/^\//, ''));
  }
  return null;
}

function valueImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, false);
  const specs: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.isTypeOnly) continue;
      specs.push((statement.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      if (statement.isTypeOnly) continue;
      specs.push((statement.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return specs;
}

/** Chain of files from the entry to the first import of `FORBIDDEN`, or null. */
function findForbiddenPath(entry: string): string[] | null {
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  const chain = (file: string): string[] => {
    const out: string[] = [];
    for (let f: string | null = file; f; f = parent.get(f) ?? null) out.unshift(f.replace(`${resolve(here, '../../..')}/`, ''));
    return out;
  };
  while (queue.length > 0) {
    const file = queue.shift()!;
    for (const spec of valueImports(file)) {
      if (spec === FORBIDDEN) return [...chain(file), FORBIDDEN];
      const next = resolveSpecifier(file, spec);
      if (next && !parent.has(next)) {
        parent.set(next, file);
        queue.push(next);
      }
    }
  }
  return null;
}

describe('relay import graph', () => {
  it('reaches no Rapier import from the server entry point', () => {
    expect(findForbiddenPath(serverEntry)).toBeNull();
  });

  it('would notice if it did', () => {
    // Guards the walker itself: the full shared barrel does import Rapier.
    expect(findForbiddenPath(sharedExport(''))).not.toBeNull();
  });
});
