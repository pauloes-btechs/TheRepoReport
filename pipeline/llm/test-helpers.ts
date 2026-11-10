/** Test-only helpers: fixture loading and a scriptable fake Ollama. */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../../shared/contracts';
import { EditorialConfig, ScoredStory } from '../../shared/schemas';

const FIXTURES = fileURLToPath(new URL('../../fixtures/llm/', import.meta.url));

export interface FixtureCase {
  name: string;
  expectedRank: number;
  story: ScoredStory;
  cannedOutput?: unknown;
  expectValid: boolean;
}

export function loadFixture(name: string): FixtureCase {
  const raw = JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8')) as Record<string, unknown>;
  return {
    name: raw.name as string,
    expectedRank: raw.expectedRank as number,
    story: ScoredStory.parse(raw.story),
    cannedOutput: raw.cannedOutput,
    expectValid: (raw.expectValid as boolean | undefined) ?? true,
  };
}

export function allFixtures(): FixtureCase[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadFixture(f.replace(/\.json$/, '')))
    .sort((a, b) => a.expectedRank - b.expectedRank);
}

export function editorialConfig(overrides: Partial<EditorialConfig> = {}): EditorialConfig {
  const base = EditorialConfig.parse(
    JSON.parse(readFileSync(fileURLToPath(new URL('../../config/editorial.json', import.meta.url)), 'utf8')),
  );
  return { ...base, ...overrides };
}

export interface RecordedCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

export type ChatReply = string | { error: Error } | { hang: true } | { status: number };

/**
 * Fake Ollama. `replies` are consumed in order for /api/chat calls (the last
 * one repeats). `tags` controls /api/tags; `down` makes every call fail with
 * a connection error.
 */
export function fakeOllama(opts: { replies?: ChatReply[]; models?: string[]; down?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const replies = opts.replies ?? [];
  let chatIndex = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (opts.down) {
      const err = new TypeError('fetch failed');
      (err as TypeError & { cause: unknown }).cause = { code: 'ECONNREFUSED' };
      throw err;
    }
    if (url.endsWith('/api/tags')) {
      return Response.json({ models: (opts.models ?? ['qwen3:4b-instruct']).map((name) => ({ name })) });
    }
    const reply = replies[Math.min(chatIndex, replies.length - 1)] ?? '{}';
    chatIndex++;
    if (typeof reply === 'object' && 'error' in reply) throw reply.error;
    if (typeof reply === 'object' && 'status' in reply) return new Response('boom', { status: reply.status });
    if (typeof reply === 'object' && 'hang' in reply) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    return Response.json({
      model: body?.model,
      message: { role: 'assistant', content: reply },
      done: true,
      eval_count: 100,
      eval_duration: 2_000_000_000,
    });
  }) as FetchLike;
  return { fetch: fetchFn, calls, chatCalls: () => calls.filter((c) => c.url.endsWith('/api/chat')) };
}
