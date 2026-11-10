import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanPaths, scanText } from './check-secrets';

// Built at runtime so this file itself never contains a token-shaped string.
const fakeClassic = ['ghp', '_', 'A'.repeat(36)].join('');
const fakeFineGrained = ['github', '_pat_', '1'.repeat(30)].join('');
const fakeServer = ['ghs', '_', 'b'.repeat(36)].join('');

describe('check-secrets', () => {
  it('finds a token planted in built output, including nested and binary files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<html>clean</html>');
    writeFileSync(join(dir, 'assets', 'app.js'), `const a = 1;\nconst t = "${fakeClassic}";\n`);
    writeFileSync(join(dir, 'audio.mp3'), Buffer.concat([Buffer.from([0xff, 0xfb, 0x00]), Buffer.from(fakeServer)]));
    const findings = scanPaths([dir]);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ file: join(dir, 'assets', 'app.js'), line: 2, pattern: expect.stringMatching(/classic/) });
    // The finding never echoes the secret itself.
    expect(JSON.stringify(findings)).not.toContain(fakeClassic);
  });

  it('detects fine-grained tokens, Bearer credentials and literal secret values', () => {
    expect(scanText(`x ${fakeFineGrained} y`, 'f')).toHaveLength(1);
    expect(scanText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 'f')).toHaveLength(1);
    expect(scanText('value=s3cr3t-value-123', 'f', ['s3cr3t-value-123'])).toHaveLength(1);
  });

  it('does not flag ordinary prose about tokens', () => {
    expect(scanText('Send a Bearer token in the Authorization header. Prefix ghp_ marks classic tokens.', 'f')).toEqual([]);
  });

  it('passes a clean directory and ignores missing paths', () => {
    const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
    writeFileSync(join(dir, 'manifest.json'), '{"ok":true}');
    expect(scanPaths([dir, join(dir, 'nope')])).toEqual([]);
  });
});
