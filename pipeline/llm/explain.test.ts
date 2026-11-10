import { describe, expect, it } from 'vitest';
import { explainStories, explainStoriesWith } from './index';
import { allFixtures, editorialConfig, fakeOllama, loadFixture } from './test-helpers';

const editorial = editorialConfig();
const good = loadFixture('merged-unreleased-feature');
const goodJson = JSON.stringify(good.cannedOutput);

describe('explainStories: Ollama request', () => {
  it('posts a non-streaming chat with the JSON schema as `format` and the expected options', async () => {
    const ollama = fakeOllama({ replies: [goodJson] });
    const result = await explainStories([good.story], { editorial, fetch: ollama.fetch, ollamaUrl: 'http://ollama.test:11434/' });

    expect(ollama.calls[0]!.url).toBe('http://ollama.test:11434/api/tags');
    const chat = ollama.chatCalls();
    expect(chat).toHaveLength(1);
    expect(chat[0]!.url).toBe('http://ollama.test:11434/api/chat');
    expect(chat[0]!.method).toBe('POST');
    const body = chat[0]!.body!;
    expect(body.model).toBe('qwen3:4b-instruct');
    expect(body.stream).toBe(false);
    expect(body.keep_alive).toBeTypeOf('string');
    expect(body.options).toMatchObject({ temperature: 0.2, num_ctx: 4096 });
    expect((body.options as { num_predict: number }).num_predict).toBeGreaterThanOrEqual(600);
    const format = body.format as { type: string; required: string[]; $schema?: string };
    expect(format.type).toBe('object');
    expect(format.$schema).toBeUndefined();
    expect(format.required).toEqual(expect.arrayContaining(['headline', 'whatHappened', 'whyItMatters', 'glossary', 'technical']));
    const messages = body.messages as { role: string; content: string }[];
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('Version 1');
    expect(messages.at(-1)!.content).toContain('<<<EVIDENCE');

    expect(result.summarization).toBe('llm');
    expect(result.model).toBe('qwen3:4b-instruct');
    expect(result.stories[0]!.explanation.source).toBe('llm');
    expect(result.stories[0]!.explanation.model).toBe('qwen3:4b-instruct');
    expect(result.tokensPerSecond).toBe(50); // 100 tokens / 2 s
  });

  it('uses options.model over the editorial default', async () => {
    const ollama = fakeOllama({ replies: [goodJson], models: ['qwen3:1.7b'] });
    const result = await explainStories([good.story], { editorial, model: 'qwen3:1.7b', fetch: ollama.fetch });
    expect(ollama.chatCalls()[0]!.body!.model).toBe('qwen3:1.7b');
    expect(result.model).toBe('qwen3:1.7b');
  });

  it('strips <think> blocks and code fences before parsing', async () => {
    const ollama = fakeOllama({ replies: [`<think>Let me reason about the status first.</think>\n\`\`\`json\n${goodJson}\n\`\`\``] });
    const result = await explainStories([good.story], { editorial, fetch: ollama.fetch });
    expect(result.stories[0]!.explanation.source).toBe('llm');
    expect(ollama.chatCalls()).toHaveLength(1);
  });

  it('blanks intermediate and technical for routine stories', async () => {
    const routine = loadFixture('routine-maintenance');
    const out = {
      ...(good.cannedOutput as Record<string, unknown>),
      headline: 'react merges routine development dependency bumps',
      whatHappened: 'The react project merged a routine update of packages used only during development.',
      whyItMatters: 'Nothing changes for people who use react in their apps; this keeps the tools current.',
      glossary: [],
      analogy: '',
      intermediate: 'should be removed',
      technical: 'should be removed',
    };
    const ollama = fakeOllama({ replies: [JSON.stringify(out)] });
    const result = await explainStories([routine.story], { editorial, fetch: ollama.fetch });
    const x = result.stories[0]!.explanation;
    expect(x.source).toBe('llm');
    expect(x.intermediate).toBe('');
    expect(x.technical).toBe('');
    const prompt = (ollama.chatCalls()[0]!.body!.messages as { content: string }[]).at(-1)!.content;
    expect(prompt).toMatch(/Set "intermediate" and "technical" to empty strings/);
  });

  it('caps every free-text field in the format schema and uses all CPU threads', async () => {
    const ollama = fakeOllama({ replies: ['{}'] });
    await explainStories([loadFixture('routine-maintenance').story], { editorial, fetch: ollama.fetch }).catch(() => undefined);
    const body = ollama.chatCalls()[0]!.body! as {
      format: { properties: Record<string, { maxLength?: number; maxItems?: number }> };
      options: { num_thread: number; num_predict: number };
    };
    for (const key of ['headline', 'whatHappened', 'previously', 'whatChanged', 'whyItMatters', 'analogy', 'intermediate', 'technical']) {
      expect(body.format.properties[key]?.maxLength).toBeGreaterThan(0);
    }
    expect(body.format.properties.glossary?.maxItems).toBe(2);
    expect(body.options.num_thread).toBeGreaterThan(0);
    expect(body.options.num_predict).toBeGreaterThanOrEqual(700);
  });
});

describe('explainStories: failure handling', () => {
  it('retries once with the validator issues appended, then accepts a corrected answer', async () => {
    const overclaim = loadFixture('merged-overclaim');
    const fixed = {
      ...(overclaim.cannedOutput as Record<string, unknown>),
      headline: 'lnd merges a change that caches fee estimates during routing',
      whatHappened: 'The lnd project merged a change that remembers fee estimates during a payment attempt. It is in the main code but not in a published version yet.',
      whyItMatters: 'Lightning node operators could see faster payments once this reaches a version they install. The pull request reports path finding about 30% faster on large graphs.',
    };
    const ollama = fakeOllama({ replies: [JSON.stringify(overclaim.cannedOutput), JSON.stringify(fixed)] });
    const result = await explainStories([overclaim.story], { editorial, fetch: ollama.fetch });

    const chat = ollama.chatCalls();
    expect(chat).toHaveLength(2);
    const retryMessages = chat[1]!.body!.messages as { role: string; content: string }[];
    expect(retryMessages.at(-2)!.role).toBe('assistant');
    expect(retryMessages.at(-1)!.role).toBe('user');
    expect(retryMessages.at(-1)!.content).toMatch(/rejected/);
    expect(retryMessages.at(-1)!.content).toMatch(/released/);

    const x = result.stories[0]!.explanation;
    expect(x.source).toBe('llm');
    expect(x.validationNotes).toContain('Accepted on retry.');
    expect(result.summarization).toBe('llm');
  });

  it('falls back after exactly one failed retry', async () => {
    const overclaim = loadFixture('merged-overclaim');
    const ollama = fakeOllama({ replies: [JSON.stringify(overclaim.cannedOutput)] });
    const result = await explainStories([overclaim.story], { editorial, fetch: ollama.fetch });
    expect(ollama.chatCalls()).toHaveLength(2);
    const x = result.stories[0]!.explanation;
    expect(x.source).toBe('fallback');
    expect(x.validationNotes.some((n) => n.startsWith('Retry rejected'))).toBe(true);
    expect(result.summarization).toBe('fallback');
  });

  it('times out a hung request and falls back for that story only', async () => {
    const second = loadFixture('pr-issue-release');
    const secondOut = JSON.stringify(second.cannedOutput);
    const twoReplies = fakeOllama({ replies: [{ hang: true }, secondOut] });
    const result = await explainStoriesWith([good.story, second.story], {
      editorial,
      fetch: twoReplies.fetch,
      requestTimeoutMs: 50,
    });
    expect(result.stories[0]!.explanation.source).toBe('fallback');
    expect(result.stories[0]!.explanation.validationNotes.join(' ')).toMatch(/timed out/);
    expect(result.stories[1]!.explanation.source).toBe('llm');
    expect(result.summarization).toBe('mixed');
    expect(twoReplies.chatCalls()).toHaveLength(2);
  });

  it('sends every story to fallback when Ollama is unreachable', async () => {
    const ollama = fakeOllama({ down: true });
    const stories = allFixtures().map((f) => f.story);
    const result = await explainStories(stories, { editorial, fetch: ollama.fetch });
    expect(result.summarization).toBe('fallback');
    expect(result.model).toBeUndefined();
    expect(result.stories).toHaveLength(stories.length);
    for (const s of result.stories) {
      expect(s.explanation.source).toBe('fallback');
      expect(s.explanation.validationNotes.join(' ')).toMatch(/unreachable/i);
    }
    expect(ollama.chatCalls()).toHaveLength(0);
  });

  it('falls back when the model is not installed', async () => {
    const ollama = fakeOllama({ models: ['llama3:8b'] });
    const result = await explainStories([good.story], { editorial, fetch: ollama.fetch });
    expect(result.summarization).toBe('fallback');
    expect(result.stories[0]!.explanation.validationNotes.join(' ')).toMatch(/not installed/);
  });

  it('honors forceFallback without touching the network', async () => {
    const ollama = fakeOllama({ replies: [goodJson] });
    const result = await explainStories([good.story], { editorial, fetch: ollama.fetch, forceFallback: true });
    expect(result.summarization).toBe('fallback');
    expect(ollama.calls).toHaveLength(0);
  });

  it('falls back on HTTP errors and keeps going', async () => {
    const second = loadFixture('pr-issue-release');
    const ollama = fakeOllama({ replies: [{ status: 500 }, JSON.stringify(second.cannedOutput)] });
    const result = await explainStories([good.story, second.story], { editorial, fetch: ollama.fetch });
    expect(result.stories.map((s) => s.explanation.source)).toEqual(['fallback', 'llm']);
    expect(result.summarization).toBe('mixed');
  });

  it('stops calling Ollama after a connection error mid-run', async () => {
    const refused = new TypeError('fetch failed');
    (refused as TypeError & { cause: unknown }).cause = { code: 'ECONNREFUSED' };
    const ollama = fakeOllama({ replies: [{ error: refused }, goodJson] });
    const result = await explainStories([good.story, good.story], { editorial, fetch: ollama.fetch });
    expect(ollama.chatCalls()).toHaveLength(1);
    expect(result.stories.every((s) => s.explanation.source === 'fallback')).toBe(true);
  });

  it('sends remaining stories straight to fallback once the inference budget is spent', async () => {
    let now = 0;
    const ollama = fakeOllama({ replies: [goodJson] });
    const timed = ((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/api/chat')) now += 61_000;
      return ollama.fetch(input, init);
    }) as typeof fetch;
    const result = await explainStoriesWith([good.story, good.story, good.story], {
      editorial: { ...editorial, inferenceBudgetSeconds: 60 },
      fetch: timed,
      clock: () => now,
    });
    expect(ollama.chatCalls()).toHaveLength(1);
    expect(result.stories.map((s) => s.explanation.source)).toEqual(['llm', 'fallback', 'fallback']);
    expect(result.stories[1]!.explanation.validationNotes.join(' ')).toMatch(/budget/);
    expect(result.summarization).toBe('mixed');
  });

  it('returns an empty result for a quiet window without calling Ollama', async () => {
    const ollama = fakeOllama();
    const result = await explainStories([], { editorial, fetch: ollama.fetch });
    expect(result.stories).toEqual([]);
    expect(ollama.calls).toHaveLength(0);
  });

  it('rejects the injection fixture output and publishes the fallback', async () => {
    const inj = loadFixture('prompt-injection');
    const ollama = fakeOllama({ replies: [JSON.stringify(inj.cannedOutput)] });
    const result = await explainStories([inj.story], { editorial, fetch: ollama.fetch });
    const x = result.stories[0]!.explanation;
    expect(x.source).toBe('fallback');
    const { validationNotes, ...text } = x;
    expect(JSON.stringify(text)).not.toMatch(/example\.net|now available|developer mode|3\.0\.0/i);
    // Notes are published too: they must not echo the hostile link.
    expect(validationNotes.join(' ')).not.toMatch(/example\.net/);
    // The evidence the model saw had the hostile delimiter and HTML comment removed.
    const prompt = (ollama.chatCalls()[0]!.body!.messages as { content: string }[]).at(-1)!.content;
    const block = prompt.slice(prompt.indexOf('<<<EVIDENCE id='));
    expect(block.match(/END EVIDENCE/g)).toHaveLength(1);
    expect(block).toContain('IMPORTANT NOTE TO AI SUMMARIZERS'); // kept as data, not removed
    expect(prompt).not.toContain('<!--');
  });
});
