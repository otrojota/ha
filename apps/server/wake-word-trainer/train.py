#!/usr/bin/env python3
import argparse
import json
import math
import os
import random
import subprocess
import sys
import urllib.request
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper
from openwakeword.utils import AudioFeatures
from piper import PiperVoice, SynthesisConfig
from scipy.io import wavfile
from scipy.signal import resample_poly
from sklearn.metrics import precision_recall_fscore_support, roc_auc_score
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

SAMPLE_RATE = 16_000
DEFAULT_CLIP_SECONDS = 2.4
FEATURE_MODEL_URLS = {
    "melspectrogram.onnx": "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/melspectrogram.onnx",
    "embedding_model.onnx": "https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/embedding_model.onnx",
}
DEFAULT_VOICES = [
    "es_AR-daniela-high",
    "es_ES-carlfm-x_low",
    "es_ES-davefx-medium",
    "es_ES-mls_10246-low",
    "es_ES-mls_9972-low",
    "es_ES-sharvard-medium",
    "es_MX-ald-medium",
    "es_MX-claude-high",
]
NEGATIVE_PHRASES = [
    "pon música", "sube el volumen", "baja el volumen", "qué hora es",
    "cómo está el tiempo", "enciende la luz", "apaga la luz", "buenos días",
    "buenas noches", "muchas gracias", "qué quieres comer", "vamos a salir",
    "abre la puerta", "cierra la ventana", "siguiente canción", "pausa la música",
    "reproduce la radio", "dime las noticias", "programa una alarma", "avísame mañana",
    "no te escucho", "ven un momento", "mira esto", "qué estás haciendo",
    "habla más fuerte", "está sonando el teléfono", "la televisión está encendida",
    "terminamos por hoy", "puedes ayudarme", "cuánto falta", "dónde están las llaves",
    "tengo una pregunta", "necesito recordar algo", "espera un minuto",
    "no pasa nada", "todo está bien", "qué canción es", "cambia de emisora",
    "prende el parlante", "detén la reproducción", "cuál es la temperatura",
    "abre las cortinas", "cierra las cortinas", "limpia la casa", "vuelve a intentarlo",
    "hay alguien ahí", "qué día es hoy", "recuérdame comprar pan",
]


def log(message):
    print(message, flush=True)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--wake-word", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--config-json", default="{}")
    return parser.parse_args()


def merged_config(raw):
    supplied = json.loads(raw or "{}")
    quick = bool(supplied.get("quick", False))
    defaults = {
        "seed": 20260728,
        "voices": DEFAULT_VOICES,
        "positiveBasePerVoice": 3 if quick else 12,
        "positiveAugmentations": 2 if quick else 7,
        "negativeAugmentations": 1 if quick else 3,
        "negativePhraseCount": 8 if quick else len(NEGATIVE_PHRASES),
        "noiseExamples": 10 if quick else 120,
        "validationFraction": 0.2,
        "clipSeconds": DEFAULT_CLIP_SECONDS,
        "hiddenUnits": 24 if quick else 48,
        "maxIterations": 25 if quick else 180,
        "useSyntheticVoices": False,
    }
    defaults.update({key: value for key, value in supplied.items() if value is not None})
    return defaults


def ensure_download(url, target):
    if target.exists() and target.stat().st_size > 0:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    log(f"Descargando {target.name}…")
    urllib.request.urlretrieve(url, temporary)
    temporary.replace(target)


def ensure_resources(runtime, voices):
    feature_dir = runtime / "features"
    for name, url in FEATURE_MODEL_URLS.items():
        ensure_download(url, feature_dir / name)
    voice_dir = runtime / "voices"
    voice_dir.mkdir(parents=True, exist_ok=True)
    missing = [voice for voice in voices if not (voice_dir / f"{voice}.onnx").exists()]
    if missing:
        log(f"Descargando {len(missing)} voces Piper españolas…")
        subprocess.run(
            [sys.executable, "-m", "piper.download_voices", "--data-dir", str(voice_dir), *missing],
            check=True,
        )
    return feature_dir, voice_dir


def to_mono_int16(rate, audio):
    array = np.asarray(audio)
    if array.ndim > 1:
        array = array.astype(np.float32).mean(axis=1)
    if np.issubdtype(array.dtype, np.floating):
        array = np.clip(array, -1, 1) * 32767
    elif array.dtype != np.int16:
        peak = max(1.0, float(np.max(np.abs(array))))
        array = array.astype(np.float32) / peak * 32767
    array = array.astype(np.int16)
    if rate != SAMPLE_RATE:
        divisor = math.gcd(int(rate), SAMPLE_RATE)
        array = resample_poly(array.astype(np.float32), SAMPLE_RATE // divisor, int(rate) // divisor)
        array = np.clip(array, -32768, 32767).astype(np.int16)
    return array


def read_audio(path):
    rate, audio = wavfile.read(path)
    return to_mono_int16(rate, audio)


def synthesize(voice, text, rng):
    config = SynthesisConfig(
        length_scale=float(rng.uniform(0.78, 1.24)),
        noise_scale=float(rng.uniform(0.55, 1.05)),
        noise_w_scale=float(rng.uniform(0.55, 1.05)),
        volume=float(rng.uniform(0.82, 1.0)),
        normalize_audio=True,
    )
    chunks = list(voice.synthesize(text, syn_config=config))
    if not chunks:
        raise RuntimeError(f"Piper no generó audio para: {text}")
    raw = b"".join(chunk.audio_int16_bytes for chunk in chunks)
    audio = np.frombuffer(raw, dtype=np.int16)
    return to_mono_int16(chunks[0].sample_rate, audio)


def fit_clip(audio, length, rng, background=None, training=True):
    values = audio.astype(np.float32)
    if training:
        speed = float(rng.uniform(0.90, 1.11))
        target = max(1, int(len(values) / speed))
        values = np.interp(
            np.linspace(0, len(values) - 1, target),
            np.arange(len(values)),
            values,
        )
        if rng.random() < 0.45:
            decay = float(rng.uniform(0.12, 0.4))
            impulse = np.zeros(int(SAMPLE_RATE * 0.18), dtype=np.float32)
            impulse[0] = 1
            for delay in (0.025, 0.05, 0.09, 0.14):
                index = min(len(impulse) - 1, int(delay * SAMPLE_RATE))
                impulse[index] = decay * float(rng.uniform(0.35, 0.9))
            values = np.convolve(values, impulse, mode="full")[: len(values)]
    if len(values) > length:
        values = values[:length]
    result = np.zeros(length, dtype=np.float32)
    maximum_start = max(0, length - len(values))
    start = int(rng.integers(0, maximum_start + 1)) if training else maximum_start // 2
    result[start:start + len(values)] = values
    gain = float(rng.uniform(0.45, 1.0)) if training else 0.85
    result *= gain
    if training:
        signal_rms = max(30.0, float(np.sqrt(np.mean(result * result))))
        snr_db = float(rng.uniform(5, 28))
        noise_rms = signal_rms / (10 ** (snr_db / 20))
        result += rng.normal(0, noise_rms, length)
        if background is not None and len(background):
            bg = fit_clip(background, length, rng, training=False).astype(np.float32)
            bg_rms = max(1.0, float(np.sqrt(np.mean(bg * bg))))
            result += bg / bg_rms * noise_rms * float(rng.uniform(0.4, 1.2))
    return np.clip(result, -32768, 32767).astype(np.int16)


def split_base(samples, fraction, rng):
    indexes = np.arange(len(samples))
    rng.shuffle(indexes)
    count = max(1, int(len(samples) * fraction))
    validation = [samples[index] for index in indexes[:count]]
    training = [samples[index] for index in indexes[count:]]
    return training or validation, validation


def augmented(samples, copies, length, rng, backgrounds, training=True):
    output = []
    for sample in samples:
        rounds = copies if training else 1
        for _ in range(rounds):
            background = backgrounds[int(rng.integers(0, len(backgrounds)))] if backgrounds else None
            output.append(fit_clip(sample, length, rng, background, training=training))
    return np.stack(output)


def collect_real_samples(model_dir, kind):
    path = model_dir / "samples" / kind
    if not path.exists():
        return []
    clips = []
    for item in sorted(path.iterdir()):
        if not item.is_file():
            continue
        try:
            clips.append(read_audio(item))
        except Exception as error:
            log(f"Advertencia: se omitió {item.name}: {error}")
    return clips


def generate_bases(wake_word, voices, voice_dir, config, rng):
    positive = []
    negative = []
    negative_phrases = NEGATIVE_PHRASES[: int(config["negativePhraseCount"])]
    log(f"Generando positivos sintéticos con {len(voices)} voces…")
    for voice_index, voice_name in enumerate(voices):
        log(f"Voz {voice_index + 1}/{len(voices)}: {voice_name}")
        voice = PiperVoice.load(voice_dir / f"{voice_name}.onnx", use_cuda=False)
        for _ in range(int(config["positiveBasePerVoice"])):
            positive.append(synthesize(voice, wake_word, rng))
        assigned = negative_phrases[voice_index::len(voices)]
        for phrase in assigned:
            negative.append(synthesize(voice, phrase, rng))
        del voice
    return positive, negative


def extract_features(audio, feature_dir):
    ncpu = max(1, min(4, (os.cpu_count() or 2) // 2))
    extractor = AudioFeatures(
        inference_framework="onnx",
        melspec_model_path=str(feature_dir / "melspectrogram.onnx"),
        embedding_model_path=str(feature_dir / "embedding_model.onnx"),
        ncpu=ncpu,
    )
    return extractor.embed_clips(audio, batch_size=64, ncpu=ncpu).astype(np.float32)


def export_mlp(path, frame_count, feature_size, scaler, classifier):
    first_weights = classifier.coefs_[0].astype(np.float32)
    first_bias = classifier.intercepts_[0].astype(np.float32)
    second_weights = classifier.coefs_[1].astype(np.float32)
    second_bias = classifier.intercepts_[1].astype(np.float32)
    initializers = [
        numpy_helper.from_array(scaler.mean_.astype(np.float32), "scaler_mean"),
        numpy_helper.from_array(scaler.scale_.astype(np.float32), "scaler_scale"),
        numpy_helper.from_array(first_weights, "weight_1"),
        numpy_helper.from_array(first_bias, "bias_1"),
        numpy_helper.from_array(second_weights, "weight_2"),
        numpy_helper.from_array(second_bias, "bias_2"),
    ]
    nodes = [
        helper.make_node("Flatten", ["input"], ["flat"], axis=1),
        helper.make_node("Sub", ["flat", "scaler_mean"], ["centered"]),
        helper.make_node("Div", ["centered", "scaler_scale"], ["scaled"]),
        helper.make_node("Gemm", ["scaled", "weight_1", "bias_1"], ["hidden"]),
        helper.make_node("Relu", ["hidden"], ["activated"]),
        helper.make_node("Gemm", ["activated", "weight_2", "bias_2"], ["logit"]),
        helper.make_node("Sigmoid", ["logit"], ["output"]),
    ]
    graph = helper.make_graph(
        nodes,
        "ha_wake_word",
        [helper.make_tensor_value_info("input", TensorProto.FLOAT, [None, frame_count, feature_size])],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, [None, 1])],
        initializers,
    )
    model = helper.make_model(
        graph,
        producer_name="ha-wake-word-trainer",
        opset_imports=[helper.make_opsetid("", 17)],
    )
    model.ir_version = min(model.ir_version, 10)
    onnx.checker.check_model(model)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    onnx.save(model, temporary)
    temporary.replace(path)


def evaluate(classifier, scaler, positive, negative):
    x = np.vstack((positive, negative))
    y = np.hstack((np.ones(len(positive)), np.zeros(len(negative))))
    probabilities = classifier.predict_proba(scaler.transform(x))[:, 1]
    predictions = probabilities >= 0.5
    precision, recall, f1, _ = precision_recall_fscore_support(y, predictions, average="binary", zero_division=0)
    false_positive_rate = float(np.mean(probabilities[len(positive):] >= 0.5))
    return {
        "precision": float(precision),
        "recall": float(recall),
        "f1": float(f1),
        "rocAuc": float(roc_auc_score(y, probabilities)) if len(np.unique(y)) > 1 else None,
        "falsePositiveRate": false_positive_rate,
        "positiveScoreMedian": float(np.median(probabilities[:len(positive)])),
        "negativeScoreMedian": float(np.median(probabilities[len(positive):])),
    }


def main():
    args = parse_args()
    config = merged_config(args.config_json)
    runtime = Path(os.environ["WAKE_WORD_TRAINER_RUNTIME_PATH"]).resolve()
    model_dir = Path(args.model_dir).resolve()
    output = Path(args.output).resolve()
    rng = np.random.default_rng(int(config["seed"]))
    random.seed(int(config["seed"]))
    voices = list(config["voices"]) if bool(config["useSyntheticVoices"]) else []
    feature_dir, voice_dir = ensure_resources(runtime, voices)

    synthetic_positive, synthetic_negative = (
        generate_bases(args.wake_word, voices, voice_dir, config, rng)
        if voices else ([], [])
    )
    real_positive = collect_real_samples(model_dir, "positive")
    real_negative = collect_real_samples(model_dir, "negative")
    if len(real_positive) < 5 or len(real_negative) < 5:
        raise RuntimeError(
            "Se necesitan al menos 5 muestras positivas y 5 negativas reales para entrenar"
        )
    positive_bases = synthetic_positive + real_positive
    negative_bases = synthetic_negative + real_negative
    log(f"Dataset base: {len(positive_bases)} positivos y {len(negative_bases)} negativos")

    positive_train, positive_val = split_base(positive_bases, float(config["validationFraction"]), rng)
    negative_train, negative_val = split_base(negative_bases, float(config["validationFraction"]), rng)
    length = int(float(config["clipSeconds"]) * SAMPLE_RATE)
    backgrounds = real_negative

    train_positive_audio = augmented(
        positive_train, int(config["positiveAugmentations"]), length, rng, backgrounds, training=True
    )
    train_negative_audio = augmented(
        negative_train, int(config["negativeAugmentations"]), length, rng, backgrounds, training=True
    )
    for _ in range(int(config["noiseExamples"])):
        train_negative_audio = np.vstack((
            train_negative_audio,
            rng.normal(0, rng.uniform(20, 1000), (1, length)).clip(-32768, 32767).astype(np.int16),
        ))
    validation_positive_audio = augmented(positive_val, 1, length, rng, backgrounds, training=False)
    validation_negative_audio = augmented(negative_val, 1, length, rng, backgrounds, training=False)
    log(f"Dataset aumentado: {len(train_positive_audio)} positivos y {len(train_negative_audio)} negativos")

    log("Extrayendo embeddings openWakeWord…")
    train_positive = extract_features(train_positive_audio, feature_dir)
    train_negative = extract_features(train_negative_audio, feature_dir)
    validation_positive = extract_features(validation_positive_audio, feature_dir)
    validation_negative = extract_features(validation_negative_audio, feature_dir)
    frame_count, feature_size = train_positive.shape[1:]
    train_x = np.vstack((train_positive, train_negative)).reshape(
        len(train_positive) + len(train_negative), -1
    )
    train_y = np.hstack((np.ones(len(train_positive)), np.zeros(len(train_negative))))
    validation_positive_flat = validation_positive.reshape(len(validation_positive), -1)
    validation_negative_flat = validation_negative.reshape(len(validation_negative), -1)

    order = rng.permutation(len(train_x))
    train_x, train_y = train_x[order], train_y[order]
    scaler = StandardScaler().fit(train_x)
    classifier = MLPClassifier(
        hidden_layer_sizes=(int(config["hiddenUnits"]),),
        activation="relu",
        solver="adam",
        batch_size=min(128, max(16, len(train_x) // 8)),
        learning_rate_init=0.001,
        max_iter=int(config["maxIterations"]),
        early_stopping=True,
        validation_fraction=0.15,
        n_iter_no_change=15,
        random_state=int(config["seed"]),
        verbose=True,
    )
    log("Entrenando clasificador neuronal…")
    classifier.fit(scaler.transform(train_x), train_y)
    metrics = evaluate(classifier, scaler, validation_positive_flat, validation_negative_flat)
    log(
        f"Evaluación: recall={metrics['recall']:.3f}, precisión={metrics['precision']:.3f}, "
        f"F1={metrics['f1']:.3f}, falsos positivos={metrics['falsePositiveRate']:.3f}"
    )

    export_mlp(output, frame_count, feature_size, scaler, classifier)
    session = ort.InferenceSession(str(output), providers=["CPUExecutionProvider"])
    onnx_scores = session.run(None, {"input": validation_positive[:1].astype(np.float32)})[0]
    if onnx_scores.shape != (1, 1) or not np.isfinite(onnx_scores).all():
        raise RuntimeError("El ONNX exportado no produjo una salida válida")

    report = {
        "modelId": args.model_id,
        "wakeWord": args.wake_word,
        "config": config,
        "dataset": {
            "syntheticPositiveBase": len(synthetic_positive),
            "syntheticNegativeBase": len(synthetic_negative),
            "realPositive": len(real_positive),
            "realNegative": len(real_negative),
            "trainingPositive": len(train_positive),
            "trainingNegative": len(train_negative),
            "validationPositive": len(validation_positive),
            "validationNegative": len(validation_negative),
        },
        "inputShape": [frame_count, feature_size],
        "iterations": int(classifier.n_iter_),
        "metrics": metrics,
        "onnxPositiveProbeScore": float(onnx_scores[0, 0]),
    }
    (model_dir / "training-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    log(f"Modelo ONNX generado correctamente en {output}")


if __name__ == "__main__":
    main()
