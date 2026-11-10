/**
 * Shared data contracts for TheRepoReport.
 *
 * Every JSON file the pipeline reads or publishes is described here, and both
 * the pipeline and the frontend validate against these schemas. Changing a
 * schema is a contract change: do it in its own small pull request.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

// ───────────────────────── Configuration ─────────────────────────

/** Only https links are published; rules out javascript:, data: and plain http. */
export const HttpsUrl = z.string().url().regex(/^https:\/\//, 'expected an https:// URL');

export const RepoSlug = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected "owner/name"');

export const WatchedRepo = z.object({
  repo: RepoSlug,
  category: z.string().default('Uncategorized'),
  /** 1 = low, 2 = normal, 3 = high. */
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  enabled: z.boolean().default(true),
  topics: z.array(z.string()).default([]),
});
export type WatchedRepo = z.infer<typeof WatchedRepo>;

export const WatchlistConfig = z.object({
  version: z.literal(1),
  /** GitHub username whose public stars are merged into the watchlist. */
  githubUser: z.string().optional(),
  /** When true, the collector adds the user's public starred repos at run time. */
  includeStarred: z.boolean().default(false),
  maxRepos: z.number().int().positive().default(50),
  repos: z.array(WatchedRepo),
});
export type WatchlistConfig = z.infer<typeof WatchlistConfig>;

export const DIMENSION_KEYS = ['security', 'breaking', 'capability', 'reliability', 'ecosystem', 'relevance'] as const;
export const DimensionKey = z.enum(DIMENSION_KEYS);
export type DimensionKey = z.infer<typeof DimensionKey>;

export const DIMENSION_LABELS: Record<DimensionKey, string> = {
  security: 'Security and safety',
  breaking: 'Breaking change / compatibility',
  capability: 'New capability',
  reliability: 'Reliability and performance',
  ecosystem: 'Ecosystem significance',
  relevance: 'Personal relevance',
};

export const EditorialConfig = z.object({
  version: z.literal(1),
  topics: z.array(z.string()).default([]),
  /** Maximum points per dimension. Must sum to 100. */
  weights: z.object({
    security: z.number().min(0),
    breaking: z.number().min(0),
    capability: z.number().min(0),
    reliability: z.number().min(0),
    ecosystem: z.number().min(0),
    relevance: z.number().min(0),
  }),
  minScore: z.number().min(0).max(100).default(35),
  maxStories: z.number().int().positive().default(8),
  targetMinutes: z.object({ min: z.number().positive(), max: z.number().positive() }),
  retentionDays: z.number().int().positive().default(7),
  voice: z.string().default('en_US-ljspeech-high'),
  model: z.string().default('qwen3:4b-instruct'),
  fallbackModel: z.string().optional(),
  inferenceBudgetSeconds: z.number().positive().default(1200),
  /** Spoken replacements applied before narration, e.g. { "CVE": "C V E" }. */
  lexicon: z.record(z.string(), z.string()).default({}),
});
export type EditorialConfig = z.infer<typeof EditorialConfig>;

// ───────────────────────── Collected activity ─────────────────────────

export const EventKind = z.enum(['release', 'pull_request', 'issue', 'advisory', 'discussion']);
export type EventKind = z.infer<typeof EventKind>;

/** One normalized piece of GitHub activity. `id` is stable across runs. */
export const RawEvent = z.object({
  /** e.g. "release:ollama/ollama:v0.9.0", "pull_request:owner/repo#123", "advisory:GHSA-xxxx". */
  id: z.string(),
  kind: EventKind,
  repo: RepoSlug,
  number: z.number().int().optional(),
  title: z.string(),
  /** Body text, already truncated by the collector. Untrusted. */
  body: z.string().default(''),
  url: HttpsUrl,
  author: z.string().optional(),
  labels: z.array(z.string()).default([]),
  state: z.enum(['open', 'closed', 'merged', 'published']),
  draft: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().optional(),
  publishedAt: z.string().optional(),
  /** Releases only. */
  tagName: z.string().optional(),
  prerelease: z.boolean().optional(),
  /** Advisories only. */
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  cveId: z.string().optional(),
  ghsaId: z.string().optional(),
  comments: z.number().int().optional(),
  reactions: z.number().int().optional(),
  /** Cross references found in the title/body, as "owner/repo#123". */
  refs: z.array(z.string()).default([]),
  /** Repository star count at collection time, when known. */
  repoStars: z.number().int().optional(),
});
export type RawEvent = z.infer<typeof RawEvent>;

// ───────────────────────── Stories ─────────────────────────

export const STATUS_ORDER = ['proposed', 'in_development', 'merged', 'released', 'deployed'] as const;
export const DevStatus = z.enum(STATUS_ORDER);
export type DevStatus = z.infer<typeof DevStatus>;

export const STATUS_LABELS: Record<DevStatus, string> = {
  proposed: 'Proposed',
  in_development: 'In development',
  merged: 'Merged',
  released: 'Released',
  deployed: 'Confirmed deployed',
};

export const Story = z.object({
  /** Stable across editions for the same underlying development. */
  id: z.string(),
  repo: RepoSlug,
  /** Working title taken from the primary event. */
  title: z.string(),
  events: z.array(RawEvent).min(1),
  status: DevStatus,
  /** URL of the evidence that justifies `status`. */
  statusEvidenceUrl: HttpsUrl,
  categories: z.array(z.string()).default([]),
  firstSeen: z.string(),
  updatedAt: z.string(),
});
export type Story = z.infer<typeof Story>;

export const ImpactBand = z.enum(['critical', 'major', 'high', 'notable', 'routine']);
export type ImpactBand = z.infer<typeof ImpactBand>;

export const BAND_LABELS: Record<ImpactBand, string> = {
  critical: 'Critical',
  major: 'Major',
  high: 'High importance',
  notable: 'Notable',
  routine: 'Routine',
};

export function bandFor(total: number): ImpactBand {
  if (total >= 90) return 'critical';
  if (total >= 75) return 'major';
  if (total >= 55) return 'high';
  if (total >= 35) return 'notable';
  return 'routine';
}

export const ScoreSignal = z.object({
  points: z.number(),
  /** Human-readable reason, e.g. "Advisory rated high severity". */
  reason: z.string(),
  evidenceUrl: HttpsUrl.optional(),
});

export const ScoreDimension = z.object({
  key: DimensionKey,
  max: z.number(),
  awarded: z.number(),
  signals: z.array(ScoreSignal),
});

export const Confidence = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof Confidence>;

export const ScoreBreakdown = z.object({
  total: z.number().min(0).max(100),
  band: ImpactBand,
  dimensions: z.array(ScoreDimension),
  confidence: Confidence,
  confidenceReason: z.string(),
  /** Why this story outranks the one below it. Absent on the last story. */
  ranksAboveNext: z.string().optional(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

export const ScoredStory = Story.extend({ score: ScoreBreakdown });
export type ScoredStory = z.infer<typeof ScoredStory>;

// ───────────────────────── Explanations ─────────────────────────

/** What the language model is asked to produce for one story. */
export const LlmExplanation = z.object({
  headline: z.string().min(8).max(140),
  whatHappened: z.string().min(20),
  previously: z.string().min(10),
  whatChanged: z.string().min(10),
  whyItMatters: z.string().min(20),
  nextConfirmed: z.string(),
  /** Clearly speculative outlook, or an empty string. */
  nextSpeculative: z.string(),
  glossary: z.array(z.object({ term: z.string(), definition: z.string() })).max(6),
  analogy: z.string(),
  intermediate: z.string(),
  technical: z.string(),
});
export type LlmExplanation = z.infer<typeof LlmExplanation>;

export const Explanation = LlmExplanation.extend({
  /** "llm" = model output that passed validation; "fallback" = deterministic template. */
  source: z.enum(['llm', 'fallback']),
  model: z.string().optional(),
  /** Validator notes kept for transparency (e.g. why a fallback was used). */
  validationNotes: z.array(z.string()).default([]),
});
export type Explanation = z.infer<typeof Explanation>;

export const ExplainedStory = ScoredStory.extend({ explanation: Explanation });
export type ExplainedStory = z.infer<typeof ExplainedStory>;

// ───────────────────────── Script and audio ─────────────────────────

export const SegmentKind = z.enum(['intro', 'headlines', 'lead', 'story', 'why', 'watching', 'closing']);

export const ScriptSegment = z.object({
  id: z.string(),
  kind: SegmentKind,
  title: z.string(),
  /** Display text (also the transcript). */
  text: z.string(),
  /** Text sent to the speech engine after the pronunciation pass. */
  spokenText: z.string(),
  storyId: z.string().optional(),
});
export type ScriptSegment = z.infer<typeof ScriptSegment>;

export const Chapter = z.object({
  id: z.string(),
  title: z.string(),
  startSec: z.number().min(0),
  storyId: z.string().optional(),
});
export type Chapter = z.infer<typeof Chapter>;

export const AudioInfo = z.object({
  available: z.boolean(),
  /** Relative to the edition folder, e.g. "audio.mp3". */
  file: z.string().optional(),
  bytes: z.number().int().optional(),
  durationSec: z.number().optional(),
  voice: z.string().optional(),
  chapters: z.array(Chapter).default([]),
  /** Present when audio is unavailable. */
  unavailableReason: z.string().optional(),
});
export type AudioInfo = z.infer<typeof AudioInfo>;

// ───────────────────────── Published edition ─────────────────────────

export const EDITIONS = ['morning', 'afternoon', 'evening'] as const;
export const EditionName = z.enum(EDITIONS);
export type EditionName = z.infer<typeof EditionName>;

export const EditionKey = z.string().regex(/^\d{4}-\d{2}-\d{2}-(morning|afternoon|evening)$/);

export const ReportStory = z.object({
  id: z.string(),
  repo: RepoSlug,
  status: DevStatus,
  statusEvidenceUrl: HttpsUrl,
  /** Set when this story was covered before and its status has advanced. */
  previousStatus: DevStatus.optional(),
  categories: z.array(z.string()),
  score: ScoreBreakdown,
  explanation: Explanation,
  links: z.array(z.object({ label: z.string(), url: HttpsUrl, kind: EventKind })),
  updatedAt: z.string(),
});
export type ReportStory = z.infer<typeof ReportStory>;

export const WatchItem = z.object({
  title: z.string(),
  repo: RepoSlug,
  url: HttpsUrl,
  status: DevStatus,
  note: z.string(),
});

export const RunMetrics = z.object({
  githubRequests: z.number().int().optional(),
  githubRateRemaining: z.number().int().optional(),
  reposScanned: z.number().int().optional(),
  eventsCollected: z.number().int().optional(),
  storiesConsidered: z.number().int().optional(),
  modelLoadSeconds: z.number().optional(),
  inferenceSeconds: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  audioSeconds: z.number().optional(),
  totalSeconds: z.number().optional(),
  peakMemoryMb: z.number().optional(),
});
export type RunMetrics = z.infer<typeof RunMetrics>;

export const EditionReport = z.object({
  schemaVersion: z.literal(1),
  key: EditionKey,
  /** YYYY-MM-DD in America/New_York. */
  date: z.string(),
  edition: EditionName,
  generatedAt: z.string(),
  windowStart: z.string(),
  windowEnd: z.string(),
  /** "mixed" when some stories used the deterministic fallback. */
  summarization: z.enum(['llm', 'fallback', 'mixed']),
  model: z.string().optional(),
  /** True when nothing cleared the reporting threshold. */
  quiet: z.boolean(),
  stories: z.array(ReportStory),
  worthWatching: z.array(WatchItem).default([]),
  transcript: z.array(ScriptSegment),
  audio: AudioInfo,
  metrics: RunMetrics.default({}),
});
export type EditionReport = z.infer<typeof EditionReport>;

// ───────────────────────── Site manifest ─────────────────────────

export const ManifestEdition = z.object({
  key: EditionKey,
  date: z.string(),
  edition: EditionName,
  publishedAt: z.string(),
  storyCount: z.number().int(),
  topHeadline: z.string().optional(),
  topScore: z.number().optional(),
  quiet: z.boolean(),
  summarization: z.enum(['llm', 'fallback', 'mixed']),
  /** Paths relative to the site root, e.g. "data/editions/<key>/report.json". */
  reportPath: z.string(),
  audioPath: z.string().optional(),
  audioBytes: z.number().int().optional(),
  durationSec: z.number().optional(),
});
export type ManifestEdition = z.infer<typeof ManifestEdition>;

export const ManifestRepo = WatchedRepo.extend({
  /** "config" = listed in config/watchlist.json; "starred" = imported at run time. */
  source: z.enum(['config', 'starred']),
  lastScannedAt: z.string().optional(),
  lastActivityAt: z.string().optional(),
  recentStoryIds: z.array(z.string()).default([]),
});
export type ManifestRepo = z.infer<typeof ManifestRepo>;

export const Manifest = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  /** Time of the most recent run that scanned GitHub successfully. */
  lastSuccessfulScan: z.string(),
  retentionDays: z.number().int(),
  /** Newest first. */
  editions: z.array(ManifestEdition),
  repos: z.array(ManifestRepo),
  /** The production configuration this site was built from (for the Settings diff). */
  config: z.object({ watchlist: WatchlistConfig, editorial: EditorialConfig }),
});
export type Manifest = z.infer<typeof Manifest>;

// ───────────────────────── Durable state ─────────────────────────

export const StoryState = z.object({
  title: z.string(),
  repo: RepoSlug,
  status: DevStatus,
  firstSeen: z.string(),
  lastCoveredAt: z.string().optional(),
  lastCoveredEdition: z.string().optional(),
  lastCoveredStatus: DevStatus.optional(),
  /** Event ids already folded into this story. */
  eventIds: z.array(z.string()).default([]),
  updatedAt: z.string(),
});
export type StoryState = z.infer<typeof StoryState>;

export const PipelineState = z.object({
  schemaVersion: z.literal(1),
  lastSuccessfulRunAt: z.string().optional(),
  lastEditionKey: z.string().optional(),
  /** Per-repository collection cursors. */
  repos: z.record(
    z.string(),
    z.object({
      /** Activity at or before this instant has been processed. */
      since: z.string(),
      etags: z.record(z.string(), z.string()).default({}),
    }),
  ),
  /** Story registry, pruned after 14 days without updates. */
  stories: z.record(z.string(), StoryState),
});
export type PipelineState = z.infer<typeof PipelineState>;

export function emptyState(): PipelineState {
  return { schemaVersion: 1, repos: {}, stories: {} };
}
