// Map ids come from a text field, so they can hold anything a user
// typed — and they end up as a JS identifier in the generated module.
// An id of "canyon run 2" would otherwise emit source that does not
// parse, which the author only finds out when they paste it in.

import { describe, expect, it } from 'vitest';
import { Maps } from '@mydrunner/shared';
import { moduleIdentifier, moduleSource } from '../editor/documentIo.js';

describe('moduleIdentifier', () => {
  it('passes a clean id through', () => {
    expect(moduleIdentifier('canyon')).toBe('canyon');
    expect(moduleIdentifier('canyon_run2')).toBe('canyon_run2');
  });

  it('replaces characters that cannot appear in an identifier', () => {
    expect(moduleIdentifier('canyon run')).toBe('canyon_run');
    expect(moduleIdentifier('canyon-run.2')).toBe('canyon_run_2');
  });

  it('prefixes an id that starts with a digit', () => {
    expect(moduleIdentifier('2fast')).toBe('map_2fast');
  });

  it('falls back rather than emitting an empty name', () => {
    expect(moduleIdentifier('')).toBe('authoredMap');
  });

  it('leaves an all-punctuation id as underscores, which is legal', () => {
    // Not pretty, but `___` parses; only the empty result needs a name
    // invented for it.
    expect(moduleIdentifier('!!!')).toBe('___');
  });
});

describe('moduleSource', () => {
  it('emits a module that declares the map under a usable name', () => {
    const doc = { ...Maps.proceduralDoc({ size: 100, resolution: 32 }), id: 'canyon run' };
    const src = moduleSource(doc);
    expect(src).toContain('export const canyon_run: MapDoc =');
    expect(src).toContain("import type { MapDoc } from '../mapDoc.js';");
  });

  it('emits a body the strict decoder accepts', () => {
    const doc = Maps.proceduralDoc({ size: 100, resolution: 32 });
    const body = moduleSource(doc).split('MapDoc = ')[1]!.replace(/;\n$/, '');
    expect(() => Maps.decodeMapDoc(JSON.parse(body))).not.toThrow();
  });
});
