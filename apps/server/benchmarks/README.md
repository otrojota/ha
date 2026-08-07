# Benchmarks STT

La prueba de Moonshine Spanish Base es aislada: no inicia ni modifica el
servidor. El entorno y el modelo se preparan así:

```bash
python3.12 -m venv dev/server/.venv-moonshine
dev/server/.venv-moonshine/bin/pip install \
  -r dev/server/requirements-moonshine.txt
dev/server/.venv-moonshine/bin/moonshine-voice download \
  --language es \
  --model-arch base \
  --stt \
  --root dev/server/models/moonshine
```

Luego se ejecuta el benchmark con un directorio de WAV mono o estéreo. Los
nombres conocidos en `EXPECTED_TEXT` se usan como corpus y referencia:

```bash
dev/server/.venv-moonshine/bin/python \
  apps/server/benchmarks/moonshine_spanish_base.py \
  --model-path dev/server/models/moonshine/download.moonshine.ai/model/base-es/quantized/base-es \
  --samples /private/tmp/ha-moonshine-benchmark \
  --output dev/server/moonshine-benchmark.json
```

El corpus sintético sólo sirve como smoke test reproducible. La decisión de
integración requiere después grabaciones humanas, ruido real y comparación con
Whisper usando exactamente el mismo audio.
