/**
 * Copies the development fixtures into public/data so `vite` serves them like
 * the published site. Development only: the app never imports fixtures, and
 * public/data must not be committed.
 *
 *   npx tsx scripts/dev-data.ts            # dates shifted so the newest edition is today (New York)
 *   npx tsx scripts/dev-data.ts --as-is    # keep the fixture dates
 *   npx tsx scripts/dev-data.ts --today=2026-12-01   # pretend today is another date
 *   npx tsx scripts/dev-data.ts --clean    # remove public/data (shows the first-run empty state)
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newYorkClock } from '../shared/edition';
import { EditionReport, Manifest } from '../shared/schemas';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'fixtures', 'site-data');
const target = join(root, 'public', 'data');
const args = new Set(process.argv.slice(2));

rmSync(target, { recursive: true, force: true });
if (args.has('--clean')) {
  console.log('Removed public/data. The app will show the first-edition empty state.');
  process.exit(0);
}

const manifestText = readFileSync(join(source, 'manifest.json'), 'utf8');
const original = Manifest.parse(JSON.parse(manifestText));
const newest = original.editions.map((e) => e.date).sort().at(-1);
const todayArg = process.argv.find((a) => a.startsWith('--today='))?.slice('--today='.length);
const today = todayArg && /^\d{4}-\d{2}-\d{2}$/.test(todayArg) ? todayArg : newYorkClock(new Date()).date;
const shiftDays =
  args.has('--as-is') || !newest ? 0 : Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${newest}T00:00:00Z`)) / 86_400_000);

/** Shifts every YYYY-MM-DD in the text (dates, timestamps, keys and paths) by shiftDays. */
function shift(text: string): string {
  if (shiftDays === 0) return text;
  return text.replace(/\b(\d{4}-\d{2}-\d{2})(?=T|-morning|-afternoon|-evening|"|\/)/g, (date) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + shiftDays);
    return d.toISOString().slice(0, 10);
  });
}

mkdirSync(target, { recursive: true });
const manifest = Manifest.parse(JSON.parse(shift(manifestText)));
writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const editionsDir = join(source, 'editions');
let count = 0;
for (const key of readdirSync(editionsDir)) {
  const text = readFileSync(join(editionsDir, key, 'report.json'), 'utf8');
  const report = EditionReport.parse(JSON.parse(shift(text)));
  const out = join(target, 'editions', report.key);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (report.audio.available) cpSync(join(source, 'audio.mp3'), join(out, report.audio.file ?? 'audio.mp3'));
  count++;
}

console.log(
  `Copied ${count} fixture editions to public/data${shiftDays ? `, dates shifted by ${shiftDays} day(s) so the newest is ${today}` : ''}.`,
);
console.log('Development data only. Do not commit public/data.');
