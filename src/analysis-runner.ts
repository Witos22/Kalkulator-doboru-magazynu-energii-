import { TauronAdapter } from "./adapters/tauron-adapter.js";
import { SemsAdapter } from "./adapters/sems-adapter.js";
import { FirmProfileAdapter } from "./adapters/firm-profile-adapter.js";
import { MojLicznikDailyAdapter } from "./adapters/moj-licznik-daily-adapter.js";
import { SolarModel } from "./solar/solar-model.js";
import { getAllProducts } from "./catalog/product-catalog.js";
import { TariffArbitrageStrategy } from "./strategies/tariff-arbitrage.js";
import { ScenarioScanner } from "./engine/scenario-scanner.js";
import {
  NEW_PV_SIZES_KWP,
  PV_EXPANSION_EXTRAS_KWP,
  PV_EXPANSION_SEARCH_KWP,
  maxInstallablePvKwp,
  connectionUpgradeWarning,
  pvSizesKeepingDeclared,
  pvSizesWithinLimit,
} from "./engine/connection-limit.js";
import { DEFAULT_FINANCIAL_CONFIG } from "./engine/financial-calculator.js";
import { DeclaredConsumptionAdapter } from "./adapters/declared-consumption-adapter.js";
import type { Appliance } from "./adapters/declared-consumption-adapter.js";
import { createTariffSchedule, DEFAULT_TARIFF_PRICES } from "./types/tariff.js";
import type { TariffType, TariffPrices } from "./types/tariff.js";
import type { DataSourceInfo } from "./types/financial.js";
import type { ClientSegment, BuildingType, InputSummary, FinancialAnalysisConfig, RecommendationReport } from "./types/financial.js";
import { suggestedVatRate } from "./types/financial.js";
import type { TimeSeriesRecord } from "./types/timeseries.js";
import type { PvProfileRecord } from "./types/pv-profile.js";

export type AdapterType = "tauron" | "sems" | "firma-15min" | "moj-licznik-daily" | "declared";

/**
 * Jedna fizyczna instalacja PV (np. jeden dach/jedna połać) o własnym kącie
 * nachylenia i azymucie. Klient może mieć kilka takich instalacji naraz
 * (np. połać wschodnia + zachodnia) — każda ma inny profil produkcji w ciągu
 * doby, więc nie da się ich uśrednić jedną parą tilt/azimuth.
 */
export interface PvInstallation {
  readonly kwp: number;
  readonly tilt: number | null;
  readonly azimuth: number | null;
  /** Marka falownika tej instalacji (wymagana) — decyduje o kompatybilności z magazynem (K3). */
  readonly inverterBrand: string;
  /** Model falownika z katalogu formularza — tylko do sekcji założeń. Puste przy „nie wiem”. */
  readonly inverterModel?: string | undefined;
  /** Moc AC falownika [kW] (wymagana) — powyżej niej produkcja modułów jest ucinana (clipping, I6). */
  readonly inverterAcKw: number;
  /**
   * Instalacja jeszcze niezrealizowana: liczona tak jak istniejąca (koszt PV pominięty, wynik "po realizacji"),
   * ale wyłączona z rekonstrukcji zużycia — nie produkuje, więc nie wolno jej odejmować od oddania do sieci.
   */
  readonly planned?: boolean | undefined;
}

/**
 * Wspólne parametry analizy — używane zarówno przez CLI (`index.ts`),
 * jak i przez API webowe (`server.ts`). Ścieżki do plików muszą już
 * wskazywać na pliki zapisane na dysku (upload przez API zapisuje je
 * najpierw do katalogu tymczasowego).
 */
export interface AnalysisParams {
  readonly adapter: AdapterType;
  /** Taryfa OBECNA — w niej są dane historyczne (mapowanie stref, koszt wariantu bazowego). */
  readonly tariff: TariffType;
  /** Taryfa DOCELOWA po inwestycji (I7); domyślnie = obecna. */
  readonly targetTariff?: TariffType | undefined;
  /** Korekta cen taryfy docelowej (gdy różni się od obecnej). Gdy taryfy są te same, używane są `customTariffPrices`. */
  readonly targetTariffPrices?: TariffPrices | undefined;
  /** Korekta domyślnych stawek taryfy (cena energii / dystrybucji per strefa) — opcjonalna */
  readonly customTariffPrices?: TariffPrices | undefined;
  /**
   * Wartość 1 kWh oddanej do sieci [PLN/kWh] — opcjonalna korekta domyślnej
   * wartości orientacyjnej (0,30 zł). Patrz `FinancialAnalysisConfig.exportPricePerKwh`.
   */
  readonly exportPricePerKwh?: number | undefined;
  /** Moc przyłączeniowa / zabezpieczenie przedlicznikowe [kW] — limit poboru z sieci (I6). Brak = bez limitu. */
  readonly gridConnectionPowerKw?: number | undefined;
  /** Limit oddawania do sieci [kW]; 0 = zero export (nadwyżka ucinana). Brak = bez limitu (I6). */
  readonly exportLimitKw?: number | undefined;
  /**
   * Segment klienta — decyduje, czy ceny magazynu/PV są netto czy brutto.
   * Domyślnie: "firma" dla adaptera firma-15min, "prosument" dla pozostałych.
   */
  readonly clientSegment?: ClientSegment | undefined;
  /**
   * Typ budynku — decyduje o sugerowanej stawce VAT dla prosumenta/b2c
   * (mieszkalny do 300m² → sugestia 8%, inne → 23%). Nie dotyczy firmy (zawsze netto).
   * Nadpisywane przez `vatRatePercent`, jeśli podane wprost.
   */
  readonly buildingType?: BuildingType | undefined;
  /**
   * Jawna korekta stawki VAT [ułamek, np. 0.08 albo 0.23] — nadpisuje sugestię
   * z `buildingType`. [DO WERYFIKACJI per przypadek — K5 audytu 30.09.2026]
   */
  readonly vatRatePercent?: number | undefined;
  /**
   * System rozliczeń prosumenta (K2 audytu 30.09.2026) — decyduje o wycenie energii oddanej.
   * "net-billing" (domyślnie, od 1.04.2022): oddana energia wyceniana pieniężnie.
   * "opusty" (sprzed 1.04.2022): oddana energia to kredyt w kWh do odebrania ze
   * współczynnikiem 0,8 (do 10 kW) lub 0,7 (10–50 kW); sieć pełni rolę darmowego
   * "magazynu", więc fizyczny magazyn ma tu znikomą wartość — model liczy to wprost
   * (bilans roczny per strefa, bez arbitrażu z sieci). [DO WERYFIKACJI: współczynniki,
   * próg 10 kW, rozliczenie międzystrefowe u danego OSD, utrata statusu przy rozbudowie]
   */
  readonly settlementSystem?: "net-billing" | "opusty" | undefined;
  /**
   * Marka istniejącego falownika klienta (np. "Huawei", "Sigenergy") — jeśli
   * podana i zgodna z wymaganą marką rekomendowanego magazynu, koszt falownika
   * nie jest doliczany do inwestycji (K3 audytu 30.09.2026). Pominięcie oznacza
   * bezpieczne założenie "trzeba dokupić falownik".
   */
  readonly existingInverterBrand?: string | undefined;
  readonly lat: number;
  readonly lon: number;
  /** Nazwa miejscowości z formularza — do sekcji założeń. Silnik liczy z lat/lon. */
  readonly cityName?: string | undefined;
  /** Liczba faz przyłącza: 1 → 5,75 kW, 3 → 14 kW. Do sekcji założeń; limit mocy idzie w `gridConnectionPowerKw`. */
  readonly phases?: 1 | 3 | undefined;
  readonly contractedPowerKw: number;
  /** Roczne zużycie z sieci [kWh] — wymagane dla adaptera "declared" (bez plików pomiarowych). */
  readonly annualConsumptionKwh?: number | undefined;
  /** Zadeklarowane odbiorniki, które kształtują profil dobowy i sezonowy (adapter "declared"). */
  readonly appliances?: readonly Appliance[] | undefined;
  readonly existingPvKwp: number | null;
  readonly tilt: number | null;
  readonly azimuth: number | null;
  /**
   * Wiele instalacji PV o różnych azymutach/kątach (tylko adapter moj-licznik-daily).
   * Gdy podane (min. 1 element), ma pierwszeństwo przed `existingPvKwp`/`tilt`/`azimuth` —
   * `existingPvKwp` jest wtedy wyliczane jako suma `kwp` wszystkich instalacji.
   */
  readonly installations?: readonly PvInstallation[] | undefined;
  /** Wymagane dla adapter: tauron, sems, firma-15min */
  readonly csvPath?: string | undefined;
  /** Wymagane dla adapter: moj-licznik-daily — 12 plików "Pobór A+" (raport dobowy, jeden na miesiąc) */
  readonly csvAPlusPaths?: readonly string[] | undefined;
  /** Wymagane dla adapter: moj-licznik-daily — 12 plików "Energia oddana A-" (raport dobowy, jeden na miesiąc) */
  readonly csvAMinusPaths?: readonly string[] | undefined;
  /** Opcjonalny callback do logowania postępu (np. do konsoli CLI) */
  readonly onProgress?: ((message: string) => void) | undefined;
}

export class AnalysisError extends Error {}

/** Opis poziomu źródła danych dla raportu (hierarchia źródeł z audytu). Niepewność opisowa — bez zmyślonych liczb. */
function describeDataSource(adapter: AdapterType, appliances: readonly Appliance[]): DataSourceInfo {
  switch (adapter) {
    case "declared":
      return {
        level: 4,
        label: `Samo roczne zużycie z deklaracji${appliances.length > 0 ? ` + odbiorniki (${appliances.join(", ")})` : ""}`,
        uncertainty: "Wysoka: kształt doby i sezonowość zużycia są założone modelowo, a nie zmierzone. Wynik (zwłaszcza arbitraż taryfowy) może się istotnie różnić od rzeczywistości — to ocena orientacyjna.",
      };
    case "moj-licznik-daily":
      return {
        level: 2,
        label: "Sumy dobowe A+/A− na strefę + modelowana produkcja PV (lokalny model solarny)",
        uncertainty: "Średnia: dobowe sumy są zmierzone, ale rozkład w ciągu doby wynika z szablonu generycznego, a produkcja PV jest modelowa (typowy rok, nie rzeczywista pogoda).",
      };
    default:
      return {
        level: 1,
        label: "Profil 15-minutowy z licznika/falownika",
        uncertainty: "Niska: dane pomiarowe w rozdzielczości 15 min; główna niepewność to zmienność zużycia i cen w kolejnych latach.",
      };
  }
}

/** Czy użytkownik zmienił którąkolwiek stawkę względem domyślnych sugestii kalkulatora. */
function pricesDifferFromDefaults(type: TariffType, custom: TariffPrices | undefined): boolean {
  if (custom === undefined) return false;
  const defaults = DEFAULT_TARIFF_PRICES[type].zones;
  return Object.entries(custom.zones).some(([zone, c]) => {
    const d = defaults[zone];
    return d === undefined
      || Math.abs(c.energyPricePerKwh - d.energyPricePerKwh) > 1e-9
      || Math.abs(c.distributionPricePerKwh - d.distributionPricePerKwh) > 1e-9;
  });
}

/**
 * Oblicza z modelu solarnego profil produkcji każdej instalacji osobno (bo każda ma
 * własny tilt/azimuth), sumuje je do łącznej produkcji [kW], a następnie
 * dzieli przez łączną moc [kWp] — wynik to uśredniony ważony kształt produkcji
 * "na 1 kWp", którego `ScenarioScanner` używa do skalowania scenariuszy
 * rozbudowy (patrz `buildTimeSeries` w `scenario-scanner.ts`). Dla jednej
 * instalacji wynik jest identyczny jak dotychczasowe `fetchPvProfile(...,1,...)`.
 */
async function fetchCombinedPvUnitProfile(
  solarModel: SolarModel,
  lat: number,
  lon: number,
  installations: readonly PvInstallation[],
): Promise<{ profile: PvProfileRecord[]; rawKwh: number; clippedKwh: number }> {
  const totalKwp = installations.reduce((sum, inst) => sum + inst.kwp, 0);
  if (totalKwp <= 0) {
    throw new AnalysisError("Suma mocy instalacji PV musi być większa od zera.");
  }

  const reports = installations.map((inst) => {
    const geometry = inst.tilt !== null && inst.azimuth !== null
      ? { tilt: inst.tilt, azimuth: inst.azimuth, acPowerKw: inst.inverterAcKw }
      : { acPowerKw: inst.inverterAcKw };
    return solarModel.productionProfile(lat, lon, inst.kwp, geometry);
  });

  let rawKwh = 0;
  let clippedKwh = 0;
  const profiles = reports.map((report) => {
    rawKwh += report.rawKwh;
    clippedKwh += report.clippedKwh;
    return report.records;
  });

  const len = Math.min(...profiles.map((p) => p.length));
  const combined: PvProfileRecord[] = new Array(len);
  for (let i = 0; i < len; i++) {
    let sumKw = 0;
    for (const profile of profiles) {
      sumKw += profile[i]!.pvProductionKw;
    }
    combined[i] = { timestamp: profiles[0]![i]!.timestamp, pvProductionKw: sumKw / totalKwp };
  }
  return { profile: combined, rawKwh, clippedKwh };
}

const APPLIANCE_LABELS: Readonly<Record<string, string>> = {
  "heat-pump": "pompa ciepła",
  ev: "ładowarka EV",
  ac: "klimatyzacja",
  boiler: "bojler elektryczny",
  "remote-work": "praca zdalna",
};

function plNum(value: number, digits = 0): string {
  return value.toLocaleString("pl-PL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const UNKNOWN_INVERTER_ASSUMPTION =
  "Falownik jest nieznany. Gdy żaden znany falownik nie jest hybrydą zgodną z magazynem, porównujemy zostawienie go ze sprzężeniem AC (sprawność cyklu × 0,95) z wymianą na hybrydę, która mieści moc PV i ma dość MPPT na liczbę połaci. Wygrywa wyższe NPV, a drugi wariant zostaje w raporcie.";

/** Tekst sekcji „Założenia” — w tym wartości, których użytkownik nie ruszał. */
export function buildAssumptions(
  params: AnalysisParams,
  financial: FinancialAnalysisConfig,
  tariffPricesBasis: string,
  clientSegment: ClientSegment,
  modeledConsumptionKwh: number,
): string[] {
  const lines: string[] = [];
  const tilt = params.tilt ?? 35;
  const azimuth = params.azimuth ?? 180;
  const city = params.cityName?.trim();
  const place = city ? `${city} (${plNum(params.lat, 4)}°N, ${plNum(params.lon, 4)}°E)` : `${plNum(params.lat, 4)}°N, ${plNum(params.lon, 4)}°E`;
  lines.push(`Lokalizacja: ${place}.`);

  const target = params.targetTariff ?? params.tariff;
  lines.push(
    target === params.tariff
      ? `Taryfa: ${params.tariff}, bez zmiany taryfy docelowej. Stawki: ${tariffPricesBasis}.`
      : `Taryfa obecna: ${params.tariff}. Taryfa docelowa: ${target}. Stawki: ${tariffPricesBasis}.`,
  );

  if (params.adapter === "declared" && params.annualConsumptionKwh !== undefined) {
    const appliances = (params.appliances ?? []).map((a) => APPLIANCE_LABELS[a] ?? a);
    lines.push(
      appliances.length > 0
        ? `Roczne zużycie z deklaracji: ${plNum(params.annualConsumptionKwh)} kWh. Odbiorniki: ${appliances.join(", ")}.`
        : `Roczne zużycie z deklaracji: ${plNum(params.annualConsumptionKwh)} kWh. Bez dodatkowych odbiorników.`,
    );
  } else {
    lines.push(`Roczne zużycie w modelu: ${plNum(modeledConsumptionKwh)} kWh.`);
  }

  const installations = params.installations ?? [];
  if (installations.length > 0) {
    installations.forEach((inst, index) => {
      const status = inst.planned === true ? "do realizacji" : "istniejąca";
      const instTilt = inst.tilt ?? 35;
      const instAzimuth = inst.azimuth ?? 180;
      const unknown = inst.inverterBrand.trim().toLowerCase() === "nie wiem"
        || (inst.inverterModel ?? "").trim().toLowerCase() === "nie wiem";
      const inverter = unknown
        ? "falownik: nie wiem"
        : `falownik: ${inst.inverterBrand}${inst.inverterModel ? " " + inst.inverterModel : ""}`;
      lines.push(
        `Połać ${index + 1}: ${plNum(inst.kwp, 1)} kWp, ${status}, kąt ${plNum(instTilt)}°, azymut ${plNum(instAzimuth)}°, ${inverter}. Moc AC ${plNum(inst.inverterAcKw, 1)} kW (kWp / 1,2).`,
      );
    });
    if (installations.some((inst) => inst.inverterBrand.trim().toLowerCase() === "nie wiem" || (inst.inverterModel ?? "").trim().toLowerCase() === "nie wiem")) {
      lines.push(UNKNOWN_INVERTER_ASSUMPTION);
    }
  } else if ((params.existingPvKwp ?? 0) > 0) {
    lines.push(`Istniejące PV: ${plNum(params.existingPvKwp ?? 0, 1)} kWp, kąt ${plNum(tilt)}°, azymut ${plNum(azimuth)}° (180° = południe).`);
    if ((params.existingInverterBrand ?? "").trim().toLowerCase() === "nie wiem") {
      lines.push(UNKNOWN_INVERTER_ASSUMPTION);
    }
  } else {
    lines.push(`Brak istniejącego PV. Dobierana instalacja: kąt ${plNum(tilt)}°, azymut ${plNum(azimuth)}° (180° = południe).`);
  }

  if (params.phases === 1 || params.phases === 3) {
    const kw = params.gridConnectionPowerKw ?? (params.phases === 1 ? 5.75 : 14);
    lines.push(`Przyłącze: ${params.phases} ${params.phases === 1 ? "faza" : "fazy"}, ${plNum(kw, 2)} kW.`);
  } else if (params.gridConnectionPowerKw !== undefined) {
    lines.push(`Moc przyłączeniowa: ${plNum(params.gridConnectionPowerKw, 2)} kW.`);
  } else {
    lines.push("Moc przyłączeniowa: bez limitu.");
  }

  lines.push(
    params.exportLimitKw !== undefined
      ? `Limit eksportu: ${plNum(params.exportLimitKw, 2)} kW${params.exportLimitKw === 0 ? " (zero export)" : ""}.`
      : "Limit eksportu: bez limitu.",
  );
  lines.push(`Wartość eksportu: ${plNum(financial.exportPricePerKwh, 2)} zł/kWh.`);

  if (clientSegment === "firma") {
    lines.push("Ceny netto (firma).");
  } else if (Math.abs(financial.vatRatePercent - 0.08) < 1e-9) {
    lines.push("VAT 8% (dom do 300 m²).");
  } else {
    lines.push(`VAT ${plNum(financial.vatRatePercent * 100)}%.`);
  }

  lines.push(financial.settlementSystem === "opusty"
    ? "System rozliczeń: opusty (kredyt w kWh, bez ładowania magazynu z sieci)."
    : "System rozliczeń: net-billing.");

  return lines;
}

/**
 * Uruchamia pełną analizę: parsowanie danych wejściowych → (opcjonalnie)
 * modelowanie PV z lokalnego modelu słońca → skanowanie scenariuszy PV × magazyn → raport.
 *
 * Wyodrębnione z `index.ts`, żeby ta sama logika była używana przez CLI
 * i przez serwer webowy bez duplikacji.
 */
export async function runAnalysis(params: AnalysisParams): Promise<RecommendationReport> {
  const log = params.onProgress ?? (() => {});

  if (params.installations !== undefined && params.installations.length > 0) {
    for (const inst of params.installations) {
      if (!Number.isFinite(inst.kwp) || inst.kwp <= 0) {
        throw new AnalysisError("Każda instalacja PV musi mieć moc [kWp] większą od zera.");
      }
      if (!Number.isFinite(inst.inverterAcKw) || inst.inverterAcKw <= 0) {
        throw new AnalysisError("Każda instalacja PV musi mieć podaną moc AC falownika [kW] większą od zera.");
      }
      if (typeof inst.inverterBrand !== "string" || inst.inverterBrand.trim() === "") {
        throw new AnalysisError("Każda instalacja PV musi mieć podaną markę falownika.");
      }
      if ((inst.tilt === null) !== (inst.azimuth === null)) {
        throw new AnalysisError("Instalacja PV: kąt nachylenia i azymut trzeba podać razem albo pominąć oba.");
      }
    }
  }

  const clientSegment: ClientSegment = params.clientSegment
    ?? (params.adapter === "firma-15min" ? "firma" : "prosument");

  const effectiveExistingPvKwp = params.installations !== undefined && params.installations.length > 0
    ? params.installations.reduce((sum, inst) => sum + inst.kwp, 0)
    : params.existingPvKwp;

  // Marki falowników: z instalacji; dla ścieżki bez listy instalacji — pole existingInverterBrand.
  const inverterBrands: string[] = params.installations !== undefined && params.installations.length > 0
    ? params.installations.map((inst) => inst.inverterBrand)
    : params.existingInverterBrand ? [params.existingInverterBrand] : [];
  if ((effectiveExistingPvKwp ?? 0) > 0 && inverterBrands.length === 0) {
    throw new AnalysisError("Podaj markę falownika istniejącej instalacji PV.");
  }
  const pvCapKwp = maxInstallablePvKwp(params.phases, params.gridConnectionPowerKw);
  const connectionUpgradeNote = connectionUpgradeWarning(effectiveExistingPvKwp ?? 0, params.gridConnectionPowerKw);

  const settlementSystem = params.settlementSystem ?? "net-billing";
  if (settlementSystem === "opusty" && params.adapter !== "moj-licznik-daily") {
    throw new AnalysisError(
      "System opustów dotyczy prosumenta z istniejącą instalacją PV — wybierz ścieżkę \"Mam PV\"."
    );
  }

  if (params.adapter === "tauron" && params.existingPvKwp !== null) {
    throw new AnalysisError(
      "Nieprawidłowa kombinacja: adapter tauron razem z existingPvKwp. " +
      "Dane z licznika OSD (Tauron) dla obiektu z już istniejącym PV są rozliczane netto, " +
      "więc nie da się ich poprawnie połączyć z osobno symulowaną produkcją PV. " +
      "Dla obiektu z PV użyj adaptera moj-licznik-daily lub sems."
    );
  }

  // Tworzone tu (nie dopiero przy konfiguracji skanera niżej), bo adapter
  // moj-licznik-daily potrzebuje HARMONOGRAMU taryfy już na etapie parsowania —
  // żeby poprawnie zmapować "Strefa 1"/"Strefa 2" z pliku na realne godziny
  // (dla G12w strefa 2 to nie tylko noc, ale i CAŁY weekend).
  const currentTariff = createTariffSchedule(params.tariff, params.customTariffPrices);
  const targetTariffType = params.targetTariff ?? params.tariff;
  const tariffChanges = targetTariffType !== params.tariff;
  // Stawki docelowej: jawne albo, gdy taryfa się nie zmienia, te same co obecne.
  const targetTariffSchedule = tariffChanges
    ? createTariffSchedule(targetTariffType, params.targetTariffPrices)
    : currentTariff;

  // --- 1. Parsowanie danych wejściowych ---
  log("Parsowanie danych wejściowych...");
  let loadProfile: TimeSeriesRecord[];
  let pvUnitProfileForMojLicznik: PvProfileRecord[] | null = null;
  let pvModeledForReconstruction: PvProfileRecord[] | null = null;
  let monthlyZoneBreakdown: RecommendationReport["monthlyZoneBreakdown"];
  let dailyZoneBreakdown: RecommendationReport["dailyZoneBreakdown"];
  let dataQualityWarning: string | undefined;
  let inverterClippingNote: string | undefined;
  let reconstructionUnitProfile: PvProfileRecord[] | null = null;
  let reconstructionKwp: number | null = null;
  let plannedPvKwp = 0;
  const validationWarnings: string[] = [];
  if (connectionUpgradeNote !== undefined) validationWarnings.push(connectionUpgradeNote);

  if (params.adapter === "sems") {
    if (!params.csvPath) throw new AnalysisError("Adapter sems wymaga csvPath.");
    const adapter = new SemsAdapter();
    loadProfile = await adapter.parse(params.csvPath);
  } else if (params.adapter === "firma-15min") {
    if (!params.csvPath) throw new AnalysisError("Adapter firma-15min wymaga csvPath.");
    const adapter = new FirmProfileAdapter();
    loadProfile = await adapter.parse(params.csvPath);
  } else if (params.adapter === "moj-licznik-daily") {
    if (!params.csvAPlusPaths?.length || !params.csvAMinusPaths?.length) {
      throw new AnalysisError("Adapter moj-licznik-daily wymaga csvAPlusPaths i csvAMinusPaths (po 12 plików).");
    }
    if (effectiveExistingPvKwp === null) {
      throw new AnalysisError(
        "Adapter moj-licznik-daily wymaga podania mocy instalacji PV (existingPvKwp albo installations) — bez niej nie da się " +
        "zrekonstruować produkcji PV ani zużycia brutto z poboru i oddania."
      );
    }

    const solarModel = new SolarModel();
    if (params.installations !== undefined && params.installations.length > 0) {
      log(`Modelowanie produkcji PV (model solarny) dla ${params.installations.length} instalacji...`);
      const combined = await fetchCombinedPvUnitProfile(solarModel, params.lat, params.lon, params.installations);
      pvUnitProfileForMojLicznik = combined.profile;
      // Rekonstrukcja zużycia używa TYLKO instalacji już działających.
      const operating = params.installations.filter((inst) => inst.planned !== true);
      if (operating.length === params.installations.length) {
        reconstructionUnitProfile = combined.profile;
      } else if (operating.length > 0) {
        reconstructionUnitProfile = (await fetchCombinedPvUnitProfile(solarModel, params.lat, params.lon, operating)).profile;
      } else {
        reconstructionUnitProfile = combined.profile.map((r) => ({ timestamp: r.timestamp, pvProductionKw: 0 }));
      }
      reconstructionKwp = operating.reduce((sum, inst) => sum + inst.kwp, 0);
      plannedPvKwp = params.installations.length > 0 ? effectiveExistingPvKwp - reconstructionKwp : 0;
      if (combined.clippedKwh > 0.5 && combined.rawKwh > 0) {
        inverterClippingNote =
          `Clipping AC falowników: ${combined.clippedKwh.toFixed(0)} kWh/rok (${((combined.clippedKwh / combined.rawKwh) * 100).toFixed(1)}% modelowanej produkcji) ` +
          `przekracza ich moc AC i jest tracone. Dołożone panele zakładają ten sam stosunek mocy DC do AC.`;
      }
    } else {
      log("Modelowanie produkcji PV (model solarny) dla istniejącej instalacji...");
      const solarOptions = params.tilt !== null && params.azimuth !== null
        ? { tilt: params.tilt, azimuth: params.azimuth }
        : undefined;
      pvUnitProfileForMojLicznik = await solarModel.fetchPvProfile(params.lat, params.lon, 1, solarOptions);
    }
    const reconstructionSource = reconstructionUnitProfile ?? pvUnitProfileForMojLicznik;
    const reconstructionKw = reconstructionKwp ?? effectiveExistingPvKwp;
    pvModeledForReconstruction = reconstructionSource.map((r) => ({
      timestamp: r.timestamp,
      pvProductionKw: r.pvProductionKw * reconstructionKw,
    }));

    log("Parsowanie raportów dobowych A+/A-...");
    const adapter = new MojLicznikDailyAdapter();
    const parsed = await adapter.parse(params.csvAPlusPaths!, params.csvAMinusPaths!, pvModeledForReconstruction, currentTariff);
    loadProfile = parsed.records;
    monthlyZoneBreakdown = parsed.monthlyZoneBreakdown;
    dailyZoneBreakdown = parsed.dailyZoneBreakdown;

    // Walidacja spójności deklaracji z danymi (audyt: sprawdzamy deklarację, nie zgadujemy).
    const totalExportKwh = parsed.monthlyZoneBreakdown.reduce((sum, m) => sum + m.zone1ExportKwh + m.zone2ExportKwh, 0);
    if (reconstructionKw > 0 && totalExportKwh <= 0) {
      validationWarnings.push(
        "Zadeklarowano instalację PV, a w plikach „Energia oddana A-” nie ma żadnego oddania energii do sieci. " +
        "Możliwe przyczyny: zero export, istniejący magazyn, zły plik albo PV nie działa — potwierdź deklarację.",
      );
    }

    for (const warning of parsed.calibrationWarnings) validationWarnings.push(warning);

    // K8 audytu 30.09.2026: gdy produkcja PV z modelu słońca nie pasuje do
    // realnej pogody tego dnia, bilans doby schodzi poniżej zera i zużycie
    // tej strefy jest obcinane. Ostrzegamy, gdy dzieje się to zbyt często.
    const { totalDayZoneCount, clippedDayZoneCount, clippedEnergyKwh } = parsed.dataQuality;
    const clippedRatio = totalDayZoneCount > 0 ? clippedDayZoneCount / totalDayZoneCount : 0;
    if (clippedRatio > 0.15) {
      dataQualityWarning =
        `Rekonstrukcja zużycia ucięła do zera ${clippedDayZoneCount} z ${totalDayZoneCount} par dzień×strefa ` +
        `(${(clippedRatio * 100).toFixed(0)}%, ${clippedEnergyKwh.toFixed(0)} kWh łącznie) — modelowana produkcja PV ` +
        `w te dni/strefy nie pokrywała realnego oddania do sieci. Wynik dla tych okresów jest mniej wiarygodny ` +
        `niż zwykle; sprawdź kąt/azymut/moc instalacji albo zacienienie.`;
      log(`⚠️  ${dataQualityWarning}`);
    }
  } else if (params.adapter === "declared") {
    if (params.annualConsumptionKwh === undefined || !Number.isFinite(params.annualConsumptionKwh) || params.annualConsumptionKwh <= 0) {
      throw new AnalysisError("Podaj roczne zużycie energii z sieci [kWh] (z faktur) — większe od zera.");
    }
    if (params.existingPvKwp !== null) {
      throw new AnalysisError("Tryb deklaracji (bez plików) dotyczy obiektu bez PV — dla instalacji PV potrzebne są dane z licznika.");
    }
    loadProfile = new DeclaredConsumptionAdapter().generate(params.annualConsumptionKwh, params.appliances ?? []);
  } else {
    if (!params.csvPath) throw new AnalysisError("Adapter tauron wymaga csvPath.");
    const adapter = new TauronAdapter();
    loadProfile = await adapter.parse(params.csvPath);
  }

  log(`Wczytano ${loadProfile.length} rekordów`);

  if (loadProfile.length === 0) {
    throw new AnalysisError("Brak danych wejściowych. Sprawdź format plików i nazwy kolumn.");
  }

  // --- Podsumowanie zużycia ---
  let totalConsumption = 0;
  for (const record of loadProfile) {
    totalConsumption += record.loadKw * 0.25;
  }
  log(`Roczne zużycie: ${totalConsumption.toFixed(0)} kWh`);

  // --- 2. Profil PV z lokalnego modelu słońca (jeśli brak istniejącego PV) ---
  let pvBaseProfile: PvProfileRecord[] | null = null;

  const netAlreadyIncludesPv =
    (params.adapter === "sems" || params.adapter === "firma-15min") &&
    params.existingPvKwp !== null;

  if (params.adapter === "moj-licznik-daily" && effectiveExistingPvKwp !== null) {
    log("Profil PV: modelowany (model solarny) — będzie skalowany dla wariantów rozbudowy");
    pvBaseProfile = pvUnitProfileForMojLicznik;
  } else if (netAlreadyIncludesPv) {
    log("Profil PV: z danych wejściowych (realna produkcja)");
    pvBaseProfile = null;
  } else {
    log("Generowanie profilu PV z lokalnego modelu solarnego (1 kWp)...");
    const solarModel = new SolarModel();
    const solarOptions = params.tilt !== null && params.azimuth !== null
      ? { tilt: params.tilt, azimuth: params.azimuth }
      : undefined;
    try {
      pvBaseProfile = await solarModel.fetchPvProfile(params.lat, params.lon, 1, solarOptions);
      log(`Wygenerowano ${pvBaseProfile.length} rekordów PV (15-min)`);
    } catch (error) {
      throw new AnalysisError(
        `Błąd modelowania PV: ${error instanceof Error ? error.message : String(error)}. ` +
        "Sprawdź współrzędne (lat/lon)."
      );
    }
  }

  // --- 3. Konfiguracja skanera ---
  const products = getAllProducts();
  // W opustach ładowanie magazynu z sieci jest wyłączone: kredyt w kWh rozlicza się strefowo
  // i ten model nie wyceniłby arbitrażu poprawnie — liczymy samą autokonsumpcję.
  const strategy = new TariffArbitrageStrategy(targetTariffSchedule, settlementSystem !== "opusty", {
    maxGridImportKw: params.gridConnectionPowerKw,
    maxExportKw: params.exportLimitKw,
  });

  let pvSizesToTest: number[];
  if (params.adapter === "moj-licznik-daily" && effectiveExistingPvKwp !== null) {
    const existing = effectiveExistingPvKwp;
    pvSizesToTest = pvSizesKeepingDeclared(
      existing,
      PV_EXPANSION_EXTRAS_KWP.map((extra) => existing + extra),
      pvCapKwp,
    );
  } else if (params.existingPvKwp !== null) {
    pvSizesToTest = pvSizesKeepingDeclared(params.existingPvKwp, [params.existingPvKwp], pvCapKwp);
  } else {
    pvSizesToTest = pvSizesWithinLimit(NEW_PV_SIZES_KWP, pvCapKwp);
  }

  const financialConfig: FinancialAnalysisConfig = {
    horizonYears: 15,
    discountRate: 0.05,
    energyPriceInflation: 0.03,
    pvCostPerKwp: DEFAULT_FINANCIAL_CONFIG.pvCostPerKwp,
    pvFixedCostPln: DEFAULT_FINANCIAL_CONFIG.pvFixedCostPln,
    exportPricePerKwh: params.exportPricePerKwh ?? DEFAULT_FINANCIAL_CONFIG.exportPricePerKwh,
    vatRatePercent: params.vatRatePercent ?? suggestedVatRate(params.buildingType),
    settlementSystem,
  };

  const inputSummary: InputSummary = {
    tariffType: params.tariff,
    targetTariffType,
    plannedPvKwp,
    tariffPricesBasis: pricesDifferFromDefaults(params.tariff, params.customTariffPrices)
      || (tariffChanges && pricesDifferFromDefaults(targetTariffType, params.targetTariffPrices))
      ? "wprowadzone przez użytkownika"
      : "sugestia kalkulatora",
    annualConsumptionKwh: totalConsumption,
    existingPvKwp: effectiveExistingPvKwp,
    location: { lat: params.lat, lon: params.lon },
    contractedPowerKw: params.contractedPowerKw,
    clientSegment,
    settlementSystem,
  };

  // --- 4. Skanowanie scenariuszy ---
  const totalBessConfigs = products.reduce((sum, p) => sum + p.maxModules, 0);
  const totalScenarios = pvSizesToTest.length * totalBessConfigs;
  log(`Skanowanie ${totalScenarios} scenariuszy (${pvSizesToTest.length} PV × ${totalBessConfigs} konfiguracji magazynu z ${products.length} produktów)...`);

  const scanner = new ScenarioScanner(strategy, financialConfig);
  const report = scanner.scan(loadProfile, pvBaseProfile, {
    pvSizesToTest,
    products: [...products],
    tariff: targetTariffSchedule,
    currentTariff: tariffChanges
      ? { schedule: currentTariff, name: params.tariff, targetName: targetTariffType }
      : undefined,
    financialConfig,
    topN: 3,
    existingPvKwp: effectiveExistingPvKwp ?? 0,
    clientSegment,
    existingInverterBrands: inverterBrands,
    inverterPlanes: params.installations !== undefined && params.installations.length > 0
      ? params.installations.map((inst) => ({
        brand: inst.inverterBrand,
        ...(inst.inverterModel !== undefined && inst.inverterModel.trim() !== "" ? { model: inst.inverterModel } : {}),
      }))
      : params.existingInverterBrand ? [{ brand: params.existingInverterBrand }] : [],
    ...(params.phases === 1 || params.phases === 3 ? { connectionPhases: params.phases } : {}),
  }, inputSummary);

  const tariffPricesBasis = pricesDifferFromDefaults(params.tariff, params.customTariffPrices)
    || (tariffChanges && pricesDifferFromDefaults(targetTariffType, params.targetTariffPrices))
    ? "wprowadzone przez użytkownika"
    : "sugestia kalkulatora";

  let result: RecommendationReport = {
    ...report,
    assumptions: buildAssumptions(params, financialConfig, tariffPricesBasis, clientSegment, totalConsumption),
  };

  // I6: informacja o limitach mocy. Limit poboru chroni tylko ładowanie z sieci i pokrywa
  // ponad-limitowy pobór z magazynu — samego zużycia obiektu nie da się ograniczyć.
  const powerLimitNotes: string[] = [];
  // Szczyt poboru porównujemy z przyłączem tylko dla danych 15-min — z danych dobowych jest to artefakt rekonstrukcji.
  if (
    params.gridConnectionPowerKw !== undefined
    && params.adapter !== "moj-licznik-daily"
    && report.baseline.peakGridImportKw > params.gridConnectionPowerKw + 1e-9
  ) {
    powerLimitNotes.push(
      `Szczytowy pobór obiektu (${report.baseline.peakGridImportKw.toFixed(1)} kW) przekracza zadeklarowaną moc przyłączeniową ` +
      `(${params.gridConnectionPowerKw} kW) — sprawdź zabezpieczenie przedlicznikowe i dane wejściowe.`,
    );
  }
  if (params.exportLimitKw !== undefined) {
    const curtailed = report.top3[0]?.simulationResult.totalCurtailedKwh ?? 0;
    powerLimitNotes.push(
      `Limit eksportu ${params.exportLimitKw} kW${params.exportLimitKw === 0 ? " (zero export)" : ""}: w rekomendowanym wariancie ` +
      `ucięto ${curtailed.toFixed(0)} kWh/rok nadwyżki PV (nie jest sprzedana ani zmagazynowana).`,
    );
  }
  if (params.gridConnectionPowerKw !== undefined) {
    powerLimitNotes.push(`Ładowanie magazynu z sieci ograniczone mocą przyłączeniową ${params.gridConnectionPowerKw} kW.`);
  }
  result = { ...result, dataSource: describeDataSource(params.adapter, params.appliances ?? []) };
  if (inverterClippingNote !== undefined) result = { ...result, inverterClippingNote };
  if (validationWarnings.length > 0) result = { ...result, validationWarnings };
  if (powerLimitNotes.length > 0) {
    result = { ...result, powerLimitNote: powerLimitNotes.join(" ") };
  }

  if (monthlyZoneBreakdown !== undefined) {
    result = { ...result, monthlyZoneBreakdown, dailyZoneBreakdown, dataQualityWarning };
  }

  // --- 5. Jeśli najlepszy magazyn się nie zwraca: sprawdź, czy pomogłoby większe PV ---
  const best = report.top3[0];

  if (best !== undefined && best.simulationResult.bessConfig !== null) {
    log("Liczenie rozkładu wykorzystania PV dla rekomendowanego scenariusza (do wykresu)...");
    const { monthly: monthlyPvUsageBreakdown, daily: dailyPvUsageBreakdown } = scanner.computeMonthlyPvUsageBreakdown(
      loadProfile,
      pvBaseProfile,
      best.simulationResult.bessConfig,
      best.simulationResult.pvSizeKwp,
    );
    result = { ...result, monthlyPvUsageBreakdown, dailyPvUsageBreakdown };
  }
  const bestPaybackIsInfinite = best !== undefined
    && best.simulationResult.bessConfig !== null
    && (best.paybackYears === Infinity || !Number.isFinite(best.paybackYears));

  if (bestPaybackIsInfinite && pvBaseProfile !== null && best !== undefined) {
    log("Payback najlepszego magazynu jest nieskończony — sprawdzanie, czy pomogłaby większa instalacja PV...");
    const currentMaxPv = Math.max(...pvSizesToTest);
    const extendedPvSizes = pvSizesWithinLimit(
      PV_EXPANSION_SEARCH_KWP.filter((kwp) => kwp > currentMaxPv),
      pvCapKwp,
      false,
    );

    if (extendedPvSizes.length === 0) {
      return result;
    }

    const bessConfig = best.simulationResult.bessConfig!;
    const extendedResults = scanner.scanPvRangeForBess(
      loadProfile,
      pvBaseProfile,
      bessConfig,
      extendedPvSizes,
      targetTariffSchedule,
      effectiveExistingPvKwp ?? 0,
      clientSegment,
      inverterBrands,
    );

    const firstViable = extendedResults
      .map((fr, i) => ({ fr, pvSizeKwp: extendedPvSizes[i]! }))
      .find(({ fr }) => Number.isFinite(fr.paybackYears) && fr.paybackYears <= financialConfig.horizonYears);

    result = {
      ...result,
      pvExpansionSuggestion: firstViable
        ? { pvSizeKwp: firstViable.pvSizeKwp, paybackYears: firstViable.fr.paybackYears }
        : null,
    };
  }

  return result;
}
