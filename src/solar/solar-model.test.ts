import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SolarModel } from "./solar-model.js";

const CITIES = {
  warszawa: { lat: 52.2297, lon: 21.0122, min: 950, max: 1050 },
  gdansk: { lat: 54.3483, lon: 18.654, min: 920, max: 1020 },
  krakow: { lat: 50.0647, lon: 19.945, min: 980, max: 1080 },
} as const;

function annualKwh(profile: ReadonlyArray<{ pvProductionKw: number }>): number {
  let energy = 0;
  for (const record of profile) energy += record.pvProductionKw * 0.25;
  return energy;
}

describe("SolarModel", () => {
  const model = new SolarModel();
  const south = { tilt: 35, azimuth: 180 } as const;

  test("generuje dokładnie 35040 rekordów dla roku 2023", async () => {
    const profile = await model.fetchPvProfile(CITIES.warszawa.lat, CITIES.warszawa.lon, 1, south);

    assert.equal(profile.length, 35040);

    const first = profile[0]!;
    assert.equal(first.timestamp.getUTCFullYear(), 2023);
    assert.equal(first.timestamp.getUTCMonth(), 0);
    assert.equal(first.timestamp.getUTCDate(), 1);
    assert.equal(first.timestamp.getUTCHours(), 0);
    assert.equal(first.timestamp.getUTCMinutes(), 0);

    const last = profile[profile.length - 1]!;
    assert.equal(last.timestamp.getUTCFullYear(), 2023);
    assert.equal(last.timestamp.getUTCMonth(), 11);
    assert.equal(last.timestamp.getUTCDate(), 31);
    assert.equal(last.timestamp.getUTCHours(), 23);
    assert.equal(last.timestamp.getUTCMinutes(), 45);
  });

  test("1 kWp, 35°/S: Warszawa, Gdańsk i Kraków w pasmach uzysku", async () => {
    for (const [name, city] of Object.entries(CITIES)) {
      const started = performance.now();
      const profile = await model.fetchPvProfile(city.lat, city.lon, 1, south);
      const elapsedMs = performance.now() - started;
      const yieldKwh = annualKwh(profile);
      assert.ok(
        yieldKwh >= city.min && yieldKwh <= city.max,
        `${name}: ${yieldKwh.toFixed(1)} kWh poza ${city.min}–${city.max}`,
      );
      assert.ok(elapsedMs < 100, `${name}: obliczenie trwało ${elapsedMs.toFixed(1)} ms`);
      for (const record of profile) {
        assert.ok(record.pvProductionKw >= 0);
        assert.ok(record.pvProductionKw <= 1 / 1.2 + 1e-9);
      }
    }
  });

  test("wschód i zachód to 80–88% południa", async () => {
    for (const [name, city] of Object.entries(CITIES)) {
      const southProfile = await model.fetchPvProfile(city.lat, city.lon, 1, south);
      const eastProfile = await model.fetchPvProfile(city.lat, city.lon, 1, { tilt: 35, azimuth: 90 });
      const westProfile = await model.fetchPvProfile(city.lat, city.lon, 1, { tilt: 35, azimuth: 270 });
      const southKwh = annualKwh(southProfile);
      const eastRatio = annualKwh(eastProfile) / southKwh;
      const westRatio = annualKwh(westProfile) / southKwh;
      assert.ok(eastRatio >= 0.8 && eastRatio <= 0.88, `${name} wschód ${(eastRatio * 100).toFixed(1)}%`);
      assert.ok(westRatio >= 0.8 && westRatio <= 0.88, `${name} zachód ${(westRatio * 100).toFixed(1)}%`);
    }
  });

  test("dwa uruchomienia dają ten sam wynik i model nie woła fetch", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("fetch nie powinien być wywołany");
    }) as typeof fetch;

    try {
      const first = await model.fetchPvProfile(CITIES.warszawa.lat, CITIES.warszawa.lon, 1, south);
      const second = await model.fetchPvProfile(CITIES.warszawa.lat, CITIES.warszawa.lon, 1, south);
      assert.equal(fetchCalls, 0);
      assert.equal(first.length, second.length);
      for (let i = 0; i < first.length; i++) {
        assert.equal(first[i]!.pvProductionKw, second[i]!.pvProductionKw);
        assert.equal(first[i]!.timestamp.getTime(), second[i]!.timestamp.getTime());
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
