#!/usr/bin/env python3
import json
import os
import sys
import time

from piper import PiperVoice


def send(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Uso: piper_worker.py MODELO.onnx")

    model_path = sys.argv[1]
    voice = PiperVoice.load(model_path, use_cuda=False)
    audio = os.fdopen(3, "wb", buffering=0)
    send({"type": "ready", "sampleRate": voice.config.sample_rate, "model": model_path})

    for line in sys.stdin:
        try:
            request = json.loads(line)
            request_id = request["id"]
            text = str(request.get("text", "")).strip()
            if not text:
                raise ValueError("El texto TTS está vacío")

            started = time.monotonic()
            samples = 0
            announced = False
            for chunk in voice.synthesize(text):
                if not announced:
                    send({"type": "audio", "id": request_id})
                    announced = True
                audio.write(chunk.audio_int16_bytes)
                samples += len(chunk.audio_int16_bytes) // (chunk.sample_width * chunk.sample_channels)

            send({
                "type": "done",
                "id": request_id,
                "audioSeconds": samples / voice.config.sample_rate,
                "synthesisSeconds": time.monotonic() - started,
            })
        except Exception as error:
            send({"type": "error", "id": locals().get("request_id"), "message": str(error)})


if __name__ == "__main__":
    main()
