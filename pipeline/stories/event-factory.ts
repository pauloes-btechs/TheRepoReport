/** Test helpers that build schema-valid RawEvents with sensible defaults. */
import { RawEvent } from '../../shared/schemas';

type Overrides = Partial<RawEvent>;

const T = '2026-11-10T08:00:00Z';

function make(base: Omit<RawEvent, 'body' | 'labels' | 'refs'> & Overrides, overrides: Overrides): RawEvent {
  return RawEvent.parse({ body: '', labels: [], refs: [], ...base, ...overrides });
}

export function pull(repo: string, number: number, overrides: Overrides = {}): RawEvent {
  return make(
    {
      id: `pull_request:${repo}#${number}`,
      kind: 'pull_request',
      repo,
      number,
      title: `Pull request ${number}`,
      url: `https://github.com/${repo}/pull/${number}`,
      state: 'merged',
      draft: false,
      createdAt: '2026-11-09T10:00:00Z',
      updatedAt: T,
      mergedAt: T,
    },
    overrides,
  );
}

export function issue(repo: string, number: number, overrides: Overrides = {}): RawEvent {
  return make(
    {
      id: `issue:${repo}#${number}`,
      kind: 'issue',
      repo,
      number,
      title: `Issue ${number}`,
      url: `https://github.com/${repo}/issues/${number}`,
      state: 'open',
      createdAt: '2026-11-09T09:00:00Z',
      updatedAt: T,
    },
    overrides,
  );
}

export function release(repo: string, tag: string, overrides: Overrides = {}): RawEvent {
  return make(
    {
      id: `release:${repo}:${tag}`,
      kind: 'release',
      repo,
      title: tag,
      url: `https://github.com/${repo}/releases/tag/${tag}`,
      state: 'published',
      tagName: tag,
      prerelease: false,
      createdAt: T,
      updatedAt: T,
      publishedAt: T,
    },
    overrides,
  );
}

export function advisory(repo: string, ghsa: string, overrides: Overrides = {}): RawEvent {
  return make(
    {
      id: `advisory:${ghsa}`,
      kind: 'advisory',
      repo,
      title: `Advisory ${ghsa}`,
      url: `https://github.com/${repo}/security/advisories/${ghsa}`,
      labels: ['security'],
      state: 'published',
      ghsaId: ghsa,
      severity: 'high',
      createdAt: T,
      updatedAt: T,
      publishedAt: T,
    },
    overrides,
  );
}
