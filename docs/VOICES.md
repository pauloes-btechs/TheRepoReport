# Voices

TheRepoReport narrates each edition with [Piper](https://github.com/OHF-Voice/piper1-gpl), an offline
neural text-to-speech engine, then FFmpeg joins, normalizes and encodes the result
(`pipeline/audio`).

## Default voices: Kokoro George and Heart, alternating by edition

Editions are narrated by [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), an open speech model with Apache-2.0 weights, run through [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) (MIT). It replaced Piper as the default on 2026-11-10 because Piper's narration sounded choppy.

| | |
|---|---|
| Configured in | `config/editorial.json` → `voice: "kokoro:bm_george\|af_heart"`. Each edition is read by one of them, rotating slot by slot so consecutive editions change voice (`voiceForEdition` in `shared/edition.ts`). Use `kokoro:bm_george` or `kokoro:af_heart` for a single narrator. |
| Other voices | `kokoro:am_michael` (US male), `kokoro:af_bella`, `kokoro:am_adam`, and others in `voices-v1.0.bin`. Chosen by listening tests: George (British male) and Heart (US female) sounded best. |
| Blends | `kokoro:am_michael:60,af_heart:40` mixes two voices by weight into one narrator |
| Model | `kokoro-v1.0.fp16.onnx` (177 MB) + `voices-v1.0.bin` (28 MB), downloaded from the kokoro-onnx GitHub release and cached by Actions |
| Speed | 0.40–0.47 s of compute per second of audio on 2 vCPUs (fp16). The int8 model was 3× slower on these CPUs, so it isn't used. |
| Helper | `scripts/kokoro_tts.py`, run as a separate program with one process for all segments |

**Fallback:** if Kokoro is missing or fails, `narrate()` uses Piper with `en_US-ljspeech-high` (public domain) so the edition still has audio. The report records the voice actually used, and the site shows it.

## Piper voices

Set `voice` to a plain Piper name (no `kokoro:` prefix) to narrate with Piper directly. The default Piper voice is `en_US-ljspeech-high`, trained on [LJ Speech](https://keithito.com/LJ-Speech-Dataset/), which is public domain. `lessac` voices are avoided: the Blizzard 2013 Lessac data is under a *noncommercial* license
(<https://www.cstr.inf.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013_software/license.html>).

### Where voices come from

Voices are published in the Hugging Face repository
[`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices). The pipeline downloads them with
Piper's own tool and never commits them to git:

```sh
pip install piper-tts
python3 -m piper.download_voices en_US-ljspeech-high --data-dir .work/voices
```

`narrate()` looks for `<PIPER_VOICES_DIR>/<voice>.onnx` and `<voice>.onnx.json`
(`PIPER_VOICES_DIR` defaults to `./.work/voices`, which is git-ignored). If the files are missing it
returns `available: false` with the download command in `unavailableReason`; the edition is still
published without audio. In Actions, `.work/voices` is cached with `actions/cache` so the download
happens once.

### Licenses

**Engine: GPL-3.0.** `piper1-gpl` is licensed GPL-3.0. TheRepoReport runs it only as a separate
program (`python3 -m piper …` through `child_process.spawn`, with text on stdin and WAV files out). Our
code does not import, link, bundle or redistribute it, so the MIT license of this repository is
unaffected. Keep it that way: do not add Python helpers to this repo that `import piper`. That is why
the batch mode uses the CLI's `--output-dir` option rather than the Python API.

**Voice:** check the `MODEL_CARD` next to the voice in `rhasspy/piper-voices` whenever you change
voices. Avoid voices trained on, or fine-tuned from, lessac.

## Alternatives (English)

Each of these is in `rhasspy/piper-voices` and works with `python3 -m piper.download_voices <name>`.
The license notes are what the dataset is generally known to use. Check each model card the same way
before switching.

| Voice | Notes |
|---|---|
| `en_US-ljspeech-medium` | Same public-domain dataset, smaller and faster than `high`. |
| `en_US-ryan-high` (or `-medium`) | Male U.S. voice, clear newsreader delivery. Check the dataset license on the model card. |
| `en_GB-alan-medium` | Male British voice. Check the dataset license on the model card. |

Multi-speaker voices (for example `en_US-libritts_r-medium`) also work, but they need a speaker id.
`buildPiperCommand` does not pass `-s` yet, so they would always use speaker 0.

## Measured performance (local smoke test)

The test machine was a 2-vCPU sandbox (the Actions runner has 4) with Piper 1.8.0, the `lessac-medium` voice (the only one reachable from the sandbox; the `high` default is somewhat slower), and a 9-segment
script of about 3.7 minutes:

| Mode | Piper wall time | Real-time factor | Encode (loudnorm + MP3) | Total `narrate()` |
|---|---:|---:|---:|---:|
| Batch: one Piper process, `--output-dir` (default) | 17.7 s | 0.079 | 5.7 s | 24.5 s |
| One Piper process per segment (`PIPER_BATCH=0`) | 31.8 s | 0.142 | 6.8 s | 40.3 s |

Each Piper process spends about 3 s loading the model, which is why batch mode is the default. The MP3
size is 0.48 MB per minute (64 kbps CBR, mono, 44.1 kHz), so a 10-minute edition is about 4.8 MB.
Chapter start times matched the actual silence boundaries in the MP3 to within about 0.1 s.
