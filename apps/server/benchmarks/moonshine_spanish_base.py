#!/usr/bin/env python3
"""Benchmark aislado de Moonshine Spanish Base; no inicia el servidor HA."""

from __future__ import annotations

import argparse
import json
import platform
import re
import statistics
import time
import unicodedata
from pathlib import Path

import psutil
from moonshine_voice import ModelArch, Transcriber, load_wav_file
from moonshine_voice.transcriber import TranscriptEventListener


EXPECTED_TEXT = {
    "monica_wake_command.wav": "pantallita que hora es",
    "monica_wake_command_noise.wav": "pantallita que hora es",
    "paulina_wake_command.wav": "pantallita toca musica de los jaivas",
    "monica_negative.wav": "gracias por la informacion",
    "paulina_interrupt_words.wav": "pantallita no pongas stop alto y detente son parte del titulo",
    "eddy_wake_command.wav": "pantallita sube el volumen al cincuenta por ciento",
    "flo_wake_command.wav": "pantallita busca noticias de valparaiso",
    "grandma_wake_only.wav": "pantallita",
}


def normalize(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text.lower())
    without_marks = "".join(char for char in decomposed if unicodedata.category(char) != "Mn")
    return " ".join(re.findall(r"[a-z0-9]+", without_marks))


def contains_wake(text: str) -> bool:
    return "pantallita" in normalize(text).split()


def transcript_text(transcript) -> str:
    return " ".join(line.text.strip() for line in transcript.lines if line.text.strip()).strip()


def edit_distance(left: list[str], right: list[str]) -> int:
    row = list(range(len(right) + 1))
    for left_index, left_item in enumerate(left, 1):
        next_row = [left_index]
        for right_index, right_item in enumerate(right, 1):
            next_row.append(min(
                next_row[-1] + 1,
                row[right_index] + 1,
                row[right_index - 1] + (left_item != right_item),
            ))
        row = next_row
    return row[-1]


def word_error_rate(expected: str, actual: str) -> float:
    expected_words = normalize(expected).split()
    actual_words = normalize(actual).split()
    return edit_distance(expected_words, actual_words) / max(1, len(expected_words))


class StreamingEvents(TranscriptEventListener):
    def __init__(self):
        self.started_at = 0.0
        self.events: list[dict] = []

    def reset(self):
        self.started_at = time.perf_counter()
        self.events = []

    def _append(self, kind: str, event):
        text = event.line.text.strip()
        if not text:
            return
        self.events.append({
            "kind": kind,
            "wallMs": round((time.perf_counter() - self.started_at) * 1000, 1),
            "text": text,
            "inferenceMs": event.line.last_transcription_latency_ms,
            "complete": event.line.is_complete,
        })

    def on_line_started(self, event):
        self._append("started", event)

    def on_line_text_changed(self, event):
        self._append("text_changed", event)

    def on_line_completed(self, event):
        self._append("completed", event)

    def on_error(self, event):
        self.events.append({"kind": "error", "wallMs": 0, "text": str(event)})


def measure_offline(transcriber, audio, sample_rate: int, iterations: int) -> dict:
    process = psutil.Process()
    runs = []
    texts = []
    for _ in range(iterations):
        cpu_before = sum(process.cpu_times()[:2])
        started = time.perf_counter()
        transcript = transcriber.transcribe_without_streaming(audio, sample_rate)
        elapsed = time.perf_counter() - started
        cpu_after = sum(process.cpu_times()[:2])
        runs.append({"wallMs": round(elapsed * 1000, 1), "cpuMs": round((cpu_after - cpu_before) * 1000, 1)})
        texts.append(transcript_text(transcript))
    return {
        "text": texts[-1],
        "runs": runs,
        "medianWallMs": round(statistics.median(run["wallMs"] for run in runs), 1),
    }


def measure_streaming(transcriber, listener: StreamingEvents, audio, sample_rate: int, chunk_ms: int) -> dict:
    listener.reset()
    transcriber.start()
    chunk_size = max(1, int(sample_rate * chunk_ms / 1000))
    for offset in range(0, len(audio), chunk_size):
        chunk = audio[offset:offset + chunk_size]
        transcriber.add_audio(chunk, sample_rate)
        time.sleep(len(chunk) / sample_rate)
    transcriber.stop()
    final = transcriber.update_transcription()
    text = transcript_text(final)
    first_wake = next((event for event in listener.events if contains_wake(event.get("text", ""))), None)
    return {
        "text": text,
        "wakeRecognized": first_wake is not None,
        "firstWakeEventMs": first_wake["wallMs"] if first_wake else None,
        "events": listener.events,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=3)
    parser.add_argument("--chunk-ms", type=int, default=100)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    process = psutil.Process()
    rss_before = process.memory_info().rss
    load_started = time.perf_counter()
    transcriber = Transcriber(
        model_path=args.model_path,
        model_arch=ModelArch.BASE,
        update_interval=0.5,
        options={"vad_threshold": 0.0},
    )
    load_ms = (time.perf_counter() - load_started) * 1000
    rss_loaded = process.memory_info().rss
    listener = StreamingEvents()
    transcriber.add_listener(listener)

    results = []
    try:
        for name, expected in EXPECTED_TEXT.items():
            path = args.samples / name
            if not path.is_file():
                continue
            audio, sample_rate = load_wav_file(path)
            duration = len(audio) / sample_rate
            offline = measure_offline(transcriber, audio, sample_rate, args.iterations)
            result = {
                "file": name,
                "durationMs": round(duration * 1000, 1),
                "expected": expected,
                "offline": offline,
                "wordErrorRate": round(word_error_rate(expected, offline["text"]), 3),
                "wakeRecognized": contains_wake(offline["text"]),
                "realTimeFactor": round((offline["medianWallMs"] / 1000) / duration, 3),
            }
            if contains_wake(expected):
                result["streaming"] = measure_streaming(transcriber, listener, audio, sample_rate, args.chunk_ms)
            results.append(result)
    finally:
        transcriber.close()

    wake_results = [item for item in results if contains_wake(item["expected"])]
    streaming_wake_results = [item for item in wake_results if item["streaming"]["wakeRecognized"]]
    timely_streaming_wake_results = [
        item
        for item in streaming_wake_results
        if item["streaming"]["firstWakeEventMs"] <= 1500
    ]

    report = {
        "environment": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
            "logicalCpus": psutil.cpu_count(),
        },
        "model": {
            "path": str(args.model_path),
            "architecture": "Spanish Base",
            "loadMs": round(load_ms, 1),
            "rssBeforeMiB": round(rss_before / 1024 / 1024, 1),
            "rssLoadedMiB": round(rss_loaded / 1024 / 1024, 1),
            "rssIncreaseMiB": round((rss_loaded - rss_before) / 1024 / 1024, 1),
        },
        "samples": results,
        "summary": {
            "samples": len(results),
            "wakeSamples": len(wake_results),
            "wakeRecognized": sum(item["wakeRecognized"] for item in wake_results),
            "wakeRecognitionRate": round(
                sum(item["wakeRecognized"] for item in wake_results) / len(wake_results), 3
            ) if wake_results else None,
            "streamingWakeRecognized": len(streaming_wake_results),
            "streamingWakeRecognitionRate": round(
                len(streaming_wake_results) / len(wake_results), 3
            ) if wake_results else None,
            "streamingWakeWithin1500Ms": len(timely_streaming_wake_results),
            "streamingWakeWithin1500MsRate": round(
                len(timely_streaming_wake_results) / len(wake_results), 3
            ) if wake_results else None,
            "meanWordErrorRate": round(statistics.mean(item["wordErrorRate"] for item in results), 3) if results else None,
            "medianInferenceMs": round(statistics.median(item["offline"]["medianWallMs"] for item in results), 1) if results else None,
            "rssFinalMiB": round(process.memory_info().rss / 1024 / 1024, 1),
        },
    }
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
