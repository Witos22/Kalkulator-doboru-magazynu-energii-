import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTariffSchedule } from "./tariff.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function expectedG12(hour: number): "dzien" | "noc" {
  return hour >= 6 && hour < 22 ? "dzien" : "noc";
}

/** Strefy G12 dla stycznia i lipca, godzina po godzinie, w podanej strefie procesu. */
function g12Zones(tz: string): string[] {
  const script = `
    import { createTariffSchedule } from "./src/types/tariff.ts";
    const tariff = createTariffSchedule("G12");
    const names = [];
    for (const month of [0, 6]) {
      for (let hour = 0; hour < 24; hour++) {
        names.push(tariff.resolve(new Date(Date.UTC(2024, month, 16, hour, 0))).name);
      }
    }
    process.stdout.write(names.join(","));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: projectRoot,
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.split(",");
}

test("G12 ma te same strefy przy TZ=UTC i TZ=Europe/Warsaw", () => {
  const utc = g12Zones("UTC");
  const warsaw = g12Zones("Europe/Warsaw");
  const expected: string[] = [];
  for (let month = 0; month < 2; month++) {
    for (let hour = 0; hour < 24; hour++) expected.push(expectedG12(hour));
  }
  assert.deepEqual(utc, expected);
  assert.deepEqual(warsaw, expected);

  const tariff = createTariffSchedule("G12");
  const summerMorning = new Date(Date.UTC(2024, 6, 16, 6, 0));
  const summerBefore = new Date(Date.UTC(2024, 6, 16, 4, 0));
  assert.equal(tariff.resolve(summerMorning).name, "dzien");
  assert.equal(tariff.resolve(summerBefore).name, "noc");
});
