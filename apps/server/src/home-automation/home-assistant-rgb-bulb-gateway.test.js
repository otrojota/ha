import assert from "node:assert/strict";
import test from "node:test";
import { HomeAssistantRgbBulbGateway } from "./home-assistant-rgb-bulb-gateway.js";

test("traduce y verifica brillo, color y temperatura a servicios light", async () => {
  const calls = [];
  let brightness = 255;
  const client = {
    state: async () => ({ state: "on", attributes: { brightness, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6000 } }),
    callService: async (domain, service, data) => {
      calls.push({ domain, service, data });
      if (data.brightness_pct !== undefined) brightness = Math.round(data.brightness_pct * 255 / 100);
    }
  };
  const gateway = new HomeAssistantRgbBulbGateway({ client, wait: async () => {} });
  const device = { configuration: { entityId: "light.living" } };
  await gateway.setBrightness(device, 40);
  await gateway.setColor(device, { hue: 240, saturationPercent: 100, brightnessPercent: 60 });
  await gateway.setColorTemperature(device, 25);
  assert.equal(calls[0].data.brightness_pct, 40);
  assert.equal(calls[0].data.transition, 0);
  assert.deepEqual(calls[1].data.hs_color, [240, 100]);
  assert.equal(calls[2].data.color_temp_kelvin, 3000);
});

test("no confirma un cambio de brillo que Home Assistant no aplicó", async () => {
  const gateway = new HomeAssistantRgbBulbGateway({
    wait: async () => {},
    client: {
      callService: async () => [],
      state: async () => ({ state: "on", attributes: { brightness: 255 } })
    }
  });
  const device = { name: "Lámpara", configuration: { entityId: "light.lampara" } };

  await assert.rejects(gateway.setBrightness(device, 50), /aceptó el comando.*quedó en 100%/);
});
