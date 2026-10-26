import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { MojLicznikDailyAdapter } from "./moj-licznik-daily-adapter.js";
import { calibratePvToExport } from "./pv-export-calibration.js";
import { SolarModel } from "../solar/solar-model.js";
import { createTariffSchedule } from "../types/tariff.js";
import type { PvProfileRecord } from "../types/pv-profile.js";
import { kwToKwhPerStep } from "../utils/energy-math.js";

function day(month: number, dayNum: number, pvKw: number): PvProfileRecord {
  return { timestamp: new Date(Date.UTC(2024, month, dayNum, 12, 0)), pvProductionKw: pvKw };
}

test("k jest obcinane do [0,6; 1,2], a lato poniżej 0,8 daje ostrzeżenie", () => {
  const profile: PvProfileRecord[] = [];
  const july: { year: number; month: number; day: number; exportKwh: number }[] = [];
  const august: { year: number; month: number; day: number; exportKwh: number }[] = [];
  for (let d = 1; d <= 10; d++) {
    const sunny = d > 8;
    profile.push(day(6, d, sunny ? 40 : 4));
    july.push({ year: 2025, month: 6, day: d, exportKwh: sunny ? 14 : 0 });
    profile.push(day(7, d, sunny ? 40 : 4));
    august.push({ year: 2025, month: 7, day: d, exportKwh: sunny ? 5 : 0 });
  }

  const result = calibratePvToExport(profile, [...july, ...august]);
  const julyK = result.months.find((m) => m.month === 6)?.k;
  const augustK = result.months.find((m) => m.month === 7)?.k;
  assert.equal(julyK, 1.2);
  assert.equal(augustK, 0.6);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /sierpniu/);

  const augustSunny = result.profile.find((r) => r.timestamp.getUTCMonth() === 7 && r.timestamp.getUTCDate() === 10);
  assert.ok(Math.abs((augustSunny?.pvProductionKw ?? 0) - 24) < 1e-9);
});

test("na plikach testowych ucięcia spadają o co najmniej połowę, a G12 i G12w różnią się o mniej niż 5%", async () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const plus = readdirSync(path.join(root, "pobor_A+_ardomago")).filter((f) => f.endsWith(".xls")).map((f) => path.join(root, "pobor_A+_ardomago", f));
  const minus = readdirSync(path.join(root, "pobor_A-_ardomago")).filter((f) => f.endsWith(".xls")).map((f) => path.join(root, "pobor_A-_ardomago", f));
  const model = new SolarModel();
  const unit = await model.fetchPvProfile(52.23, 21.01, 1, { tilt: 35, azimuth: 180, year: 2024 });
  const kwp = 20;
  const pv = unit.map((r) => ({ timestamp: r.timestamp, pvProductionKw: r.pvProductionKw * kwp }));
  const adapter = new MojLicznikDailyAdapter();
  const g12 = createTariffSchedule("G12");
  const g12w = createTariffSchedule("G12w");

  const before = await adapter.parse(plus, minus, pv, g12, { calibrate: false });
  const after = await adapter.parse(plus, minus, pv, g12);
  const afterW = await adapter.parse(plus, minus, pv, g12w);
  const load = (records: readonly { loadKw: number }[]) => records.reduce((sum, r) => sum + kwToKwhPerStep(r.loadKw), 0);
  const loadG12 = load(after.records);
  const loadG12w = load(afterW.records);

  assert.ok(before.dataQuality.clippedDayZoneCount > 0);
  assert.ok(
    after.dataQuality.clippedDayZoneCount <= before.dataQuality.clippedDayZoneCount * 0.5,
    `ucięcia ${before.dataQuality.clippedDayZoneCount} → ${after.dataQuality.clippedDayZoneCount}`,
  );
  assert.ok(
    Math.abs(loadG12 - loadG12w) / Math.max(loadG12, loadG12w) < 0.05,
    `G12 ${loadG12.toFixed(0)} vs G12w ${loadG12w.toFixed(0)}`,
  );
});
