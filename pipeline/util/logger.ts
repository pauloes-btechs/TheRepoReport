import type { Logger } from '../../shared/contracts';
import { redact } from './redact';

export interface CreateLoggerOptions {
  /** Where lines go. Defaults to stderr so stdout stays clean for tooling. */
  write?: (line: string) => void;
  /** Literal secret values to scrub in addition to the built-in patterns. */
  secrets?: readonly string[];
  /** Prefix for every line, e.g. "edition". */
  scope?: string;
}

/** Plain-text structured logger. Every line is passed through the redactor. */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const secrets = options.secrets ?? [];
  const scope = options.scope ? `[${options.scope}] ` : '';
  const emit = (level: string, message: string, data?: Record<string, unknown>) => {
    const suffix = data && Object.keys(data).length > 0 ? ` ${safeJson(data)}` : '';
    write(redact(`${new Date().toISOString()} ${level.padEnd(5)} ${scope}${message}${suffix}`, secrets));
  };
  return {
    info: (message, data) => emit('info', message, data),
    warn: (message, data) => emit('warn', message, data),
    error: (message, data) => emit('error', message, data),
  };
}

/** A logger that records lines in memory; used by tests. */
export function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  return Object.assign(logger, { lines });
}

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, (_key, value: unknown) => (value instanceof Error ? value.message : value));
  } catch {
    return '[unserializable]';
  }
}
