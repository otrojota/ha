const state = { models: [], jobs: [], trainingAvailable: false };
const elements = {
  list: document.querySelector("#model-list"),
  empty: document.querySelector("#empty"),
  notice: document.querySelector("#notice"),
  modelDialog: document.querySelector("#model-dialog"),
  modelForm: document.querySelector("#model-form"),
  modelFormStatus: document.querySelector("#model-form-status"),
  createModelButton: document.querySelector("#create-model-button"),
  detailDialog: document.querySelector("#detail-dialog"),
  detail: document.querySelector("#detail-content")
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat("es-CL", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Nunca";
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

function showNotice(message, error = false) {
  elements.notice.textContent = message;
  elements.notice.className = `notice${error ? " error" : ""}`;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => elements.notice.classList.add("hidden"), 5000);
}

function setModelFormStatus(message = "", error = false) {
  elements.modelFormStatus.textContent = message;
  elements.modelFormStatus.className = message ? `form-status${error ? " error" : ""}` : "form-status hidden";
}

function setModelFormBusy(busy) {
  elements.modelForm.setAttribute("aria-busy", String(busy));
  for (const control of elements.modelForm.elements) control.disabled = busy;
  elements.createModelButton.classList.toggle("busy", busy);
  elements.createModelButton.querySelector(".button-label").textContent = busy ? "Creando…" : "Crear modelo";
  if (busy) setModelFormStatus("Guardando el nuevo modelo en el servidor…");
}

async function api(path, options = {}) {
  const response = await fetch(`/api/wake-word${path}`, options);
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.message || `HTTP ${response.status}`);
  return result;
}

function activeJob(modelId) {
  return state.jobs.find((job) => job.modelId === modelId && ["queued", "running"].includes(job.status));
}

function render() {
  document.querySelector("#model-count").textContent = state.models.length;
  document.querySelector("#ready-count").textContent = state.models.filter((model) => model.file).length;
  document.querySelector("#job-count").textContent = state.jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  elements.empty.classList.toggle("hidden", state.models.length > 0);
  elements.list.replaceChildren(...state.models.map((model) => {
    const card = document.createElement("article");
    card.className = "model-card";
    const job = activeJob(model.id);
    card.innerHTML = `
      <div class="card-top">
        <div><p class="eyebrow">${escapeHtml(model.id)}</p><h2>${escapeHtml(model.name)}</h2><p class="wake-word">“${escapeHtml(model.wakeWord)}”</p></div>
        <span class="status ${model.file ? "ready" : ""}">${job ? "Entrenando" : model.file ? "Disponible" : "Sin archivo"}</span>
      </div>
      <p>${escapeHtml(model.description || "Sin descripción")}</p>
      <div class="metadata">
        <div><span>Archivo vigente</span><strong>${model.file ? formatBytes(model.file.size) : "Pendiente"}</strong></div>
        <div><span>Último cambio</span><strong>${formatDate(model.file?.modifiedAt)}</strong></div>
        <div><span>Muestras</span><strong>${model.samples.positive} positivas · ${model.samples.negative} negativas</strong></div>
      </div>
      <button class="secondary card-action">Administrar</button>`;
    card.querySelector("button").addEventListener("click", () => openDetail(model.id));
    return card;
  }));
}

async function refresh() {
  const [catalog, jobs] = await Promise.all([api("/models"), api("/jobs")]);
  state.models = catalog.models;
  state.trainingAvailable = catalog.trainingAvailable;
  state.jobs = jobs.jobs;
  render();
}

async function upload(path, file) {
  return api(path, { method: path.includes("/samples/") ? "POST" : "PUT", headers: { "Content-Type": "application/octet-stream", "X-File-Name": file.name }, body: file });
}

function filePicker(accept, onSelect) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.className = "file-input";
  input.addEventListener("change", () => input.files[0] && onSelect(input.files[0]));
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 60_000);
}

let activeRecording = null;

function mergeFloat32(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function pcmWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function microphoneDevices() {
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    throw new Error("El navegador sólo permite usar el micrófono desde localhost o una conexión HTTPS.");
  }
  const permissionStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  permissionStream.getTracks().forEach((track) => track.stop());
  return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
}

function recorderStatus(message, error = false, scope = activeRecording?.scope || "samples") {
  const status = elements.detail.querySelector(`[data-recorder="${scope}"] [data-recorder-status]`);
  if (!status) return;
  status.textContent = message;
  status.className = `recorder-status${error ? " error" : ""}`;
}

async function prepareMicrophones(scope) {
  const root = elements.detail.querySelector(`[data-recorder="${scope}"]`);
  const select = root.querySelector("[data-recorder-device]");
  const prepare = root.querySelector('[data-action="prepare-microphone"]');
  prepare.disabled = true;
  recorderStatus("Solicitando permiso y buscando micrófonos…", false, scope);
  try {
    const devices = await microphoneDevices();
    if (!devices.length) throw new Error("No se encontraron micrófonos disponibles.");
    select.replaceChildren(...devices.map((device, index) => new Option(device.label || `Micrófono ${index + 1}`, device.deviceId)));
    select.disabled = false;
    for (const button of root.querySelectorAll("[data-record-kind]")) button.disabled = false;
    recorderStatus(`${devices.length} micrófono${devices.length === 1 ? "" : "s"} disponible${devices.length === 1 ? "" : "s"}.`, false, scope);
  } catch (error) {
    recorderStatus(error.message, true, scope);
  } finally {
    prepare.disabled = false;
  }
}

async function stopMicrophoneRecording({ uploadRecording = true } = {}) {
  const recording = activeRecording;
  if (!recording) return;
  activeRecording = null;
  clearInterval(recording.timer);
  recording.processor.disconnect();
  recording.source.disconnect();
  recording.stream.getTracks().forEach((track) => track.stop());
  const sampleRate = recording.context.sampleRate;
  await recording.context.close();
  const duration = (Date.now() - recording.startedAt) / 1000;
  const root = elements.detail.querySelector(`[data-recorder="${recording.scope}"]`);
  const stopButton = root?.querySelector('[data-action="stop-recording"]');
  if (stopButton) stopButton.hidden = true;
  for (const button of root?.querySelectorAll("[data-record-kind]") || []) button.disabled = false;
  if (!uploadRecording) return;
  if (duration < 0.35 || !recording.chunks.length) {
    recorderStatus("La grabación fue demasiado corta. Inténtalo nuevamente.", true, recording.scope);
    return;
  }
  recorderStatus(recording.test ? "Evaluando el audio con el modelo…" : `Subiendo muestra ${recording.kind === "positive" ? "positiva" : "negativa"}…`, false, recording.scope);
  try {
    const blob = pcmWav(mergeFloat32(recording.chunks), sampleRate);
    const file = new File([blob], `${recording.kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`, { type: "audio/wav" });
    if (recording.test) {
      const response = await fetch(`/api/wake-word/models/${recording.modelId}/test`, {
        method: "POST",
        headers: { "Content-Type": "audio/wav", "X-Wake-Word-Threshold": "0.995" },
        body: file
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
      const evaluation = result.evaluation;
      const expectedActivation = recording.kind === "positive";
      const correct = evaluation.activated === expectedActivation;
      recorderStatus(
        `${correct ? "✓ Resultado esperado" : "✕ Resultado incorrecto"} · score ${evaluation.score.toFixed(4)} · umbral ${evaluation.threshold.toFixed(3)} · ${evaluation.activated ? "activaría" : "no activaría"}.`,
        !correct,
        recording.scope
      );
      root?.querySelector("[data-test-save]")?.removeAttribute("hidden");
      const saveButton = root?.querySelector("[data-test-save]");
      if (saveButton) {
        saveButton.dataset.kind = recording.kind;
        saveButton._recordedFile = file;
      }
      return;
    }
    await upload(`/models/${recording.modelId}/samples/${recording.kind}`, file);
    await refresh();
    recorderStatus(`Muestra ${recording.kind === "positive" ? "positiva" : "negativa"} guardada (${duration.toFixed(1)} s).`, false, recording.scope);
    const model = state.models.find((item) => item.id === recording.modelId);
    const summary = elements.detail.querySelector("[data-sample-summary]");
    if (model && summary) summary.textContent = `${model.samples.positive} positivas y ${model.samples.negative} negativas almacenadas.`;
  } catch (error) {
    recorderStatus(error.message, true, recording.scope);
  }
}

async function startMicrophoneRecording(modelId, kind, { scope = "samples", test = false } = {}) {
  if (activeRecording) return;
  const root = elements.detail.querySelector(`[data-recorder="${scope}"]`);
  const select = root.querySelector("[data-recorder-device]");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: select.value ? { exact: select.value } : undefined, channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, source.channelCount, 1);
    const silentOutput = context.createGain();
    silentOutput.gain.value = 0;
    const chunks = [];
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const mono = new Float32Array(input.length);
      for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
        const values = input.getChannelData(channel);
        for (let index = 0; index < values.length; index += 1) mono[index] += values[index] / input.numberOfChannels;
      }
      chunks.push(mono);
    };
    source.connect(processor);
    processor.connect(silentOutput);
    silentOutput.connect(context.destination);
    activeRecording = { modelId, kind, scope, test, stream, context, source, processor, silentOutput, chunks, startedAt: Date.now(), timer: null };
    const stopButton = root.querySelector('[data-action="stop-recording"]');
    stopButton.hidden = false;
    for (const button of root.querySelectorAll("[data-record-kind]")) button.disabled = true;
    const updateTimer = () => {
      const seconds = (Date.now() - activeRecording.startedAt) / 1000;
      recorderStatus(`${test ? "Probando" : "Grabando muestra"} ${kind === "positive" ? "positiva" : "negativa"} · ${seconds.toFixed(1)} s`, false, scope);
      if (seconds >= 15) void stopMicrophoneRecording();
    };
    activeRecording.timer = setInterval(updateTimer, 100);
    updateTimer();
  } catch (error) {
    recorderStatus(`No se pudo iniciar la grabación: ${error.message}`, true, scope);
  }
}

async function openDetail(id) {
  const model = state.models.find((item) => item.id === id);
  if (!model) return;
  const job = activeJob(id);
  elements.detail.innerHTML = `
    <div class="dialog-heading">
      <div><p class="eyebrow">${escapeHtml(model.id)}</p><h2>${escapeHtml(model.name)}</h2></div>
      <button type="button" class="icon-button" data-action="close" aria-label="Cerrar">×</button>
    </div>
    <section class="detail-section">
      <h3>Archivo del modelo</h3>
      <p>${model.file ? `${escapeHtml(model.file.name)} · ${formatBytes(model.file.size)} · modificado ${formatDate(model.file.modifiedAt)}` : "Carga un modelo ONNX existente o ejecuta un entrenamiento."}</p>
      ${model.file ? `<p class="hash">SHA-256 ${escapeHtml(model.file.sha256)}</p>` : ""}
      <div class="button-row">
        ${model.file ? `<a class="secondary" href="/api/wake-word/models/${model.id}/download">Descargar</a>` : ""}
        <button class="secondary" data-action="model-file">${model.file ? "Reemplazar archivo" : "Cargar ONNX"}</button>
      </div>
    </section>
    <section class="detail-section">
      <h3>Muestras para mejorar el modelo</h3>
      <p data-sample-summary>${model.samples.positive} positivas y ${model.samples.negative} negativas almacenadas.</p>
      <div class="recorder" data-recorder="samples">
        <label>Micrófono
          <select data-recorder-device disabled><option>Primero permite el acceso al micrófono</option></select>
        </label>
        <div class="button-row recorder-actions">
          <button class="secondary" data-action="prepare-microphone">Buscar micrófonos</button>
          <button class="secondary" data-record-kind="positive" disabled>Grabar positiva</button>
          <button class="secondary" data-record-kind="negative" disabled>Grabar negativa</button>
          <button class="danger" data-action="stop-recording" hidden>Detener y guardar</button>
        </div>
        <p class="recorder-status" data-recorder-status>${window.isSecureContext ? "Selecciona “Buscar micrófonos” para conceder permiso." : "Para grabar, abre esta página desde localhost o mediante HTTPS."}</p>
        <p class="recorder-help">Positiva: pronuncia solamente “${escapeHtml(model.wakeWord)}”. Negativa: graba voces, TV o ruido que haya causado una activación falsa.</p>
      </div>
      <p>También puedes cargar archivos WAV existentes:</p>
      <div class="button-row">
        <button class="secondary" data-action="positive">Cargar positiva</button>
        <button class="secondary" data-action="negative">Cargar negativa</button>
      </div>
    </section>
    <section class="detail-section test-section">
      <h3>Probar modelo</h3>
      <p>Estas grabaciones se evalúan sin agregarse al entrenamiento. Comprueba frases que deberían activar y sonidos que no deberían hacerlo.</p>
      <div class="recorder" data-recorder="test">
        <label>Micrófono
          <select data-recorder-device disabled><option>Primero permite el acceso al micrófono</option></select>
        </label>
        <div class="button-row recorder-actions">
          <button class="secondary" data-action="prepare-microphone">Buscar micrófonos</button>
          <button class="secondary" data-record-kind="positive" disabled>Probar “${escapeHtml(model.wakeWord)}”</button>
          <button class="secondary" data-record-kind="negative" disabled>Probar negativo</button>
          <button class="danger" data-action="stop-recording" hidden>Detener y evaluar</button>
        </div>
        <p class="recorder-status" data-recorder-status>${window.isSecureContext ? "Selecciona un micrófono y graba una prueba." : "Para grabar, abre esta página desde localhost o mediante HTTPS."}</p>
        <button class="secondary test-save" data-test-save hidden>Agregar esta grabación al entrenamiento</button>
      </div>
    </section>
    <section class="detail-section">
      <h3>Entrenamiento</h3>
      <p>${job ? `Trabajo en curso desde ${formatDate(job.startedAt || job.createdAt)}.` : state.trainingAvailable ? "Generará un nuevo archivo y reemplazará el vigente al terminar correctamente." : "Configura WAKE_WORD_TRAINER_EXECUTABLE para habilitar el entrenador del servidor."}</p>
      <div class="button-row"><button class="primary" data-action="train" ${job || !state.trainingAvailable ? "disabled" : ""}>${job ? "Entrenando…" : "Entrenar ahora"}</button></div>
    </section>
    <div class="button-row"><button class="danger" data-action="delete">Eliminar modelo</button></div>`;
  elements.detail.querySelector('[data-action="close"]').addEventListener("click", async () => {
    await stopMicrophoneRecording({ uploadRecording: false });
    elements.detailDialog.close();
  });
  for (const recorder of elements.detail.querySelectorAll("[data-recorder]")) {
    const scope = recorder.dataset.recorder;
    recorder.querySelector('[data-action="prepare-microphone"]').addEventListener("click", () => prepareMicrophones(scope));
    for (const button of recorder.querySelectorAll("[data-record-kind]")) {
      button.addEventListener("click", () => startMicrophoneRecording(id, button.dataset.recordKind, { scope, test: scope === "test" }));
    }
    recorder.querySelector('[data-action="stop-recording"]').addEventListener("click", () => stopMicrophoneRecording());
  }
  const saveTest = elements.detail.querySelector("[data-test-save]");
  saveTest.addEventListener("click", async () => {
    if (!saveTest._recordedFile || !saveTest.dataset.kind) return;
    saveTest.disabled = true;
    recorderStatus("Agregando la grabación al conjunto de entrenamiento…", false, "test");
    try {
      await upload(`/models/${id}/samples/${saveTest.dataset.kind}`, saveTest._recordedFile);
      await refresh();
      const updated = state.models.find((item) => item.id === id);
      const summary = elements.detail.querySelector("[data-sample-summary]");
      if (updated && summary) summary.textContent = `${updated.samples.positive} positivas y ${updated.samples.negative} negativas almacenadas.`;
      recorderStatus("Grabación agregada al entrenamiento.", false, "test");
      saveTest.hidden = true;
      saveTest._recordedFile = null;
    } catch (error) {
      recorderStatus(error.message, true, "test");
    } finally {
      saveTest.disabled = false;
    }
  });
  elements.detail.querySelector('[data-action="model-file"]').addEventListener("click", () => filePicker(".onnx,application/octet-stream", async (file) => {
    try { await upload(`/models/${id}/file`, file); await refresh(); elements.detailDialog.close(); showNotice("Archivo del modelo actualizado."); } catch (error) { showNotice(error.message, true); }
  }));
  for (const kind of ["positive", "negative"]) elements.detail.querySelector(`[data-action="${kind}"]`).addEventListener("click", () => filePicker("audio/*,.wav", async (file) => {
    try { await upload(`/models/${id}/samples/${kind}`, file); await refresh(); elements.detailDialog.close(); showNotice("Muestra agregada."); } catch (error) { showNotice(error.message, true); }
  }));
  elements.detail.querySelector('[data-action="train"]').addEventListener("click", async () => {
    try { await api(`/models/${id}/train`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); await refresh(); elements.detailDialog.close(); showNotice("Entrenamiento iniciado."); } catch (error) { showNotice(error.message, true); }
  });
  elements.detail.querySelector('[data-action="delete"]').addEventListener("click", async () => {
    if (!confirm(`¿Eliminar el modelo ${model.name} y todas sus muestras?`)) return;
    try { await api(`/models/${id}`, { method: "DELETE" }); elements.detailDialog.close(); await refresh(); showNotice("Modelo eliminado."); } catch (error) { showNotice(error.message, true); }
  });
  elements.detailDialog.showModal();
}

document.querySelector("#new-model").addEventListener("click", () => {
  setModelFormStatus();
  elements.modelDialog.showModal();
});
elements.detailDialog.addEventListener("close", () => {
  if (activeRecording) void stopMicrophoneRecording({ uploadRecording: false });
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => {
  if (elements.modelForm.getAttribute("aria-busy") !== "true") elements.modelDialog.close();
}));
elements.modelDialog.addEventListener("cancel", (event) => {
  if (elements.modelForm.getAttribute("aria-busy") === "true") event.preventDefault();
});
elements.modelForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  setModelFormBusy(true);
  try {
    await api("/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
    formElement.reset();
    elements.modelDialog.close();
    showNotice("Modelo creado correctamente.");
    try { await refresh(); } catch (error) { showNotice(`El modelo fue creado, pero no se pudo actualizar la lista: ${error.message}`, true); }
  } catch (error) {
    setModelFormStatus(error.message, true);
  } finally {
    setModelFormBusy(false);
  }
});

refresh().catch((error) => showNotice(error.message, true));
setInterval(() => refresh().catch(() => {}), 5000);
