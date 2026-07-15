import assert from "node:assert/strict";
import test from "node:test";
import { createGetCurrentWeatherTool } from "../tools/weather/get-current-weather.tool.js";
import { createGetWeatherForecastTool } from "../tools/weather/get-weather-forecast.tool.js";
import { OpenMeteoWeatherProvider } from "./open-meteo-weather-provider.js";
import { getMoonPhase } from "./moon-phase.js";
import { weatherIcon } from "./weather-codes.js";

const location = { city: "Valparaíso", country: "Chile", latitude: -33.0472, longitude: -71.6127, timeZone: "America/Santiago" };
const responseBody = {
  current: {
    time: "2026-07-14T20:00",
    temperature_2m: 12.4,
    apparent_temperature: 10.1,
    relative_humidity_2m: 82,
    precipitation: 0,
    weather_code: 2,
    wind_speed_10m: 14.5,
    is_day: 0
  },
  daily: {
    time: ["2026-07-14", "2026-07-15"],
    weather_code: [2, 61],
    temperature_2m_max: [15, 13],
    temperature_2m_min: [8, 7],
    apparent_temperature_max: [14, 12],
    apparent_temperature_min: [6, 5],
    precipitation_probability_max: [10, 80],
    precipitation_sum: [0, 4.2],
    sunrise: ["2026-07-14T07:45", "2026-07-15T07:44"],
    sunset: ["2026-07-14T17:55", "2026-07-15T17:56"]
  }
};

test("obtiene y normaliza clima actual y pronóstico desde Open-Meteo", async () => {
  let calls = 0;
  let requestedUrl;
  const provider = new OpenMeteoWeatherProvider({
    fetchImpl: async (url) => {
      calls += 1;
      requestedUrl = url;
      return { ok: true, json: async () => responseBody };
    }
  });

  const first = await provider.get(location);
  const cached = await provider.get(location);

  assert.equal(calls, 1);
  assert.equal(cached, first);
  assert.equal(first.current.condition, "Parcialmente nublado");
  assert.equal(first.current.icon, "☁️🌙");
  assert.equal(first.daily[1].condition, "Lluvia ligera");
  assert.equal(requestedUrl.searchParams.get("timezone"), "America/Santiago");
  assert.match(requestedUrl.searchParams.get("current"), /temperature_2m/);
});

test("representa estados diurnos, nocturnos y fases lunares", () => {
  assert.equal(weatherIcon(0, true), "☀️");
  assert.equal(weatherIcon(0, false), "🌙");
  assert.equal(weatherIcon(2, true), "🌤️");
  assert.equal(weatherIcon(63, false), "🌧️");
  assert.equal(getMoonPhase(new Date("2000-01-06T18:14:00Z")).name, "Luna nueva");
});

test("las tools entregan clima actual y días de pronóstico", async () => {
  const provider = { get: async () => ({ provider: "test", location, current: { temperature: 12, condition: "Nublado" }, daily: responseBody.daily.time.map((date, index) => ({ date, temperatureMax: responseBody.daily.temperature_2m_max[index] })), fetchedAt: "2026-07-14T20:00:00Z" }) };
  const context = { location };
  const current = await createGetCurrentWeatherTool({ provider }).execute({}, context);
  const tomorrow = await createGetWeatherForecastTool({ provider }).execute({ daysFromToday: 1 }, context);

  assert.equal(current.temperature, 12);
  assert.equal(tomorrow.forecast.length, 1);
  assert.equal(tomorrow.forecast[0].date, "2026-07-15");
});
