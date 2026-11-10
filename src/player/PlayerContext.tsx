/**
 * One audio element for the whole app, so playback continues across routes.
 * Editions without downloadable audio can be read by the browser's speech
 * synthesis instead (clearly labeled as a fallback in the UI).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { EDITION_TITLES } from '../../shared/edition';
import type { Chapter, EditionReport, ScriptSegment } from '../../shared/schemas';
import { audioPathFor, siteUrl } from '../lib/data';
import { formatDate } from '../lib/format';
import { SPEEDS, useRatePref } from '../lib/prefs';

export interface LoadedEdition {
  report: EditionReport;
  reportPath: string;
  /** Absent when the edition has no downloadable audio. */
  audioUrl?: string;
}

interface LoadOptions {
  autoplay?: boolean;
  startAt?: number;
}

export interface PlayerApi {
  edition: LoadedEdition | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  rate: number;
  error: string | null;
  chapters: Chapter[];
  currentChapterIndex: number;
  /** Transcript segment currently being heard (audio or speech), or -1. */
  activeSegmentIndex: number;
  speech: { supported: boolean; speaking: boolean };
  expanded: boolean;
  setExpanded: (open: boolean) => void;
  load: (report: EditionReport, reportPath: string, options?: LoadOptions) => void;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  skip: (delta: number) => void;
  restart: () => void;
  setRate: (rate: number) => void;
  jumpToChapter: (index: number) => void;
  /** Loads the edition if needed and starts at a story's chapter (or reads it aloud). */
  playStory: (report: EditionReport, reportPath: string, storyId: string) => void;
  /** Starts at a transcript segment. */
  playSegment: (report: EditionReport, reportPath: string, segmentIndex: number) => void;
  prevStory: () => void;
  nextStory: () => void;
  speakFrom: (segmentIndex: number) => void;
  stopSpeech: () => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

export function usePlayer(): PlayerApi {
  const value = useContext(PlayerContext);
  if (!value) throw new Error('usePlayer must be used inside PlayerProvider');
  return value;
}

export function sortedChapters(report: EditionReport | undefined): Chapter[] {
  return [...(report?.audio.chapters ?? [])].sort((a, b) => a.startSec - b.startSec);
}

export function chapterIndexAt(chapters: Chapter[], time: number): number {
  let index = chapters.length ? 0 : -1;
  for (let i = 0; i < chapters.length; i++) if (chapters[i]!.startSec <= time + 0.25) index = i;
  return index;
}

/** Maps a chapter to its transcript segment: by id, then story id, then position. */
export function segmentIndexForChapter(segments: ScriptSegment[], chapters: Chapter[], chapterIndex: number): number {
  const chapter = chapters[chapterIndex];
  if (!chapter) return -1;
  const byId = segments.findIndex((s) => s.id === chapter.id);
  if (byId !== -1) return byId;
  if (chapter.storyId) {
    const byStory = segments.findIndex((s) => s.storyId === chapter.storyId);
    if (byStory !== -1) return byStory;
  }
  return segments.length === chapters.length ? chapterIndex : -1;
}

export function chapterIndexForSegment(segments: ScriptSegment[], chapters: Chapter[], segmentIndex: number): number {
  const seg = segments[segmentIndex];
  if (!seg) return -1;
  const byId = chapters.findIndex((c) => c.id === seg.id);
  if (byId !== -1) return byId;
  if (seg.storyId) {
    const byStory = chapters.findIndex((c) => c.storyId === seg.storyId);
    if (byStory !== -1) return byStory;
  }
  return segments.length === chapters.length ? segmentIndex : -1;
}

/** Split long text so speech engines that stop on long utterances keep going. */
export function speechChunks(text: string, max = 220): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*/g) ?? [];
  const chunks: string[] = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > max && current) {
      chunks.push(current.trim());
      current = '';
    }
    current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [edition, setEdition] = useState<LoadedEdition | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [rate, setRatePref] = useRatePref();
  const [speaking, setSpeaking] = useState(false);
  const [speechIndex, setSpeechIndex] = useState(-1);
  const speechRun = useRef(0);
  const supported = useMemo(speechSupported, []);

  const chapters = useMemo(() => sortedChapters(edition?.report), [edition]);
  const duration = mediaDuration > 0 ? mediaDuration : (edition?.report.audio.durationSec ?? 0);
  const currentChapterIndex = chapterIndexAt(chapters, currentTime);

  const segments = edition?.report.transcript ?? [];
  const activeSegmentIndex = edition
    ? edition.audioUrl
      ? segmentIndexForChapter(segments, chapters, currentChapterIndex)
      : speechIndex
    : -1;

  // Latest values for event handlers registered once.
  const live = useRef({ chapters, currentTime, duration, rate, edition });
  live.current = { chapters, currentTime, duration, rate, edition };

  const el = () => audioRef.current;

  const stopSpeech = useCallback(() => {
    speechRun.current++;
    if (speechSupported()) window.speechSynthesis.cancel();
    setSpeaking(false);
    setSpeechIndex(-1);
  }, []);

  const play = useCallback(() => {
    const a = el();
    if (!a || !live.current.edition?.audioUrl) return;
    setError(null);
    const result = a.play();
    if (result && typeof result.catch === 'function') {
      result.catch((err: unknown) => {
        const name = (err as Error)?.name;
        if (name === 'AbortError') return;
        if (name === 'NotAllowedError') setError('Press play to start listening.');
        else setError('The audio file could not be played.');
      });
    }
  }, []);

  const pause = useCallback(() => el()?.pause(), []);

  const seek = useCallback((seconds: number) => {
    const a = el();
    if (!a) return;
    const max = live.current.duration || Number.POSITIVE_INFINITY;
    const t = Math.min(Math.max(0, seconds), max);
    a.currentTime = t;
    live.current.currentTime = t;
    setCurrentTime(t);
  }, []);

  const skip = useCallback((delta: number) => seek((el()?.currentTime ?? 0) + delta), [seek]);

  const toggle = useCallback(() => {
    const a = el();
    if (!a) return;
    if (a.paused) play();
    else a.pause();
  }, [play]);

  const restart = useCallback(() => {
    seek(0);
    play();
  }, [seek, play]);

  const setRate = useCallback(
    (next: number) => {
      const r = (SPEEDS as readonly number[]).includes(next) ? next : 1;
      setRatePref(r);
      const a = el();
      if (a) {
        a.defaultPlaybackRate = r;
        a.playbackRate = r;
      }
    },
    [setRatePref],
  );

  const load = useCallback(
    (report: EditionReport, reportPath: string, options: LoadOptions = {}) => {
      const a = el();
      const current = live.current.edition;
      const audioUrl = report.audio.available ? siteUrl(audioPathFor(reportPath, report.audio.file)) : undefined;
      if (!current || current.report.key !== report.key) {
        stopSpeech();
        setError(null);
        setMediaDuration(0);
        setCurrentTime(0);
        setEdition({ report, reportPath, audioUrl });
        // Keep the shared ref current so play() works in the same tick.
        live.current = {
          ...live.current,
          edition: { report, reportPath, audioUrl },
          chapters: sortedChapters(report),
          duration: report.audio.durationSec ?? 0,
          currentTime: 0,
        };
        if (a) {
          if (!a.paused) a.pause();
          if (audioUrl) {
            a.src = audioUrl;
            a.defaultPlaybackRate = live.current.rate;
            a.playbackRate = live.current.rate;
          } else {
            a.removeAttribute('src');
          }
        }
      }
      if (!audioUrl) return;
      if (options.startAt !== undefined && a) {
        a.currentTime = options.startAt;
        setCurrentTime(options.startAt);
      }
      if (options.autoplay) play();
    },
    [play, stopSpeech],
  );

  const jumpToChapter = useCallback(
    (index: number) => {
      const chapter = live.current.chapters[index];
      if (!chapter) return;
      seek(chapter.startSec);
      play();
    },
    [seek, play],
  );

  const storyChapterIndexes = useCallback(() => {
    const list = live.current.chapters;
    const stories = list.map((c, i) => (c.storyId ? i : -1)).filter((i) => i !== -1);
    return stories.length ? stories : list.map((_, i) => i);
  }, []);

  const nextStory = useCallback(() => {
    const idx = storyChapterIndexes();
    const now = live.current.currentTime;
    const next = idx.find((i) => live.current.chapters[i]!.startSec > now + 0.5);
    if (next !== undefined) jumpToChapter(next);
  }, [storyChapterIndexes, jumpToChapter]);

  const prevStory = useCallback(() => {
    const idx = storyChapterIndexes();
    const now = live.current.currentTime;
    const started = idx.filter((i) => live.current.chapters[i]!.startSec <= now + 0.25);
    const currentStart = started.at(-1);
    if (currentStart === undefined) return seek(0);
    // Within the first few seconds of a story, go to the previous one.
    if (now - live.current.chapters[currentStart]!.startSec > 3 || started.length < 2) jumpToChapter(currentStart);
    else jumpToChapter(started.at(-2)!);
  }, [storyChapterIndexes, jumpToChapter, seek]);

  const speakFrom = useCallback(
    (segmentIndex: number) => {
      const ed = live.current.edition;
      if (!ed || !speechSupported()) return;
      const synth = window.speechSynthesis;
      speechRun.current++;
      const run = speechRun.current;
      synth.cancel();
      const segs = ed.report.transcript.slice(segmentIndex);
      const utterances: SpeechSynthesisUtterance[] = [];
      segs.forEach((seg, offset) => {
        const chunks = speechChunks(seg.text);
        chunks.forEach((chunk, ci) => {
          const u = new SpeechSynthesisUtterance(chunk);
          u.lang = 'en-US';
          u.rate = live.current.rate;
          if (ci === 0) u.onstart = () => run === speechRun.current && setSpeechIndex(segmentIndex + offset);
          utterances.push(u);
        });
      });
      const last = utterances.at(-1);
      if (!last) return;
      last.onend = () => {
        if (run !== speechRun.current) return;
        setSpeaking(false);
        setSpeechIndex(-1);
      };
      utterances.forEach((u) => {
        u.onerror = (e) => {
          if (run !== speechRun.current || e.error === 'interrupted' || e.error === 'canceled') return;
          setSpeaking(false);
          setError('Your browser stopped reading aloud.');
        };
        synth.speak(u);
      });
      setSpeaking(true);
      setSpeechIndex(segmentIndex);
    },
    [],
  );

  const playSegment = useCallback(
    (report: EditionReport, reportPath: string, segmentIndex: number) => {
      load(report, reportPath);
      if (report.audio.available) {
        const chs = sortedChapters(report);
        const ci = chapterIndexForSegment(report.transcript, chs, segmentIndex);
        const chapter = chs[ci];
        if (chapter) {
          seek(chapter.startSec);
          play();
        }
      } else {
        speakFrom(segmentIndex);
      }
    },
    [load, seek, play, speakFrom],
  );

  const playStory = useCallback(
    (report: EditionReport, reportPath: string, storyId: string) => {
      load(report, reportPath);
      if (report.audio.available) {
        const chapter = sortedChapters(report).find((c) => c.storyId === storyId);
        seek(chapter?.startSec ?? 0);
        play();
      } else {
        const index = report.transcript.findIndex((s) => s.storyId === storyId);
        speakFrom(Math.max(0, index));
      }
    },
    [load, seek, play, speakFrom],
  );

  // Media element events.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    let lastPosition = 0;
    const onTime = () => {
      setCurrentTime(a.currentTime);
      const now = Date.now();
      if (now - lastPosition > 1000 && 'mediaSession' in navigator && Number.isFinite(a.duration) && a.duration > 0) {
        lastPosition = now;
        try {
          navigator.mediaSession.setPositionState?.({
            duration: a.duration,
            playbackRate: a.playbackRate,
            position: Math.min(a.currentTime, a.duration),
          });
        } catch {
          // Some browsers reject position updates during loading.
        }
      }
    };
    const onDuration = () => setMediaDuration(Number.isFinite(a.duration) ? a.duration : 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onError = () => {
      if (!a.getAttribute('src')) return;
      setPlaying(false);
      setError('The audio file could not be loaded. It may have expired from the archive.');
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('seeked', onTime);
    a.addEventListener('durationchange', onDuration);
    a.addEventListener('loadedmetadata', onDuration);
    a.addEventListener('play', onPlay);
    a.addEventListener('pause', onPause);
    a.addEventListener('ended', onPause);
    a.addEventListener('error', onError);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('seeked', onTime);
      a.removeEventListener('durationchange', onDuration);
      a.removeEventListener('loadedmetadata', onDuration);
      a.removeEventListener('play', onPlay);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('ended', onPause);
      a.removeEventListener('error', onError);
    };
  }, []);

  // Media Session: lock screen and hardware controls.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || !edition?.audioUrl) return;
    const { report } = edition;
    const title = report.stories[0]?.explanation.headline ?? (report.quiet ? 'A quiet period on GitHub' : EDITION_TITLES[report.edition]);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: 'TheRepoReport',
        album: `${EDITION_TITLES[report.edition]}, ${formatDate(report.date, { month: 'long', day: 'numeric' })}`,
        artwork: [{ src: siteUrl('podcast-cover.png'), sizes: '1400x1400', type: 'image/png' }],
      });
    } catch {
      // MediaMetadata unsupported.
    }
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Action not supported by this browser.
      }
    };
    set('play', () => play());
    set('pause', () => pause());
    set('stop', () => pause());
    set('seekbackward', (d) => skip(-(d.seekOffset ?? 15)));
    set('seekforward', (d) => skip(d.seekOffset ?? 15));
    set('seekto', (d) => d.seekTime !== undefined && seek(d.seekTime));
    set('previoustrack', () => prevStory());
    set('nexttrack', () => nextStory());
    return () => {
      for (const action of ['play', 'pause', 'stop', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'] as const) {
        set(action, null);
      }
    };
  }, [edition, play, pause, skip, seek, prevStory, nextStory]);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : edition?.audioUrl ? 'paused' : 'none';
    }
  }, [playing, edition]);

  // Stop speech when the tab closes.
  useEffect(() => () => {
    if (speechSupported()) window.speechSynthesis.cancel();
  }, []);

  const api: PlayerApi = {
    edition,
    playing,
    currentTime,
    duration,
    rate,
    error,
    chapters,
    currentChapterIndex,
    activeSegmentIndex,
    speech: { supported, speaking },
    expanded,
    setExpanded,
    load,
    play,
    pause,
    toggle,
    seek,
    skip,
    restart,
    setRate,
    jumpToChapter,
    playStory,
    playSegment,
    prevStory,
    nextStory,
    speakFrom,
    stopSpeech,
  };

  return (
    <PlayerContext.Provider value={api}>
      {children}
      {/* The transcript is shown on the edition page. */}
      <audio ref={audioRef} preload="metadata" data-testid="edition-audio" hidden />
    </PlayerContext.Provider>
  );
}
