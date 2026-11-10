/** Small, dependency-free readability helpers for the eval harness. */

/** Heuristic English syllable count (good enough for Flesch on short texts). */
export function syllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const groups = w.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[A-Za-z]/.test(s));
}

export function words(text: string): string[] {
  return text.match(/[A-Za-z][A-Za-z'-]*|\d+(?:\.\d+)*/g) ?? [];
}

/** Flesch reading ease: higher is easier. 60–70 is plain English; 30 and below is academic. */
export function fleschReadingEase(text: string): number {
  const w = words(text);
  const s = Math.max(1, sentences(text).length);
  if (w.length === 0) return 0;
  const syl = w.reduce((n, x) => n + syllables(x), 0);
  return 206.835 - 1.015 * (w.length / s) - 84.6 * (syl / w.length);
}

/**
 * Terms a college freshman may not know. A term counts as "undefined" when it
 * appears in the beginner text but no glossary entry covers it.
 */
export const JARGON = [
  'API', 'SDK', 'CLI', 'CVE', 'GHSA', 'RPC', 'P2P', 'TLS', 'OAuth', 'JWT', 'SQL', 'GPU', 'CPU', 'KV cache',
  'repository', 'pull request', 'merge', 'merged', 'commit', 'branch', 'fork', 'rebase', 'semver',
  'dependency', 'dependencies', 'runtime', 'compiler', 'kernel', 'cache', 'latency', 'throughput',
  'regression', 'deprecated', 'deprecation', 'endpoint', 'webhook', 'middleware', 'refactor', 'schema',
  'mempool', 'UTXO', 'consensus', 'node', 'mainnet', 'testnet', 'soft fork', 'hard fork', 'opcode',
  'smart contract', 'EVM', 'gas', 'liquidity', 'oracle', 'bundle', 'gzip', 'minifier', 'transpile',
  'memory leak', 'race condition', 'buffer overflow', 'path traversal', 'deserialization', 'sandbox',
  'inference', 'quantization', 'token', 'embedding', 'checksum', 'hash', 'signature', 'invoice', 'routing',
  'security advisory', 'pre-release', 'release candidate', 'Tor', 'I2P', 'inbound',
] as const;

function termRegex(term: string): RegExp {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const caseSensitive = /^[A-Z0-9]{2,}$/.test(term) || /^[A-Z][a-z]+[A-Z]/.test(term);
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?:s|es|ed|ing)?(?![A-Za-z0-9])`, caseSensitive ? '' : 'i');
}

/** Jargon terms used in `text` that no glossary term covers. */
export function undefinedJargon(text: string, glossaryTerms: string[]): string[] {
  const defined = glossaryTerms.map((g) => g.toLowerCase());
  const found: string[] = [];
  for (const term of JARGON) {
    if (!termRegex(term).test(text)) continue;
    const t = term.toLowerCase();
    const covered = defined.some((d) => d === t || d.includes(t) || t.includes(d) || d.startsWith(t.slice(0, 5)));
    if (!covered) found.push(term);
  }
  // "merge" and "merged" are one concept.
  return found.filter((t, _i, all) => !(t === 'merge' && all.includes('merged')));
}

/** Acronyms (2–6 capitals, optional plural s) in display text. */
export function acronyms(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,5})(s?)(?![A-Za-z0-9])/g)) {
    const a = m[1]!;
    if (/^\d/.test(a) || /^(I|A|OK)$/.test(a)) continue;
    out.add(a);
  }
  return [...out];
}
