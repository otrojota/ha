#!/usr/bin/env python3
import argparse
from collections import deque
import json
import math
import signal
import sys
import time

import numpy as np
from openwakeword.model import Model


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--melspectrogram", required=True)
parser.add_argument("--embedding", required=True)
parser.add_argument("--wake-word", required=True)
parser.add_argument("--threshold", type=float, default=0.8)
parser.add_argument("--patience", type=int, default=2)
parser.add_argument("--cooldown-ms", type=int, default=2000)
parser.add_argument("--minimum-audio-db", type=float, default=-55)
parser.add_argument("--audio-activity-window-ms", type=int, default=1000)
args = parser.parse_args()

detector = Model(
    wakeword_models=[args.model],
    inference_framework="onnx",
    melspec_model_path=args.melspectrogram,
    embedding_model_path=args.embedding,
)
model_name = next(iter(detector.models))


def reset_detector(_signal_number, _frame):
    global consecutive
    detector.reset()
    consecutive = 0
    recent_levels.clear()
    emit({"type": "reset"})


signal.signal(signal.SIGUSR1, reset_detector)
emit({"type": "ready", "wakeWord": args.wake_word, "model": model_name})

pending = bytearray()
consecutive = 0
last_detection = 0.0
recent_levels = deque()
try:
    while True:
        chunk = sys.stdin.buffer.read1(4096)
        if not chunk:
            break
        pending.extend(chunk)
        frame_bytes = 1280 * 2
        while len(pending) >= frame_bytes:
            frame = bytes(pending[:frame_bytes])
            del pending[:frame_bytes]
            audio = np.frombuffer(frame, dtype="<i2")
            score = float(detector.predict(audio).get(model_name, 0.0))
            rms = float(np.sqrt(np.mean(np.square(audio.astype(np.float64)))) / 32768)
            audio_db = max(-120.0, 20 * math.log10(rms)) if rms > 0 else -120.0
            now = time.monotonic()
            recent_levels.append((now, audio_db))
            activity_cutoff = now - max(0, args.audio_activity_window_ms) / 1000
            while recent_levels and recent_levels[0][0] < activity_cutoff:
                recent_levels.popleft()
            recent_audio_db = max(level for _, level in recent_levels)
            eligible = score >= args.threshold and recent_audio_db >= args.minimum_audio_db
            consecutive = consecutive + 1 if eligible else 0
            if consecutive >= max(1, args.patience) and (now - last_detection) * 1000 >= args.cooldown_ms:
                last_detection = now
                consecutive = 0
                emit({
                    "type": "detected",
                    "wakeWord": args.wake_word,
                    "text": args.wake_word,
                    "score": score,
                    "audioDb": recent_audio_db,
                    "model": model_name,
                })
                # The JS process stops feeding audio while the voice session is active.
                # Do not let activity from this activation qualify a later detection.
                recent_levels.clear()
except KeyboardInterrupt:
    pass
