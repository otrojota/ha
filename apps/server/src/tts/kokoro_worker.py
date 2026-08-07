#!/usr/bin/env python3
import argparse
import base64
import contextlib
import json
import sys
import traceback


SAMPLE_RATE = 24000
SPANISH_VOICES = (
    "ef_dora",
    "em_alex",
    "em_santa",
    "ef_dora,em_alex",
    "ef_dora,em_santa",
    "em_alex,em_santa",
)


def send(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def select_device(requested, torch):
    if requested != "auto":
        return requested
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def to_pcm16(audio, numpy):
    samples = audio.squeeze().detach().float().cpu().numpy()
    samples = numpy.nan_to_num(samples, nan=0.0, posinf=1.0, neginf=-1.0)
    samples = numpy.clip(samples, -1.0, 1.0)
    return (samples * 32767.0).astype("<i2", copy=False).tobytes()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()
    pipeline = None
    device = None
    torch = None
    numpy = None

    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("type") == "initialize":
                with contextlib.redirect_stdout(sys.stderr):
                    import numpy as np
                    import torch as torch_module
                    from kokoro import KPipeline
                    torch = torch_module
                    numpy = np
                    device = select_device(args.device, torch)
                    pipeline = KPipeline(lang_code="e", repo_id="hexgrad/Kokoro-82M", device=device)
                    for voice in SPANISH_VOICES:
                        pipeline.load_voice(voice)
                    # Calienta los kernels y buffers antes de aceptar conexiones.
                    for _result in pipeline("Sistema listo.", voice=SPANISH_VOICES[0], speed=1.0, split_pattern=None):
                        pass
                send({"id": request_id, "type": "ready", "device": device, "sampleRate": SAMPLE_RATE})
                continue
            if request.get("type") != "synthesize" or pipeline is None:
                raise RuntimeError("Kokoro todavía no está inicializado")
            chunks = []
            with contextlib.redirect_stdout(sys.stderr):
                for result in pipeline(request.get("text", ""), voice=request.get("voice", "ef_dora"), speed=1.0, split_pattern=None):
                    if result.audio is not None:
                        chunks.append(to_pcm16(result.audio, numpy))
            if not chunks:
                raise RuntimeError("Kokoro no produjo audio")
            send({"id": request_id, "type": "audio", "audio": base64.b64encode(b"".join(chunks)).decode("ascii")})
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            send({"id": request.get("id") if request else None, "type": "error", "message": str(error)})


if __name__ == "__main__":
    main()
