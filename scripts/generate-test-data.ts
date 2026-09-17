/**
 * Generator testowego pliku CSV w formacie Tauron.
 * Symuluje typowe zużycie domu jednorodzinnego (~5000 kWh/rok).
 *
 * Profil zużycia:
 * - Noc (22:00-6:00): bazowe 0.3 kW (lodówka, standby)
 * - Poranek (6:00-8:00): 1.5 kW (pobudka, gotowanie, prysznic)
 * - Dzień (8:00-16:00): 0.5 kW (dom pusty)
 * - Popołudnie (16:00-22:00): 2.0 kW (gotowanie, TV, pranie, ogrzewanie CWU)
 * - Weekendy: +30% w ciągu dnia
 */

import * as fs from "node:fs";
import * as path from "node:path";

const OUTPUT_PATH = path.resolve("test-data", "tauron_test_2024.csv");

function getLoadKw(hour: number, isWeekend: boolean): number {
  let base: number;

  if (hour >= 22 || hour < 6) {
    base = 0.3; // Noc
  } else if (hour >= 6 && hour < 8) {
    base = 1.5; // Poranek
  } else if (hour >= 8 && hour < 16) {
    base = 0.5; // Dzień (dom pusty)
  } else {
    base = 2.0; // Popołudnie/wieczór
  }

  // Weekendy — wyższe zużycie w ciągu dnia
  if (isWeekend && hour >= 8 && hour < 16) {
    base *= 1.5;
  }

  // Losowa wariancja ±20%
  const variance = 0.8 + Math.random() * 0.4;
  return base * variance;
}

// --- Generuj plik CSV ---
const lines: string[] = ["Data;Godzina;EC [kWh]"];

const startDate = new Date(Date.UTC(2024, 0, 1, 0, 0));
const endDate = new Date(Date.UTC(2025, 0, 1, 0, 0));

let current = new Date(startDate);
let totalKwh = 0;
let recordCount = 0;

while (current < endDate) {
  const day = current.getUTCDate().toString().padStart(2, "0");
  const month = (current.getUTCMonth() + 1).toString().padStart(2, "0");
  const year = current.getUTCFullYear();
  const hours = current.getUTCHours().toString().padStart(2, "0");
  const minutes = current.getUTCMinutes().toString().padStart(2, "0");

  const dayOfWeek = current.getUTCDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  const loadKw = getLoadKw(current.getUTCHours(), isWeekend);
  const energyKwh = loadKw * 0.25; // 15 min = 0.25h

  // Format: DD.MM.YYYY
  const dateStr = `${day}.${month}.${year}`;
  const timeStr = `${hours}:${minutes}`;

  // Tauron uses comma as decimal separator
  const energyStr = energyKwh.toFixed(4).replace(".", ",");

  lines.push(`${dateStr};${timeStr};${energyStr}`);
  totalKwh += energyKwh;
  recordCount++;

  // Następne 15 min
  current = new Date(current.getTime() + 15 * 60 * 1000);
}

// Upewnij się, że katalog istnieje
const dir = path.dirname(OUTPUT_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

fs.writeFileSync(OUTPUT_PATH, lines.join("\n"), "utf8");

console.log(`✅ Wygenerowano testowy CSV:`);
console.log(`   📂 ${OUTPUT_PATH}`);
console.log(`   📊 ${recordCount} rekordów (15-min)`);
console.log(`   ⚡ Roczne zużycie: ${totalKwh.toFixed(0)} kWh`);
