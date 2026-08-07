import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserSatelliteId } from "./browser-identity.js";

test("usa randomUUID cuando el origen seguro lo ofrece", () => {
  assert.equal(createBrowserSatelliteId({ randomUUID: () => "native-id" }), "native-id");
});

test("genera un UUID v4 mediante getRandomValues en HTTP local", () => {
  const id = createBrowserSatelliteId({
    getRandomValues(bytes) {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    }
  });
  assert.equal(id, "00010203-0405-4607-8809-0a0b0c0d0e0f");
});
