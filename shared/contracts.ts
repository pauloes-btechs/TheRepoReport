/**
 * Module boundaries for the pipeline. Each stage is implemented in its own
 * directory and exported from that directory's index.ts with exactly these
 * signatures, so stages can be built and tested independently.
 */
import type {
  AudioInfo,
  EditorialConfig,
  EditionName,
  EditionReport,
  ExplainedStory,
  Manifest,
  ManifestRepo,
  PipelineState,
  RawEvent,
  ScoredStory,
  ScriptSegment,
  Story,
  WatchlistConfig,
} from './schemas';

export type FetchLike = typeof fetch;

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ── pipeline/collect ──
export interface CollectOptions {
  watchlist: WatchlistConfig;
  state: PipelineState;
  /** Upper bound of the reporting window (run start). */
  now: Date;
  /** GitHub token; never logged. Optional for unauthenticated local runs. */
  token?: string;
  fetch?: FetchLike;
  logger?: Logger;
  /** First-run lookback when a repo has no cursor yet. Default 36 hours. */
  initialLookbackHours?: number;
}
export interface CollectResult {
  events: RawEvent[];
  /** The resolved watchlist (config entries plus imported stars), enabled or not. */
  repos: ManifestRepo[];
  /** Cursors to store if, and only if, the whole run succeeds. */
  nextRepoState: PipelineState['repos'];
  windowStart: string;
  windowEnd: string;
  requestCount: number;
  rateRemaining?: number;
  /** Repos that could not be scanned this run; their cursors are not advanced. */
  failedRepos: { repo: string; reason: string }[];
}
export type Collect = (options: CollectOptions) => Promise<CollectResult>;

// ── pipeline/stories ──
/** Groups events into stories, merging with known stories from state, and classifies status. */
export type BuildStories = (events: RawEvent[], known: PipelineState['stories']) => Story[];

// ── pipeline/score ──
export interface ScoreContext {
  editorial: EditorialConfig;
  repos: ManifestRepo[];
}
/** Returns stories sorted by total score, highest first, with `ranksAboveNext` filled in. */
export type ScoreStories = (stories: Story[], context: ScoreContext) => ScoredStory[];

export interface Selection {
  /** Stories to report in full, in rank order. */
  selected: ScoredStory[];
  /** Proposed or unresolved items for the "worth watching" segment. */
  watching: ScoredStory[];
  /** Everything else, with the reason it was left out. */
  skipped: { story: ScoredStory; reason: string }[];
}
export type SelectStories = (
  scored: ScoredStory[],
  state: PipelineState,
  editorial: EditorialConfig,
) => Selection;

// ── pipeline/llm (includes validation and the deterministic fallback) ──
export interface ExplainOptions {
  editorial: EditorialConfig;
  /** Ollama base URL, default http://127.0.0.1:11434. */
  ollamaUrl?: string;
  model?: string;
  /** Skip the model entirely and use the deterministic template. */
  forceFallback?: boolean;
  fetch?: FetchLike;
  logger?: Logger;
}
export interface ExplainResult {
  stories: ExplainedStory[];
  summarization: 'llm' | 'fallback' | 'mixed';
  model?: string;
  inferenceSeconds: number;
  tokensPerSecond?: number;
}
export type ExplainStories = (stories: ScoredStory[], options: ExplainOptions) => Promise<ExplainResult>;

// ── pipeline/script ──
export interface ScriptInput {
  edition: EditionName;
  /** YYYY-MM-DD (New York). */
  date: string;
  stories: ExplainedStory[];
  watching: ScoredStory[];
  editorial: EditorialConfig;
}
export type BuildScript = (input: ScriptInput) => ScriptSegment[];

// ── pipeline/audio ──
export interface NarrateOptions {
  segments: ScriptSegment[];
  voice: string;
  /** Directory for intermediate WAV files. */
  workDir: string;
  /** Destination MP3 path. */
  outFile: string;
  logger?: Logger;
}
/** Never throws for an unavailable speech engine: returns `{ available: false, unavailableReason }`. */
export type Narrate = (options: NarrateOptions) => Promise<AudioInfo & { audioSeconds: number }>;

// ── pipeline/feed ──
export interface FeedOptions {
  manifest: Manifest;
  /** Loaded reports for the editions in the manifest, keyed by edition key. */
  reports: Record<string, EditionReport>;
  /** Absolute site URL ending in a slash. */
  siteUrl: string;
}
export type BuildFeed = (options: FeedOptions) => string;

/** Absolute URL of the deployed site. */
export const SITE_URL = 'https://pauloes-btechs.github.io/TheRepoReport/';
