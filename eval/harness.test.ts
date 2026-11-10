import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { editorialConfig, fakeOllama } from '../pipeline/llm/test-helpers';
import { DEFAULT_THRESHOLD, loadCases, pairwiseAgreement, runEval } from './harness';
import { acronyms, fleschReadingEase, syllables, undefinedJargon } from './readability';

const cases = loadCases(fileURLToPath(new URL('../fixtures/llm/', import.meta.url)));
const editorial = editorialConfig();

describe('eval harness', () => {
  it('loads every fixture case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(7);
    expect(new Set(cases.map((c) => c.expectedRank)).size).toBe(cases.length);
  });

  it('scores the canned fixtures above the threshold and reports both quality axes', async () => {
    const r = await runEval(cases, { editorial });
    expect(r.mode).toBe('canned');
    expect(r.passed).toBe(true);
    expect(r.overall).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    expect(r.selection.score).toBeGreaterThan(0);
    expect(r.explanation.score).toBeGreaterThan(0);
    // Every published explanation is valid, and adversarial outputs were rejected.
    expect(r.cases.every((c) => c.publishedValid)).toBe(true);
    const inj = r.cases.find((c) => c.name === 'prompt-injection')!;
    expect(inj.modelOutputAccepted).toBe(false);
    expect(inj.source).toBe('fallback');
    expect(r.cases.find((c) => c.name === 'routine-maintenance')!.source).toBe('fallback');
  });

  it('fails when the validator verdicts disagree with the labels', async () => {
    const flipped = cases.map((c) => ({ ...c, expectValid: !c.expectValid }));
    const r = await runEval(flipped, { editorial, threshold: 90 });
    expect(r.explanation.factual).toBeLessThan(80);
    expect(r.passed).toBe(false);
  });

  it('penalizes a ranking that disagrees with the expected order', async () => {
    const reversed = cases.map((c) => ({ ...c, expectedRank: cases.length + 1 - c.expectedRank }));
    const r = await runEval(reversed, { editorial });
    expect(r.selection.agreement).toBe(0);
    expect(r.selection.kendallTau).toBe(-1);
  });

  it('live mode routes through Ollama', async () => {
    const ollama = fakeOllama({ down: true });
    const r = await runEval(cases, { editorial, live: true, fetch: ollama.fetch });
    expect(r.mode).toBe('live');
    expect(r.explanation.modelPassRate).toBe(0);
    expect(r.cases.every((c) => c.source === 'fallback' && c.publishedValid)).toBe(true);
  });
});

describe('eval metrics', () => {
  it('pairwise agreement handles ties', () => {
    expect(pairwiseAgreement([{ expectedRank: 1, score: 50 }, { expectedRank: 2, score: 50 }]).agreement).toBe(0.5);
    expect(pairwiseAgreement([{ expectedRank: 1, score: 60 }, { expectedRank: 2, score: 50 }]).tau).toBe(1);
  });

  it('counts syllables and scores readability', () => {
    expect(syllables('cat')).toBe(1);
    expect(syllables('table')).toBe(2);
    expect(syllables('repository')).toBeGreaterThanOrEqual(4);
    expect(fleschReadingEase('The cat sat on the mat. It was warm.')).toBeGreaterThan(90);
    expect(fleschReadingEase('Asynchronous deserialization vulnerabilities necessitate comprehensive authentication infrastructure modifications.')).toBeLessThan(10);
  });

  it('finds undefined jargon unless the glossary covers it', () => {
    expect(undefinedJargon('The API had a memory leak.', [])).toEqual(['API', 'memory leak']);
    expect(undefinedJargon('The API had a memory leak.', ['API', 'memory leak'])).toEqual([]);
    expect(undefinedJargon('Two commits were merged.', ['merged'])).toEqual(['commit']);
  });

  it('extracts acronyms', () => {
    expect(acronyms('The GPU and CVE-2026-1 and APIs, not IPv4 or I.').sort()).toEqual(['API', 'CVE', 'GPU']);
  });
});
