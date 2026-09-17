import { BaseAdapter } from './base-adapter.js';
import type { TimeSeriesRecord } from '../types/timeseries.js';
import type csvParser from 'csv-parser';

export class SemsAdapter extends BaseAdapter {
  protected getCsvOptions(): csvParser.Options {
    return { separator: ',' };
  }

  protected mapRow(row: Record<string, string>): TimeSeriesRecord | null {
    const timeStr = row['Time'] || row['Date/Time'];
    const loadStr = row['House Load(kW)'] || row['Load Power(kW)'];
    const pvStr = row['PV Power(kW)'] || row['PV(W)'];

    if (!timeStr) {
      return null;
    }

    // Expected format: YYYY-MM-DD HH:mm:ss or YYYY/MM/DD HH:mm:ss
    const match = timeStr.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
    if (!match) {
      return null;
    }

    const [, year, month, day, hours, minutes, seconds] = match;
    
    // Creating Date object in UTC to consistently represent local wall-clock time
    const timestamp = new Date(Date.UTC(
      parseInt(year as string, 10),
      parseInt(month as string, 10) - 1,
      parseInt(day as string, 10),
      parseInt(hours as string, 10),
      parseInt(minutes as string, 10),
      parseInt(seconds as string, 10)
    ));

    const loadKw = loadStr ? parseFloat(loadStr.replace(',', '.')) : 0;
    let pvProductionKw = pvStr ? parseFloat(pvStr.replace(',', '.')) : 0;

    // Handle case if PV is given in Watts instead of kW
    if (row['PV(W)']) {
      pvProductionKw /= 1000;
    }

    return {
      timestamp,
      loadKw: isNaN(loadKw) ? 0 : loadKw,
      pvProductionKw: isNaN(pvProductionKw) ? 0 : pvProductionKw,
    };
  }
}
