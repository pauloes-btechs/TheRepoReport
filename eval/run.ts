/**
 * npm run eval            → offline, uses recorded model outputs in fixtures/llm (CI-safe)
 * npm run eval -- --live  → calls a local Ollama (OLLAMA_HOST or http://127.0.0.1:11434)
 * Options: --model <name>  --threshold <n>  --out <path>
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatSummary, loadCases, loadEditorial, runEval, DEFAULT_THRESHOLD } from './harness';

const root = new URL('../', import.meta.url);
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const cases = loadCases(fileURLToPath(new URL('fixtures/llm/', root)));
const editorial = loadEditorial(fileURLToPath(new URL('config/editorial.json', root)));
const threshold = Number(value('threshold') ?? DEFAULT_THRESHOLD);
const out = value('out') ?? fileURLToPath(new URL('eval/report.json', root));

const report = await runEval(cases, {
  editorial,
  live: flag('live'),
  model: value('model'),
  ollamaUrl: process.env.OLLAMA_HOST ? `http://${process.env.OLLAMA_HOST.replace(/^https?:\/\//, '')}` : undefined,
  threshold,
});
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(formatSummary(report));
console.log(`Report written to ${out}`);
process.exitCode = report.passed ? 0 : 1;
