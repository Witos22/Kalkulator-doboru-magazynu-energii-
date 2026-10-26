import type { SimulationResult } from "./simulation.js";
import type {
  MonthlyZoneEnergyBreakdown, MonthlyPvUsageBreakdown,
  DailyZoneEnergyBreakdown, DailyPvUsageBreakdown,
} from "./energy-breakdown.js";

/**
 * Segment klienta — decyduje, czy ceny magazynów/PV są prezentowane i liczone
 * netto czy brutto (ustalenia z odprawy 28.09.2026):
 * - "firma": ceny netto (firma odlicza VAT),
 * - "prosument": ceny brutto z 23% VAT (gospodarstwo domowe płaci realną cenę brutto),
 * - "b2c": klient końcowy kupujący bezpośrednio (business-to-consumer) — ceny brutto, jak prosument.
 */
export type ClientSegment = "prosument" | "firma" | "b2c";

/**
 * System rozliczeń prosumenta:
 * - "net-billing" (od 1.04.2022): oddana energia jest wyceniana pieniężnie (depozyt, RCEm),
 * - "opusty" (net-metering, sprzed 1.04.2022): oddana energia daje "kredyt" w kWh, który
 *   można odebrać z sieci ze współczynnikiem 0,8 (instalacje do 10 kW) lub 0,7 (10–50 kW).
 */
export type SettlementSystem = "net-billing" | "opusty";

/**
 * Typ budynku — wpływa na sugerowaną stawkę VAT dla PV/magazynu u prosumenta/B2C
 * (firma zawsze liczy netto, więc dla niej to pole nie ma znaczenia).
 * [DO WERYFIKACJI: dokładne progi i warunki — ustawa o VAT art. 41 ust. 12 i nast.,
 * interpretacje KIS; audyt zewnętrzny z 30.09.2026 wskazał to jako błąd krytyczny (K5)]
 */
export type BuildingType = "mieszkalny_do_300m2" | "mieszkalny_powyzej_300m2" | "niemieszkalny";

/**
 * Domyślna (orientacyjna) stawka VAT [%] sugerowana wg typu budynku dla
 * prosumenta/B2C. Powszechna praktyka: PV/magazyn montowany na budynku
 * mieszkalnym do 300 m² — obniżona stawka 8% (budownictwo objęte społecznym
 * programem mieszkaniowym); budynek mieszkalny >300 m² lub niemieszkalny —
 * stawka podstawowa 23%. TO JEST SUGESTIA, NIE PEWNIK — [DO WERYFIKACJI] z
 * doradcą podatkowym per konkretny przypadek (sposób montażu, rodzaj usługi
 * na fakturze itd. też mają znaczenie, nie tylko metraż budynku).
 */
export function suggestedVatRate(buildingType: BuildingType | undefined): number {
  return buildingType === "mieszkalny_do_300m2" ? 0.08 : 0.23;
}

/** @deprecated Zastąpione przez `FinancialAnalysisConfig.vatRatePercent` (K5 audytu 30.09.2026) — stawka VAT nie może być sztywną stałą, zależy od typu budynku i wymaga weryfikacji per przypadek. Zostawione dla kompatybilności wstecznej. */
export const VAT_RATE = 0.23;

/**
 * Wynik kalkulacji finansowej dla jednego scenariusza.
 */
export interface FinancialResult {
  /** Wynik symulacji energetycznej */
  readonly simulationResult: SimulationResult;
  /**
   * Całkowity koszt inwestycji [PLN] = koszt magazynu + koszt dodatkowego PV
   * + ewentualny falownik + montaż (K3 audytu 30.09.2026).
   */
  readonly investmentCostPln: number;
  /** Koszt zakupu samego magazynu [PLN] */
  readonly bessInvestmentCostPln: number;
  /** Punkt odniesienia dla efektu magazynu: ten sam obiekt z tym samym PV, ale BEZ magazynu — pobór z sieci [kWh/rok] */
  readonly referenceGridImportKwh: number;
  /** Jw. — autokonsumpcja [%] bez magazynu */
  readonly referenceSelfConsumptionRate: number;
  /** Koszt rozbudowy PV ponad obecną moc [PLN] — 0, jeśli PV się nie zmienia */
  readonly pvInvestmentCostPln: number;
  /**
   * Koszt falownika/sterownika [PLN] — 0, jeśli klient zadeklarował istniejący
   * falownik marki zgodnej z wymaganą przez rekomendowany magazyn (K3 audytu).
   */
  readonly inverterUpgradeCostPln: number;
  /** Orientacyjny koszt montażu magazynu (robocizna, okablowanie) [PLN] (K3 audytu). */
  readonly installationCostPln: number;
  /** Rok (1-indeksowany), w którym magazyn wymaga wymiany — `null`, jeśli ani gwarancja, ani cykle nie kończą się w horyzoncie. */
  readonly replacementYear: number | null;
  /** Dlaczego wymiana wypada w `replacementYear` albo dlaczego jej nie ma. */
  readonly replacementReason: string;
  /** Koszt wymiany magazynu (magazyn + montaż) w `replacementYear` [PLN] — 0, jeśli wymiana niepotrzebna. */
  readonly replacementCostPln: number;
  /** Roczne oszczędności w roku 1 [PLN] */
  readonly annualSavingsYear1Pln: number;
  /** Oszczędności rok po roku z uwzględnieniem degradacji [PLN] */
  readonly annualSavingsWithDegradation: readonly number[];
  /** Skumulowane oszczędności rok po roku [PLN] */
  readonly cumulativeSavings: readonly number[];
  /** Okres zwrotu inwestycji [lata] — Infinity jeśli nie zwraca się */
  readonly paybackYears: number;
  /** ROI na horyzoncie analizy [%] */
  readonly roiPercent: number;
  /** Koszt za jeden pełny cykl [PLN] */
  readonly costPerCyclePln: number;
  /** NPV na horyzoncie analizy [PLN] (opcjonalnie, stopa dyskontowa) */
  readonly npvPln: number;
  /** Czy `investmentCostPln`/`bessInvestmentCostPln`/`pvInvestmentCostPln` są netto czy brutto (zależy od segmentu klienta) */
  readonly priceBasis: "netto" | "brutto";
  /**
   * Drugi sposób podłączenia magazynu (AC albo wymiana na hybrydę), gdy oba
   * były liczone. W rekomendacji zostaje wariant z wyższym NPV.
   */
  readonly inverterAlternative?: InverterAlternative | undefined;
}

/** Wariant falownika, który przegrał porównanie NPV. */
export interface InverterAlternative {
  readonly coupling: "DC" | "AC";
  readonly label: string;
  readonly inverterUpgradeCostPln: number;
  readonly npvPln: number;
  readonly paybackYears: number;
}

/**
 * Wariant "samo PV, bez magazynu" jako punkt odniesienia (I9 audytu 30.09.2026).
 * Pokazuje, czy to rozbudowa/montaż PV, czy dopiero magazyn, psuje opłacalność
 * łącznej inwestycji — bez tego "PV + magazyn nie zwraca się" nie mówi, który
 * element jest problemem. Liczony dla mocy PV z rekomendowanego scenariusza,
 * tylko gdy scenariusz dokłada PV (dla klienta z już opłaconym PV — brak).
 */
/**
 * Efekt samej zmiany taryfy (I7 audytu 30.09.2026): ten sam obiekt (istniejące PV,
 * bez nowego magazynu) wyceniony w taryfie obecnej i docelowej. Zmiana taryfy
 * nie wymaga inwestycji, więc jest pokazana OSOBNO od efektu magazynu.
 */
export interface TariffChangeEffect {
  readonly currentTariff: string;
  readonly targetTariff: string;
  readonly annualCostCurrentPln: number;
  readonly annualCostTargetPln: number;
  /** Dodatnia = zmiana taryfy obniża koszt energii [PLN/rok, rok 1]. */
  readonly annualEffectPln: number;
}

/**
 * Jeden wiersz analizy wrażliwości (wykres tornado): jak zmienia się NPV
 * rekomendowanego wariantu, gdy jedno założenie przesunie się w dół i w górę,
 * a pozostałe zostają bez zmian.
 */
export interface SensitivityRow {
  readonly parameter: string;
  /** Opis wartości "niskiej" i "wysokiej" założenia, np. "0,15 zł/kWh" */
  readonly lowLabel: string;
  readonly highLabel: string;
  readonly npvLowPln: number;
  readonly npvHighPln: number;
}

/**
 * Poziom źródła danych o zużyciu (hierarchia z audytu 30.09.2026) — raport zawsze
 * pokazuje, z którego poziomu liczono, i jak duża jest niepewność.
 */
export interface DataSourceInfo {
  /** 1 = profile z licznika (+ produkcja z falownika) … 4 = samo roczne zużycie */
  readonly level: 1 | 2 | 3 | 4;
  readonly label: string;
  readonly uncertainty: string;
}

export interface PvOnlyResult {
  readonly pvSizeKwp: number;
  /** Koszt dołożonego PV [PLN], brutto/netto wg segmentu klienta */
  readonly investmentCostPln: number;
  readonly annualSavingsYear1Pln: number;
  readonly paybackYears: number;
  readonly npvPln: number;
  readonly roiPercent: number;
}

/**
 * Raport rekomendacyjny — główny output systemu.
 */
export interface RecommendationReport {
  /** Podsumowanie danych wejściowych */
  readonly inputSummary: InputSummary;
  /** Wynik bazowy (bez magazynu) */
  readonly baseline: SimulationResult;
  /** Wszystkie przesymulowane scenariusze z wynikami finansowymi */
  readonly allScenarios: readonly FinancialResult[];
  /** Top 3 najlepsze konfiguracje po payback */
  readonly top3: readonly FinancialResult[];
  /**
   * Top 3 wg NPV (I8 audytu 30.09.2026), tylko spośród wariantów zwracających się
   * w horyzoncie analizy — pusta, jeśli żaden się nie zwraca. Ranking po payback
   * faworyzuje najmniejszy magazyn; ten pokazuje, co daje najwięcej wartości netto.
   */
  readonly top3ByNpv: readonly FinancialResult[];
  /** Wariant "samo PV" dla mocy PV z top1 — patrz `PvOnlyResult`. Brak, gdy top1 nie dokłada PV. */
  readonly pvOnly?: PvOnlyResult | undefined;
  /** Z jakiego poziomu danych policzono wynik i jaka jest niepewność. */
  readonly dataSource?: DataSourceInfo | undefined;
  /** Analiza wrażliwości NPV rekomendowanego wariantu (wartość eksportu, ceny energii, stopa dyskontowa, sprawność, koszt magazynu). */
  readonly sensitivity?: { readonly baseNpvPln: number; readonly rows: readonly SensitivityRow[] } | undefined;
  /** Obecna ≠ docelowa taryfa: efekt zmiany taryfy (osobno od efektu magazynu). */
  readonly tariffChange?: TariffChangeEffect | undefined;
  /** Najlepsza konfiguracja (wg payback) dla każdego producenta z katalogu */
  readonly bestPerManufacturer: readonly FinancialResult[];
  /** Tekstowe uzasadnienie rekomendacji */
  readonly recommendation: string;
  /** Dlaczego rekomendowany magazyn jest wymieniany albo dlaczego wymiany nie ma. */
  readonly replacementReason: string;
  /** Średnie zużycie 16:00–08:00 w sezonie PV [kWh] — orientacyjna pojemność magazynu. */
  readonly suggestedCapacityKwh: number;
  /** 95. percentyl poboru 17:00–22:00 [kW] — orientacyjna moc magazynu. */
  readonly suggestedPowerKw: number;
  /**
   * Założenia, na których policzono wynik (lokalizacja, taryfa, geometria PV,
   * falownik, przyłącze, eksport, VAT). Sekcja raportu — także wartości domyślne,
   * których użytkownik nie zmieniał.
   */
  readonly assumptions?: readonly string[] | undefined;
  /**
   * Jeśli najlepszy magazyn nie zwraca się przy obecnym/testowanym PV: wynik
   * poszukiwania minimalnej mocy PV, przy której TEN SAM magazyn zaczyna się
   * zwracać w horyzoncie analizy. `null`, jeśli nie znaleziono w przeszukanym
   * zakresie (czyli sam magazyn jest ograniczeniem, nie zbyt mała moc PV).
   * `undefined`, jeśli magazyn już się zwraca (poszukiwanie niepotrzebne).
   */
  readonly pvExpansionSuggestion?: { readonly pvSizeKwp: number; readonly paybackYears: number } | null;
  /**
   * Realny (zmierzony) miesięczny pobór/oddanie per strefa — tylko dla
   * adaptera `moj-licznik-daily` (dane dobowe A+/A-). Do wykresu.
   */
  readonly monthlyZoneBreakdown?: readonly MonthlyZoneEnergyBreakdown[] | undefined;
  /** To samo co `monthlyZoneBreakdown`, tylko per dzień (365 punktów) — do przełącznika Miesiąc/Dzień na wykresie. */
  readonly dailyZoneBreakdown?: readonly DailyZoneEnergyBreakdown[] | undefined;
  /**
   * Miesięczny rozkład wykorzystania PV (zużyte na miejscu / naładowało
   * magazyn / oddane do sieci) dla rekomendowanego scenariusza (top1). Do wykresu.
   */
  readonly monthlyPvUsageBreakdown?: readonly MonthlyPvUsageBreakdown[] | undefined;
  /** To samo co `monthlyPvUsageBreakdown`, tylko per dzień (365 punktów). */
  readonly dailyPvUsageBreakdown?: readonly DailyPvUsageBreakdown[] | undefined;
  /**
   * Ostrzeżenie o jakości rekonstrukcji zużycia (K8 audytu 30.09.2026) — ustawione,
   * gdy formuła `max(0, pobór-oddanie+PV)` zbyt często ucinała wynik do zera
   * (modelowana produkcja PV nie pasowała do realnych danych z pliku).
   */
  readonly dataQualityWarning?: string | undefined;
  /** Informacje o limitach mocy przyłącza i eksportu (I6) */
  readonly powerLimitNote?: string | undefined;
  /** Clipping AC falowników (moc modułów ponad moc AC falownika jest tracona) — notatka dla raportu (I6). */
  readonly inverterClippingNote?: string | undefined;
  /** Walidacja spójności deklaracji klienta z danymi pomiarowymi (audyt: sprawdzamy deklarację, nie zgadujemy). */
  readonly validationWarnings?: readonly string[] | undefined;
}

/**
 * Podsumowanie danych wejściowych użytkownika.
 */
export interface InputSummary {
  /** Taryfa OBECNA (w niej są dane historyczne). */
  readonly tariffType: string;
  /** Taryfa DOCELOWA (po inwestycji); równa obecnej, jeśli klient nie zmienia taryfy. */
  readonly targetTariffType: string;
  /** Moc instalacji oznaczonych jako "do realizacji" [kWp] — wliczone w wynik jak istniejące, bez kosztu PV. */
  readonly plannedPvKwp: number;
  /** Skąd pochodzą stawki taryfy: sugestia kalkulatora (domyślne, orientacyjne) albo wartości zmienione przez użytkownika. */
  readonly tariffPricesBasis: "sugestia kalkulatora" | "wprowadzone przez użytkownika";
  readonly annualConsumptionKwh: number;
  readonly existingPvKwp: number | null;
  readonly location: {
    readonly lat: number;
    readonly lon: number;
  };
  readonly contractedPowerKw: number;
  readonly clientSegment: ClientSegment;
  /** System rozliczeń, w którym policzono wynik — pokazywany w raporcie wraz z założeniami. */
  readonly settlementSystem: SettlementSystem;
}

/**
 * Konfiguracja analizy finansowej.
 */
export interface FinancialAnalysisConfig {
  /** Horyzont analizy [lata] */
  readonly horizonYears: number;
  /** Roczna stopa dyskontowa dla NPV (np. 0.05 = 5%) */
  readonly discountRate: number;
  /** Roczny wzrost cen energii [%] (np. 0.03 = 3%) */
  readonly energyPriceInflation: number;
  /** Koszt zmienny netto 1 kWp NOWEJ instalacji PV [PLN] — część proporcjonalna do mocy */
  readonly pvCostPerKwp: number;
  /**
   * Koszt STAŁY netto nowej instalacji PV [PLN], niezależny od mocy (I10 audytu
   * 30.09.2026): projekt, zgłoszenie do OSD, montaż konstrukcji, falownik w zasadzie
   * stały dla klasy mocy. Płatny tylko, gdy w scenariuszu dokładamy PV (>0 kWp).
   * Razem: koszt_PV = pvFixedCostPln + pvCostPerKwp × moc. Wartości orientacyjne
   * (4000 + 4100/kWp daje ~45 000 zł dla 10 kWp, jak wcześniejsze 4500/kWp) — [DO WERYFIKACJI].
   */
  readonly pvFixedCostPln: number;
  /**
   * Wartość 1 kWh oddanej do sieci [PLN/kWh] — DOMYŚLNIE 0.30 zł, wartość orientacyjna,
   * NIE realna stawka RCEm. Realny mechanizm (depozyt prosumencki, net-billing od
   * kwietnia 2022): eksport wyceniany jest miesięczną ceną rynkową RCEm (zmienną,
   * publikowaną przez PSE), wpływa tylko na część energetyczną rachunku (nie na
   * dystrybucję), a niewykorzystany depozyt po 12 miesiącach w 80% przepada.
   * Traktowanie eksportu jako 0 zł (poprzedni stan) ZAWYŻAŁO oszczędności magazynu —
   * energia naładowana z nadwyżki PV "zjada" wartość, którą inaczej dałby depozyt.
   * [DO WERYFIKACJI: realna stawka RCEm, rozdzielczość rozliczenia, limit zwrotu 20%]
   */
  readonly exportPricePerKwh: number;
  /**
   * Stawka VAT [ułamek, np. 0.23 = 23%] stosowana do cen magazynu/PV I do cen
   * energii z taryfy dla segmentów prosument/b2c (firma zawsze liczy netto,
   * niezależnie od tej wartości). Domyślnie sugerowana wg `BuildingType` przez
   * `suggestedVatRate()`, ale zawsze nadpisywalna — [DO WERYFIKACJI] per przypadek.
   */
  readonly vatRatePercent: number;
  /**
   * System rozliczeń prosumenta — decyduje o sposobie wyceny energii oddanej do sieci.
   * W "opusty" `exportPricePerKwh` nie jest używane (oddana energia to kredyt w kWh,
   * nie pieniądze) — patrz `FinancialCalculator.calculateAnnualEnergyCostNetMetering`.
   */
  readonly settlementSystem: SettlementSystem;
}
