import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EditorialConfig, WatchlistConfig } from '../../shared/schemas';

export interface ProductionConfig {
  watchlist: WatchlistConfig;
  editorial: EditorialConfig;
}

/** Load and validate config/watchlist.json and config/editorial.json. */
export async function loadConfig(configDir: string): Promise<ProductionConfig> {
  const read = async (name: string) => JSON.parse(await readFile(join(configDir, name), 'utf8')) as unknown;
  return {
    watchlist: WatchlistConfig.parse(await read('watchlist.json')),
    editorial: EditorialConfig.parse(await read('editorial.json')),
  };
}
