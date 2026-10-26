import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DeviceDatabaseError, loadDeviceDatabase, validateDeviceDatabase } from "./device-database.js";
import { getProductByModel } from "./product-catalog.js";
import { bessPowerKw } from "../bess/bess-power.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../public");

function readCatalog(): { storages: unknown; inverters: unknown; pvModules: unknown } {
  return {
    storages: JSON.parse(fs.readFileSync(path.join(publicDir, "storages.json"), "utf8")) as unknown,
    inverters: JSON.parse(fs.readFileSync(path.join(publicDir, "inverters.json"), "utf8")) as unknown,
    pvModules: JSON.parse(fs.readFileSync(path.join(publicDir, "pv-modules.json"), "utf8")) as unknown,
  };
}

describe("baza urządzeń", () => {
  test("start wczytuje kompletne karty i powiązania", () => {
    const db = loadDeviceDatabase();
    assert.ok(db.storages.length >= 10);
    assert.ok(db.inverters.length >= 12);
    assert.ok(db.pvModules.length >= 3);
    assert.ok(db.inverters.some((item) => item.batteryCapable.value));
    assert.ok(db.inverters.some((item) => !item.batteryCapable.value));
    for (const storage of db.storages) {
      assert.ok(storage.builtInInverter || storage.compatibleInverterIds.length > 0);
    }

    const s0 = getProductByModel("LUNA2000-15-S0");
    assert.ok(s0);
    assert.equal(s0.modulePowerKw, 2.5);
    assert.equal(s0.towerPowerLimitKw, 5);
    assert.equal(s0.maxChargePowerKw, 5);
    assert.equal(bessPowerKw(s0, 2), 10);

    const bat6 = getProductByModel("SigenStor BAT 6.0");
    const bat10 = getProductByModel("SigenStor BAT 10.0");
    assert.equal(db.storages.find((item) => item.id === "sigenstor-bat-6")?.nominalCapacityKwh.value, 6.02);
    assert.equal(bat6?.usableCapacityKwh, 5.84);
    assert.equal(db.storages.find((item) => item.id === "sigenstor-bat-10")?.nominalCapacityKwh.value, 9.04);
    assert.equal(bat10?.usableCapacityKwh, 8.76);
  });

  test("brak pola przerywa wczytanie", () => {
    const raw = readCatalog();
    const storages = raw.storages as Array<Record<string, unknown>>;
    const broken = { ...storages[0] };
    delete broken["modulePowerKw"];
    assert.throws(
      () => validateDeviceDatabase({ ...raw, storages: [broken, ...storages.slice(1)] }),
      (error: unknown) => error instanceof DeviceDatabaseError && /modulePowerKw/.test(error.message),
    );
  });
});
