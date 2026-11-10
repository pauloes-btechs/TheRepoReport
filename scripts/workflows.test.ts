import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const edition = readFileSync('.github/workflows/edition.yml', 'utf8');
const keepalive = readFileSync('.github/workflows/keepalive.yml', 'utf8');

describe('edition.yml', () => {
  it('schedules three New York editions', () => {
    for (const cron of ['15 7 * * *', '15 13 * * *', '15 19 * * *']) {
      expect(edition).toMatch(new RegExp(`- cron: '${cron.replace(/\*/g, '\\*')}'\\n\\s+timezone: "America/New_York"`));
    }
    expect(edition.match(/timezone: "America\/New_York"/g)).toHaveLength(3);
  });

  it('declares every manual input', () => {
    expect(edition).toContain('workflow_dispatch:');
    for (const input of ['edition', 'force', 'dry_run', 'model', 'force_fallback', 'force_no_audio']) {
      expect(edition).toMatch(new RegExp(`\\n      ${input}:\\n`));
    }
  });

  it('grants write scopes per job only (least privilege), with concurrency and time budget', () => {
    // Workflow default is read-only; the build job (untrusted content, installers) inherits it.
    expect(edition).toMatch(/^permissions:\n  contents: read\n/m);
    expect(edition).toMatch(/persist-credentials: false/);
    const deployJob = edition.slice(edition.indexOf('\n  deploy:'), edition.indexOf('\n  commit-state:'));
    expect(deployJob).toMatch(/permissions:\n      pages: write.*\n      id-token: write/);
    const stateJob = edition.slice(edition.indexOf('\n  commit-state:'));
    expect(stateJob).toMatch(/permissions:\n      contents: write/);
    const buildJob = edition.slice(edition.indexOf('\n  build:'), edition.indexOf('\n  deploy:'));
    expect(buildJob).not.toMatch(/contents: write|pages: write|id-token: write/);
    expect(edition).toMatch(/concurrency:\n  group: edition\n  cancel-in-progress: false/);
    expect(edition).toMatch(/build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 45/);
  });

  it('publishes the edition key the precheck checked for duplicates', () => {
    expect(edition).toMatch(/PRECHECK_EDITION: \$\{\{ steps\.precheck\.outputs\.edition \}\}/);
    expect(edition).toMatch(/edition="\$\{INPUT_EDITION:-\$PRECHECK_EDITION\}"/);
  });

  it('keeps a 7-day recovery copy and scans for secrets before upload', () => {
    expect(edition).toMatch(/name: edition-\$\{\{ steps\.run\.outputs\.edition \}\}[\s\S]*?retention-days: 7/);
    const scan = edition.indexOf('scripts/check-secrets.ts');
    expect(scan).toBeGreaterThan(0);
    expect(scan).toBeLessThan(edition.indexOf('actions/upload-pages-artifact@v3'));
  });

  it('deploys before pushing state, and pushes state only after a successful deploy', () => {
    const deploy = edition.indexOf('actions/deploy-pages@v4');
    const push = edition.indexOf('git push --force origin HEAD:state');
    expect(deploy).toBeGreaterThan(0);
    expect(push).toBeGreaterThan(deploy);
    expect(edition).toMatch(/commit-state:\n    needs: \[build, deploy\]\n    if: .*needs\.deploy\.result == 'success'/);
    expect(edition).toMatch(/environment:\n      name: github-pages/);
  });

  it('commits state as Pauloes Berhe on an orphan branch', () => {
    expect(edition).toContain('git checkout --orphan state-tmp');
    for (const v of ['GIT_AUTHOR_NAME: Pauloes Berhe', 'GIT_AUTHOR_EMAIL: pauloes@btechs.io', 'GIT_COMMITTER_NAME: Pauloes Berhe', 'GIT_COMMITTER_EMAIL: pauloes@btechs.io']) {
      expect(edition).toContain(v);
    }
  });

  it('pins actions to major versions', () => {
    const uses = [...edition.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(5);
    for (const u of uses) expect(u).toMatch(/^actions\/[a-z-]+(\/[a-z]+)?@v\d+$/);
  });

  it('never interpolates workflow inputs directly into shell', () => {
    const runBlocks = edition.split(/\n\s+run: /).slice(1);
    for (const block of runBlocks) expect(block.split(/\n\s+- (?:name|uses):/)[0]).not.toMatch(/\$\{\{\s*inputs\./);
  });
});

describe('keepalive.yml', () => {
  it('re-enables the edition workflow monthly with actions: write and no commits', () => {
    expect(keepalive).toMatch(/cron: '\d+ \d+ 1 \* \*'/);
    expect(keepalive).toContain('actions: write');
    expect(keepalive).toContain('gh workflow enable "$wf"');
    expect(keepalive).toContain('edition.yml');
    expect(keepalive).not.toMatch(/git (commit|push)/);
  });
});
