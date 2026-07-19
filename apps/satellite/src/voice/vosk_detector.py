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
parser.add_argument("--exact-min-confidence", type=float, default=0.72)
parser.add_argument("--embedded-min-confidence", type=float, default=0.90)
parser.add_argument("--validate-only", action="store_true")
args = parser.parse_args()

SetLogLevel(0 if args.validate_only else -1)
model = Model(args.model)
if args.validate_only:
    # La gramática restringida se usa sólo para que Vosk informe palabras que
    # no existen en el vocabulario al guardar un nuevo nombre del asistente.
    grammar = json.dumps([args.wake_word.lower(), "[unk]"], ensure_ascii=False)
    KaldiRecognizer(model, 16000, grammar)
    emit({"type": "valid", "wakeWord": args.wake_word})
    raise SystemExit(0)

# En escucha real se usa el vocabulario completo. Restringirlo a la wake word
# hacía que nombres distintos (por ejemplo, "David") fueran forzados hacia la
# única alternativa conocida (por ejemplo, "Amigo") con confianza engañosa.
recognizer = KaldiRecognizer(model, 16000)
recognizer.SetWords(True)
recognizer.SetPartialWords(True)
last_detection = 0.0
emit({"type": "ready", "wakeWord": args.wake_word})


def detect(result):
    global last_detection
    confidence = wake_word_confidence(result, args.wake_word)
    recognized_words = normalize(result.get("text") or result.get("partial") or "").split()
    exact_wake_word = recognized_words == normalize(args.wake_word).split()
    required_confidence = args.exact_min_confidence if exact_wake_word else args.embedded_min_confidence
    now = time.monotonic()
    if confidence < required_confidence or (now - last_detection) * 1000 < args.cooldown_ms:
        return False
    last_detection = now
    emit({
        "type": "detected",
        "text": result.get("text") or result.get("partial") or "",
        "wakeWord": args.wake_word,
        "confidence": confidence,
        "requiredConfidence": required_confidence,
        "exact": exact_wake_word,
    })
    return True


while True:
    audio = sys.stdin.buffer.read(3200)
    if not audio:
        break
    complete = recognizer.AcceptWaveform(audio)
    # Con vocabulario completo los parciales no están forzados hacia una única
    # palabra. Detectarlos permite armar la captura apenas se pronuncia el nombre,
    # sin esperar al silencio que finaliza también el comando completo.
    result = json.loads(recognizer.Result() if complete else recognizer.PartialResult())
    if not complete:
        result["text"] = result.get("partial") or ""
        result["result"] = result.get("partial_result") or []
    if detect(result):
        # La activación consume por completo la hipótesis acústica que contenía
        # la wake word. Mientras el satélite escucha/procesa no se envía audio
        # nuevo a Vosk; sin este reset, al reanudar el detector podía volver a
        # publicar exactamente el mismo parcial y abrir otra sesión de escucha.
        recognizer.Reset()
