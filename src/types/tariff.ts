/**
 * Typ taryfy energetycznej dla klientów indywidualnych w Polsce.
 */
export type TariffType = "G11" | "G12" | "G12w" | "G13";

/**
 * Strefa taryfowa z ceną.
 */
export interface TariffZone {
  /** Nazwa strefy (np. "szczyt", "pozaszyt", "noc", "jednolita") */
  readonly name: string;
  /** Cena za kWh [PLN brutto, z dystrybucją] */
  readonly pricePerKwh: number;
}

/**
 * Definicja cen dla poszczególnych stref taryfy.
 */
export interface TariffPrices {
  readonly type: TariffType;
  /** Ceny per strefa — klucz to nazwa strefy */
  readonly zones: Readonly<Record<string, number>>;
}

/**
 * Harmonogram taryfowy — rozwiązuje cenę dla danego timestampu.
 */
export interface TariffSchedule {
  readonly type: TariffType;
  /** Zwraca strefę taryfową (z ceną) dla danego momentu czasowego */
  resolve(timestamp: Date): TariffZone;
}

// ─── Domyślne ceny (orientacyjne, Q3 2026) ───────────────────

/**
 * Domyślne ceny brutto z dystrybucją [PLN/kWh] dla taryf.
 * Użytkownik może je nadpisać parametrem CLI.
 */
export const DEFAULT_TARIFF_PRICES: Readonly<Record<TariffType, TariffPrices>> = {
  G11: {
    type: "G11",
    zones: { jednolita: 0.65 },
  },
  G12: {
    type: "G12",
    zones: { dzien: 0.75, noc: 0.45 },
  },
  G12w: {
    type: "G12w",
    zones: { dzien: 0.75, noc_weekend: 0.45 },
  },
  G13: {
    type: "G13",
    zones: { szczyt: 0.85, pozaszczyt: 0.65, noc: 0.40 },
  },
} as const;

// ─── Factory do tworzenia TariffSchedule ────────────────────

/**
 * Tworzy TariffSchedule na podstawie typu taryfy i opcjonalnych cen.
 */
export function createTariffSchedule(
  type: TariffType,
  customPrices?: TariffPrices,
): TariffSchedule {
  const prices = customPrices ?? DEFAULT_TARIFF_PRICES[type];

  switch (type) {
    case "G11":
      return {
        type: "G11",
        resolve: () => ({
          name: "jednolita",
          pricePerKwh: prices.zones["jednolita"] ?? 0.65,
        }),
      };

    case "G12":
      return {
        type: "G12",
        resolve: (timestamp: Date) => {
          const hour = timestamp.getHours();
          // Dzień: 6:00–22:00, Noc: 22:00–6:00
          if (hour >= 6 && hour < 22) {
            return { name: "dzien", pricePerKwh: prices.zones["dzien"] ?? 0.75 };
          }
          return { name: "noc", pricePerKwh: prices.zones["noc"] ?? 0.45 };
        },
      };

    case "G12w":
      return {
        type: "G12w",
        resolve: (timestamp: Date) => {
          const hour = timestamp.getHours();
          const day = timestamp.getDay(); // 0=niedziela, 6=sobota
          const isWeekend = day === 0 || day === 6;
          // Dzień: 6:00–22:00 pon-pt, Noc+Weekend: reszta
          if (!isWeekend && hour >= 6 && hour < 22) {
            return { name: "dzien", pricePerKwh: prices.zones["dzien"] ?? 0.75 };
          }
          return { name: "noc_weekend", pricePerKwh: prices.zones["noc_weekend"] ?? 0.45 };
        },
      };

    case "G13":
      return {
        type: "G13",
        resolve: (timestamp: Date) => {
          const hour = timestamp.getHours();
          // Szczyt: 7:00–13:00 + 16:00–22:00
          // Pozaszczyt: 13:00–16:00
          // Noc: 22:00–7:00
          if ((hour >= 7 && hour < 13) || (hour >= 16 && hour < 22)) {
            return { name: "szczyt", pricePerKwh: prices.zones["szczyt"] ?? 0.85 };
          }
          if (hour >= 13 && hour < 16) {
            return { name: "pozaszczyt", pricePerKwh: prices.zones["pozaszczyt"] ?? 0.65 };
          }
          return { name: "noc", pricePerKwh: prices.zones["noc"] ?? 0.40 };
        },
      };
  }
}
