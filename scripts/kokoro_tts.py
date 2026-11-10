"""Synthesize narration segments with Kokoro (82M, Apache-2.0) via kokoro-onnx.

Reads a JSON array of strings on stdin and writes one 16-bit WAV per string to
--out-dir as 000.wav, 001.wav, ... in order. Prints one JSON line per segment
with its duration so the caller can log progress.

Run as a separate program from pipeline/audio (no Python is imported by the
Node pipeline).
"""

import argparse
import json
import os
import sys
import time


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="path to kokoro-v1.0*.onnx")
    parser.add_argument("--voices", required=True, help="path to voices-v1.0.bin")
    parser.add_argument(
        "--voice",
        required=True,
        help='voice id (am_michael), a blend (am_michael:60,af_heart:40), or co-anchors separated by "|" '
        "(bm_george|af_heart) that take turns segment by segment",
    )
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--lang", default="en-us")
    parser.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()

    for path in (args.model, args.voices):
        if not os.path.isfile(path):
            print(f"kokoro: file not found: {path}", file=sys.stderr)
            return 3

    try:
        import numpy as np
        import onnxruntime as ort
        import soundfile as sf
        from kokoro_onnx import Kokoro
    except ImportError as exc:  # engine not installed
        print(f"kokoro: missing Python package ({exc.name}); pip install kokoro-onnx soundfile", file=sys.stderr)
        return 4

    texts = json.load(sys.stdin)
    if not isinstance(texts, list) or not all(isinstance(t, str) and t.strip() for t in texts):
        print("kokoro: stdin must be a JSON array of non-empty strings", file=sys.stderr)
        return 2

    options = ort.SessionOptions()
    # onnxruntime otherwise picks physical cores; hosted runners expose vCPUs.
    options.intra_op_num_threads = os.cpu_count() or 1
    session = ort.InferenceSession(args.model, options, providers=["CPUExecutionProvider"])
    kokoro = Kokoro.from_session(session, args.voices)

    def style(spec):
        if ":" not in spec and "," not in spec:
            return spec
        # Weighted blend: "am_michael:60,af_heart:40".
        parts = [p.split(":") for p in spec.split(",")]
        weights = np.array([float(w) for _, w in parts], dtype=np.float32)
        weights = weights / weights.sum()
        return sum(kokoro.get_voice_style(name) * w for (name, _), w in zip(parts, weights))

    # Co-anchors: segment i is read by voice i mod n.
    voices = [style(v.strip()) for v in args.voice.split("|") if v.strip()]

    os.makedirs(args.out_dir, exist_ok=True)
    for index, text in enumerate(texts):
        started = time.time()
        samples, rate = kokoro.create(text, voice=voices[index % len(voices)], speed=args.speed, lang=args.lang)
        path = os.path.join(args.out_dir, f"{index:03d}.wav")
        sf.write(path, samples, rate, subtype="PCM_16")
        print(json.dumps({"segment": index, "seconds": round(len(samples) / rate, 2), "wall": round(time.time() - started, 2)}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
