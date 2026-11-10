/**
 * Editorial eval: scores selection and explanation quality over fixtures with
 * source-grounded checks (no model grading itself).
 *
 *   Factual accuracy      30%  validator verdicts; published text traceable to evidence
 *   Story selection       25%  pairwise agreement of score order with hand-labeled order
 *   Beginner clarity      20%  Flesch reading ease + undefined-jargon count
 *   Practical impact      15%  "why it matters" length, concrete subject, specificity
 *   Narration and brevity 10%  script length vs target, acronym pronunciation coverage
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { FetchLike } from '../shared/contracts';
import { EditorialConfig, ScoredStory, type ExplainedStory } from '../shared/schemas';
import { explainStoriesWith } from '../pipeline/llm';
import { checkAgainstEvidence, meaningfulWords, validateExplanation } from '../pipeline/llm/validate';
import { buildScript, estimateMinutes } from '../pipeline/script';
import { acronyms, fleschReadingEase, undefinedJargon } from './readability';

export const EvalCase = z.object({
  name: z.string(),
  description: z.string().default(''),
  /** Hand-labeled position in the expected running order (1 = lead). */
  expectedRank: z.number().int().positive(),
  story: ScoredStory,
  /** Recorded model output (object or raw string). Absent → deterministic fallback. */
  cannedOutput: z.unknown().optional(),
  /** Whether the validator should accept the canned output. Adversarial cases set false. */
  expectValid: z.boolean().default(true),
});
export type EvalCase = z.infer<typeof EvalCase>;

export const WEIGHTS = { factual: 30, selection: 25, clarity: 20, impact: 15, narration: 10 } as const;
export const DEFAULT_THRESHOLD = 70;

export function loadCases(dir: string): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => EvalCase.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

export function loadEditorial(path: string): EditorialConfig {
  return EditorialConfig.parse(JSON.parse(readFileSync(path, 'utf8')));
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** Share of case pairs whose score order agrees with the expected order (ties count half). */
export function pairwiseAgreement(items: { expectedRank: number; score: number }[]): { agreement: number; tau: number } {
  let pairs = 0;
  let agree = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.expectedRank === b.expectedRank) continue;
      pairs++;
      const expectAFirst = a.expectedRank < b.expectedRank;
      if (a.score === b.score) agree += 0.5;
      else if (a.score > b.score === expectAFirst) agree += 1;
    }
  }
  const agreement = pairs ? agree / pairs : 1;
  return { agreement, tau: 2 * agreement - 1 };
}

/** A fetch that serves a recorded model output, so the full explain path runs offline. */
export function cannedFetch(output: unknown, model: string): FetchLike {
  const content = typeof output === 'string' ? output : JSON.stringify(output);
  return (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: model }] });
    return Response.json({
      message: { role: 'assistant', content },
      eval_count: Math.ceil(content.length / 4),
      eval_duration: 1e9,
    });
  }) as FetchLike;
}

function beginnerText(s: ExplainedStory): string {
  const x = s.explanation;
  return [x.headline, x.whatHappened, x.previously, x.whatChanged, x.whyItMatters, x.nextConfirmed, x.nextSpeculative]
    .filter(Boolean)
    .map((t) => (/[.!?]$/.test(t.trim()) ? t : `${t}.`))
    .join(' ');
}

const AFFECTED_RE =
  /\b(users?|developers?|operators?|anyone|people|apps?|teams?|projects?|wallets?|nodes?|maintainers|customers|servers?|businesses|websites?|readers?)\b/i;

export interface CaseResult {
  name: string;
  expectedRank: number;
  score: number;
  source: 'llm' | 'fallback';
  modelOutputAccepted?: boolean;
  expectValid: boolean;
  verdictCorrect?: boolean;
  publishedValid: boolean;
  publishedIssues: string[];
  modelIssues: string[];
  flesch: number;
  undefinedJargon: string[];
  whyItMattersWords: number;
  scores: { factual: number; clarity: number; impact: number };
}

export interface EvalReport {
  generatedAt: string;
  mode: 'canned' | 'live';
  model?: string;
  threshold: number;
  overall: number;
  passed: boolean;
  selection: { score: number; agreement: number; kendallTau: number; expectedOrder: string[]; scoreOrder: string[] };
  explanation: {
    score: number;
    factual: number;
    clarity: number;
    impact: number;
    narration: number;
    modelPassRate?: number;
  };
  narration: { minutes: number; target: { min: number; max: number }; acronymsFound: string[]; acronymsUnspoken: string[] };
  cases: CaseResult[];
}

export interface RunEvalOptions {
  editorial: EditorialConfig;
  live?: boolean;
  ollamaUrl?: string;
  model?: string;
  fetch?: FetchLike;
  threshold?: number;
}

async function explainCases(cases: EvalCase[], opts: RunEvalOptions): Promise<ExplainedStory[]> {
  const model = opts.model ?? opts.editorial.model;
  if (opts.live) {
    const result = await explainStoriesWith(
      cases.map((c) => c.story),
      { editorial: opts.editorial, ollamaUrl: opts.ollamaUrl, model, fetch: opts.fetch },
    );
    return result.stories;
  }
  const out: ExplainedStory[] = [];
  for (const c of cases) {
    const result = await explainStoriesWith([c.story], {
      editorial: opts.editorial,
      model,
      forceFallback: c.cannedOutput === undefined,
      fetch: cannedFetch(c.cannedOutput, model),
    });
    out.push(result.stories[0]!);
  }
  return out;
}

export async function runEval(cases: EvalCase[], opts: RunEvalOptions): Promise<EvalReport> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const ordered = [...cases].sort((a, b) => a.expectedRank - b.expectedRank);
  const explained = await explainCases(ordered, opts);

  // ── Story selection (independent of the model) ──
  const pw = pairwiseAgreement(ordered.map((c) => ({ expectedRank: c.expectedRank, score: c.story.score.total })));
  const scoreOrder = [...ordered].sort((a, b) => b.story.score.total - a.story.score.total).map((c) => c.name);

  // ── Per-explanation checks ──
  const results: CaseResult[] = ordered.map((c, i) => {
    const s = explained[i]!;
    const x = s.explanation;
    const publishedIssues = checkAgainstEvidence(x, c.story);
    const publishedValid = publishedIssues.length === 0;

    let modelOutputAccepted: boolean | undefined;
    let modelIssues: string[] = [];
    if (opts.live) {
      modelOutputAccepted = x.source === 'llm';
      modelIssues = x.source === 'llm' ? [] : x.validationNotes;
    } else if (c.cannedOutput !== undefined) {
      const v = validateExplanation(c.cannedOutput, c.story);
      modelOutputAccepted = v.ok;
      modelIssues = v.issues;
    }
    // Canned mode: the validator must reach the labeled verdict. Live mode: the model must pass.
    const verdictCorrect =
      modelOutputAccepted === undefined ? undefined : opts.live ? modelOutputAccepted : modelOutputAccepted === c.expectValid;
    const factual = (publishedValid ? 0.5 : 0) + (verdictCorrect === undefined ? 0.5 : verdictCorrect ? 0.5 : 0);

    const text = beginnerText(s);
    const flesch = fleschReadingEase(text);
    const jargon = undefinedJargon(text, x.glossary.map((g) => g.term));
    const clarity = 0.6 * clamp01((flesch - 30) / 30) + 0.4 * clamp01(1 - 0.25 * jargon.length);

    const whyWords = (x.whyItMatters.match(/\S+/g) ?? []).length;
    const lengthScore = whyWords < 12 ? whyWords / 12 : whyWords <= 80 ? 1 : clamp01(1 - (whyWords - 80) / 80);
    const subject = AFFECTED_RE.test(x.whyItMatters) || x.whyItMatters.toLowerCase().includes(c.story.repo.split('/')[1]!.toLowerCase()) ? 1 : 0;
    const anchor = new Set(meaningfulWords([c.story.title, ...c.story.events.map((e) => `${e.title} ${e.body}`)].join(' ')));
    const specific = meaningfulWords(x.whyItMatters).some((w) => anchor.has(w)) ? 1 : 0;
    const impact = 0.4 * lengthScore + 0.3 * subject + 0.3 * specific;

    return {
      name: c.name,
      expectedRank: c.expectedRank,
      score: c.story.score.total,
      source: x.source,
      modelOutputAccepted,
      expectValid: c.expectValid,
      verdictCorrect,
      publishedValid,
      publishedIssues,
      modelIssues,
      flesch: round(flesch, 1),
      undefinedJargon: jargon,
      whyItMattersWords: whyWords,
      scores: { factual: round(factual), clarity: round(clarity), impact: round(impact) },
    };
  });

  // ── Narration: build the edition script the way the pipeline would ──
  const isWatch = (s: ExplainedStory) => s.status === 'proposed' || s.status === 'in_development';
  const selected = explained.filter((s) => !isWatch(s)).slice(0, opts.editorial.maxStories);
  const watching = explained.filter(isWatch);
  const segments = buildScript({ edition: 'morning', date: '2026-11-10', stories: selected, watching, editorial: opts.editorial });
  const minutes = estimateMinutes(segments);
  const { max } = opts.editorial.targetMinutes;
  const lengthScore = minutes <= max ? 1 : clamp01(max / minutes);
  const found = [...new Set(segments.flatMap((s) => acronyms(s.text)))];
  const unspoken = [...new Set(segments.flatMap((s) => acronyms(s.spokenText)))].filter((a) => found.includes(a));
  const coverage = found.length ? 1 - unspoken.length / found.length : 1;
  const narration = 0.6 * lengthScore + 0.4 * coverage;

  const factual = mean(results.map((r) => r.scores.factual));
  const clarity = mean(results.map((r) => r.scores.clarity));
  const impact = mean(results.map((r) => r.scores.impact));
  const selection = pw.agreement;
  const overall =
    WEIGHTS.factual * factual +
    WEIGHTS.selection * selection +
    WEIGHTS.clarity * clarity +
    WEIGHTS.impact * impact +
    WEIGHTS.narration * narration;
  const explanationScore =
    ((WEIGHTS.factual * factual + WEIGHTS.clarity * clarity + WEIGHTS.impact * impact + WEIGHTS.narration * narration) /
      (100 - WEIGHTS.selection)) *
    100;
  const judged = results.filter((r) => r.modelOutputAccepted !== undefined);

  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    mode: opts.live ? 'live' : 'canned',
    threshold,
    overall: round(overall, 1),
    passed: overall >= threshold,
    selection: {
      score: round(selection * 100, 1),
      agreement: round(pw.agreement),
      kendallTau: round(pw.tau),
      expectedOrder: ordered.map((c) => c.name),
      scoreOrder,
    },
    explanation: {
      score: round(explanationScore, 1),
      factual: round(factual * 100, 1),
      clarity: round(clarity * 100, 1),
      impact: round(impact * 100, 1),
      narration: round(narration * 100, 1),
      modelPassRate: judged.length ? round(judged.filter((r) => r.modelOutputAccepted).length / judged.length) : undefined,
    },
    narration: { minutes: round(minutes, 2), target: opts.editorial.targetMinutes, acronymsFound: found, acronymsUnspoken: unspoken },
    cases: results,
  };
  if (opts.live) report.model = opts.model ?? opts.editorial.model;
  return report;
}

export function formatSummary(r: EvalReport): string {
  const lines = [
    `TheRepoReport eval (${r.mode}${r.model ? `, ${r.model}` : ''}) over ${r.cases.length} fixtures`,
    `  Selection quality:   ${r.selection.score.toFixed(1)} / 100  (pairwise agreement ${r.selection.agreement}, Kendall tau ${r.selection.kendallTau})`,
    `  Explanation quality: ${r.explanation.score.toFixed(1)} / 100`,
    `    factual accuracy ${r.explanation.factual}  clarity ${r.explanation.clarity}  impact ${r.explanation.impact}  narration ${r.explanation.narration}`,
    `    model outputs accepted by validator: ${r.explanation.modelPassRate ?? 'n/a'}`,
    `  Script length: ${r.narration.minutes} min (target ${r.narration.target.min}–${r.narration.target.max})` +
      (r.narration.acronymsUnspoken.length ? `; acronyms missing from lexicon: ${r.narration.acronymsUnspoken.join(', ')}` : ''),
    '  Cases:',
    ...r.cases.map(
      (c) =>
        `    #${c.expectedRank} ${c.name.padEnd(28)} score ${String(c.score).padStart(3)}  ${c.source.padEnd(8)} ` +
        `model ${c.modelOutputAccepted === undefined ? 'n/a     ' : c.modelOutputAccepted ? 'accepted' : 'rejected'} ` +
        `(expected ${c.expectValid ? 'accept' : 'reject'})  published ${c.publishedValid ? 'valid' : 'INVALID'}  ` +
        `Flesch ${c.flesch}  jargon ${c.undefinedJargon.length ? c.undefinedJargon.join('/') : '0'}`,
    ),
    `  OVERALL ${r.overall.toFixed(1)} / 100 (threshold ${r.threshold}) → ${r.passed ? 'PASS' : 'FAIL'}`,
  ];
  return lines.join('\n');
}
