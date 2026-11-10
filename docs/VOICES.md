# Voices

TheRepoReport narrates each edition with [Piper](https://github.com/OHF-Voice/piper1-gpl), an offline
neural text-to-speech engine, then FFmpeg joins, normalizes and encodes the result
(`pipeline/audio`).

## Default voice: `en_US-lessac-medium`

| | |
|---|---|
| Language | U.S. English, single speaker |
| Quality tier | medium (22,050 Hz output) |
| Model size | about 63 MB (`.onnx`) plus a 6 KB config (`.onnx.json`) |
| Configured in | `config/editorial.json` → `voice` |

### Where voices come from

Voices are published in the Hugging Face repository
[`rhasspy/piper-voices`](https://huggingface.co/rhasspy/piper-voices). The pipeline downloads them with
Piper's own tool and never commits them to git:

```sh
pip install piper-tts
python3 -m piper.download_voices en_US-lessac-medium --data-dir .work/voices
```

`narrate()` looks for `<PIPER_VOICES_DIR>/<voice>.onnx` and `<voice>.onnx.json`
(`PIPER_VOICES_DIR` defaults to `./.work/voices`, which is git-ignored). If the files are missing it
returns `available: false` with the download command in `unavailableReason`; the edition is still
published without audio. In Actions, cache `.work/voices` with `actions/cache` so the download
happens once.

An older packaging of the same voice is also attached to the archived
[`rhasspy/piper` v0.0.2 release](https://github.com/rhasspy/piper/releases/tag/v0.0.2)
(`voice-en-us-lessac-medium.tar.gz`, files named `en-us-lessac-medium.*`; rename them to
`en_US-lessac-medium.*`). Piper 1.8.0 loads it. That copy was only used for the local smoke test
because Hugging Face was not reachable from the build sandbox. Production should use
`download_voices`.

### Licenses

**Engine: GPL-3.0.** `piper1-gpl` is licensed GPL-3.0. TheRepoReport runs it only as a separate
program (`python3 -m piper …` through `child_process.spawn`, with text on stdin and WAV files out). Our
code does not import, link, bundle or redistribute it, so the MIT license of this repository is
unaffected. Keep it that way. Do not add Python helpers to this repo that `import piper`. That is why
the batch mode uses the CLI's `--output-dir` option rather than the Python API.

**Voice: per its model card. Confirm this before the feed is promoted.** The `MODEL_CARD` shipped with the
voice (checked from the v0.0.2 release archive) says:

> Dataset: https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/
> License: https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html
> Training: Trained from scratch.

So the voice is governed by the **Lessac Technologies Blizzard Challenge 2013 data license**, not
by an open-source license. Neither that license page nor the Hugging Face copy of the model card could
be fetched from the build sandbox, so the terms were **not verified here**. This voice is widely
reported to be restricted to non-commercial use. TheRepoReport is free and carries no ads, but a
public podcast feed is distribution, so read the terms. To confirm:

1. Open `https://huggingface.co/rhasspy/piper-voices/blob/main/en/en_US/lessac/medium/MODEL_CARD`
   and check that it still points to the same dataset license.
2. Read the CSTR license page linked above. Check (a) whether it allows non-commercial use,
   (b) whether it allows publicly distributing audio synthesized from a model trained on the
   data, and (c) any attribution it requires.
3. Record the result here. If the terms do not fit, switch `voice` in `config/editorial.json` to one
   of the alternatives below. No code change is needed.

## Alternatives (English)

Each of these is in `rhasspy/piper-voices` and works with `python3 -m piper.download_voices <name>`.
The license notes are what the dataset is generally known to use. Check each model card the same way
before switching.

| Voice | Notes |
|---|---|
| `en_US-ljspeech-high` (or `-medium`) | Trained on the LJ Speech dataset, which is public domain. Likely the least restrictive choice. Female U.S. voice. `high` is slower to synthesize and larger. |
| `en_US-ryan-high` (or `-medium`) | Male U.S. voice, clear newsreader delivery. Check the dataset license on the model card. |
| `en_GB-alan-medium` | Male British voice. Check the dataset license on the model card. |

Multi-speaker voices (for example `en_US-libritts_r-medium`) also work, but they need a speaker id.
`buildPiperCommand` does not pass `-s` yet, so they would always use speaker 0.

## Measured performance (local smoke test)

The test machine was a 2-vCPU sandbox (the Actions runner has 4) with Piper 1.8.0, `en_US-lessac-medium`, and a 9-segment
script of about 3.7 minutes:

| Mode | Piper wall time | Real-time factor | Encode (loudnorm + MP3) | Total `narrate()` |
|---|---:|---:|---:|---:|
| Batch: one Piper process, `--output-dir` (default) | 17.7 s | 0.079 | 5.7 s | 24.5 s |
| One Piper process per segment (`PIPER_BATCH=0`) | 31.8 s | 0.142 | 6.8 s | 40.3 s |

Each Piper process spends about 3 s loading the model, which is why batch mode is the default. The MP3
size is 0.48 MB per minute (64 kbps CBR, mono, 44.1 kHz), so a 10-minute edition is about 4.8 MB.
Chapter start times matched the actual silence boundaries in the MP3 to within about 0.1 s.
