import { readFileSync } from 'node:fs';

export interface MemoryPeaks {
  /** Peak resident set size of this Node process, in MB. */
  peakRssMb: number;
  /** Peak machine-wide used memory (MemTotal - MemAvailable), in MB, when /proc/meminfo is readable. Includes Ollama and Piper. */
  peakSystemUsedMb?: number;
  samples: number;
}

/** Machine-wide used memory in MB from /proc/meminfo (Linux only). */
export function systemUsedMb(meminfo?: string): number | undefined {
  let text = meminfo;
  if (text === undefined) {
    try {
      text = readFileSync('/proc/meminfo', 'utf8');
    } catch {
      return undefined;
    }
  }
  const field = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text ?? '');
    return m ? Number(m[1]) : undefined;
  };
  const total = field('MemTotal');
  const available = field('MemAvailable');
  if (total === undefined || available === undefined) return undefined;
  return Math.round((total - available) / 1024);
}

/** Samples memory on an interval; the timer is unref'd so it never keeps the process alive. */
export class MemorySampler {
  private peakRss = 0;
  private peakSystem: number | undefined;
  private samples = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly intervalMs = 2000) {}

  start(): this {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  sample(): void {
    this.samples += 1;
    const rss = process.memoryUsage().rss / 1024 / 1024;
    if (rss > this.peakRss) this.peakRss = rss;
    const sys = systemUsedMb();
    if (sys !== undefined && (this.peakSystem === undefined || sys > this.peakSystem)) this.peakSystem = sys;
  }

  stop(): MemoryPeaks {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.sample();
    return {
      peakRssMb: Math.round(this.peakRss),
      ...(this.peakSystem !== undefined ? { peakSystemUsedMb: this.peakSystem } : {}),
      samples: this.samples,
    };
  }
}
