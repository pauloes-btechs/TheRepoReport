import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

describe('loadConfig', () => {
  it('loads the fixture config', async () => {
    const config = await loadConfig('fixtures/config');
    expect(config.watchlist.repos.length).toBeGreaterThan(0);
  });

  it('rejects a hand-edited editorial.json whose weights do not total 100', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'config-'));
    cpSync('fixtures/config/watchlist.json', join(dir, 'watchlist.json'));
    const editorial = JSON.parse(readFileSync('fixtures/config/editorial.json', 'utf8'));
    writeFileSync(join(dir, 'editorial.json'), JSON.stringify({ ...editorial, weights: { ...editorial.weights, security: editorial.weights.security + 10 } }));
    await expect(loadConfig(dir)).rejects.toThrow(/weights total 110, not 100/);
  });
});
