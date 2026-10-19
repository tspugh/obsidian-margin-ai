import { describe, expect, it } from 'vitest';
import { mergeRetryExclusions, normalizeExcludedFolders } from '../src/margin-ai/request-policy';

describe('context request policy', () => {
  it('normalizes vault-relative exclusion folders and fails closed on invalid input', () => {
    expect(normalizeExcludedFolders(' Private , Archive/Old\nProjects ')).toEqual(['Private', 'Archive/Old', 'Projects']);
    expect(() => normalizeExcludedFolders('../Outside')).toThrow(/vault-relative/i);
    expect(() => normalizeExcludedFolders('.obsidian')).toThrow(/vault-relative/i);
    expect(() => normalizeExcludedFolders('A//B')).toThrow(/vault-relative/i);
  });

  it('retries with the union of original and currently stricter exclusions', () => {
    expect(mergeRetryExclusions(['Private', 'Old'], ['Private', 'Secret'])).toEqual(['Private', 'Old', 'Secret']);
  });
});
