import csvParser from 'csv-parser';
import * as fs from 'node:fs';
import type { TimeSeriesRecord } from '../types/timeseries.js';

export abstract class BaseAdapter {
  /**
   * Maps a raw CSV row to a TimeSeriesRecord.
   * Return null to skip the row.
   */
  protected abstract mapRow(row: Record<string, string>): TimeSeriesRecord | null;
  
  /**
   * Returns csv-parser options specific to the format.
   */
  protected abstract getCsvOptions(): csvParser.Options;

  /**
   * Optional file encoding, defaults to utf-8.
   */
  protected getEncoding(): BufferEncoding {
    return 'utf8';
  }

  /**
   * Parses the given CSV file into an array of TimeSeriesRecords.
   */
  async parse(filePath: string): Promise<TimeSeriesRecord[]> {
    return new Promise((resolve, reject) => {
      const results: TimeSeriesRecord[] = [];
      const options = this.getCsvOptions();

      const handleStreamError = (error: NodeJS.ErrnoException): void => {
        if (error.code === 'ENOENT') {
          reject(new Error(`Nie znaleziono pliku CSV: ${filePath}`));
        } else {
          reject(error);
        }
      };

      fs.createReadStream(filePath, { encoding: this.getEncoding() })
        .on('error', handleStreamError)
        .pipe(csvParser(options))
        .on('data', (data: Record<string, string>) => {
          try {
            const record = this.mapRow(data);
            if (record) {
              results.push(record);
            }
          } catch (error) {
            // Silently ignore mapping errors (e.g. malformed rows)
          }
        })
        .on('end', () => resolve(results))
        .on('error', handleStreamError);
    });
  }
}
