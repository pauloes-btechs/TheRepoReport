/**
 * pipeline/llm — explain scored stories with a local Ollama model, validate
 * every answer against the evidence, retry once with the validator's findings,
 * and fall back to a deterministic briefing when anything goes wrong.
 */
import type { ExplainOptions, ExplainResult, ExplainStories, Logger } from '../../shared/contracts';
import type { ExplainedStory, Explanation, ScoredStory } from '../../shared/schemas';
import { fallbackExplanation } from './fallback';
import { DEFAULT_OLLAMA_URL, OllamaError, chat, checkHealth } from './ollama';
import {
  buildMessages,
  buildRetryMessage,
  explanationJsonSchema,
  wantsTechnicalLayers,
  loadExemplars,
  loadInstructions,
  type ChatMessage,
  type Exemplar,
} from './prompt';
import { validateExplanation } from './validate';

export { fallbackExplanation } from './fallback';
export { validateExplanation, checkAgainstEvidence, stripThinking } from './validate';
export { buildEvidenceBundle, buildMessages, buildSystemPrompt, buildUserPrompt, explanationJsonSchema } from './prompt';

/** Extra knobs for tests and the eval harness. Production callers pass plain ExplainOptions. */
export interface ExplainInternals {
  /** Per-request timeout. Default 180 s. */
  requestTimeoutMs?: number;
  /** Style-guide text; defaults to editorial/instructions.md read at run time. */
  instructions?: string;
  /** Few-shot exemplars; defaults to editorial/examples/*.json. Pass [] to disable. */
  exemplars?: Exemplar[];
  /** Millisecond clock, for budget tests. */
  clock?: () => number;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function fallbackFor(story: ScoredStory, reasons: string[]): ExplainedStory {
  return { ...story, explanation: fallbackExplanation(story, reasons) };
}

function summarize(stories: ExplainedStory[]): ExplainResult['summarization'] {
  const llm = stories.filter((s) => s.explanation.source === 'llm').length;
  if (llm === stories.length) return 'llm';
  if (llm === 0) return 'fallback';
  return 'mixed';
}

export async function explainStoriesWith(
  stories: ScoredStory[],
  options: ExplainOptions & ExplainInternals,
): Promise<ExplainResult> {
  const clock = options.clock ?? Date.now;
  const logger = options.logger ?? silentLogger;
  const fetchFn = options.fetch ?? fetch;
  const baseUrl = options.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const model = options.model ?? options.editorial.model;
  const start = clock();
  const elapsedSeconds = () => (clock() - start) / 1000;

  if (stories.length === 0) {
    return { stories: [], summarization: options.forceFallback ? 'fallback' : 'llm', inferenceSeconds: 0 };
  }

  const allFallback = (reason: string): ExplainResult => {
    logger.warn('Using deterministic fallback for every story', { reason, stories: stories.length });
    return {
      stories: stories.map((s) => fallbackFor(s, [reason])),
      summarization: 'fallback',
      inferenceSeconds: elapsedSeconds(),
    };
  };

  if (options.forceFallback) return allFallback('Fallback summarization was forced for this run.');

  const health = await checkHealth(baseUrl, model, fetchFn);
  if (!health.ok) return allFallback(health.reason ?? 'Ollama is unavailable.');

  let instructions = options.instructions;
  let exemplars = options.exemplars;
  try {
    instructions ??= loadInstructions();
    exemplars ??= loadExemplars();
  } catch (err) {
    if (!instructions) return allFallback(`Editorial instructions could not be loaded (${(err as Error).message}).`);
    exemplars = [];
  }

  const format = explanationJsonSchema();
  const budgetMs = options.editorial.inferenceBudgetSeconds * 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let evalTokens = 0;
  let evalNanos = 0;
  let ollamaDown: string | undefined;
  const out: ExplainedStory[] = [];

  const remainingMs = () => budgetMs - (clock() - start);

  const ask = async (messages: ChatMessage[], storyId: string) => {
    const began = clock();
    const response = await chat({
      baseUrl,
      model,
      messages,
      format,
      timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remainingMs())),
      fetch: fetchFn,
    });
    if (response.evalCount && response.evalDuration) {
      evalTokens += response.evalCount;
      evalNanos += response.evalDuration;
    }
    const secs = (ns?: number) => (ns ? Math.round(ns / 1e8) / 10 : undefined);
    logger.info('Model call', {
      story: storyId,
      seconds: Math.round((clock() - began) / 100) / 10,
      promptTokens: response.promptEvalCount,
      promptSeconds: secs(response.promptEvalDuration),
      outputTokens: response.evalCount,
      outputSeconds: secs(response.evalDuration),
      loadSeconds: secs(response.loadDuration),
    });
    return response.content;
  };

  for (const story of stories) {
    if (ollamaDown) {
      out.push(fallbackFor(story, [`Ollama became unavailable earlier in this run: ${ollamaDown}`]));
      continue;
    }
    if (remainingMs() <= 0) {
      out.push(
        fallbackFor(story, [
          `The inference budget of ${options.editorial.inferenceBudgetSeconds} s was spent before this story was reached.`,
        ]),
      );
      continue;
    }

    const messages = buildMessages(story, { instructions, exemplars });
    try {
      const first = await ask(messages, story.id);
      let result = validateExplanation(first, story);
      const notes: string[] = [];
      if (!result.ok) {
        logger.warn('Model output rejected; retrying once', { story: story.id, issues: result.issues });
        notes.push(...result.issues.map((i) => `First attempt rejected: ${i}`));
        if (remainingMs() <= 0) {
          out.push(fallbackFor(story, [...notes, 'The inference budget ran out before a retry.']));
          continue;
        }
        const second = await ask([...messages, { role: 'assistant', content: first }, buildRetryMessage(result.issues)], story.id);
        result = validateExplanation(second, story);
        if (!result.ok) {
          logger.warn('Retry rejected; using fallback', { story: story.id, issues: result.issues });
          out.push(fallbackFor(story, [...notes, ...result.issues.map((i) => `Retry rejected: ${i}`)]));
          continue;
        }
        notes.push('Accepted on retry.');
      }
      const value = result.value!;
      if (!wantsTechnicalLayers(story)) {
        value.intermediate = '';
        value.technical = '';
      }
      const explanation: Explanation = { ...value, source: 'llm', model, validationNotes: notes };
      out.push({ ...story, explanation });
    } catch (err) {
      const e = err instanceof OllamaError ? err : new OllamaError(String(err), 'protocol');
      logger.warn('Ollama request failed; using fallback', { story: story.id, kind: e.kind, message: e.message });
      if (e.kind === 'unreachable') ollamaDown = e.message;
      out.push(fallbackFor(story, [e.message]));
    }
  }

  const summarization = summarize(out);
  const result: ExplainResult = {
    stories: out,
    summarization,
    inferenceSeconds: Math.round(elapsedSeconds() * 10) / 10,
  };
  if (summarization !== 'fallback') result.model = model;
  if (evalTokens > 0 && evalNanos > 0) result.tokensPerSecond = Math.round((evalTokens / (evalNanos / 1e9)) * 10) / 10;
  logger.info('Explained stories', {
    stories: out.length,
    summarization,
    inferenceSeconds: result.inferenceSeconds,
    tokensPerSecond: result.tokensPerSecond,
  });
  return result;
}

export const explainStories: ExplainStories = (stories, options) => explainStoriesWith(stories, options);
