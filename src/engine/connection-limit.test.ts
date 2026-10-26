import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEW_PV_SIZES_KWP,
  connectionUpgradeWarning,
  maxInstallablePvKwp,
  pvSizesKeepingDeclared,
  pvSizesWithinLimit,
} from "./connection-limit.js";
import { inverterPaths } from "../catalog/inverter-decision.js";
import { loadDeviceDatabase } from "../catalog/device-database.js";

test("dobór nowej PV nie przekracza zadeklarowanej mocy przyłącza", () => {
  const threePhase = pvSizesWithinLimit(NEW_PV_SIZES_KWP, maxInstallablePvKwp(3, 14));
  assert.ok(threePhase.length > 0);
  assert.ok(threePhase.every((size) => size <= 14));
  assert.ok(!threePhase.includes(50));
  assert.ok(threePhase.includes(14));

  const onePhase = pvSizesWithinLimit(NEW_PV_SIZES_KWP, maxInstallablePvKwp(1, 5.75));
  assert.ok(onePhase.every((size) => size <= 5.75));
  assert.ok(onePhase.includes(5.75));
  assert.ok(!onePhase.includes(6));
});

test("istniejące PV większe niż przyłącze zostaje w analizie i dostaje ostrzeżenie", () => {
  assert.deepEqual(pvSizesKeepingDeclared(38, [38, 39, 40], 14), [38]);
  const warning = connectionUpgradeWarning(38, 14);
  assert.match(warning ?? "", /zmiany warunków przyłączenia/);
  assert.match(warning ?? "", /38/);
  assert.equal(connectionUpgradeWarning(10, 14), undefined);
});

test("przyłącze jednofazowe dobiera tylko falownik jednofazowy", () => {
  const db = loadDeviceDatabase();
  const storage = db.storages.find((item) => item.id === "luna2000-5-s0");
  assert.ok(storage);
  const paths = inverterPaths({
    hasExistingPv: false,
    planes: [],
    phases: 1,
    pvKwp: 3,
    compatibleInverterIds: storage.compatibleInverterIds,
    builtInInverter: false,
    replacementCostNetPln: 8_000,
    inverters: db.inverters,
  });
  assert.equal(paths.length, 1);
  assert.equal(paths[0]!.inverterBatteryKw, 5);
  const onePhase = db.inverters.filter((item) => item.phases.value === 1 && item.batteryCapable.value);
  assert.ok(onePhase.some((item) => item.acKw.value === paths[0]!.inverterBatteryKw));
});
