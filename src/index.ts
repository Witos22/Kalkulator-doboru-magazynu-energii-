import * as path from "node:path";
import * as fs from "node:fs";

import { runAnalysis, AnalysisError } from "./analysis-runner.js";
import { loadDeviceDatabase } from "./catalog/device-database.js";
import type { AdapterType, PvInstallation } from "./analysis-runner.js";
import { APPLIANCES } from "./adapters/declared-consumption-adapter.js";
import type { Appliance } from "./adapters/declared-consumption-adapter.js";
import type { TariffType, TariffPrices } from "./types/tariff.js";
import type { ClientSegment, BuildingType } from "./types/financial.js";

// ─── CLI Argument Parsing ────────────────────────────────────

interface CliArgs {
  annualConsumptionKwh: number | null;
  appliances: Appliance[];
  csvPath: string | null;
  adapter: AdapterType;
  tariff: TariffType;
  targetTariff: TariffType | null;
  targetTariffPrices: TariffPrices | null;
  lat: number;
  lon: number;
  contractedPowerKw: number;
  existingPvKwp: number | null;
  outputPath: string | null;
  tilt: number | null;
  azimuth: number | null;
  // Tylko dla --adapter moj-licznik-daily:
  csvAPlusPaths: string[] | null;
  csvAMinusPaths: string[] | null;
  /** Wiele instalacji PV o różnych azymutach/kątach (tylko moj-licznik-daily); nadpisuje existing-pv/tilt/azimuth */
  installations: PvInstallation[] | null;
  /** Korekta cen taryfy (energia/dystrybucja per strefa) */
  tariffPrices: TariffPrices | null;
  /** Segment klienta (VAT: netto dla firm, brutto dla prosumentów/B2C). Domyślnie wg adaptera. */
  clientSegment: ClientSegment | null;
  /** Wartość eksportu [PLN/kWh] — korekta domyślnej wartości orientacyjnej (0,30 zł) */
  exportPricePerKwh: number | null;
  gridConnectionPowerKw: number | null;
  exportLimitKw: number | null;
  /** System rozliczeń prosumenta: net-billing (domyślnie) albo opusty (nieobsługiwane, blokuje analizę) */
  settlementSystem: "net-billing" | "opusty" | null;
  /** Typ budynku — sugeruje stawkę VAT (mieszkalny ≤300m² → 8%, inne → 23%) */
  buildingType: BuildingType | null;
  /** Jawna korekta stawki VAT [ułamek] — nadpisuje sugestię z buildingType */
  vatRatePercent: number | null;
  /** Marka istniejącego falownika klienta (np. "Huawei", "Sigenergy") */
  existingInverterBrand: string | null;
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

  const adapter = (parsed["adapter"] as AdapterType) ?? "tauron";

  const csvPath = parsed["csv"] ?? null;

  const readXlsDir = (dirFlag: string): string[] | null => {
    const dir = parsed[dirFlag];
    if (dir === undefined) return null;
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      console.error(`❌ --${dirFlag} nie jest istniejącym katalogiem: ${dir}`);
      printUsage();
      process.exit(1);
    }
    return fs.readdirSync(dir)
      .filter((f) => /\.xlsx?$/i.test(f))
      .map((f) => path.join(dir, f));
  };
  const csvAPlusPaths = readXlsDir("a-plus-dir");
  const csvAMinusPaths = readXlsDir("a-minus-dir");

  if (adapter === "moj-licznik-daily") {
    if (!csvAPlusPaths?.length || !csvAMinusPaths?.length) {
      console.error("❌ Adapter moj-licznik-daily wymaga --a-plus-dir i --a-minus-dir (katalogi z 12 plikami .xls każdy).");
      printUsage();
      process.exit(1);
    }
    if (parsed["existing-pv"] === undefined && parsed["installations"] === undefined) {
      console.error("❌ Adapter moj-licznik-daily wymaga --existing-pv (moc instalacji PV [kWp]) albo --installations.");
      printUsage();
      process.exit(1);
    }
  } else if (adapter === "declared") {
    if (parsed["annual-consumption"] === undefined) {
      console.error("❌ Adapter declared wymaga --annual-consumption (roczne zużycie z sieci [kWh], z faktur).");
      printUsage();
      process.exit(1);
    }
  } else if (!csvPath) {
    printUsage();
    process.exit(1);
  }

  const annualConsumptionKwh = parsed["annual-consumption"] !== undefined ? parseFloat(parsed["annual-consumption"]) : null;
  const appliances = (parsed["appliances"] ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "") as Appliance[];
  const unknownAppliance = appliances.find((a) => !APPLIANCES.includes(a));
  if (unknownAppliance !== undefined) {
    console.error(`❌ Nieznany odbiornik w --appliances: ${unknownAppliance} (dozwolone: ${APPLIANCES.join(", ")})`);
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
  const exportPricePerKwh = parsed["export-price"] !== undefined ? parseFloat(parsed["export-price"]) : null;
  const gridConnectionPowerKw = parsed["grid-connection-kw"] !== undefined ? parseFloat(parsed["grid-connection-kw"]) : null;
  const exportLimitKw = parsed["export-limit-kw"] !== undefined ? parseFloat(parsed["export-limit-kw"]) : null;

  let installations: PvInstallation[] | null = null;
  if (parsed["installations"] !== undefined) {
    try {
      const raw = JSON.parse(parsed["installations"]) as Array<{ kwp: number; tilt?: number; azimuth?: number; inverter?: string; inverterAcKw?: number; planned?: boolean }>;
      if (!Array.isArray(raw) || raw.length === 0) throw new Error("pusta lista");
      installations = raw.map((r) => ({
        kwp: r.kwp,
        tilt: r.tilt ?? null,
        azimuth: r.azimuth ?? null,
        inverterBrand: r.inverter ?? "",
        inverterAcKw: r.inverterAcKw ?? NaN,
        planned: r.planned === true,
      }));
    } catch (error) {
      console.error(`❌ Nieprawidłowy format --installations (oczekiwano JSON, np. '[{"kwp":6,"tilt":35,"azimuth":180,"inverter":"Huawei","inverterAcKw":5}]'): ${error instanceof Error ? error.message : error}`);
      printUsage();
      process.exit(1);
    }
  }

  const numericChecks: Array<[string, number | null]> = [
    ["--annual-consumption", annualConsumptionKwh],
    ["--lat", lat],
    ["--lon", lon],
    ["--contracted-power", contractedPowerKw],
    ["--existing-pv", existingPvKwp],
    ["--tilt", tilt],
    ["--azimuth", azimuth],
    ["--export-price", exportPricePerKwh],
    ["--grid-connection-kw", gridConnectionPowerKw],
    ["--export-limit-kw", exportLimitKw],
  ];
  for (const [flag, value] of numericChecks) {
    if (value !== null && Number.isNaN(value)) {
      console.error(`❌ Nieprawidłowa wartość liczbowa dla flagi ${flag}.`);
      printUsage();
      process.exit(1);
    }
  }

  let tariffPrices: TariffPrices | null = null;
  if (parsed["tariff-prices"] !== undefined) {
    try {
      tariffPrices = JSON.parse(parsed["tariff-prices"]) as TariffPrices;
    } catch (error) {
      console.error(`❌ Nieprawidłowy format --tariff-prices (oczekiwano JSON): ${error instanceof Error ? error.message : error}`);
      printUsage();
      process.exit(1);
    }
  }

  let targetTariffPrices: TariffPrices | null = null;
  if (parsed["target-tariff-prices"] !== undefined) {
    try {
      targetTariffPrices = JSON.parse(parsed["target-tariff-prices"]) as TariffPrices;
    } catch (error) {
      console.error(`❌ Nieprawidłowy format --target-tariff-prices (oczekiwano JSON): ${error instanceof Error ? error.message : error}`);
      printUsage();
      process.exit(1);
    }
  }

  return {
    annualConsumptionKwh,
    appliances,
    csvPath,
    adapter,
    tariff: (parsed["tariff"] as TariffType) ?? "G11",
    targetTariff: (parsed["target-tariff"] as TariffType | undefined) ?? null,
    targetTariffPrices,
    lat,
    lon,
    contractedPowerKw,
    existingPvKwp,
    outputPath: parsed["output"] ?? null,
    tilt,
    azimuth,
    csvAPlusPaths,
    csvAMinusPaths,
    installations,
    tariffPrices,
    clientSegment: (parsed["client-segment"] as ClientSegment) ?? null,
    exportPricePerKwh,
    gridConnectionPowerKw,
    exportLimitKw,
    settlementSystem: (parsed["settlement-system"] as "net-billing" | "opusty") ?? null,
    buildingType: (parsed["building-type"] as BuildingType) ?? null,
    vatRatePercent: parsed["vat-rate"] !== undefined ? parseFloat(parsed["vat-rate"]) : null,
    existingInverterBrand: parsed["existing-inverter"] ?? null,
  };
}

function printUsage(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║       Kalkulator Magazynu Energii — Silnik Rekomendacyjny   ║
╚══════════════════════════════════════════════════════════════╝

USAGE (OSD/SEMS/firma):
  tsx src/index.ts \\
    --csv ./dane/tauron_2024.csv \\
    --adapter tauron|sems|firma-15min \\
    --tariff G11|G12|G12w|G13 \\
    --lat 52.23 --lon 21.01 \\
    --contracted-power 10 \\
    [--existing-pv 6.5] \\
    [--tilt 35 --azimuth 180] \\
    [--output ./raport.json]

USAGE (prosument, "Mój Licznik", dane dobowe):
  tsx src/index.ts \\
    --adapter moj-licznik-daily \\
    --a-plus-dir ./pobor_A+ --a-minus-dir ./pobor_A- \\
    --existing-pv 10.8 [--tilt 35 --azimuth 180] \\
    --tariff G12 --lat 52.23 --lon 21.01 --contracted-power 10

OPTIONS:
  --csv               Ścieżka do pliku z danymi energetycznymi (wymagane dla tauron/sems/firma-15min)
  --adapter           Typ adaptera: tauron, sems, firma-15min, moj-licznik-daily, declared (domyślnie: tauron)
  --tariff            Typ taryfy: G11, G12, G12w, G13 (domyślnie: G11). Dla taryf
                      wielostrefowych magazyn dodatkowo dogrywa się z sieci w
                      najtańszej strefie, jeśli to się opłaca (arbitraż taryfowy).
  --annual-consumption  Roczne zużycie z sieci [kWh] z faktur — dla --adapter declared (bez plików pomiarowych, tylko obiekt bez PV)
  --appliances        Odbiorniki kształtujące profil (dla declared), po przecinku: heat-pump, ev, ac, boiler, remote-work
  --lat               Szerokość geograficzna (domyślnie: 52.23 = Warszawa)
  --lon               Długość geograficzna (domyślnie: 21.01)
  --contracted-power  Moc umowna [kW] (domyślnie: 10)
  --existing-pv       Istniejąca moc PV [kWp] — pomiń jeśli brak PV (wymagane dla moj-licznik-daily/sems)
  --tilt              Kąt nachylenia paneli PV [°] — wymaga podania razem z --azimuth
                      (domyślnie: 35° na południe)
  --azimuth           Azymut/orientacja paneli PV [°, 180 = południe] — wymaga --tilt
  --installations     Wiele instalacji PV o różnych azymutach/kątach (tylko moj-licznik-daily), JSON, np.:
                      '[{"kwp":6,"tilt":35,"azimuth":180,"inverter":"Huawei","inverterAcKw":5},{"kwp":3,"tilt":35,"azimuth":90,"inverter":"Huawei","inverterAcKw":3}]'
                      Pola "inverter" (marka falownika) i "inverterAcKw" (moc AC [kW]) są wymagane przy każdej instalacji.
                      Opcjonalne "planned":true oznacza instalację jeszcze niezrealizowaną (liczona jak istniejąca,
                      ale pominięta przy odtwarzaniu zużycia).
                      Nadpisuje --existing-pv/--tilt/--azimuth (suma kwp = łączna moc PV).
  --client-segment    Segment klienta: prosument, firma, b2c — decyduje, czy ceny magazynu/PV
                      są netto (firma) czy brutto z 23% VAT (prosument/b2c). Domyślnie:
                      firma dla --adapter firma-15min, prosument dla pozostałych.
  --grid-connection-kw  Moc przyłączeniowa / zabezpieczenie przedlicznikowe [kW] — limit poboru z sieci (np. ładowania nocnego)
  --export-limit-kw   Limit oddawania do sieci [kW]; 0 = zero export (nadwyżka ucinana)
  --target-tariff     Taryfa docelowa po inwestycji (domyślnie = --tariff); raport pokazuje osobno efekt zmiany taryfy
  --target-tariff-prices  Korekta cen taryfy docelowej (JSON, jak --tariff-prices)
  --tariff-prices     Korekta cen taryfy (domyślne są orientacyjne), JSON, np. dla G12:
                      '{"type":"G12","zones":{"dzien":{"energyPricePerKwh":0.62,"distributionPricePerKwh":0.42},"noc":{"energyPricePerKwh":0.38,"distributionPricePerKwh":0.09}}}'
  --export-price      Wartość 1 kWh oddanej do sieci [PLN/kWh] — domyślnie 0,30 (orientacyjnie,
                      NIE realna stawka RCEm — realny mechanizm depozytu jest bardziej złożony)
  --settlement-system net-billing (domyślnie) albo opusty (net-metering sprzed 04.2022:
                      kredyt 0,8/0,7 w kWh zamiast wyceny pieniężnej; bez arbitrażu z sieci;
                      bilans roczny per strefa — uproszczenie, [DO WERYFIKACJI])
  --building-type     mieszkalny_do_300m2 | mieszkalny_powyzej_300m2 | niemieszkalny —
                      sugeruje stawkę VAT dla prosumenta/b2c (8% dla ≤300m², inaczej 23%,
                      [DO WERYFIKACJI] per przypadek). Nie dotyczy segmentu firma.
  --vat-rate          Jawna korekta stawki VAT [ułamek, np. 0.08], nadpisuje --building-type
  --existing-inverter Marka istniejącego falownika (np. Huawei, Sigenergy, Fronius, "nie wiem").
                      Zgodna hybryda: sprzężenie DC i 0 zł. On-grid albo „nie wiem”:
                      porównanie AC (zostaje stary falownik, sprawność × 0,95) z wymianą na hybrydę.
  --output            Ścieżka do pliku wyjściowego JSON (opcjonalnie)

OPCJE TYLKO DLA --adapter moj-licznik-daily:
  --a-plus-dir        Katalog z 12 plikami "Pobór A+" (raport dobowy, jeden na miesiąc, .xls)
  --a-minus-dir       Katalog z 12 plikami "Energia oddana A-" (raport dobowy, jeden na miesiąc, .xls)
                      Wymagane też: --existing-pv albo --installations. Zużycie liczone osobno
                      dla każdego dnia i każdej strefy (dzień/noc), nie z jednej liczby netto
                      na miesiąc — patrz src/adapters/moj-licznik-daily-adapter.ts.
`);
}

// ─── Main ────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadDeviceDatabase();
  const args = parseArgs(process.argv);

  console.log("🔌 Kalkulator Magazynu Energii");
  console.log("─".repeat(50));
  if (args.adapter === "moj-licznik-daily") {
    console.log(`📂 Raporty dobowe A+: ${args.csvAPlusPaths?.length ?? 0} plików, A-: ${args.csvAMinusPaths?.length ?? 0} plików`);
  } else {
    console.log(`📂 CSV: ${args.csvPath}`);
  }
  console.log(`🔧 Adapter: ${args.adapter}`);
  console.log(`💰 Taryfa obecna: ${args.tariff}${args.targetTariff !== null && args.targetTariff !== args.tariff ? ` → docelowa: ${args.targetTariff}` : ""}`);
  console.log(`📍 Lokalizacja: ${args.lat}, ${args.lon}`);
  console.log(`⚡ Moc umowna: ${args.contractedPowerKw} kW`);
  if (args.existingPvKwp !== null) {
    console.log(`☀️  Istniejące PV: ${args.existingPvKwp} kWp`);
  } else {
    console.log(`☀️  Istniejące PV: brak — program dobierze optymalny rozmiar instalacji PV (skan 3–15 kWp)`);
  }
  console.log("─".repeat(50));
  console.log();

  const report = await runAnalysis({
    adapter: args.adapter,
    tariff: args.tariff,
    targetTariff: args.targetTariff ?? undefined,
    targetTariffPrices: args.targetTariffPrices ?? undefined,
    lat: args.lat,
    lon: args.lon,
    contractedPowerKw: args.contractedPowerKw,
    annualConsumptionKwh: args.annualConsumptionKwh ?? undefined,
    appliances: args.appliances,
    existingPvKwp: args.existingPvKwp,
    tilt: args.tilt,
    azimuth: args.azimuth,
    csvPath: args.csvPath ?? undefined,
    csvAPlusPaths: args.csvAPlusPaths ?? undefined,
    csvAMinusPaths: args.csvAMinusPaths ?? undefined,
    installations: args.installations ?? undefined,
    customTariffPrices: args.tariffPrices ?? undefined,
    clientSegment: args.clientSegment ?? undefined,
    exportPricePerKwh: args.exportPricePerKwh ?? undefined,
    gridConnectionPowerKw: args.gridConnectionPowerKw ?? undefined,
    exportLimitKw: args.exportLimitKw ?? undefined,
    settlementSystem: args.settlementSystem ?? undefined,
    buildingType: args.buildingType ?? undefined,
    vatRatePercent: args.vatRatePercent ?? undefined,
    existingInverterBrand: args.existingInverterBrand ?? undefined,
    onProgress: (message) => console.log(`   ${message}`),
  });

  // --- Wyświetlenie wyników ---
  if (report.assumptions !== undefined && report.assumptions.length > 0) {
    console.log("\nZałożenia:");
    for (const line of report.assumptions) console.log(`  • ${line}`);
  }

  console.log("\n" + "═".repeat(76));
  console.log("  WYNIKI ANALIZY — TOP 3 KONFIGURACJE");
  console.log("═".repeat(76));

  console.log("\n┌─────────────────────────────────┬───────┬──────────┬───────────┬──────────┬──────────┬──────────┐");
  console.log("│ Konfiguracja                    │ PV    │ Autokon. │ Pobór     │ Cykli/r  │ Koszt    │ Payback  │");
  console.log("│                                 │ [kWp] │ [%]      │ sieć[kWh] │          │ [PLN]    │ [lata]   │");
  console.log("├─────────────────────────────────┼───────┼──────────┼───────────┼──────────┼──────────┼──────────┤");

  const bl = report.baseline;
  console.log(
    `│ ${"Baseline (bez PV/BESS)".padEnd(31)} │ ${"-".padStart(5)} │ ${"-".padStart(6)}%  │ ${bl.totalGridImportKwh.toFixed(0).padStart(9)} │ ${"-".padStart(8)} │ ${"-".padStart(8)} │ ${"-".padStart(8)} │`
  );

  const top = report.top3[0];
  if (top !== undefined) {
    console.log(
      `│ ${"Samo PV (bez magazynu)".padEnd(31)} │ ${top.simulationResult.pvSizeKwp.toString().padStart(5)} │ ${top.referenceSelfConsumptionRate.toFixed(0).padStart(6)}%  │ ${top.referenceGridImportKwh.toFixed(0).padStart(9)} │ ${"-".padStart(8)} │ ${"-".padStart(8)} │ ${"-".padStart(8)} │`
    );
  }

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
  if (report.top3[0] !== undefined) {
    console.log(`   (ceny magazynu/PV: ${report.top3[0].priceBasis}, segment: ${report.inputSummary.clientSegment}, system rozliczeń: ${report.inputSummary.settlementSystem}, stawki taryfy: ${report.inputSummary.tariffPricesBasis})`);
  }

  console.log("\n" + report.recommendation);

  if (report.tariffChange !== undefined) {
    const tc = report.tariffChange;
    console.log(
      `
🔄 Sama zmiana taryfy ${tc.currentTariff} → ${tc.targetTariff} (bez inwestycji): koszt energii ` +
      `${tc.annualCostCurrentPln.toFixed(0)} → ${tc.annualCostTargetPln.toFixed(0)} PLN/rok, ` +
      `efekt ${tc.annualEffectPln >= 0 ? "+" : ""}${tc.annualEffectPln.toFixed(0)} PLN/rok. ` +
      `Wyniki magazynu poniżej liczone w taryfie docelowej i NIE zawierają tego efektu.`
    );
  }

  if (report.pvOnly !== undefined) {
    const po = report.pvOnly;
    console.log(
      `\n☀️  Dla porównania — samo PV ${po.pvSizeKwp} kWp bez magazynu: koszt ${po.investmentCostPln.toFixed(0)} PLN, ` +
      `oszczędności ${po.annualSavingsYear1Pln.toFixed(0)} PLN/rok, ` +
      `payback ${po.paybackYears === Infinity ? "nie zwraca się" : po.paybackYears.toFixed(1) + " lat"}, NPV ${po.npvPln.toFixed(0)} PLN`
    );
  }

  // Drugi ranking — po NPV (I8 audytu): ranking po payback faworyzuje najmniejszy magazyn.
  console.log("\n💎 Ranking wg NPV (największa wartość netto w horyzoncie; tylko warianty zwracające się w horyzoncie):");
  if (report.top3ByNpv.length === 0) {
    console.log("   brak wariantów, które się zwracają w horyzoncie analizy");
  } else if (report.top3ByNpv[0]!.npvPln <= 0) {
    console.log("   ⚠️  Nawet najlepszy wariant ma NPV ≤ 0 — przy tych założeniach (wymiana po gwarancji, VAT, wartość eksportu)");
    console.log("      magazyn zwraca się nominalnie, ale nie tworzy wartości netto w horyzoncie analizy.");
  }
  for (let i = 0; i < report.top3ByNpv.length; i++) {
    const fr = report.top3ByNpv[i]!;
    const bc = fr.simulationResult.bessConfig;
    if (bc === null) continue;
    const cap = (bc.product.usableCapacityKwh * bc.moduleCount).toFixed(1);
    console.log(
      `   #${i + 1} ${bc.product.manufacturer} ${bc.product.model} ${cap}kWh — NPV ${fr.npvPln.toFixed(0)} PLN, ` +
      `koszt ${fr.investmentCostPln.toFixed(0)} PLN, payback ${fr.paybackYears.toFixed(1)} lat`
    );
  }

  const printBestPerManufacturer = (results: typeof report.bestPerManufacturer): void => {
    for (const fr of results) {
      const bc = fr.simulationResult.bessConfig;
      if (bc === null) continue;
      const cap = (bc.product.usableCapacityKwh * bc.moduleCount).toFixed(1);
      const pb = fr.paybackYears === Infinity ? "∞" : `${fr.paybackYears.toFixed(1)} lat`;
      console.log(
        `   ${bc.product.manufacturer.padEnd(10)} ${bc.product.model} ${cap}kWh — PV ${fr.simulationResult.pvSizeKwp} kWp, ` +
        `koszt ${fr.investmentCostPln.toFixed(0)} PLN, oszczędności ${fr.annualSavingsYear1Pln.toFixed(0)} PLN/rok, payback ${pb}`
      );
    }
  };

  console.log("\n🏭 Najlepszy magazyn każdego producenta:");
  printBestPerManufacturer(report.bestPerManufacturer);

  if (report.dataSource !== undefined) {
    console.log(`\n📚 Źródło danych: poziom ${report.dataSource.level} — ${report.dataSource.label}\n   Niepewność: ${report.dataSource.uncertainty}`);
  }

  if (report.inputSummary.plannedPvKwp > 0) {
    console.log(`
🔧 Instalacje do realizacji: ${report.inputSummary.plannedPvKwp} kWp — wliczone w wynik jak istniejące (koszt PV pominięty), pominięte przy odtwarzaniu zużycia.`);
  }

  if (report.sensitivity !== undefined) {
    console.log(`\n📉 Wrażliwość NPV rekomendowanego wariantu (bazowo ${report.sensitivity.baseNpvPln.toFixed(0)} PLN):`);
    for (const r of report.sensitivity.rows) {
      console.log(
        `   ${r.parameter.padEnd(34)} ${r.lowLabel.padStart(10)}: ${r.npvLowPln.toFixed(0).padStart(8)} PLN   ` +
        `${r.highLabel.padStart(10)}: ${r.npvHighPln.toFixed(0).padStart(8)} PLN`,
      );
    }
  }

  if (report.inverterClippingNote !== undefined) {
    console.log(`\n🔌 ${report.inverterClippingNote}`);
  }

  for (const w of report.validationWarnings ?? []) {
    console.log(`\n⚠️  Walidacja danych: ${w}`);
  }

  if (report.powerLimitNote !== undefined) {
    console.log(`
⚡ Limity mocy: ${report.powerLimitNote}`);
  }

  if (report.dataQualityWarning !== undefined) {
    console.log(`\n⚠️  Jakość danych: ${report.dataQualityWarning}`);
  }

  if (report.pvExpansionSuggestion !== undefined) {
    if (report.pvExpansionSuggestion === null) {
      console.log(
        "\n⚠️  Nawet zwiększenie instalacji PV (sprawdzono do 100 kWp) nie sprawia, że ten magazyn się zwraca.\n" +
        "   Ograniczeniem jest pojemność/koszt samego magazynu, nie zbyt mała moc PV — rozważ mniejszy magazyn."
      );
    } else {
      console.log(
        `\n💡 Przy PV ≥ ${report.pvExpansionSuggestion.pvSizeKwp} kWp ten sam magazyn zwróciłby się w ${report.pvExpansionSuggestion.paybackYears.toFixed(1)} lat.`
      );
    }
  }

  if (args.outputPath !== null) {
    // `steps` (kroki 15-min) są już puste u źródła (ScenarioScanner zwalnia
    // je po policzeniu kosztów) — raport można zapisać bez dodatkowego trymowania.
    const outputPath = path.resolve(args.outputPath);
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8");
    console.log(`\n💾 Raport zapisano do: ${outputPath}`);
  }

  console.log(`\n✅ Analiza zakończona. Przeskanowano ${report.allScenarios.length} scenariuszy.`);
}

main().catch((error) => {
  if (error instanceof AnalysisError) {
    console.error(`❌ ${error.message}`);
  } else {
    console.error(`❌ Błąd krytyczny: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
});
