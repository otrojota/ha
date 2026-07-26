import assert from "node:assert/strict";
import test from "node:test";
import { PipeWireAudioDeviceProvider } from "./pipewire-audio-device-provider.js";

test("usa nombres técnicos e índices cuando pactl devuelve descripciones null", async () => {
  const provider = new PipeWireAudioDeviceProvider({ exec: async () => ({ stdout: JSON.stringify([
    {
      index: 42,
      name: "null",
      description: "null",
      state: "SUSPENDED",
      properties: { "node.description": "null", "alsa.card_name": "bcm2835 Headphones" }
    },
    {
      index: 43,
      name: null,
      description: "(null)",
      state: "RUNNING",
      properties: { "node.description": "undefined", "node.nick": "<null>" }
    }
  ]) }) });

  const devices = await provider.listOutputDevices();

  assert.deepEqual(devices.map(({ id, name }) => ({ id, name })), [
    { id: "42", name: "Audio interno · Jack 3,5 mm" },
    { id: "43", name: "Salida PipeWire 43" }
  ]);
  assert.equal(devices.some((device) => device.id === "null" || device.name.toLowerCase() === "null"), false);
});

test("diferencia las salidas internas analógica y HDMI aunque compartan descripción", async () => {
  const provider = new PipeWireAudioDeviceProvider({ exec: async () => ({ stdout: JSON.stringify([
    {
      index: 74,
      name: "alsa_output.platform-fe00b840.mailbox.stereo-fallback",
      description: "(null)",
      state: "RUNNING",
      properties: {
        "device.description": "Audio Interno",
        "alsa.card_name": "bcm2835 Headphones"
      },
      ports: [{ name: "analog-output", type: "Analog", description: "(null)" }],
      active_port: "analog-output"
    },
    {
      index: 75,
      name: "alsa_output.platform-fef00700.hdmi.hdmi-stereo",
      description: "(null)",
      state: "RUNNING",
      properties: {
        "device.description": "Audio Interno",
        "alsa.card_name": "vc4-hdmi-0",
        "device.profile.name": "hdmi-stereo"
      },
      ports: [{ name: "hdmi-output-0", type: "HDMI", description: "HDMI / DisplayPort" }],
      active_port: "hdmi-output-0"
    }
  ]) }) });

  const devices = await provider.listOutputDevices();

  assert.deepEqual(devices.map(({ id, name }) => ({ id, name })), [
    {
      id: "alsa_output.platform-fe00b840.mailbox.stereo-fallback",
      name: "Audio interno · Jack 3,5 mm"
    },
    {
      id: "alsa_output.platform-fef00700.hdmi.hdmi-stereo",
      name: "Audio interno · HDMI"
    }
  ]);
});
