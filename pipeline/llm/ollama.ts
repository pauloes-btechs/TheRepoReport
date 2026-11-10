/** Minimal Ollama HTTP client: health check and non-streaming structured chat. */
import type { FetchLike } from '../../shared/contracts';
import type { ChatMessage } from './prompt';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

export interface ChatRequestOptions {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  format: Record<string, unknown>;
  timeoutMs: number;
  fetch: FetchLike;
  numPredict?: number;
  keepAlive?: string;
}

export interface ChatResponse {
  content: string;
  evalCount?: number;
  /** Nanoseconds. */
  evalDuration?: number;
  /** Nanoseconds. */
  loadDuration?: number;
  promptEvalCount?: number;
  /** Nanoseconds. */
  promptEvalDuration?: number;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'timeout' | 'http' | 'protocol',
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

/** Reject as soon as `signal` aborts, even if the underlying promise ignores it. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

function isConnectionError(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string };
  const code = e?.cause?.code ?? e?.code ?? '';
  return (
    ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code) ||
    /fetch failed|ECONNREFUSED|connect/i.test(e?.message ?? '')
  );
}

export interface HealthResult {
  ok: boolean;
  reason?: string;
  models: string[];
}

/** GET /api/tags. Unreachable server or missing model → not ok, with a reason. */
export async function checkHealth(
  baseUrl: string,
  model: string,
  fetchFn: FetchLike,
  timeoutMs = 10_000,
): Promise<HealthResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await withAbort(fetchFn(`${base(baseUrl)}/api/tags`, { signal: controller.signal }), controller.signal);
    if (!res.ok) return { ok: false, reason: `Ollama health check returned HTTP ${res.status}`, models: [] };
    const body = (await withAbort(res.json(), controller.signal)) as { models?: { name?: string; model?: string }[] };
    const models = (body.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
    const want = model.includes(':') ? model : `${model}:latest`;
    if (!models.some((m) => m === model || m === want)) {
      return { ok: false, reason: `Model ${model} is not installed in Ollama`, models };
    }
    return { ok: true, models };
  } catch (err) {
    const reason = controller.signal.aborted
      ? 'Ollama health check timed out'
      : `Ollama is unreachable (${(err as Error).message})`;
    return { ok: false, reason, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/chat with stream:false and a JSON-schema `format`. */
export async function chat(opts: ChatRequestOptions): Promise<ChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: false,
    format: opts.format,
    options: { temperature: 0.2, num_ctx: 4096, num_predict: opts.numPredict ?? 700 },
    keep_alive: opts.keepAlive ?? '15m',
  };
  try {
    const res = await withAbort(
      opts.fetch(`${base(opts.baseUrl)}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OllamaError(`Ollama returned HTTP ${res.status}: ${text.slice(0, 200)}`, 'http');
    }
    const json = (await withAbort(res.json(), controller.signal)) as {
      message?: { content?: string };
      eval_count?: number;
      eval_duration?: number;
      load_duration?: number;
      prompt_eval_count?: number;
      prompt_eval_duration?: number;
      error?: string;
    };
    if (json.error) throw new OllamaError(`Ollama error: ${json.error}`, 'http');
    if (typeof json.message?.content !== 'string') throw new OllamaError('Ollama response had no message content', 'protocol');
    return {
      content: json.message.content,
      evalCount: json.eval_count,
      evalDuration: json.eval_duration,
      loadDuration: json.load_duration,
      promptEvalCount: json.prompt_eval_count,
      promptEvalDuration: json.prompt_eval_duration,
    };
  } catch (err) {
    if (err instanceof OllamaError) throw err;
    if (controller.signal.aborted) throw new OllamaError(`Ollama request timed out after ${opts.timeoutMs} ms`, 'timeout');
    if (isConnectionError(err)) throw new OllamaError(`Ollama is unreachable (${(err as Error).message})`, 'unreachable');
    throw new OllamaError(`Ollama request failed (${(err as Error).message})`, 'protocol');
  } finally {
    clearTimeout(timer);
  }
}
