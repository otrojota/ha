#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from openwakeword.utils import AudioFeatures
from scipy.io import wavfile
from scipy.signal import resample_poly

SAMPLE_RATE = 16_000
FEATURE_MODEL_URLS = {
    "melspectrogram.onnx": "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
    "embedding_model.onnx": "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
}


def ensure_download(url, target):
    if target.exists() and target.stat().st_size > 0:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    print(f"Descargando {target.name}…", file=sys.stderr, flush=True)
    urllib.request.urlretrieve(url, temporary)
    temporary.replace(target)


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--threshold", type=float, default=0.995)
    return parser.parse_args()


def read_audio(path):
    rate, audio = wavfile.read(path)
    values = np.asarray(audio)
    if values.ndim > 1:
        values = values.astype(np.float32).mean(axis=1)
    if np.issubdtype(values.dtype, np.floating):
        values = np.clip(values, -1, 1) * 32767
    else:
        values = values.astype(np.float32)
    if rate != SAMPLE_RATE:
        from math import gcd
        divisor = gcd(int(rate), SAMPLE_RATE)
        values = resample_poly(values, SAMPLE_RATE // divisor, int(rate) // divisor)
    return np.clip(values, -32768, 32767).astype(np.int16)


def clips(audio, length):
    if len(audio) <= length:
        maximum_start = length - len(audio)
        starts = list(range(0, maximum_start + 1, 1280))
        if starts[-1] != maximum_start:
            starts.append(maximum_start)
        windows = []
        for start in starts:
            padded = np.zeros(length, dtype=np.int16)
            padded[start:start + len(audio)] = audio
            windows.append(padded)
        return np.stack(windows)
    step = SAMPLE_RATE // 4
    starts = list(range(0, len(audio) - length + 1, step))
    if starts[-1] != len(audio) - length:
        starts.append(len(audio) - length)
    return np.stack([audio[start:start + length] for start in starts])


def main():
    args = arguments()
    runtime = Path(os.environ["WAKE_WORD_TRAINER_RUNTIME_PATH"])
    for name, url in FEATURE_MODEL_URLS.items():
        ensure_download(url, runtime / "features" / name)
    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    input_shape = session.get_inputs()[0].shape
    frame_count = int(input_shape[1])
    # Cada embedding avanza 80 ms; 21 frames corresponden al clip de 2,4 s
    # usado por el entrenador. La fórmula conserva compatibilidad si cambia.
    clip_samples = int((76 + 8 * (frame_count - 1) + 3) * 160)
    audio = read_audio(args.audio)
    windows = clips(audio, clip_samples)
    ncpu = max(1, min(4, (os.cpu_count() or 2) // 2))
    extractor = AudioFeatures(
        inference_framework="onnx",
        melspec_model_path=str(runtime / "features" / "melspectrogram.onnx"),
        embedding_model_path=str(runtime / "features" / "embedding_model.onnx"),
        ncpu=ncpu,
    )
    features = extractor.embed_clips(windows, batch_size=32, ncpu=ncpu).astype(np.float32)
    scores = session.run(None, {session.get_inputs()[0].name: features})[0].reshape(-1)
    maximum_index = int(np.argmax(scores))
    result = {
        "score": float(scores[maximum_index]),
        "threshold": float(args.threshold),
        "activated": bool(scores[maximum_index] >= args.threshold),
        "durationSeconds": float(len(audio) / SAMPLE_RATE),
        "windowsEvaluated": int(len(scores)),
        "peakWindow": maximum_index,
    }
    print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
