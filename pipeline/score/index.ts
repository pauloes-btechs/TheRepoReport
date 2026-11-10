/**
 * Deterministic impact scoring and edition selection. Every point traces to a
 * signal with a reason and (where one exists) an evidence URL.
 */
import type { ScoreContext, ScoreStories, SelectStories } from '../../shared/contracts';
import {
  DIMENSION_KEYS,
  DIMENSION_LABELS,
  bandFor,
  type Confidence,
  type DimensionKey,
  type ManifestRepo,
  type ScoreBreakdown,
  type ScoredStory,
  type Story,
} from '../../shared/schemas';
import { statusRank } from '../stories/status';
import { BASE_MAX, DIMENSION_SIGNALS, type Signal } from './rubric';

export { selectStories } from './select';
export { BASE_MAX, parseSemver } from './rubric';

type Dimension = ScoreBreakdown['dimensions'][number];

export const scoreStories: ScoreStories = (stories, context) => {
  const scored = stories.map((story) => scoreStory(story, context));
  scored.sort(compareScored);
  for (let i = 0; i < scored.length - 1; i++) {
    scored[i]!.score.ranksAboveNext = explainRank(scored[i]!, scored[i + 1]!);
  }
  return scored;
};

function scoreStory(story: Story, context: ScoreContext): ScoredStory {
  const repo = findRepo(context.repos, story.repo);
  const categories = repo ? [...new Set([repo.category, ...story.categories])] : story.categories;
  const withCategories: Story = { ...story, categories };

  const dimensions = DIMENSION_KEYS.map((key) =>
    scoreDimension(key, DIMENSION_SIGNALS[key](withCategories, { editorial: context.editorial, repo }), context),
  );
  const total = Math.max(0, Math.min(100, dimensions.reduce((sum, d) => sum + d.awarded, 0)));
  const { confidence, confidenceReason } = assessConfidence(story);
  return {
    ...withCategories,
    score: { total, band: bandFor(total), dimensions, confidence, confidenceReason },
  };
}

function findRepo(repos: ManifestRepo[], slug: string): ManifestRepo | undefined {
  const key = slug.toLowerCase();
  return repos.find((r) => r.repo.toLowerCase() === key);
}

/** Scales base points to the configured weight and caps the dimension at that weight. */
function scoreDimension(key: DimensionKey, signals: Signal[], context: ScoreContext): Dimension {
  const max = context.editorial.weights[key];
  const factor = BASE_MAX[key] > 0 ? max / BASE_MAX[key] : 0;
  const scaled = signals
    .map((s) => ({ ...s, points: Math.round(s.points * factor) }))
    .filter((s) => s.points > 0)
    .sort((a, b) => b.points - a.points);
  const awarded = Math.min(max, scaled.reduce((sum, s) => sum + s.points, 0));
  return { key, max, awarded, signals: scaled };
}

function assessConfidence(story: Story): { confidence: Confidence; confidenceReason: string } {
  const sources: string[] = [];
  const has = (pred: (e: Story['events'][number]) => boolean) => story.events.some(pred);
  if (has((e) => e.kind === 'release' && !e.prerelease)) sources.push('a published release');
  else if (has((e) => e.kind === 'release')) sources.push('a pre-release');
  if (has((e) => e.kind === 'pull_request' && e.state === 'merged')) sources.push('a merged pull request');
  if (has((e) => e.kind === 'advisory')) sources.push('a security advisory');
  if (has((e) => e.kind === 'advisory' && !!e.cveId)) sources.push('a CVE record');

  if (sources.length >= 2) {
    return { confidence: 'high', confidenceReason: `Independent primary sources agree: ${joinList(sources)}.` };
  }
  if (sources.length === 1) {
    return { confidence: 'medium', confidenceReason: `One authoritative source: ${sources[0]}.` };
  }
  return {
    confidence: 'low',
    confidenceReason: 'Only open proposals or discussion so far; nothing has been merged or released.',
  };
}

function joinList(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Higher score first; ties go to the more advanced status, then the fresher story. */
function compareScored(a: ScoredStory, b: ScoredStory): number {
  return (
    b.score.total - a.score.total ||
    statusRank(b.status) - statusRank(a.status) ||
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}

const SHORT_LABELS: Record<DimensionKey, string> = {
  security: 'security',
  breaking: 'breaking change',
  capability: 'capability',
  reliability: 'reliability',
  ecosystem: 'ecosystem',
  relevance: 'relevance',
};

/** One sentence naming the two largest dimension advantages over the next story. */
export function explainRank(a: ScoredStory, b: ScoredStory): string {
  const name = `"${b.title}" (${b.repo})`;
  const leads = a.score.dimensions
    .map((dim) => {
      const other = b.score.dimensions.find((d) => d.key === dim.key);
      return { dim, delta: dim.awarded - (other?.awarded ?? 0) };
    })
    .filter((x) => x.delta > 0)
    .sort((x, y) => y.delta - x.delta || DIMENSION_KEYS.indexOf(x.dim.key) - DIMENSION_KEYS.indexOf(y.dim.key))
    .slice(0, 2);

  if (a.score.total === b.score.total || leads.length === 0) {
    const why =
      statusRank(a.status) > statusRank(b.status)
        ? 'its development status is further along'
        : 'it was updated more recently';
    return `Ties with ${name} at ${a.score.total} points; listed first because ${why}.`;
  }
  const parts = leads.map(({ dim, delta }) => {
    const signal = distinguishingSignal(dim, b.score.dimensions.find((d) => d.key === dim.key));
    const what = signal ? lowerFirst(signal.reason) : DIMENSION_LABELS[dim.key].toLowerCase();
    return `${SHORT_LABELS[dim.key]} (+${delta}: ${what})`;
  });
  return `Ranks above ${name} on ${parts.join(' and ')}.`;
}

/** The strongest signal the other story lacks, so the sentence names the actual difference. */
function distinguishingSignal(dim: Dimension, other: Dimension | undefined): Dimension['signals'][number] | undefined {
  const theirs = new Set(other?.signals.map((s) => s.reason) ?? []);
  return dim.signals.find((s) => !theirs.has(s.reason)) ?? dim.signals[0];
}

function lowerFirst(s: string): string {
  // Keep acronyms such as "CVE-…" intact.
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
