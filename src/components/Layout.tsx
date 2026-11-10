import { useEffect, useId, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { Manifest } from '../../shared/schemas';
import { DataError } from '../lib/data';
import { SCHEDULE_TEXT } from '../lib/editions';
import { applyTheme, useThemePref, type Level, type ThemePref } from '../lib/prefs';
import { useSiteData } from '../lib/site-data';
import { usePlayer } from '../player/PlayerContext';
import { PlayerBar } from '../player/PlayerViews';
import { MonitorIcon, MoonIcon, SunIcon } from './icons';
import { ErrorState, PageSkeleton, cx } from './ui';

const NAV = [
  { to: '/', label: 'Today', end: true },
  { to: '/archive', label: 'Archive' },
  { to: '/repos', label: 'Repositories' },
  { to: '/settings', label: 'Settings' },
  { to: '/about', label: 'About' },
];

const THEME_NEXT: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_NAME: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function ThemeToggle() {
  const [theme, setTheme] = useThemePref();
  const Icon = theme === 'light' ? SunIcon : theme === 'dark' ? MoonIcon : MonitorIcon;
  return (
    <button
      type="button"
      onClick={() => setTheme(THEME_NEXT[theme])}
      aria-label={`Theme: ${THEME_NAME[theme]}. Switch to ${THEME_NAME[THEME_NEXT[theme]]}`}
      title={`Theme: ${THEME_NAME[theme]}`}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      <Icon />
    </button>
  );
}

/** Keeps the <html> class in step with the preference and the system setting. */
export function ThemeSync() {
  const [theme] = useThemePref();
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [theme]);
  return null;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    if (typeof window.scrollTo === 'function' && !navigator.userAgent.includes('jsdom')) window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function Layout({ children }: { children: ReactNode }) {
  const player = usePlayer();
  const barVisible = !!player.edition && (!!player.edition.audioUrl || player.speech.speaking);
  return (
    <div className="flex min-h-dvh flex-col">
      <ScrollToTop />
      <a
        href="#main"
        onClick={(e) => {
          // HashRouter owns the hash; move focus without changing the route.
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
        className="sr-only z-50 rounded-md bg-signal px-3 py-2 text-signal-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-line bg-paper/90 backdrop-blur supports-[backdrop-filter]:bg-paper/75">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 px-4 sm:flex-nowrap">
          <NavLink to="/" className="flex items-center gap-2 py-3 font-serif text-xl font-semibold tracking-tight text-ink" aria-label="TheRepoReport, today's editions">
            <Mark />
            TheRepoReport
          </NavLink>
          <nav aria-label="Main" className="order-3 -mx-4 w-[calc(100%+2rem)] overflow-x-auto px-4 sm:order-none sm:mx-0 sm:w-auto sm:flex-1 sm:px-0">
            <ul className="flex gap-1 pb-2 sm:pb-0">
              {NAV.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    end={item.end}
                    className={({ isActive }) =>
                      cx(
                        'block rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap',
                        isActive ? 'bg-ink text-paper' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                      )
                    }
                  >
                    {item.label}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto sm:ml-0">
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={cx('mx-auto w-full max-w-5xl flex-1 px-4 pt-6 pb-16 focus:outline-none', barVisible && 'pb-36')}>
        {children}
      </main>
      <footer className={cx('border-t border-line text-sm text-ink-3', barVisible && 'pb-20')}>
        <div className="mx-auto flex max-w-5xl flex-wrap justify-between gap-2 px-4 py-6">
          <p>Editions at {SCHEDULE_TEXT} Eastern. Kept for seven days.</p>
          <p>Built from public GitHub activity. Scores come from evidence, not from the model.</p>
        </div>
      </footer>
      <PlayerBar />
    </div>
  );
}

/** Brand mark: three slots of the day, one lit. */
function Mark() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="shrink-0">
      <rect x="1" y="1" width="20" height="20" rx="5" className="fill-ink" />
      <rect x="5" y="12" width="3" height="5" rx="1" className="fill-paper" opacity="0.55" />
      <rect x="9.5" y="8" width="3" height="9" rx="1" className="fill-signal" />
      <rect x="14" y="10" width="3" height="7" rx="1" className="fill-paper" opacity="0.55" />
    </svg>
  );
}

export function FirstEditionEmpty() {
  return (
    <section aria-labelledby="empty-title" className="mx-auto max-w-2xl py-10 sm:py-16">
      <h1 id="empty-title" className="font-serif text-4xl leading-tight font-semibold tracking-tight text-balance text-ink sm:text-5xl">
        The first edition hasn't been published yet
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-ink-2">
        TheRepoReport scans the GitHub repositories on its watchlist three times a day, ranks what changed, and publishes a written
        and spoken briefing here.
      </p>
      <ol className="mt-8 grid gap-3 sm:grid-cols-3" aria-label="Daily schedule, Eastern time">
        {[
          ['Morning Edition', '7:15 AM'],
          ['Afternoon Edition', '1:15 PM'],
          ['Evening Edition', '7:15 PM'],
        ].map(([name, time]) => (
          <li key={name} className="rounded-2xl border border-line bg-surface p-4">
            <p className="font-serif text-2xl font-semibold text-ink tabular">{time}</p>
            <p className="text-sm text-ink-3">{name}, Eastern</p>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-ink-2">Check back after the next scheduled time. Until then you can review the watchlist draft in Settings.</p>
    </section>
  );
}

/** Renders children once the manifest is loaded; handles loading, missing and error states. */
export function ManifestGate({ children, label }: { children: (manifest: Manifest) => ReactNode; label?: string }) {
  const { state, reload } = useSiteData();
  if (state.status === 'loading') return <PageSkeleton label={label ?? 'Loading the latest editions'} />;
  if (state.status === 'missing') return <FirstEditionEmpty />;
  if (state.status === 'error') {
    const err = state.error;
    return (
      <ErrorState
        title="The newsroom data could not be loaded"
        message={err.message}
        detail={err instanceof DataError ? err.detail : undefined}
        onRetry={reload}
      />
    );
  }
  return <>{children(state.manifest)}</>;
}

const LEVELS: { value: Level; label: string }[] = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'technical', label: 'Technical' },
];

export function LevelSelector({ value, onChange }: { value: Level; onChange: (level: Level) => void }) {
  const name = useId();
  return (
    <fieldset className="inline-flex items-center gap-2">
      <legend className="sr-only">Explanation level</legend>
      <span className="hidden text-sm text-ink-3 sm:inline" aria-hidden="true">
        Explain at
      </span>
      <div className="inline-flex rounded-full border border-line-strong bg-surface p-0.5">
        {LEVELS.map((l) => (
          <label
            key={l.value}
            className={cx(
              'cursor-pointer rounded-full px-3 py-1 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-signal',
              value === l.value ? 'bg-ink text-paper' : 'text-ink-2 hover:text-ink',
            )}
          >
            <input type="radio" name={name} value={l.value} checked={value === l.value} onChange={() => onChange(l.value)} className="sr-only" />
            {l.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
