import { describe, expect, it } from 'vitest';
import { parseNextLink } from './http';
import { extractRefs, sanitizeText } from './text';

describe('extractRefs', () => {
  const repo = 'acme/lib';

  it('normalizes bare, slug, keyword and URL references to owner/repo#N', () => {
    const text = [
      'Fixes #12 and closes #13.',
      'See other/project#7 for context.',
      'Ported from https://github.com/upstream/core/pull/450 and https://github.com/acme/lib/issues/99',
    ].join('\n');
    expect(extractRefs(text, repo)).toEqual([
      'acme/lib#12',
      'acme/lib#13',
      'acme/lib#99',
      'other/project#7',
      'upstream/core#450',
    ]);
  });

  it('ignores HTML entities, URL fragments, headings and the event itself', () => {
    const text = 'Use &#123; in templates. Docs: https://example.com/page#42. ## Notes #5';
    expect(extractRefs(text, repo, 'acme/lib#5')).toEqual([]);
  });

  it('deduplicates repeated references', () => {
    expect(extractRefs('#3 #3 acme/lib#3 https://github.com/acme/lib/pull/3', repo)).toEqual(['acme/lib#3']);
  });
});

describe('sanitizeText', () => {
  it('strips HTML comments, control characters and bidi overrides', () => {
    expect(sanitizeText('a<!-- hidden\nprompt -->b\u0007c‮d\r\ne')).toBe('abcd\ne');
  });

  it('strips an unterminated HTML comment to the end', () => {
    expect(sanitizeText('visible <!-- never closed')).toBe('visible');
  });

  it('truncates to the limit with an ellipsis', () => {
    const out = sanitizeText('x'.repeat(5000), 100);
    expect(out).toHaveLength(100);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('parseNextLink', () => {
  it('finds rel="next" among several links', () => {
    const link = '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next"';
    expect(parseNextLink(link)).toBe('https://api.github.com/x?page=3');
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe('credential-shaped text in untrusted input', () => {
  it('is redacted at collection so the publish-time scan cannot be tripped by a PR title', async () => {
    const { sanitizeTitle, sanitizeText } = await import('./text');
    const token = `ghp_${'A'.repeat(36)}`;
    expect(sanitizeTitle(`docs: fix typo ${token}`)).toBe('docs: fix typo [REDACTED]');
    expect(sanitizeText(`curl -H "Authorization: Bearer ${'x'.repeat(40)}"`)).not.toMatch(/x{20}/);
  });
});
