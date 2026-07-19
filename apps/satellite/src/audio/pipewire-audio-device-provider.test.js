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
    { id: "42", name: "bcm2835 Headphones" },
    { id: "43", name: "Salida PipeWire 43" }
  ]);
  assert.equal(devices.some((device) => device.id === "null" || device.name.toLowerCase() === "null"), false);
});
