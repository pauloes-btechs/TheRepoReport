/** jsdom shims for media and speech APIs used by the player. */
import { vi } from 'vitest';

export function installMediaMocks() {
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, get: () => false });
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, get: () => true });
    this.dispatchEvent(new Event('pause'));
  });
  return { play, pause };
}

export function installSpeechMocks() {
  const spoken: { text: string; onstart?: () => void; onend?: () => void }[] = [];
  class Utterance {
    text: string;
    lang = '';
    rate = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }
  const synth = {
    speak: vi.fn((u: Utterance) => spoken.push(u as never)),
    cancel: vi.fn(),
  };
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
  return { synth, spoken };
}

export function removeSpeechMocks() {
  vi.unstubAllGlobals();
  // @ts-expect-error -- test cleanup of a jsdom shim
  delete window.speechSynthesis;
}
