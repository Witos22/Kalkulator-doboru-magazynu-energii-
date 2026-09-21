import type { PvgisResponse, PvProfileRecord } from '../types/pvgis.js';

/**
 * Converts a UTC instant to the equivalent local wall-clock time in Poland,
 * using the IANA timezone database (handles CET/CEST transitions correctly)
 * instead of manually re-implementing DST rules.
 */
function utcToWarsawWallClock(utcDate: Date): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(utcDate);

  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);

  // formatToParts may report hour as "24" for midnight — normalize to 0.
  const hour = get('hour') % 24;

  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute')));
}

export class PvgisClient {
  private readonly BASE_URL = 'https://re.jrc.ec.europa.eu/api/v5_3/seriescalc';

  async fetchPvProfile(
    lat: number,
    lon: number,
    peakPowerKwp: number,
    options?: { year?: number; tilt?: number; azimuth?: number; loss?: number }
  ): Promise<PvProfileRecord[]> {
    const url = new URL(this.BASE_URL);
    url.searchParams.append('lat', lat.toString());
    url.searchParams.append('lon', lon.toString());
    url.searchParams.append('peakpower', peakPowerKwp.toString());
    url.searchParams.append('pvcalculation', '1');
    url.searchParams.append('loss', (options?.loss ?? 14).toString());
    url.searchParams.append('outputformat', 'json');

    if (options?.tilt !== undefined && options?.azimuth !== undefined) {
      url.searchParams.append('angle', options.tilt.toString());
      url.searchParams.append('aspect', options.azimuth.toString());
    } else {
      url.searchParams.append('optimalangles', '1');
    }

    const year = options?.year ?? 2023;
    url.searchParams.append('startyear', year.toString());
    url.searchParams.append('endyear', year.toString());

    const response = await fetch(url.toString());
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('PVGIS API rate limit exceeded (429)');
      }
      throw new Error(`PVGIS API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as PvgisResponse;
    const records: PvProfileRecord[] = [];

    for (const record of data.outputs.hourly) {
      // Time format: YYYYMMDD:HHMM (UTC)
      const year = parseInt(record.time.substring(0, 4), 10);
      const month = parseInt(record.time.substring(4, 6), 10) - 1;
      const day = parseInt(record.time.substring(6, 8), 10);
      const hour = parseInt(record.time.substring(9, 11), 10);
      const minute = parseInt(record.time.substring(11, 13), 10);

      // We parse the UTC time
      const utcDate = new Date(Date.UTC(year, month, day, hour, minute));

      // Convert to local Polish wall-clock time (handles CET/CEST via IANA tzdata)
      const localWallClockMs = utcToWarsawWallClock(utcDate).getTime();

      // We divide PV output in Watts by 1000 to get kW
      const pvProductionKw = record.P / 1000;

      // Zero-order hold interpolation: 1 hour -> 4 x 15-minute intervals
      for (let i = 0; i < 4; i++) {
        // Create timestamp for each 15-minute interval
        // We instantiate as UTC so that `.getUTCHours()` aligns with local time logic
        const intervalMs = localWallClockMs + i * 15 * 60 * 1000;
        const timestamp = new Date(intervalMs);
        
        records.push({
          timestamp,
          pvProductionKw,
        });
      }
    }

    return records;
  }
}
