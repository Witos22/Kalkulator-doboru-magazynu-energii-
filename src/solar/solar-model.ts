import type { PvProfileRecord } from "../types/pv-profile.js";

/**
 * Opcje konfiguracyjne modelu solarnego.
 */
export interface SolarModelOptions {
  readonly year?: number | undefined;
  readonly tilt?: number | undefined;
  readonly azimuth?: number | undefined;
  readonly loss?: number | undefined;
  /** Moc AC falownika [kW]. Domyślnie kWp / 1.2. Powyżej niej produkcja jest ucinana. */
  readonly acPowerKw?: number | undefined;
}

/**
 * Wynik obliczenia rocznych sum nasłonecznienia dla danej lokalizacji.
 */
export interface AnnualIrradiationSummary {
  /** Roczna suma napromieniowania na płaszczyznę poziomą [kWh/m²] */
  readonly horizontalKwhPerM2: number;
  /** Roczna suma napromieniowania na płaszczyznę modułu [kWh/m²] */
  readonly tiltedKwhPerM2: number;
  /** Stosunek napromieniowania modułu do poziomego (gain płaszczyzny nachylonej) */
  readonly tiltRatio: number;
}

/** Stała słoneczna [W/m²] */
const ISC = 1361;

/** Albedo podłoża (trawa / jasna ziemia) */
const GROUND_ALBEDO = 0.2;

/** Znamionowa temperatura pracy ogniwa (NOCT) [°C] */
const NOCT = 45;

/** Współczynnik temperaturowy mocy modułu mono-Si [1/K] */
const GAMMA_COEFF = 0.004;

/** Domyślny kąt nachylenia modułów [°] */
const DEFAULT_TILT_DEG = 35;

/** Domyślny azymut (180° = południe) [°] */
const DEFAULT_AZIMUTH_DEG = 180;

/** Straty systemowe (okablowanie, falownik, zabrudzenie) = 14% */
const DEFAULT_LOSS_FRACTION = 0.14;

/** Stosunek mocy DC do AC, gdy falownik nie jest podany: AC = kWp / 1.2 */
const DEFAULT_DC_AC_RATIO = 1.2;

/** Stały rok referencyjny, nieprzestępny — dwa uruchomienia liczą ten sam kalendarz */
const DEFAULT_YEAR = 2023;

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Trzy pasy klimatyczne Polski. Każdy ma 12 miesięcznych sum nasłonecznienia
 * poziomego [kWh/m²] i 12 średnich temperatur [°C]. Szerokość między pasami
 * jest interpolowana liniowo; poza skrajnymi pasami wartość jest obcinana.
 *
 * Sumy roczne: południe 1110, centrum 1050, północ 940 kWh/m².
 * Północ ma pochmurniejszą zimę (Bałtyk) i jaśniejsze lato.
 * Warszawa (52,23°N) wpada między centrum a północ i zostaje w 1000–1100.
 */
interface ClimateBand {
  readonly latitudeDeg: number;
  readonly monthlyGhiKwhPerM2: readonly number[];
  readonly monthlyTempC: readonly number[];
}

const CLIMATE_BANDS: readonly ClimateBand[] = [
  {
    latitudeDeg: 50,
    monthlyGhiKwhPerM2: [24, 44, 84, 120, 158, 166, 164, 140, 96, 56, 34, 24],
    monthlyTempC: [0.0, 1.0, 4.5, 9.5, 14.5, 17.5, 19.5, 19.0, 14.5, 9.5, 4.5, 1.0],
  },
  {
    latitudeDeg: 52,
    monthlyGhiKwhPerM2: [22, 40, 78, 112, 150, 158, 156, 132, 90, 52, 38, 22],
    monthlyTempC: [-1.5, -0.5, 3.0, 8.5, 13.5, 16.5, 18.5, 18.0, 13.5, 8.5, 3.5, 0.0],
  },
  {
    latitudeDeg: 54,
    monthlyGhiKwhPerM2: [16, 28, 68, 99, 138, 149, 146, 122, 80, 42, 31, 21],
    monthlyTempC: [-3.0, -2.0, 1.5, 6.5, 11.5, 15.0, 17.0, 16.5, 12.0, 7.0, 2.0, -1.5],
  },
];

interface MonthClimate {
  readonly ghiKwh: number;
  readonly tempC: number;
}

function climateForLatitude(lat: number): MonthClimate[] {
  const bands = CLIMATE_BANDS;
  const first = bands[0]!;
  const last = bands[bands.length - 1]!;
  const mix = (a: ClimateBand, b: ClimateBand, t: number): MonthClimate[] =>
    a.monthlyGhiKwhPerM2.map((ghi, month) => ({
      ghiKwh: ghi + t * ((b.monthlyGhiKwhPerM2[month] ?? ghi) - ghi),
      tempC: (a.monthlyTempC[month] ?? 0) + t * ((b.monthlyTempC[month] ?? 0) - (a.monthlyTempC[month] ?? 0)),
    }));

  if (lat <= first.latitudeDeg) return mix(first, first, 0);
  if (lat >= last.latitudeDeg) return mix(last, last, 0);
  for (let i = 0; i < bands.length - 1; i++) {
    const left = bands[i]!;
    const right = bands[i + 1]!;
    if (lat <= right.latitudeDeg) {
      const span = right.latitudeDeg - left.latitudeDeg;
      const t = span === 0 ? 0 : (lat - left.latitudeDeg) / span;
      return mix(left, right, t);
    }
  }
  return mix(last, last, 0);
}

/** FNV-1a — ziarno dnia pochmurnego/słonecznego zależy tylko od miejsca i miesiąca. */
function hashCoordsAndDate(lat: number, lon: number, year: number, month: number): number {
  const ilat = Math.floor(lat * 100);
  const ilon = Math.floor(lon * 100);
  let h = 2166136261 >>> 0;
  for (const val of [ilat, ilon, year, month]) {
    let v = val | 0;
    for (let b = 0; b < 4; b++) {
      h ^= v & 0xff;
      h = Math.imul(h, 16777619) >>> 0;
      v >>= 8;
    }
  }
  return h >>> 0;
}

function createMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    let t = (a += 0x6d2b79f5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ostatnia niedziela miesiąca (zmiana czasu w UE: marzec i październik). */
function lastSunday(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  return last.getUTCDate() - last.getUTCDay();
}

/**
 * Przesunięcie czasu ściennego względem UTC.
 * W Polsce CET/CEST: ostatnia niedziela marca, godzina 2:00 → 3:00,
 * ostatnia niedziela października, godzina 3:00 → 2:00.
 * Poza Polską — stała strefa z długości geograficznej, bez zmiany czasu.
 */
function localUtcOffsetHours(lat: number, lon: number, year: number, month: number, day: number, hour: number): number {
  if (lat >= 48 && lat <= 56 && lon >= 13 && lon <= 26) {
    const spring = lastSunday(year, 2);
    const autumn = lastSunday(year, 9);
    if (month < 2 || month > 9) return 1;
    if (month > 2 && month < 9) return 2;
    if (month === 2) {
      if (day < spring) return 1;
      if (day > spring) return 2;
      return hour >= 2 ? 2 : 1;
    }
    if (day < autumn) return 2;
    if (day > autumn) return 1;
    return hour >= 3 ? 1 : 2;
  }
  return Math.round(lon / 15);
}

/**
 * Pozycja Słońca wg NOAA (deklinacja Spencera, równanie czasu, kąt godzinowy).
 * Azymut: 0 = północ, π = południe.
 */
function noaaSunPosition(
  latRad: number,
  lonDeg: number,
  year: number,
  doy: number,
  month: number,
  day: number,
  hour: number,
): { cosZenith: number; elevationRad: number; azimuthRad: number; omegaRad: number; sunsetRad: number; eccentricity: number } {
  const gamma = (2 * Math.PI * (doy - 1 + (hour + 0.5 - 12) / 24)) / 365;
  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const sinDec = Math.sin(declination);
  const cosDec = Math.cos(declination);
  const eccentricity = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);

  const cosOmegaS = -Math.tan(latRad) * Math.tan(declination);
  let sunsetRad = 0;
  if (cosOmegaS <= -1) sunsetRad = Math.PI;
  else if (cosOmegaS >= 1) sunsetRad = 0;
  else sunsetRad = Math.acos(cosOmegaS);

  const equationOfTimeMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.04089 * Math.sin(2 * gamma));

  const utcOffset = localUtcOffsetHours(latRad * 180 / Math.PI, lonDeg, year, month, day, hour);
  const solarHour = hour + 0.5 - utcOffset + lonDeg / 15 + equationOfTimeMin / 60;
  const omegaRad = (solarHour - 12) * (Math.PI / 12);

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const cosZenith = sinLat * sinDec + cosLat * cosDec * Math.cos(omegaRad);
  let elevationRad = 0;
  let azimuthRad = 0;
  if (cosZenith > 0) {
    const zenith = Math.acos(Math.max(-1, Math.min(1, cosZenith)));
    elevationRad = Math.max(0, Math.PI / 2 - zenith);
    const east = -cosDec * Math.sin(omegaRad);
    const north = cosLat * sinDec - sinLat * cosDec * Math.cos(omegaRad);
    azimuthRad = Math.atan2(east, north);
    if (azimuthRad < 0) azimuthRad += 2 * Math.PI;
  }

  return { cosZenith, elevationRad, azimuthRad, omegaRad, sunsetRad, eccentricity };
}

/** Dzienna suma ekstraterrestyczna na poziom [Wh/m²]. */
function extraterrestrialDailyWh(latRad: number, doy: number): number {
  const noon = noaaSunPosition(latRad, 0, DEFAULT_YEAR, doy, 0, 1, 12);
  const declinationGamma = (2 * Math.PI * (doy - 1)) / 365;
  const declination =
    0.006918 -
    0.399912 * Math.cos(declinationGamma) +
    0.070257 * Math.sin(declinationGamma) -
    0.006758 * Math.cos(2 * declinationGamma) +
    0.000907 * Math.sin(2 * declinationGamma) -
    0.002697 * Math.cos(3 * declinationGamma) +
    0.00148 * Math.sin(3 * declinationGamma);
  const sunset = noon.sunsetRad;
  if (sunset <= 0) return 0;
  const e0 = 1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const h0 =
    (24 / Math.PI) * ISC * e0 * (cosLat * Math.cos(declination) * Math.sin(sunset) + sunset * sinLat * Math.sin(declination));
  return Math.max(0, h0);
}

/**
 * Hollands–Huget (1983): rozkład dziennego Kt, którego średnia jest miesięcznym Kt.
 * Rozkład buduje się raz na miesiąc; `u` jest liczbą z ziarna (0, 1).
 */
interface HollandsDistribution {
  readonly kMin: number;
  readonly dk: number;
  readonly cdf: readonly number[];
}

function buildHollandsDistribution(ktMean: number): HollandsDistribution | null {
  const kMin = 0.05;
  const excess = Math.max(0, ktMean - 0.75);
  let kMax = Math.min(0.95, 0.6313 + 0.267 * ktMean - 11.9 * excess ** 8);
  if (kMax < ktMean + 0.02) kMax = Math.min(0.95, ktMean + 0.05);
  if (kMax <= kMin + 1e-3) return null;

  const lambda = solveHollandsLambda(kMin, kMax, ktMean);
  const knots = 64;
  const dk = (kMax - kMin) / knots;
  const weightAt = (k: number): number => Math.max(0, kMax - k) * Math.exp(lambda * k);
  const cdf: number[] = [0];
  let acc = 0;
  let prev = weightAt(kMin);
  for (let i = 1; i <= knots; i++) {
    const k = kMin + dk * i;
    const w = weightAt(k);
    acc += 0.5 * (prev + w) * dk;
    cdf.push(acc);
    prev = w;
  }
  const scale = acc > 0 ? 1 / acc : 0;
  for (let i = 0; i < cdf.length; i++) cdf[i] = (cdf[i] ?? 0) * scale;
  return { kMin, dk, cdf };
}

function sampleHollandsHugetKt(distribution: HollandsDistribution | null, ktMean: number, u: number): number {
  if (distribution === null) return Math.min(0.9, Math.max(0.05, ktMean));
  const target = Math.min(0.999999, Math.max(0.000001, u));
  const cdf = distribution.cdf;
  let lo = 0;
  let hi = cdf.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((cdf[mid] ?? 0) < target) lo = mid;
    else hi = mid;
  }
  const c0 = cdf[lo] ?? 0;
  const c1 = cdf[hi] ?? c0;
  const frac = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
  return distribution.kMin + distribution.dk * (lo + frac);
}

function hollandsMean(kMin: number, kMax: number, lambda: number): number {
  const knots = 64;
  const dk = (kMax - kMin) / knots;
  let z = 0;
  let moment = 0;
  let prevW = Math.max(0, kMax - kMin) * Math.exp(lambda * kMin);
  let prevK = kMin;
  for (let i = 1; i <= knots; i++) {
    const k = kMin + dk * i;
    const w = Math.max(0, kMax - k) * Math.exp(lambda * k);
    const area = 0.5 * (prevW + w) * dk;
    z += area;
    moment += area * (0.5 * (prevK + k));
    prevW = w;
    prevK = k;
  }
  return z > 0 ? moment / z : (kMin + kMax) / 2;
}

function solveHollandsLambda(kMin: number, kMax: number, ktMean: number): number {
  const target = Math.min(kMax - 1e-3, Math.max(kMin + 1e-3, ktMean));
  let lo = -30;
  let hi = 30;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (hollandsMean(kMin, kMax, mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Erbs (1982): ułamek składowej rozproszonej w funkcji Kt. */
function erbsDiffuseFraction(kt: number): number {
  if (kt <= 0.22) return 1 - 0.09 * kt;
  if (kt <= 0.8) {
    return 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  }
  return 0.165;
}

/**
 * Collares-Pereira i Rabl (1979): udział godziny w sumie dobowej
 * promieniowania globalnego (rt) i rozproszonego (rd).
 */
function collaresPereiraWeights(
  omegaRad: number,
  sunsetRad: number,
  cosZenith: number,
): { rt: number; rd: number } {
  if (sunsetRad <= 1e-4 || cosZenith <= 0 || Math.abs(omegaRad) >= sunsetRad) return { rt: 0, rd: 0 };
  const den = Math.sin(sunsetRad) - sunsetRad * Math.cos(sunsetRad);
  if (den <= 1e-6) return { rt: 0, rd: 0 };
  const a = 0.409 + 0.5016 * Math.sin(sunsetRad - Math.PI / 3);
  const b = 0.6609 - 0.4767 * Math.sin(sunsetRad - Math.PI / 3);
  const cosDiff = Math.cos(omegaRad) - Math.cos(sunsetRad);
  return {
    rt: Math.max(0, (Math.PI / 24) * (a + b * Math.cos(omegaRad)) * (cosDiff / den)),
    rd: Math.max(0, (Math.PI / 24) * (cosDiff / den)),
  };
}

/**
 * Hay–Davies (1980): irradiancja na płaszczyźnie modułu [W/m²]
 * ze składowej bezpośredniej, rozproszonej i odbitej.
 */
function hayDaviesTiltedW(
  beamW: number,
  diffuseW: number,
  cosZenith: number,
  elevationRad: number,
  sunAzimuthRad: number,
  tiltRad: number,
  moduleAzimuthRad: number,
  eccentricity: number,
): number {
  if (elevationRad <= 0 || cosZenith <= 1e-4) return 0;
  const cosBeta = Math.cos(tiltRad);
  const sinBeta = Math.sin(tiltRad);
  const sinAlpha = Math.sin(elevationRad);
  const cosAlpha = Math.cos(elevationRad);
  const cosIncidence = sinAlpha * cosBeta + cosAlpha * Math.cos(sunAzimuthRad - moduleAzimuthRad) * sinBeta;
  let rb = 0;
  if (cosIncidence > 0) {
    const rbMax = Math.min(10, 1 / Math.max(sinAlpha, 0.087));
    rb = Math.min(rbMax, Math.max(0, cosIncidence / cosZenith));
  }
  const i0 = ISC * eccentricity * cosZenith;
  const anisotropy = i0 > 0 ? Math.max(0, Math.min(1, beamW / i0)) : 0;
  const beamOnTilt = beamW * rb;
  const diffuseOnTilt = diffuseW * (anisotropy * rb + (1 - anisotropy) * ((1 + cosBeta) / 2));
  const reflected = (beamW + diffuseW) * GROUND_ALBEDO * ((1 - cosBeta) / 2);
  return Math.max(0, beamOnTilt + diffuseOnTilt + reflected);
}

interface HourIrradiance {
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly horizontalW: number;
  readonly tiltedW: number;
  readonly ambientC: number;
}

/**
 * Rok godzinowy: stałe klimatyczne pasa → dni Hollands–Huget (ziarno) →
 * rozkład Collares-Pereira → Erbs → Hay–Davies. Pozioma suma miesiąca
 * jest równa stałej klimatycznej.
 */
function simulateYear(
  lat: number,
  lon: number,
  tiltDeg: number,
  azimuthDeg: number,
  year: number,
): HourIrradiance[] {
  const latRad = (lat * Math.PI) / 180;
  const tiltRad = (tiltDeg * Math.PI) / 180;
  const moduleAzimuthRad = (azimuthDeg * Math.PI) / 180;
  const climate = climateForLatitude(lat);
  const hours: HourIrradiance[] = [];
  let doy = 1;

  for (let month = 0; month < 12; month++) {
    const days = DAYS_IN_MONTH[month] ?? 30;
    const monthClimate = climate[month] ?? { ghiKwh: 0, tempC: 10 };
    const monthlyWh = monthClimate.ghiKwh * 1000;
    const h0: number[] = [];
    for (let day = 1; day <= days; day++) {
      h0.push(extraterrestrialDailyWh(latRad, doy + day - 1));
    }
    const h0Sum = h0.reduce((sum, value) => sum + value, 0);
    const ktMean = h0Sum > 0 ? monthlyWh / h0Sum : 0;
    const distribution = buildHollandsDistribution(ktMean);
    const rng = createMulberry32(hashCoordsAndDate(lat, lon, year, month + 1));

    const dailyWh: number[] = [];
    let rawSum = 0;
    for (let dayIndex = 0; dayIndex < days; dayIndex++) {
      const h0Day = h0[dayIndex] ?? 0;
      const kt = h0Day > 0 ? sampleHollandsHugetKt(distribution, ktMean, rng()) : 0;
      const energy = kt * h0Day;
      dailyWh.push(energy);
      rawSum += energy;
    }
    const scale = rawSum > 0 ? monthlyWh / rawSum : 0;

    for (let dayIndex = 0; dayIndex < days; dayIndex++) {
      const day = dayIndex + 1;
      const dayDoy = doy++;
      const hd = (dailyWh[dayIndex] ?? 0) * scale;
      const h0Day = h0[dayIndex] ?? 0;
      const kt = h0Day > 0 ? Math.max(0.05, Math.min(0.9, hd / h0Day)) : 0;
      const diffuseDay = erbsDiffuseFraction(kt) * hd;

      const rawRt: number[] = [];
      const rawRd: number[] = [];
      const positions: Array<ReturnType<typeof noaaSunPosition>> = [];
      let sumRt = 0;
      let sumRd = 0;
      for (let hour = 0; hour < 24; hour++) {
        const sun = noaaSunPosition(latRad, lon, year, dayDoy, month, day, hour);
        positions.push(sun);
        const weights = collaresPereiraWeights(sun.omegaRad, sun.sunsetRad, sun.cosZenith);
        rawRt.push(weights.rt);
        rawRd.push(weights.rd);
        sumRt += weights.rt;
        sumRd += weights.rd;
      }

      const horizontalW: number[] = [];
      const diffuseW: number[] = [];
      for (let hour = 0; hour < 24; hour++) {
        const rt = sumRt > 0 ? (rawRt[hour] ?? 0) / sumRt : 0;
        const rd = sumRd > 0 ? (rawRd[hour] ?? 0) / sumRd : 0;
        horizontalW.push(rt * hd);
        diffuseW.push(rd * diffuseDay);
      }
      // Erbs dotyczy doby. Godzina nie może mieć więcej rozproszonego niż globalnego,
      // więc nadwyżkę przenosimy na godziny, które mają jeszcze miejsce.
      for (let pass = 0; pass < 24; pass++) {
        let overflow = 0;
        let room = 0;
        for (let hour = 0; hour < 24; hour++) {
          const global = horizontalW[hour] ?? 0;
          const diffuse = diffuseW[hour] ?? 0;
          if (diffuse > global) {
            overflow += diffuse - global;
            diffuseW[hour] = global;
          } else {
            room += global - diffuse;
          }
        }
        if (overflow <= 1e-6 || room <= 1e-6) break;
        for (let hour = 0; hour < 24; hour++) {
          const space = (horizontalW[hour] ?? 0) - (diffuseW[hour] ?? 0);
          if (space > 0) diffuseW[hour] = (diffuseW[hour] ?? 0) + overflow * (space / room);
        }
      }

      for (let hour = 0; hour < 24; hour++) {
        const sun = positions[hour]!;
        const globalW = horizontalW[hour] ?? 0;
        const diffuseHour = Math.min(globalW, diffuseW[hour] ?? 0);
        const beamW = Math.max(0, globalW - diffuseHour);
        const tiltedW = hayDaviesTiltedW(
          beamW,
          diffuseHour,
          sun.cosZenith,
          sun.elevationRad,
          sun.azimuthRad,
          tiltRad,
          moduleAzimuthRad,
          sun.eccentricity,
        );
        hours.push({
          month,
          day,
          hour,
          horizontalW: globalW,
          tiltedW,
          ambientC: monthClimate.tempC,
        });
      }
    }
  }

  return hours;
}

/**
 * Moc AC [kW].
 * T = T_amb + (NOCT − 20) / 800 · G
 * P = kWp · G / 1000 · (1 + γ(T − 25)) · (1 − straty), potem obcięcie do mocy AC.
 * γ = −0,004 1/K dla mono-Si.
 */
function modulePowerKw(
  irradianceW: number,
  ambientC: number,
  peakPowerKwp: number,
  inverterAcKw: number,
  lossFraction: number,
): { dcKw: number; acKw: number } {
  const cellC = ambientC + ((NOCT - 20) / 800) * irradianceW;
  const temperatureFactor = 1 - GAMMA_COEFF * (cellC - 25);
  const dcKw = Math.max(0, peakPowerKwp * (irradianceW / 1000) * Math.max(0, temperatureFactor) * (1 - lossFraction));
  return { dcKw, acKw: Math.min(inverterAcKw, dcKw) };
}
/**
 * Lokalny model słońca. Nie wykonuje żadnych zapytań sieciowych.
 *
 * 1. Pozycja Słońca — NOAA
 * 2. Dzień pochmurny / słoneczny — Hollands–Huget, ziarno z lokalizacji i miesiąca
 * 3. Rozkład dobowy — Collares-Pereira i Rabl
 * 4. Podział bezpośrednie / rozproszone — Erbs
 * 5. Przeliczenie na kąt modułu — Hay–Davies
 * 6. Temperatura modułu, straty 14% i clipping AC
 */
export class SolarModel {
  /**
   * Roczny profil produkcji PV co 15 minut (35 040 rekordów w roku nieprzestępnym).
   * Godzina w znaczniku czasu jest czasem ściennym zapisanym jako UTC.
   * Moc jest już po stratach 14% i po obcięciu do mocy AC.
   */
  async fetchPvProfile(
    lat: number,
    lon: number,
    peakPowerKwp: number,
    options?: SolarModelOptions,
  ): Promise<PvProfileRecord[]> {
    return this.buildProduction(lat, lon, peakPowerKwp, options).records;
  }

  /**
   * To samo co `fetchPvProfile`, plus energia przed clippingiem i energia ucięta przez falownik.
   */
  productionProfile(
    lat: number,
    lon: number,
    peakPowerKwp: number,
    options?: SolarModelOptions,
  ): { records: PvProfileRecord[]; rawKwh: number; clippedKwh: number } {
    return this.buildProduction(lat, lon, peakPowerKwp, options);
  }

  private buildProduction(
    lat: number,
    lon: number,
    peakPowerKwp: number,
    options?: SolarModelOptions,
  ): { records: PvProfileRecord[]; rawKwh: number; clippedKwh: number } {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error(`Nieprawidłowe współrzędne geograficzne: lat=${lat}, lon=${lon}`);
    }

    const year = options?.year ?? DEFAULT_YEAR;
    const tiltDeg = options?.tilt ?? DEFAULT_TILT_DEG;
    const azimuthDeg = options?.azimuth ?? DEFAULT_AZIMUTH_DEG;
    const rawLoss = options?.loss;
    const lossFraction = rawLoss !== undefined
      ? (rawLoss > 1 ? rawLoss / 100 : Math.max(0, rawLoss))
      : DEFAULT_LOSS_FRACTION;
    const inverterAcKw = options?.acPowerKw !== undefined && Number.isFinite(options.acPowerKw)
      ? Math.max(0, options.acPowerKw)
      : peakPowerKwp / DEFAULT_DC_AC_RATIO;

    if (peakPowerKwp <= 0) {
      return { records: zeroProfile(year), rawKwh: 0, clippedKwh: 0 };
    }

    const hours = simulateYear(lat, lon, tiltDeg, azimuthDeg, year);
    const records: PvProfileRecord[] = [];
    let rawKwh = 0;
    let clippedKwh = 0;
    for (const hour of hours) {
      const power = modulePowerKw(hour.tiltedW, hour.ambientC, peakPowerKwp, inverterAcKw, lossFraction);
      rawKwh += power.dcKw;
      clippedKwh += power.dcKw - power.acKw;
      for (let quarter = 0; quarter < 4; quarter++) {
        records.push({
          timestamp: new Date(Date.UTC(year, hour.month, hour.day, hour.hour, quarter * 15)),
          pvProductionKw: power.acKw,
        });
      }
    }
    return { records, rawKwh, clippedKwh };
  }

  /**
   * Roczne sumy napromieniowania [kWh/m²] na poziom i na płaszczyznę modułu.
   * Poziom jest sumą stałych klimatycznych pasa; nachylenie liczy Hay–Davies.
   */
  computeAnnualIrradiation(
    lat: number,
    lon: number,
    options?: SolarModelOptions,
  ): AnnualIrradiationSummary {
    const year = options?.year ?? DEFAULT_YEAR;
    const tiltDeg = options?.tilt ?? DEFAULT_TILT_DEG;
    const azimuthDeg = options?.azimuth ?? DEFAULT_AZIMUTH_DEG;
    const hours = simulateYear(lat, lon, tiltDeg, azimuthDeg, year);
    let horizontalWh = 0;
    let tiltedWh = 0;
    for (const hour of hours) {
      horizontalWh += hour.horizontalW;
      tiltedWh += hour.tiltedW;
    }
    const horizontalKwhPerM2 = horizontalWh / 1000;
    const tiltedKwhPerM2 = tiltedWh / 1000;
    return {
      horizontalKwhPerM2,
      tiltedKwhPerM2,
      tiltRatio: horizontalKwhPerM2 > 0 ? tiltedKwhPerM2 / horizontalKwhPerM2 : 1,
    };
  }
}

function zeroProfile(year: number): PvProfileRecord[] {
  const records: PvProfileRecord[] = [];
  for (let month = 0; month < 12; month++) {
    const days = DAYS_IN_MONTH[month] ?? 30;
    for (let day = 1; day <= days; day++) {
      for (let hour = 0; hour < 24; hour++) {
        for (let quarter = 0; quarter < 4; quarter++) {
          records.push({
            timestamp: new Date(Date.UTC(year, month, day, hour, quarter * 15)),
            pvProductionKw: 0,
          });
        }
      }
    }
  }
  return records;
}
