import * as path from "node:path";
import * as fs from "node:fs";

import { TauronAdapter } from "./adapters/tauron-adapter.js";
import { SemsAdapter } from "./adapters/sems-adapter.js";
import { PvgisClient } from "./pvgis/pvgis-client.js";
import { getAllProducts } from "./catalog/product-catalog.js";
import { SelfConsumptionStrategy } from "./strategies/self-consumption.js";
import { ScenarioScanner } from "./engine/scenario-scanner.js";
import { createTariffSchedule } from "./types/tariff.js";
import type { TariffType } from "./types/tariff.js";
import type { InputSummary, FinancialAnalysisConfig } from "./types/financial.js";
import type { TimeSeriesRecord } from "./types/timeseries.js";
import type { PvProfileRecord } from "./types/pvgis.js";

// ─── CLI Argument Parsing ────────────────────────────────────

interface CliArgs {
  csvPath: string;
  adapter: "tauron" | "sems";
  tariff: TariffType;
  lat: number;
  lon: number;
  contractedPowerKw: number;
  existingPvKwp: number | null;
  outputPath: string | null;
  tilt: number | null;
  azimuth: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const parsed: Record<string, string> = {};

  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (key !== undefined && value !== undefined) {
      parsed[key.replace(/^--/, "")] = value;
    }
  }

  const csvPath = parsed["csv"];
  if (!csvPath) {
    printUsage();
    process.exit(1);
  }

  const lat = parseFloat(parsed["lat"] ?? "52.23");
  const lon = parseFloat(parsed["lon"] ?? "21.01");
  const contractedPowerKw = parseFloat(parsed["contracted-power"] ?? "10");
  const existingPvKwp = parsed["existing-pv"] !== undefined
    ? parseFloat(parsed["existing-pv"])
    : null;
  const tilt = parsed["tilt"] !== undefined ? parseFloat(parsed["tilt"]) : null;
  const azimuth = parsed["azimuth"] !== undefined ? parseFloat(parsed["azimuth"]) : null;

  const numericChecks: Array<[string, number | null]> = [
    ["--lat", lat],
    ["--lon", lon],
    ["--contracted-power", contractedPowerKw],
    ["--existing-pv", existingPvKwp],
    ["--tilt", tilt],
    ["--azimuth", azimuth],
  ];
  for (const [flag, value] of numericChecks) {
    if (value !== null && Number.isNaN(value)) {
      console.error(`❌ Nieprawidłowa wartość liczbowa dla flagi ${flag}.`);
      printUsage();
      process.exit(1);
    }
  }

  return {
    csvPath,
    adapter: (parsed["adapter"] as "tauron" | "sems") ?? "tauron",
    tariff: (parsed["tariff"] as TariffType) ?? "G11",
    lat,
    lon,
    contractedPowerKw,
    existingPvKwp,
    outputPath: parsed["output"] ?? null,
    tilt,
    azimuth,
  };
}

function printUsage(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║       Kalkulator Magazynu Energii — Silnik Rekomendacyjny   ║
╚══════════════════════════════════════════════════════════════╝

USAGE:
  tsx src/index.ts \\
    --csv ./dane/tauron_2024.csv \\
    --adapter tauron|sems \\
    --tariff G11|G12|G12w|G13 \\
    --lat 52.23 --lon 21.01 \\
    --contracted-power 10 \\
    [--existing-pv 6.5] \\
    [--tilt 35 --azimuth 180] \\
    [--output ./raport.json]

OPTIONS:
  --csv               Ścieżka do pliku CSV z danymi energetycznymi (wymagane)
  --adapter           Typ adaptera CSV: tauron, sems (domyślnie: tauron)
  --tariff            Typ taryfy: G11, G12, G12w, G13 (domyślnie: G11)
  --lat               Szerokość geograficzna (domyślnie: 52.23 = Warszawa)
  --lon               Długość geograficzna (domyślnie: 21.01)
  --contracted-power  Moc umowna [kW] (domyślnie: 10)
  --existing-pv       Istniejąca moc PV [kWp] — pomiń jeśli brak PV (wymaga --adapter sems)
  --tilt              Kąt nachylenia paneli PV [°] — wymaga podania razem z --azimuth
                      (domyślnie: PVGIS dobiera kąt optymalny)
  --azimuth           Azymut/orientacja paneli PV [°, 180 = południe] — wymaga --tilt
  --output            Ścieżka do pliku wyjściowego JSON (opcjonalnie)
`);
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.adapter === "tauron" && args.existingPvKwp !== null) {
    console.error(
      "❌ Nieprawidłowa kombinacja: --adapter tauron razem z --existing-pv.\n" +
      "   Dane z licznika OSD (Tauron) dla obiektu z już istniejącym PV są\n" +
      "   rozliczane netto (po autokonsumpcji), więc nie da się ich poprawnie\n" +
      "   połączyć z osobno symulowaną produkcją PV z PVGIS — wynik byłby błędny\n" +
      "   (podwójne uwzględnienie efektu istniejącej instalacji).\n" +
      "   Dla obiektu z PV użyj: --adapter sems z danymi z monitoringu falownika."
    );
    process.exit(1);
  }

  console.log("🔌 Kalkulator Magazynu Energii");
  console.log("─".repeat(50));
  console.log(`📂 CSV: ${args.csvPath}`);
  console.log(`🔧 Adapter: ${args.adapter}`);
  console.log(`💰 Taryfa: ${args.tariff}`);
  console.log(`📍 Lokalizacja: ${args.lat}, ${args.lon}`);
  console.log(`⚡ Moc umowna: ${args.contractedPowerKw} kW`);
  if (args.existingPvKwp !== null) {
    console.log(`☀️  Istniejące PV: ${args.existingPvKwp} kWp`);
  } else {
    console.log(`☀️  Istniejące PV: brak — program dobierze optymalny rozmiar instalacji PV (skan 3–15 kWp)`);
  }
  console.log("─".repeat(50));

  // --- 1. Parsowanie CSV ---
  console.log("\n📊 Parsowanie pliku CSV...");
  let loadProfile: TimeSeriesRecord[];

  if (args.adapter === "sems") {
    const adapter = new SemsAdapter();
    loadProfile = await adapter.parse(args.csvPath);
  } else {
    const adapter = new TauronAdapter();
    loadProfile = await adapter.parse(args.csvPath);
  }

  console.log(`   ✅ Wczytano ${loadProfile.length} rekordów`);

  if (loadProfile.length === 0) {
    console.error("❌ Brak danych w pliku CSV. Sprawdź format i nazwy kolumn.");
    process.exit(1);
  }

  // --- Podsumowanie zużycia ---
  let totalConsumption = 0;
  for (const record of loadProfile) {
    totalConsumption += record.loadKw * 0.25;
  }
  console.log(`   📈 Roczne zużycie: ${totalConsumption.toFixed(0)} kWh`);

  // --- 2. Pobieranie profilu PV z PVGIS (jeśli brak istniejącego PV) ---
  let pvBaseProfile: PvProfileRecord[] | null = null;

  if (args.adapter === "sems" && args.existingPvKwp !== null) {
    // Dane SEMS zawierają produkcję PV — nie potrzebujemy PVGIS
    console.log("\n☀️  Profil PV: z danych SEMS (realna produkcja)");
    pvBaseProfile = null;
  } else {
    // Pobieramy profil PV z PVGIS dla 1 kWp (potem skalujemy)
    console.log("\n☀️  Pobieranie profilu PV z PVGIS API (1 kWp)...");
    const pvgis = new PvgisClient();
    const pvgisOptions = args.tilt !== null && args.azimuth !== null
      ? { tilt: args.tilt, azimuth: args.azimuth }
      : undefined;
    try {
      pvBaseProfile = await pvgis.fetchPvProfile(args.lat, args.lon, 1, pvgisOptions);
      console.log(`   ✅ Pobrano ${pvBaseProfile.length} rekordów PV (15-min)`);
    } catch (error) {
      console.error(`❌ Błąd pobierania danych PV z PVGIS: ${error instanceof Error ? error.message : String(error)}`);
      console.error("   Bez profilu produkcji PV analiza PV+magazynu byłaby błędna (zerowa produkcja PV).");
      console.error("   Sprawdź współrzędne (--lat/--lon) i połączenie z internetem, po czym spróbuj ponownie.");
      process.exit(1);
    }
  }

  // --- 3. Konfiguracja skanera ---
  const tariff = createTariffSchedule(args.tariff);
  const products = getAllProducts();
  const strategy = new SelfConsumptionStrategy();

  // Moce PV do przetestowania
  const pvSizesToTest: number[] = args.existingPvKwp !== null
    ? [args.existingPvKwp] // Użytkownik ma PV — testujemy tylko tę moc
    : [3, 4, 5, 6, 7, 8, 9, 10, 12, 15]; // Skanujemy różne moce

  const financialConfig: FinancialAnalysisConfig = {
    horizonYears: 15,
    discountRate: 0.05,
    energyPriceInflation: 0.03,
  };

  const inputSummary: InputSummary = {
    tariffType: args.tariff,
    annualConsumptionKwh: totalConsumption,
    existingPvKwp: args.existingPvKwp,
    location: { lat: args.lat, lon: args.lon },
    contractedPowerKw: args.contractedPowerKw,
  };

  // --- 4. Skanowanie scenariuszy ---
  const totalBessConfigs = products.reduce((sum, p) => sum + p.maxModules, 0);
  const totalScenarios = pvSizesToTest.length * totalBessConfigs;
  console.log(
    `\n🔍 Skanowanie ${totalScenarios} scenariuszy ` +
    `(${pvSizesToTest.length} PV × ${totalBessConfigs} konfiguracji magazynu z ${products.length} produktów)...`
  );

  const scanner = new ScenarioScanner(strategy, financialConfig);
  const report = scanner.scan(loadProfile, pvBaseProfile, {
    pvSizesToTest,
    products: [...products],
    tariff,
    financialConfig,
    topN: 3,
  }, inputSummary);

  // --- 5. Wyświetlenie wyników ---
  console.log("\n" + "═".repeat(76));
  console.log("  WYNIKI ANALIZY — TOP 3 KONFIGURACJE");
  console.log("═".repeat(76));

  // Tabela porównawcza
  console.log("\n┌─────────────────────────────────┬───────┬──────────┬───────────┬──────────┬──────────┬──────────┐");
  console.log("│ Konfiguracja                    │ PV    │ Autokon. │ Pobór     │ Cykli/r  │ Koszt    │ Payback  │");
  console.log("│                                 │ [kWp] │ [%]      │ sieć[kWh] │          │ [PLN]    │ [lata]   │");
  console.log("├─────────────────────────────────┼───────┼──────────┼───────────┼──────────┼──────────┼──────────┤");

  // Baseline
  const bl = report.baseline;
  console.log(
    `│ ${"Baseline (bez PV/BESS)".padEnd(31)} │ ${"-".padStart(5)} │ ${"-".padStart(6)}%  │ ${bl.totalGridImportKwh.toFixed(0).padStart(9)} │ ${"-".padStart(8)} │ ${"-".padStart(8)} │ ${"-".padStart(8)} │`
  );

  // Top 3
  for (let i = 0; i < report.top3.length; i++) {
    const fr = report.top3[i]!;
    const sim = fr.simulationResult;
    const bc = sim.bessConfig;
    if (bc === null) continue;

    const capacity = bc.product.usableCapacityKwh * bc.moduleCount;
    const name = `${bc.product.model} ${capacity}kWh`;
    const label = `#${i + 1} ${name}`;

    console.log(
      `│ ${label.padEnd(31).slice(0, 31)} │ ${sim.pvSizeKwp.toString().padStart(5)} │ ${sim.selfConsumptionRate.toFixed(0).padStart(6)}%  │ ${sim.totalGridImportKwh.toFixed(0).padStart(9)} │ ${sim.annualCycles.toFixed(1).padStart(8)} │ ${fr.investmentCostPln.toFixed(0).padStart(8)} │ ${(fr.paybackYears === Infinity ? "∞" : fr.paybackYears.toFixed(1)).padStart(8)} │`
    );
  }

  console.log("└─────────────────────────────────┴───────┴──────────┴───────────┴──────────┴──────────┴──────────┘");

  // Rekomendacja
  console.log("\n" + report.recommendation);

  // --- 6. Zapis raportu JSON ---
  if (args.outputPath !== null) {
    // Usuwamy steps z raportu JSON (za duży) — zostawiamy tylko KPI
    const compactReport = {
      ...report,
      baseline: { ...report.baseline, steps: `[${report.baseline.steps.length} records — omitted for compactness]` },
      allScenarios: report.allScenarios.map((fr) => ({
        ...fr,
        simulationResult: { ...fr.simulationResult, steps: `[${fr.simulationResult.steps.length} records]` },
      })),
      top3: report.top3.map((fr) => ({
        ...fr,
        simulationResult: { ...fr.simulationResult, steps: `[${fr.simulationResult.steps.length} records]` },
      })),
    };

    const outputPath = path.resolve(args.outputPath);
    fs.writeFileSync(outputPath, JSON.stringify(compactReport, null, 2), "utf8");
    console.log(`\n💾 Raport zapisano do: ${outputPath}`);
  }

  console.log(`\n✅ Analiza zakończona. Przeskanowano ${report.allScenarios.length} scenariuszy.`);
}

main().catch((error) => {
  console.error(`❌ Błąd krytyczny: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
