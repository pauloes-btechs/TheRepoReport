import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EditorialConfig, WatchlistConfig } from '../../shared/schemas';

export interface ProductionConfig {
  watchlist: WatchlistConfig;
  editorial: EditorialConfig;
}

/** Rules the watchlist schema cannot express. Shared with scripts/apply-config-issue.ts. */
export function watchlistProblems(watchlist: WatchlistConfig): string[] {
  const slugs = watchlist.repos.map((r) => r.repo.toLowerCase());
  const dupes = [...new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))];
  return dupes.length ? [`listed more than once: ${dupes.join(', ')}`] : [];
}

/** Rules the editorial schema cannot express. Shared with scripts/apply-config-issue.ts. */
export function editorialProblems(editorial: EditorialConfig): string[] {
  const problems: string[] = [];
  const total = Object.values(editorial.weights).reduce((a, b) => a + b, 0);
  if (total !== 100) problems.push(`rubric weights total ${total}, not 100.`);
  if (editorial.targetMinutes.min > editorial.targetMinutes.max) problems.push('targetMinutes.min is larger than targetMinutes.max.');
  return problems;
}

/** Load and validate config/watchlist.json and config/editorial.json. */
export async function loadConfig(configDir: string): Promise<ProductionConfig> {
  const read = async (name: string) => JSON.parse(await readFile(join(configDir, name), 'utf8')) as unknown;
  const watchlist = WatchlistConfig.parse(await read('watchlist.json'));
  const editorial = EditorialConfig.parse(await read('editorial.json'));
  const problems = [
    ...watchlistProblems(watchlist).map((p) => `watchlist.json: ${p}`),
    ...editorialProblems(editorial).map((p) => `editorial.json: ${p}`),
  ];
  if (problems.length) throw new Error(problems.join(' '));
  return { watchlist, editorial };
}
