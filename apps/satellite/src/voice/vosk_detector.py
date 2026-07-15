#!/usr/bin/env python3
import argparse
import json
import sys
import time
import unicodedata

from vosk import KaldiRecognizer, Model, SetLogLevel


def normalize(value):
    decomposed = unicodedata.normalize("NFD", value.lower())
    return "".join(character for character in decomposed if unicodedata.category(character) != "Mn")


def wake_word_confidence(result, wake_word):
    text = result.get("text") or ""
    words = normalize(text).split()
    target = normalize(wake_word).split()
    details = result.get("result") or []
    for index in range(len(words) - len(target) + 1):
        if words[index:index + len(target)] != target:
            continue
        confidences = [float(item.get("conf", 0.0)) for item in details[index:index + len(target)]]
        return min(confidences) if len(confidences) == len(target) else 0.0
    return 0.0


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True)
parser.add_argument("--wake-word", required=True)
parser.add_argument("--cooldown-ms", type=int, default=2000)
parser.add_argument("--min-confidence", type=float, default=0.82)
parser.add_argument("--validate-only", action="store_true")
args = parser.parse_args()

SetLogLevel(0 if args.validate_only else -1)
model = Model(args.model)
grammar = json.dumps([args.wake_word.lower(), "[unk]"], ensure_ascii=False)
recognizer = KaldiRecognizer(model, 16000, grammar)
recognizer.SetWords(True)
if args.validate_only:
    emit({"type": "valid", "wakeWord": args.wake_word})
    raise SystemExit(0)
last_detection = 0.0
emit({"type": "ready", "wakeWord": args.wake_word})

while True:
    audio = sys.stdin.buffer.read(3200)
    if not audio:
        break
    complete = recognizer.AcceptWaveform(audio)
    # Los parciales con gramática restringida tienden a forzar música o voces de TV
    # hacia la única palabra conocida. Sólo una frase finalizada puede activar.
    if not complete:
        continue
    result = json.loads(recognizer.Result())
    text = result.get("text") or ""
    confidence = wake_word_confidence(result, args.wake_word)
    now = time.monotonic()
    if confidence >= args.min_confidence and (now - last_detection) * 1000 >= args.cooldown_ms:
        last_detection = now
        emit({"type": "detected", "text": text, "wakeWord": args.wake_word, "confidence": confidence})
