/**
 * Applies a configuration update submitted from the site's Settings page.
 *
 * The page opens a pre-filled GitHub issue whose body carries the new file
 * contents in fenced blocks:
 *
 *   ```json file=watchlist.json
 *   { ... }
 *   ```
 *
 * .github/workflows/config-update.yml runs this only for issues opened by the
 * repository owner. Every file is validated against the shared schemas before
 * anything is written; on any problem nothing is written and the process exits 1.
 *
 * Usage: ISSUE_BODY=... npx tsx scripts/apply-config-issue.ts [--config-dir config]
 * Writes a Markdown summary to $SUMMARY_FILE when set.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditorialConfig, WatchlistConfig } from '../shared/schemas';
import { formatWatchlist } from './import-watched';

export const CONFIG_FILES = ['watchlist.json', 'editorial.json'] as const;
type ConfigFile = (typeof CONFIG_FILES)[number];

export interface ParsedUpdate {
  files: Partial<Record<ConfigFile, string>>;
  errors: string[];
}

const BLOCK_RE = /```json[ \t]+file=([A-Za-z0-9._-]+)[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

/** Validates every block; returns the formatted file contents to write. */
export function parseConfigIssue(body: string): ParsedUpdate {
  const files: ParsedUpdate['files'] = {};
  const errors: string[] = [];
  for (const match of body.matchAll(BLOCK_RE)) {
    const name = match[1]!;
    if (!(CONFIG_FILES as readonly string[]).includes(name)) {
      errors.push(`${name}: not a configuration file that can be updated here.`);
      continue;
    }
    if (files[name as ConfigFile]) {
      errors.push(`${name}: appears more than once.`);
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(match[2]!);
    } catch {
      errors.push(`${name}: is not valid JSON.`);
      continue;
    }
    if (name === 'watchlist.json') {
      const parsed = WatchlistConfig.safeParse(json);
      if (!parsed.success) {
        errors.push(`watchlist.json: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
        continue;
      }
      const slugs = parsed.data.repos.map((r) => r.repo.toLowerCase());
      const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
      if (dupes.length) {
        errors.push(`watchlist.json: listed more than once: ${[...new Set(dupes)].join(', ')}`);
        continue;
      }
      files['watchlist.json'] = formatWatchlist(parsed.data);
    } else {
      const parsed = EditorialConfig.safeParse(json);
      if (!parsed.success) {
        errors.push(`editorial.json: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`);
        continue;
      }
      const total = Object.values(parsed.data.weights).reduce((a, b) => a + b, 0);
      if (total !== 100) {
        errors.push(`editorial.json: rubric weights total ${total}, not 100.`);
        continue;
      }
      if (parsed.data.targetMinutes.min > parsed.data.targetMinutes.max) {
        errors.push('editorial.json: targetMinutes.min is larger than targetMinutes.max.');
        continue;
      }
      files['editorial.json'] = `${JSON.stringify(parsed.data, null, 2)}\n`;
    }
  }
  if (Object.keys(files).length === 0 && errors.length === 0) {
    errors.push('No configuration files were found in the issue. Use the "Save to production" button on the Settings page.');
  }
  return { files, errors };
}

function main(): number {
  const argv = process.argv.slice(2);
  const dirFlag = argv.indexOf('--config-dir');
  const configDir = dirFlag >= 0 ? argv[dirFlag + 1]! : 'config';
  const { files, errors } = parseConfigIssue(process.env.ISSUE_BODY ?? '');
  const summary: string[] = [];
  if (errors.length > 0) {
    summary.push('Nothing was saved, because the configuration has problems:', '', ...errors.map((e) => `- ${e}`));
  } else {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(configDir, name), content);
    summary.push(`Saved ${Object.keys(files).map((f) => `\`config/${f}\``).join(' and ')}. The next edition uses the new configuration.`);
  }
  const text = summary.join('\n');
  console.log(text);
  if (process.env.SUMMARY_FILE) writeFileSync(process.env.SUMMARY_FILE, `${text}\n`);
  return errors.length > 0 ? 1 : 0;
}

if (process.argv[1] && /apply-config-issue\.ts$/.test(process.argv[1])) process.exit(main());
