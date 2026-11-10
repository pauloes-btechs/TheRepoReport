import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { EditionReport, Manifest } from '../../shared/schemas';
import { DataError, clearReportCache, getReport, loadManifest } from './data';

export type ManifestState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; manifest: Manifest }
  | { status: 'error'; error: DataError | Error };

interface SiteData {
  state: ManifestState;
  reload: () => void;
}

const SiteDataContext = createContext<SiteData | null>(null);

export function SiteDataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ManifestState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    loadManifest({ signal: controller.signal })
      .then((manifest) => {
        setState(manifest ? { status: 'ready', manifest } : { status: 'missing' });
      })
      .catch((error: unknown) => {
        if ((error as Error)?.name === 'AbortError') return;
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => {
    clearReportCache();
    setAttempt((n) => n + 1);
  }, []);

  return <SiteDataContext.Provider value={{ state, reload }}>{children}</SiteDataContext.Provider>;
}

export function useSiteData(): SiteData {
  const value = useContext(SiteDataContext);
  if (!value) throw new Error('useSiteData must be used inside SiteDataProvider');
  return value;
}

export type ReportState =
  | { status: 'loading' }
  | { status: 'ready'; report: EditionReport }
  | { status: 'error'; error: Error };

/** Loads (and caches) one edition report. Pass undefined to load nothing. */
export function useReport(path: string | undefined): { state: ReportState; retry: () => void } {
  const [state, setState] = useState<ReportState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setState({ status: 'loading' });
    getReport(path)
      .then((report) => !cancelled && setState({ status: 'ready', report }))
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => {
      cancelled = true;
    };
  }, [path, attempt]);

  return { state, retry: () => setAttempt((n) => n + 1) };
}
