import XLSX from "xlsx";
import type { TimeSeriesRecord } from "../types/timeseries.js";
import { kwhPerStepToKw } from "../utils/energy-math.js";

/**
 * Adapter dla eksportu "Dane profilowe dla PPE" — realny format OSD dla dużych
 * odbiorców (firm) z rozdzielczością 15-minutową.
 *
 * Format źródłowy jest "szeroki": jeden wiersz = jeden dzień, kolumny to
 * kolejne 15-minutowe okna czasowe (00:15–24:00, 96 kolumn), plus kolumna
 * `Kierunek` (Pobór/Oddanie) i dodatkowe kolumny `HH:MMA` na powtórzoną
 * godzinę w dniu zmiany czasu z letniego na zimowy.
 */
export class FirmProfileAdapter {
  async parse(filePath: string): Promise<TimeSeriesRecord[]> {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]!]!;
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: "",
    });

    const headerRow = this.findHeaderRow(rows);
    if (headerRow === null) {
      return [];
    }

    const header = rows[headerRow]!.map((h) => String(h).trim());
    const timeColumns = this.mapTimeColumns(header);

    // Grupujemy wiersze danych po dacie, żeby połączyć Pobór/Oddanie tego samego dnia.
    const byDate = new Map<string, { pobor?: unknown[]; oddanie?: unknown[] }>();

    for (let i = headerRow + 1; i < rows.length; i++) {
      const row = rows[i]!;
      const dateStr = String(row[0] ?? "").trim();
      const kierunek = String(row[1] ?? "").trim().toLowerCase();
      if (!dateStr || !kierunek) continue;

      const entry = byDate.get(dateStr) ?? {};
      if (kierunek === "pobór" || kierunek === "pobor") {
        entry.pobor = row;
      } else if (kierunek === "oddanie") {
        entry.oddanie = row;
      }
      byDate.set(dateStr, entry);
    }

    const records: TimeSeriesRecord[] = [];

    for (const [dateStr, { pobor, oddanie }] of byDate) {
      const dayStart = this.parseDate(dateStr);
      if (dayStart === null) continue;

      for (const col of timeColumns) {
        const poborKwh = pobor ? this.toNumber(pobor[col.index]) : 0;
        const oddanieKwh = oddanie ? this.toNumber(oddanie[col.index]) : 0;

        const netKwh = poborKwh - oddanieKwh;
        const loadKw = kwhPerStepToKw(Math.max(netKwh, 0));
        const pvProductionKw = kwhPerStepToKw(Math.max(-netKwh, 0));

        const timestamp = new Date(
          dayStart.getTime() +
            (col.hour * 60 + col.minute) * 60 * 1000 +
            col.dstOffsetHours * 3600 * 1000,
        );

        records.push({ timestamp, loadKw, pvProductionKw });
      }
    }

    records.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return records;
  }

  /** Znajduje wiersz nagłówka — pierwszy wiersz zaczynający się od "Data". */
  private findHeaderRow(rows: unknown[][]): number | null {
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i]?.[0] ?? "").trim() === "Data") {
        return i;
      }
    }
    return null;
  }

  /**
   * Mapuje kolumny nagłówka na (godzina, minuta), pomijając "Data", "Kierunek", "Suma".
   * Kolumny z sufiksem "A" (np. "02:15A") to powtórzona godzina przy DST — przesunięte o +1h.
   */
  private mapTimeColumns(
    header: string[],
  ): Array<{ index: number; hour: number; minute: number; dstOffsetHours: number }> {
    const columns: Array<{ index: number; hour: number; minute: number; dstOffsetHours: number }> = [];

    for (let i = 0; i < header.length; i++) {
      const label = header[i]!;
      const match = label.match(/^(\d{1,2}):(\d{2})(A)?$/);
      if (!match) continue;

      let hour = parseInt(match[1]!, 10);
      const minute = parseInt(match[2]!, 10);
      const isDstDuplicate = match[3] === "A";

      // "24:00" oznacza koniec doby — traktujemy jako godzinę 0 następnego dnia
      // pomijamy tu i pozwalamy, by kolejny dzień zaczął się swoim "00:15" itd.,
      // ale skoro to ostatni słupek danego dnia, przypisujemy go do godziny 24 (23:60+15 nie istnieje)
      if (hour === 24) hour = 24;

      columns.push({
        index: i,
        hour,
        minute,
        dstOffsetHours: isDstDuplicate ? 1 : 0,
      });
    }

    return columns;
  }

  private parseDate(dateStr: string): Date | null {
    // Format: "2025-09-01" lub "2025-09-01 00:00"
    const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!match) return null;
    return new Date(
      Date.UTC(parseInt(match[1]!, 10), parseInt(match[2]!, 10) - 1, parseInt(match[3]!, 10)),
    );
  }

  private toNumber(value: unknown): number {
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const parsed = parseFloat(value.replace(",", "."));
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }
}
