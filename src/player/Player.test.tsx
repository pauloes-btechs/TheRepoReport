// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENING_FALLBACK, MORNING, fixtureReport } from '../test/helpers';
import { installMediaMocks, installSpeechMocks, removeSpeechMocks } from '../test/dom';
import { PlayerProvider, chapterIndexAt, speechChunks } from './PlayerContext';
import { EditionPlayer, PlayerBar } from './PlayerViews';
import { TranscriptPanel } from './TranscriptPanel';

const morning = fixtureReport(MORNING);
const morningPath = `data/editions/${MORNING}/report.json`;

function renderPlayer(report = morning, path = morningPath) {
  render(
    <MemoryRouter>
      <PlayerProvider>
        <EditionPlayer report={report} reportPath={path} />
        <TranscriptPanel report={report} reportPath={path} />
        <PlayerBar />
      </PlayerProvider>
    </MemoryRouter>,
  );
  return screen.getByTestId('edition-audio') as HTMLAudioElement;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('player controls', () => {
  it('loads the edition audio and plays and pauses it', () => {
    const { play, pause } = installMediaMocks();
    const audio = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Play the Morning Edition' }));
    expect(audio.getAttribute('src')).toBe(`/TheRepoReport/data/editions/${MORNING}/audio.mp3`);
    expect(play).toHaveBeenCalledTimes(1);

    const region = screen.getByRole('region', { name: 'Listen to this edition' });
    fireEvent.click(within(region).getByRole('button', { name: 'Pause' }));
    expect(pause).toHaveBeenCalled();
    fireEvent.click(within(region).getByRole('button', { name: 'Play' }));
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('jumps to a chapter, skips, restarts and steps between stories', () => {
    installMediaMocks();
    const audio = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Play the Morning Edition' }));
    const region = screen.getByRole('region', { name: 'Listen to this edition' });
    const chapters = within(region).getByRole('list', { name: 'Chapters' });

    fireEvent.click(within(chapters).getByRole('button', { name: /Top headlines/ }));
    expect(audio.currentTime).toBe(6);
    expect(within(chapters).getByRole('button', { name: /Top headlines/ })).toHaveAttribute('aria-current', 'true');

    fireEvent.click(within(region).getByRole('button', { name: 'Forward 15 seconds' }));
    expect(audio.currentTime).toBe(21);
    fireEvent.click(within(region).getByRole('button', { name: 'Back 15 seconds' }));
    expect(audio.currentTime).toBe(6);

    fireEvent.click(within(region).getByRole('button', { name: 'Next story' }));
    expect(audio.currentTime).toBe(13); // lead story chapter
    fireEvent.click(within(region).getByRole('button', { name: 'Next story' }));
    expect(audio.currentTime).toBe(30);
    fireEvent.click(within(region).getByRole('button', { name: 'Previous story' }));
    expect(audio.currentTime).toBe(13);

    fireEvent.click(within(region).getByRole('button', { name: 'Restart from the beginning' }));
    expect(audio.currentTime).toBe(0);
  });

  it('seeks with the keyboard-operable scrubber and persists the speed', () => {
    installMediaMocks();
    const audio = renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Play the Morning Edition' }));
    const region = screen.getByRole('region', { name: 'Listen to this edition' });
    const scrubber = within(region).getByRole('slider', { name: 'Seek' });
    fireEvent.change(scrubber, { target: { value: '42' } });
    expect(audio.currentTime).toBe(42);

    fireEvent.change(within(region).getByLabelText('Playback speed'), { target: { value: '1.5' } });
    expect(audio.playbackRate).toBe(1.5);
    expect(localStorage.getItem('trr.playbackRate')).toBe('1.5');
  });

  it('starts from a transcript passage and highlights the current segment', () => {
    installMediaMocks();
    const audio = renderPlayer();
    const transcript = screen.getByRole('region', { name: 'Transcript' });
    fireEvent.click(within(transcript).getByRole('button', { name: /Listen from “Worth watching”/ }));
    expect(audio.currentTime).toBe(60);
    act(() => {
      audio.dispatchEvent(new Event('timeupdate'));
    });
    const active = transcript.querySelector('[aria-current="true"]');
    expect(active).toHaveTextContent('Worth watching');
  });

  it('shows a persistent mini player that expands', () => {
    installMediaMocks();
    renderPlayer();
    fireEvent.click(screen.getByRole('button', { name: 'Play the Morning Edition' }));
    const bar = screen.getByRole('region', { name: 'Audio player' });
    const expand = within(bar).getByRole('button', { name: 'Expand player' });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(expand);
    expect(within(bar).getByRole('button', { name: 'Collapse player' })).toHaveAttribute('aria-expanded', 'true');
    expect(within(bar).getByRole('link', { name: /Download MP3/ })).toHaveAttribute('href', `/TheRepoReport/data/editions/${MORNING}/audio.mp3`);
  });
});

describe('audio unavailable', () => {
  afterEach(removeSpeechMocks);

  it('explains the missing audio and offers labeled browser speech', () => {
    const { synth, spoken } = installSpeechMocks();
    const report = fixtureReport(EVENING_FALLBACK);
    renderPlayer(report, `data/editions/${EVENING_FALLBACK}/report.json`);
    expect(screen.getByText('Downloadable audio unavailable for this edition')).toBeInTheDocument();
    expect(screen.getByText(/Reason: The speech engine failed/)).toBeInTheDocument();
    expect(screen.getByText(/Fallback: your browser can read the transcript aloud/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Download MP3/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Read aloud with browser voice' }));
    expect(synth.speak).toHaveBeenCalled();
    expect(spoken[0]!.text).toContain('Good evening');
    expect(screen.getByRole('region', { name: 'Audio player' })).toHaveTextContent('Reading aloud with your browser voice (fallback)');

    fireEvent.click(screen.getAllByRole('button', { name: /Stop reading/ })[0]!);
    expect(synth.cancel).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Read aloud with browser voice' })).toBeInTheDocument();
  });

  it('says so when the browser cannot speak', () => {
    const report = fixtureReport(EVENING_FALLBACK);
    renderPlayer(report, `data/editions/${EVENING_FALLBACK}/report.json`);
    expect(screen.getByText('This browser cannot read aloud. The full transcript is below.')).toBeInTheDocument();
  });
});

describe('player helpers', () => {
  it('finds the chapter for a time', () => {
    const chapters = morning.audio.chapters;
    expect(chapterIndexAt(chapters, 0)).toBe(0);
    expect(chapterIndexAt(chapters, 12.5)).toBe(1);
    expect(chapterIndexAt(chapters, 74)).toBe(chapters.length - 1);
  });

  it('splits long text into sentence chunks', () => {
    const text = 'One sentence here. '.repeat(30);
    const chunks = speechChunks(text, 100);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
    expect(chunks.join(' ')).toBe(text.trim());
  });
});
