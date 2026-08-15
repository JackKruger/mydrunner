import { describe, expect, it } from 'vitest';
import { QUALITY } from '../quality.js';
import { shouldUsePostProcessAntialias } from '../postProcessing.js';

describe('post-process antialiasing', () => {
  it('never duplicates renderer MSAA', () => {
    expect(QUALITY.high.antialias).toBe(true);
    expect(shouldUsePostProcessAntialias(QUALITY.high)).toBe(false);
  });

  it('requires both a request and a renderer without MSAA', () => {
    expect(shouldUsePostProcessAntialias({
      ...QUALITY.high,
      antialias: false,
      postProcessAntialias: true,
    })).toBe(true);
    expect(shouldUsePostProcessAntialias(QUALITY.low)).toBe(false);
  });
});
