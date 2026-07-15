import { getMoonPhase } from "./moon-phase.js";
import { describeWeatherCode, weatherIcon } from "./weather-codes.js";

const currentVariables = "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day";
const dailyVariables = "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,precipitation_sum,sunrise,sunset";

function requiredNumber(value, name) {
  if (!Number.isFinite(value)) throw new Error(`Open-Meteo no devolvió ${name}`);
  return value;
}

export class OpenMeteoWeatherProvider {
  constructor({ baseUrl = "https://api.open-meteo.com/v1/forecast", fetchImpl = fetch, timeoutMs = 10_000, cacheMs = 5 * 60_000, now = () => new Date() } = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cacheMs = cacheMs;
    this.now = now;
    this.cache = new Map();
  }

  async get(location) {
    const cacheKey = `${location.latitude},${location.longitude},${location.timeZone}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < this.cacheMs) return cached.value;

    const url = new URL(this.baseUrl);
    url.searchParams.set("latitude", location.latitude);
    url.searchParams.set("longitude", location.longitude);
    url.searchParams.set("timezone", location.timeZone);
    url.searchParams.set("forecast_days", "8");
    url.searchParams.set("current", currentVariables);
    url.searchParams.set("daily", dailyVariables);
    const response = await this.fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new Error(`Open-Meteo respondió HTTP ${response.status}`);
    const data = await response.json();
    const weatherCode = requiredNumber(data.current?.weather_code, "weather_code");
    const isDay = requiredNumber(data.current?.is_day, "is_day") === 1;
    const current = {
      time: data.current?.time,
      temperature: requiredNumber(data.current?.temperature_2m, "temperature_2m"),
      apparentTemperature: requiredNumber(data.current?.apparent_temperature, "apparent_temperature"),
      humidity: requiredNumber(data.current?.relative_humidity_2m, "relative_humidity_2m"),
      precipitation: requiredNumber(data.current?.precipitation, "precipitation"),
      windSpeed: requiredNumber(data.current?.wind_speed_10m, "wind_speed_10m"),
      weatherCode,
      isDay,
      condition: describeWeatherCode(weatherCode),
      icon: weatherIcon(weatherCode, isDay),
      moonPhase: getMoonPhase(this.now())
    };
    if (!Array.isArray(data.daily?.time)) throw new Error("Open-Meteo no devolvió pronóstico diario");
    const daily = data.daily.time.map((date, index) => {
      const weatherCode = data.daily.weather_code?.[index];
      return {
        date,
        weatherCode,
        condition: describeWeatherCode(weatherCode),
        temperatureMax: data.daily.temperature_2m_max?.[index],
        temperatureMin: data.daily.temperature_2m_min?.[index],
        apparentTemperatureMax: data.daily.apparent_temperature_max?.[index],
        apparentTemperatureMin: data.daily.apparent_temperature_min?.[index],
        precipitationProbabilityMax: data.daily.precipitation_probability_max?.[index],
        precipitationSum: data.daily.precipitation_sum?.[index],
        sunrise: data.daily.sunrise?.[index],
        sunset: data.daily.sunset?.[index]
      };
    });
    const value = { provider: "Open-Meteo", location, current, daily, fetchedAt: new Date().toISOString() };
    this.cache.set(cacheKey, { createdAt: Date.now(), value });
    return value;
  }
}
