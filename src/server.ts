import express from "express";
import multer from "multer";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { runAnalysis, AnalysisError } from "./analysis-runner.js";
import type { AdapterType, PvInstallation } from "./analysis-runner.js";
import { APPLIANCES } from "./adapters/declared-consumption-adapter.js";
import type { Appliance } from "./adapters/declared-consumption-adapter.js";
import { DEFAULT_TARIFF_PRICES, DEFAULT_TARIFF_PRICES_SOURCE } from "./types/tariff.js";
import type { TariffType, TariffPrices } from "./types/tariff.js";
import type { ClientSegment } from "./types/financial.js";
import { loadDeviceDatabase } from "./catalog/device-database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env["PORT"] ? parseInt(process.env["PORT"], 10) : 3000;

const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), "kalkulator-magazynu-uploads") });

app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/tariff-defaults/:type", (req, res) => {
  const type = req.params["type"] as TariffType;
  const prices = DEFAULT_TARIFF_PRICES[type];
  if (!prices) {
    res.status(404).json({ error: `Nieznana taryfa: ${type}` });
    return;
  }
  res.json({ ...prices, source: DEFAULT_TARIFF_PRICES_SOURCE });
});

app.post(
  "/api/analyze",
  upload.fields([
    { name: "csv", maxCount: 1 },
    // Zarezerwowane na przyszłość: realne dane z monitoringu falownika
    // (FusionSolar/iSolarCloud) — format jeszcze nieznany, plik na razie
    // przyjmowany, ale nie jest wykorzystywany w analizie.
    { name: "inverterProduction", maxCount: 1 },
    // moj-licznik-daily: po 12 plików (jeden na miesiąc) na każdą stronę.
    { name: "csvAPlus", maxCount: 12 },
    { name: "csvAMinus", maxCount: 12 },
  ]),
  async (req, res) => {
    const files = req.files as Record<string, Express.Multer.File[]> | undefined;
    const uploadedPaths: string[] = [];

    try {
      const body = req.body as Record<string, string>;
      const adapter = body["adapter"] as AdapterType;

      const csvPath = files?.["csv"]?.[0]?.path;
      const inverterProductionPath = files?.["inverterProduction"]?.[0]?.path;
      const csvAPlusPaths = files?.["csvAPlus"]?.map((f) => f.path);
      const csvAMinusPaths = files?.["csvAMinus"]?.map((f) => f.path);
      for (const p of [csvPath, inverterProductionPath, ...(csvAPlusPaths ?? []), ...(csvAMinusPaths ?? [])]) {
        if (p) uploadedPaths.push(p);
      }

      const existingPvRaw = body["existingPvKwp"];
      const tiltRaw = body["tilt"];
      const azimuthRaw = body["azimuth"];

      const lat = parseFloat(body["lat"]!);
      const lon = parseFloat(body["lon"]!);
      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        throw new AnalysisError("Nieprawidłowa lokalizacja — podaj szerokość i długość geograficzną jako liczby.");
      }

      let customTariffPrices: TariffPrices | undefined;
      const tariffPricesRaw = body["tariffPrices"];
      if (tariffPricesRaw) {
        try {
          customTariffPrices = JSON.parse(tariffPricesRaw) as TariffPrices;
        } catch (error) {
          throw new AnalysisError(`Nieprawidłowe dane cen taryfy: ${error instanceof Error ? error.message : error}`);
        }
      }

      let targetTariffPrices: TariffPrices | undefined;
      const targetTariffPricesRaw = body["targetTariffPrices"];
      if (targetTariffPricesRaw) {
        try {
          targetTariffPrices = JSON.parse(targetTariffPricesRaw) as TariffPrices;
        } catch (error) {
          throw new AnalysisError(`Nieprawidłowe dane cen taryfy docelowej: ${error instanceof Error ? error.message : error}`);
        }
      }

      let installations: PvInstallation[] | undefined;
      const installationsRaw = body["installations"];
      if (installationsRaw) {
        try {
          const parsed = JSON.parse(installationsRaw) as Array<{ kwp: number; tilt?: number; azimuth?: number; inverterBrand?: string; inverterModel?: string; inverterAcKw?: number; planned?: boolean }>;
          if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("pusta lista instalacji");
          installations = parsed.map((r) => ({
            kwp: r.kwp,
            tilt: r.tilt ?? null,
            azimuth: r.azimuth ?? null,
            inverterBrand: r.inverterBrand ?? "",
            ...(typeof r.inverterModel === "string" && r.inverterModel.trim() !== "" ? { inverterModel: r.inverterModel.trim() } : {}),
            inverterAcKw: r.inverterAcKw ?? NaN,
            planned: r.planned === true,
          }));
        } catch (error) {
          throw new AnalysisError(`Nieprawidłowe dane instalacji PV: ${error instanceof Error ? error.message : error}`);
        }
      }

      const appliancesRaw = body["appliances"];
      const appliances = (appliancesRaw ? appliancesRaw.split(",") : []).filter((a): a is Appliance => APPLIANCES.includes(a as Appliance));
      const annualRaw = body["annualConsumptionKwh"];

      // Segment klienta wynika ze ścieżki — firma-15min → netto, pozostałe → brutto.
      const clientSegment: ClientSegment = adapter === "firma-15min" ? "firma" : "prosument";

      // VAT: checkbox "Dom do 300 m²?" — zaznaczony (wartość "1") → 8%, brak/odznaczony → 23%.
      // Firma zawsze liczy netto — VAT nie ma zastosowania do cen (silnik ignoruje vatRatePercent dla firmy).
      const houseUnder300 = body["houseUnder300m2"] === "1";
      const vatRatePercent = houseUnder300 ? 0.08 : 0.23;

      const report = await runAnalysis({
        adapter,
        annualConsumptionKwh: annualRaw ? parseFloat(annualRaw) : undefined,
        appliances,
        tariff: body["tariff"] as TariffType,
        customTariffPrices,
        targetTariff: (body["targetTariff"] as TariffType) || undefined,
        targetTariffPrices,
        clientSegment,
        gridConnectionPowerKw: body["gridConnectionPowerKw"] ? parseFloat(body["gridConnectionPowerKw"]) : undefined,
        exportLimitKw: body["exportLimitKw"] !== undefined && body["exportLimitKw"] !== "" ? parseFloat(body["exportLimitKw"]) : undefined,
        exportPricePerKwh: body["exportPricePerKwh"] ? parseFloat(body["exportPricePerKwh"]) : undefined,
        settlementSystem: (body["settlementSystem"] as "net-billing" | "opusty") || undefined,
        vatRatePercent,
        existingInverterBrand: body["existingInverterBrand"] || undefined,
        lat,
        lon,
        ...(body["cityName"]?.trim() ? { cityName: body["cityName"].trim() } : {}),
        ...(body["phases"] === "1" || body["phases"] === "3" ? { phases: Number(body["phases"]) as 1 | 3 } : {}),
        contractedPowerKw: 0,
        existingPvKwp: existingPvRaw ? parseFloat(existingPvRaw) : null,
        tilt: tiltRaw ? parseFloat(tiltRaw) : null,
        azimuth: azimuthRaw ? parseFloat(azimuthRaw) : null,
        installations,
        csvPath,
        csvAPlusPaths,
        csvAMinusPaths,
      });

      // `steps` (kroki 15-min) są już puste u źródła (ScenarioScanner zwalnia
      // je po policzeniu kosztów), więc raport można wysłać bez dodatkowego trymowania.
      res.json(report);
    } catch (error) {
      const message = error instanceof AnalysisError || error instanceof Error
        ? error.message
        : String(error);
      res.status(400).json({ error: message });
    } finally {
      for (const p of uploadedPaths) {
        fs.unlink(p, () => {});
      }
    }
  },
);

loadDeviceDatabase();

app.listen(PORT, () => {
  console.log(`🔌 Kalkulator Magazynu Energii — serwer działa na http://localhost:${PORT}`);
});
