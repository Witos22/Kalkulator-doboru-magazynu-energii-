import type { PvgisResponse, PvProfileRecord } from '../types/pvgis.js';

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
      
      // Determine DST offset for Poland (CET = +1, CEST = +2)
      // DST starts last Sunday of March at 01:00 UTC
      const march31 = new Date(Date.UTC(year, 2, 31));
      const lastSundayMarch = new Date(Date.UTC(year, 2, 31 - march31.getUTCDay(), 1));
      
      // DST ends last Sunday of October at 01:00 UTC
      const oct31 = new Date(Date.UTC(year, 9, 31));
      const lastSundayOct = new Date(Date.UTC(year, 9, 31 - oct31.getUTCDay(), 1));

      const isDst = utcDate >= lastSundayMarch && utcDate < lastSundayOct;
      const offsetHours = isDst ? 2 : 1;

      // Calculate local wall-clock time in ms
      const localWallClockMs = utcDate.getTime() + offsetHours * 3600 * 1000;
      
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
