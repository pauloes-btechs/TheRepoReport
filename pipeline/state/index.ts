/**
 * Durable pipeline state (D2). Node only reads and writes a local JSON file;
 * the workflow moves it to and from the `state` orphan branch with git.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CollectResult } from '../../shared/contracts';
import {
  PipelineState,
  STATUS_ORDER,
  emptyState,
  type DevStatus,
  type Story,
  type StoryState,
} from '../../shared/schemas';

export const STORY_RETENTION_DAYS = 14;

export class StateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateFileError';
  }
}

/** Load and validate state. A missing file means a first run and yields an empty state. */
export async function loadState(path: string): Promise<PipelineState> {
  if (!existsSync(path)) return emptyState();
  const text = await readFile(path, 'utf8');
  if (text.trim() === '') return emptyState();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new StateFileError(`State file ${path} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = PipelineState.safeParse(json);
  if (!parsed.success) {
    throw new StateFileError(`State file ${path} failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Validate and write state atomically (temp file + rename). */
export async function saveState(path: string, state: PipelineState): Promise<void> {
  const valid = PipelineState.parse(state);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/** Drop stories whose last update is older than `days` before `now`. */
export function pruneStories(
  stories: PipelineState['stories'],
  now: Date,
  days = STORY_RETENTION_DAYS,
): PipelineState['stories'] {
  const cutoff = now.getTime() - days * 86_400_000;
  const kept: PipelineState['stories'] = {};
  for (const [id, story] of Object.entries(stories)) {
    const updated = Date.parse(story.updatedAt);
    if (Number.isFinite(updated) && updated >= cutoff) kept[id] = story;
  }
  return kept;
}

/** Insert or refresh registry entries for every story built this run, preserving coverage fields. */
export function upsertStories(registry: PipelineState['stories'], stories: readonly Story[]): PipelineState['stories'] {
  const next: PipelineState['stories'] = { ...registry };
  for (const story of stories) {
    const prev = registry[story.id];
    const eventIds = new Set([...(prev?.eventIds ?? []), ...story.events.map((e) => e.id)]);
    const entry: StoryState = {
      title: story.title,
      repo: story.repo,
      status: story.status,
      firstSeen: prev?.firstSeen ?? story.firstSeen,
      eventIds: [...eventIds].sort(),
      updatedAt: story.updatedAt,
    };
    if (prev?.lastCoveredAt) entry.lastCoveredAt = prev.lastCoveredAt;
    if (prev?.lastCoveredEdition) entry.lastCoveredEdition = prev.lastCoveredEdition;
    if (prev?.lastCoveredStatus) entry.lastCoveredStatus = prev.lastCoveredStatus;
    next[story.id] = entry;
  }
  return next;
}

/** Record that these stories were reported in `editionKey` at the given status. */
export function markCovered(
  registry: PipelineState['stories'],
  covered: readonly { id: string; status: DevStatus }[],
  editionKey: string,
  now: Date,
): PipelineState['stories'] {
  const next: PipelineState['stories'] = { ...registry };
  for (const { id, status } of covered) {
    const prev = next[id];
    if (!prev) continue;
    next[id] = {
      ...prev,
      lastCoveredAt: now.toISOString(),
      lastCoveredEdition: editionKey,
      lastCoveredStatus: status,
    };
  }
  return next;
}

/**
 * Merge cursors from collect. Repos that failed this run keep their previous
 * cursor (or stay absent), so their activity is picked up next time.
 */
export function mergeRepoState(
  previous: PipelineState['repos'],
  next: PipelineState['repos'],
  failedRepos: readonly { repo: string }[],
): PipelineState['repos'] {
  const failed = new Set(failedRepos.map((f) => f.repo));
  const merged: PipelineState['repos'] = { ...previous };
  for (const [repo, cursor] of Object.entries(next)) {
    if (failed.has(repo)) continue;
    merged[repo] = cursor;
  }
  for (const repo of failed) {
    if (previous[repo]) merged[repo] = previous[repo];
    else delete merged[repo];
  }
  return merged;
}

/** The status a story had when last covered, if it has advanced since. */
export function previousStatusIfAdvanced(
  registryEntry: StoryState | undefined,
  current: DevStatus,
): DevStatus | undefined {
  const prev = registryEntry?.lastCoveredStatus;
  if (!prev) return undefined;
  return STATUS_ORDER.indexOf(current) > STATUS_ORDER.indexOf(prev) ? prev : undefined;
}

export interface NextStateInput {
  previous: PipelineState;
  collect: Pick<CollectResult, 'nextRepoState' | 'failedRepos'>;
  stories: readonly Story[];
  covered: readonly { id: string; status: DevStatus }[];
  editionKey: string;
  now: Date;
}

/** Everything the next run needs, computed only after a successful build. */
export function computeNextState(input: NextStateInput): PipelineState {
  const { previous, collect, stories, covered, editionKey, now } = input;
  let registry = upsertStories(previous.stories, stories);
  registry = markCovered(registry, covered, editionKey, now);
  registry = pruneStories(registry, now);
  return PipelineState.parse({
    schemaVersion: 1,
    lastSuccessfulRunAt: now.toISOString(),
    lastEditionKey: editionKey,
    repos: mergeRepoState(previous.repos, collect.nextRepoState, collect.failedRepos),
    stories: registry,
  });
}
