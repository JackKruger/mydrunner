import { afterEach, describe, expect, it } from 'vitest';
import { TUNING } from '@mydrunner/shared';
import { serialiseTuning } from '../debugTuningExport.js';

/** Every leaf of TUNING as a path, e.g. ['axleFront', 'rideStiffnessMult']. */
function leafPaths(value: Record<string, unknown>, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for (const [key, child] of Object.entries(value)) {
    if (child !== null && typeof child === 'object') out.push(...leafPaths(child as Record<string, unknown>, [...prefix, key]));
    else out.push([...prefix, key]);
  }
  return out;
}

function holder(path: string[]): Record<string, unknown> {
  let node = TUNING as unknown as Record<string, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  return node;
}

const snapshot = JSON.stringify(TUNING);
afterEach(() => {
  // TUNING is a shared live singleton; put back whatever a case perturbed.
  const original = JSON.parse(snapshot) as Record<string, unknown>;
  for (const path of leafPaths(original)) {
    let source: unknown = original;
    for (const key of path) source = (source as Record<string, unknown>)[key];
    holder(path)[path[path.length - 1]!] = source;
  }
});

// The copy-to-clipboard serialiser is a hand-written template, so a new
// TUNING field is silently missing from it until someone remembers. A field
// whose value cannot change the output is a field the tester cannot bake.
describe('debug tuning export', () => {
  const paths = leafPaths(TUNING as unknown as Record<string, unknown>);

  it('covers a non-trivial set of fields', () => {
    expect(paths.length).toBeGreaterThan(40);
  });

  for (const path of paths) {
    it(`reflects TUNING.${path.join('.')}`, () => {
      const before = serialiseTuning();
      const target = holder(path);
      const key = path[path.length - 1]!;
      const current = target[key];
      // A distinctive value that survives the serialiser's rounding (it
      // prints as few as 0 decimals) for any field magnitude.
      target[key] = typeof current === 'boolean' ? !current : (current as number) * 3 + 7;
      expect(serialiseTuning()).not.toBe(before);
    });
  }
});
