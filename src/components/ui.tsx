import { useState, type ReactNode } from 'react';
import {
  BAND_LABELS,
  STATUS_LABELS,
  STATUS_ORDER,
  type Confidence,
  type DevStatus,
  type ImpactBand,
} from '../../shared/schemas';
import { CheckIcon, CopyIcon, ExternalIcon } from './icons';

export const BAND_CLASSES: Record<ImpactBand, string> = {
  critical: 'bg-critical-bg text-critical-fg',
  major: 'bg-major-bg text-major-fg',
  high: 'bg-high-bg text-high-fg',
  notable: 'bg-notable-bg text-notable-fg',
  routine: 'bg-routine-bg text-routine-fg',
};

export const BAND_BAR: Record<ImpactBand, string> = {
  critical: 'bg-critical-fg',
  major: 'bg-major-fg',
  high: 'bg-high-fg',
  notable: 'bg-notable-fg',
  routine: 'bg-routine-fg',
};

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function BandBadge({ total, band, size = 'md' }: { total: number; band: ImpactBand; size?: 'md' | 'lg' }) {
  return (
    <span
      className={cx(
        'inline-flex items-baseline gap-1.5 rounded-full font-medium tabular',
        BAND_CLASSES[band],
        size === 'lg' ? 'px-3 py-1 text-sm' : 'px-2.5 py-0.5 text-xs',
      )}
    >
      <span className="font-bold">{Math.round(total)}</span>
      <span>{BAND_LABELS[band]}</span>
      <span className="sr-only">impact score out of 100</span>
    </span>
  );
}

/** Lifecycle position as a five-step track plus the status name. */
export function StatusPill({ status, previous }: { status: DevStatus; previous?: DevStatus }) {
  const index = STATUS_ORDER.indexOf(status);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-2.5 py-0.5 font-medium text-ink">
        <span className="flex gap-0.5" aria-hidden="true">
          {STATUS_ORDER.map((s, i) => (
            <span key={s} className={cx('h-1.5 w-2.5 rounded-sm', i <= index ? 'bg-signal' : 'bg-line-strong')} />
          ))}
        </span>
        <span>{STATUS_LABELS[status]}</span>
        <span className="sr-only">
          , stage {index + 1} of {STATUS_ORDER.length} in the development lifecycle
        </span>
      </span>
      {previous && previous !== status && <span className="text-ink-3">previously {STATUS_LABELS[previous]}</span>}
    </span>
  );
}

const CONFIDENCE_TEXT: Record<Confidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export function ConfidenceTag({ confidence }: { confidence: Confidence }) {
  const filled = confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
      <span className="flex items-end gap-px" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <span key={i} className={cx('w-1 rounded-sm', i < filled ? 'bg-ink-2' : 'bg-line-strong')} style={{ height: 5 + i * 3 }} />
        ))}
      </span>
      {CONFIDENCE_TEXT[confidence]}
    </span>
  );
}

export function Tag({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'warn' | 'ok' | 'bad' | 'signal'; title?: string }) {
  const tones = {
    neutral: 'bg-surface-2 text-ink-2',
    warn: 'bg-warn-bg text-warn-fg',
    ok: 'bg-ok-bg text-ok-fg',
    bad: 'bg-bad-bg text-bad-fg',
    signal: 'bg-signal-soft text-signal-text',
  };
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium', tones[tone])}>
      {children}
    </span>
  );
}

export function FallbackBadge({ mixed = false }: { mixed?: boolean }) {
  return (
    <Tag tone="warn" title="Written from a deterministic template because the language model's output was unavailable or did not pass validation.">
      {mixed ? 'Some stories use fallback summarization' : 'Fallback summarization'}
    </Tag>
  );
}

export function QuietBadge() {
  return <Tag tone="neutral">Quiet period</Tag>;
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cx('inline-flex items-center gap-1 text-signal-text underline decoration-1 hover:decoration-2', className)}>
      {children}
      <ExternalIcon size={13} />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton', className)} aria-hidden="true" />;
}

export function PageSkeleton({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-6 py-6">
      <span className="sr-only">{label}…</span>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-10 w-full max-w-2xl" />
      <Skeleton className="h-10 w-3/4 max-w-xl" />
      <div className="grid gap-4 pt-4 sm:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}

export function ErrorState({ title, message, detail, onRetry }: { title: string; message: string; detail?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-line bg-surface p-6">
      <h2 className="font-serif text-xl font-semibold text-ink">{title}</h2>
      <p className="mt-2 max-w-prose text-ink-2">{message}</p>
      {detail && (
        <details className="mt-3 text-sm text-ink-3">
          <summary className="underline">Technical detail</summary>
          <p className="mt-2 break-words">{detail}</p>
        </details>
      )}
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-4 rounded-full bg-signal px-4 py-2 text-sm font-semibold text-signal-ink hover:bg-signal-hover">
          Try again
        </button>
      )}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('done');
    } catch {
      setCopied('failed');
    }
    window.setTimeout(() => setCopied('idle'), 2000);
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-2"
    >
      {copied === 'done' ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      <span aria-live="polite">{copied === 'done' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy'}</span>
    </button>
  );
}

/** Section heading with an optional line of supporting text. */
export function SectionHeading({ id, title, note, children }: { id?: string; title: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b border-line pb-2">
      <div>
        <h2 id={id} className="font-serif text-2xl font-semibold tracking-tight text-ink">
          {title}
        </h2>
        {note && <p className="mt-0.5 text-sm text-ink-3">{note}</p>}
      </div>
      {children}
    </div>
  );
}
