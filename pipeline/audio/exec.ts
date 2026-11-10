/**
 * Minimal subprocess runner: no shell, hard timeout, bounded output capture.
 */
import { spawn } from 'node:child_process';

export interface RunOptions {
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError?: NodeJS.ErrnoException;
}

const MAX_CAPTURE = 256 * 1024;

function append(buffer: string, chunk: Buffer): string {
  if (buffer.length >= MAX_CAPTURE) return buffer;
  const next = buffer + chunk.toString('utf8');
  // Keep the tail: ffmpeg and Python put the useful part of an error last.
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

export function run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ?? process.env,
      cwd: options.cwd,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (c: Buffer) => (stdout = append(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = append(stderr, c)));
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error }),
    );
    child.on('close', (code, signal) => finish({ code, signal, stdout, stderr, timedOut }));

    // A child that exits without reading stdin raises EPIPE; that is reported via the exit code instead.
    child.stdin.on('error', () => undefined);
    if (options.input !== undefined) child.stdin.end(options.input, 'utf8');
    else child.stdin.end();
  });
}

/** One-line description of a failed run, for logs and `unavailableReason`. */
export function describeFailure(label: string, result: RunResult): string {
  if (result.spawnError) {
    return result.spawnError.code === 'ENOENT'
      ? `${label} not found`
      : `${label} could not start: ${result.spawnError.message}`;
  }
  if (result.timedOut) return `${label} timed out`;
  const tail = result.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400);
  return `${label} exited with ${result.code ?? result.signal}${tail ? `: ${tail}` : ''}`;
}
