import { BaseAdapter } from './base-adapter.js';
import type { TimeSeriesRecord } from '../types/timeseries.js';
import type csvParser from 'csv-parser';
import { kwhPerStepToKw } from '../utils/energy-math.js';

export class TauronAdapter extends BaseAdapter {
  protected getCsvOptions(): csvParser.Options {
    return { separator: ';' };
  }

  protected override getEncoding(): BufferEncoding {
    // Handling possible Windows-1250 encoding by using latin1 as an approximation
    // for standard ASCII characters used in column headers and numbers.
    return 'latin1';
  }

  protected mapRow(row: Record<string, string>): TimeSeriesRecord | null {
    const dateStr = row['Data'];
    const timeStr = row['Godzina'];
    const consumptionStr = row['EC [kWh]'];

    if (!dateStr || !timeStr || !consumptionStr) {
      return null;
    }

    const [day, month, year] = dateStr.split('.');
    const [hours, minutes] = timeStr.split(':');
    
    if (!day || !month || !year || !hours || !minutes) {
      return null;
    }

    // Creating Date object in UTC to consistently represent local wall-clock time
    const timestamp = new Date(Date.UTC(
      parseInt(year, 10),
      parseInt(month, 10) - 1,
      parseInt(day, 10),
      parseInt(hours, 10),
      parseInt(minutes, 10)
    ));

    // Convert comma to dot for parsing
    const consumptionKwh = parseFloat(consumptionStr.replace(',', '.'));
    if (isNaN(consumptionKwh)) {
      return null;
    }

    const loadKw = kwhPerStepToKw(consumptionKwh);

    return {
      timestamp,
      loadKw,
      pvProductionKw: 0,
    };
  }
}
