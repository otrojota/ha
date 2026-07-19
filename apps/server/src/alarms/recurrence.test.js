import assert from "node:assert/strict";
import test from "node:test";
import { nextOccurrence } from "./recurrence.js";

test("calcula recurrencias diarias conservando la hora local", () => {
  const recurrence = { frequency: "daily", localTime: "20:00", timeZone: "America/Santiago" };
  assert.equal(nextOccurrence(recurrence, new Date("2026-07-14T16:00:00Z")).toISOString(), "2026-07-15T00:00:00.000Z");
  assert.equal(nextOccurrence(recurrence, new Date("2026-12-14T16:00:00Z")).toISOString(), "2026-12-14T23:00:00.000Z");
});

test("calcula días laborales y días semanales específicos", () => {
  const recurrence = { frequency: "weekly", localTime: "09:00", weekdays: [1, 2, 3, 4, 5], timeZone: "America/Santiago" };
  assert.equal(nextOccurrence(recurrence, new Date("2026-07-17T20:00:00Z")).toISOString(), "2026-07-20T13:00:00.000Z");
});

test("calcula recurrencias por intervalo", () => {
  const recurrence = { frequency: "interval", intervalSeconds: 7200, timeZone: "America/Santiago" };
  assert.equal(nextOccurrence(recurrence, new Date("2026-07-14T16:00:00Z")).toISOString(), "2026-07-14T18:00:00.000Z");
});
