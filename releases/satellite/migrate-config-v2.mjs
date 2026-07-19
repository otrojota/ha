import { readFile, rename, unlink, writeFile } from "node:fs/promises";

const [audioPath, serverPath] = process.argv.slice(2);
if (!audioPath || !serverPath) throw new Error("Faltan rutas de configuración del satélite");

try {
  const previous = JSON.parse(await readFile(audioPath, "utf8"));
  const current = {
    inputDeviceIds: Array.isArray(previous.inputDeviceIds) ? previous.inputDeviceIds : [],
    inputDeviceNames: previous.inputDeviceNames && !Array.isArray(previous.inputDeviceNames) ? previous.inputDeviceNames : {},
    inputChannelsByDevice: previous.inputChannelsByDevice && !Array.isArray(previous.inputChannelsByDevice) ? previous.inputChannelsByDevice : {},
    outputDeviceIds: Array.isArray(previous.outputDeviceIds) ? previous.outputDeviceIds : [],
    outputDeviceNames: previous.outputDeviceNames && !Array.isArray(previous.outputDeviceNames) ? previous.outputDeviceNames : {},
    ttsVoiceId: typeof previous.ttsVoiceId === "string" ? previous.ttsVoiceId : null,
    musicPlayerEnabled: previous.musicPlayerEnabled !== false,
    musicOutputDeviceId: typeof previous.musicOutputDeviceId === "string" ? previous.musicOutputDeviceId : null
  };
  const temporary = `${audioPath}.v2.tmp`;
  await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o660 });
  await rename(temporary, audioPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

await unlink(serverPath).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
