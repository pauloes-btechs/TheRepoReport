/**
 * Publish-time credential scan. Usage: `npx tsx scripts/check-secrets.ts <dir|file>...`
 * Exits 1 if any file contains something that looks like a GitHub token or a
 * Bearer credential, or the literal value of $GITHUB_TOKEN. Matches are never
 * printed — only the file, pattern name, and line number.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SECRET_PATTERNS } from '../pipeline/util/redact';

export interface SecretFinding {
  file: string;
  pattern: string;
  line: number;
}

const MAX_BYTES = 200 * 1024 * 1024;

function* walk(path: string): Generator<string> {
  const info = statSync(path);
  if (info.isDirectory()) {
    for (const name of readdirSync(path).sort()) yield* walk(join(path, name));
  } else if (info.isFile()) {
    yield path;
  }
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export function scanText(text: string, file: string, literals: readonly string[] = []): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const { name, regex } of SECRET_PATTERNS) {
    for (const match of text.matchAll(new RegExp(regex.source, 'g'))) {
      findings.push({ file, pattern: name, line: lineOf(text, match.index ?? 0) });
    }
  }
  for (const literal of literals) {
    if (!literal || literal.length < 8) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(literal, from);
      if (at < 0) break;
      findings.push({ file, pattern: 'value of a configured secret', line: lineOf(text, at) });
      from = at + literal.length;
    }
  }
  return findings;
}

/** Scan files and directories. Missing paths are skipped (reported by the caller). */
export function scanPaths(paths: readonly string[], literals: readonly string[] = []): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const root of paths) {
    if (!existsSync(root)) continue;
    for (const file of walk(root)) {
      if (statSync(file).size > MAX_BYTES) continue;
      // latin1 keeps a 1:1 byte mapping, so binary files (MP3) are scanned too.
      findings.push(...scanText(readFileSync(file).toString('latin1'), file, literals));
    }
  }
  return findings;
}

function main(): number {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    process.stderr.write('usage: check-secrets <dir|file>...\n');
    return 2;
  }
  const literals = [process.env.GITHUB_TOKEN, process.env.GH_TOKEN].filter((v): v is string => !!v);
  const present = paths.filter((p) => existsSync(p));
  for (const p of paths) if (!existsSync(p)) process.stdout.write(`skip (missing): ${p}\n`);
  const findings = scanPaths(present, literals);
  if (findings.length === 0) {
    process.stdout.write(`check-secrets: no credentials found in ${present.join(', ') || '(nothing)'}\n`);
    return 0;
  }
  for (const f of findings) process.stdout.write(`POSSIBLE SECRET: ${f.file}:${f.line} (${f.pattern})\n`);
  process.stdout.write(`check-secrets: ${findings.length} finding(s); refusing to publish.\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
