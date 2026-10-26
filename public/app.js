const form = document.getElementById("calc-form");
const statusContainer = document.getElementById("status-container");
const resultsEl = document.getElementById("results");
const resultsStats = document.getElementById("results-stats");
const resultsTableBody = document.getElementById("results-table-body");
const recommendationText = document.getElementById("recommendation-text");

const pathOptions = document.querySelectorAll(".path-option");
const csvSimpleGroup = document.querySelector('[data-group="csv-simple"]');
const mojLicznikFilesGroup = document.querySelector('[data-group="moj-licznik-files"]');
const pvFieldsGroup = document.querySelector('[data-group="pv-fields"]');
const declaredGroup = document.querySelector('[data-group="declared-consumption"]');
const declaredNote = document.querySelector('[data-group="declared-note"]');
const houseVat = document.querySelector('[data-group="house-vat"]');
const globalGeometry = document.querySelector('[data-group="global-geometry"]');
const pvAdvancedNodes = document.querySelectorAll('[data-group="pv-advanced"]');
const settlementHint = document.getElementById("settlement-system-hint");
const settlementSystemSelect = document.getElementById("settlement-system");
const settlementSystemWarning = document.getElementById("settlement-system-warning");
settlementSystemSelect.addEventListener("change", () => {
  settlementSystemWarning.style.display = settlementSystemSelect.value === "opusty" ? "block" : "none";
});

function currentPath() {
  return document.querySelector('input[name="path"]:checked').value;
}

function updateFormVisibility() {
  const path = currentPath();

  for (const opt of pathOptions) {
    opt.classList.toggle("active", opt.dataset.path === path);
  }

  csvSimpleGroup.style.display = path === "moj-licznik" ? "none" : "grid";
  // Deklaracja zużycia (bez plików) — tylko dla "Nie mam PV".
  declaredGroup.style.display = path === "tauron" ? "grid" : "none";
  declaredNote.style.display = path === "tauron" ? "block" : "none";
  mojLicznikFilesGroup.style.display = path === "moj-licznik" ? "grid" : "none";
  // PV pola sensowne tylko dla moj-licznik (rekonstrukcja PV) — dla tauron/firma-15min brak PV z założenia
  pvFieldsGroup.style.display = path === "moj-licznik" ? "block" : "none";
  houseVat.style.display = path === "firma-15min" ? "none" : "flex";
  globalGeometry.style.display = path === "moj-licznik" ? "none" : "grid";
  for (const node of pvAdvancedNodes) node.style.display = path === "moj-licznik" ? "block" : "none";
}

for (const opt of pathOptions) {
  opt.addEventListener("click", () => {
    opt.querySelector("input").checked = true;
    updateFormVisibility();
  });
}

updateFormVisibility();

// ─── Instalacje PV: lista, bo różne połacie mogą mieć różny azymut/kąt ───

const installationsList = document.getElementById("installations-list");
const addInstallationBtn = document.getElementById("add-installation-btn");
let installationCounter = 0;

const UNKNOWN_INVERTER = "nie wiem";
const PHASE_POWER_KW = { "1": 5.75, "3": 14 };
let inverterCatalog = [];

fetch("/inverters.json")
  .then((response) => response.json())
  .then((data) => {
    const rows = Array.isArray(data) ? data : [];
    const byBrand = new Map();
    for (const inverter of rows) {
      const name = inverter.manufacturer?.value ?? inverter.manufacturer;
      const model = inverter.model?.value ?? inverter.model;
      if (!name || !model) continue;
      const models = byBrand.get(name) ?? [];
      models.push(model);
      byBrand.set(name, models);
    }
    inverterCatalog = [...byBrand.entries()].map(([name, models]) => ({ name, models }));
    for (const select of installationsList.querySelectorAll(".inst-inverter")) fillBrandOptions(select);
  })
  .catch(() => {
    inverterCatalog = [];
  });

function fillBrandOptions(select) {
  const current = select.value;
  const brands = inverterCatalog.map((b) => `<option value="${b.name}">${b.name}</option>`).join("");
  select.innerHTML =
    `<option value="" disabled ${current ? "" : "selected"}>Wybierz markę</option>` +
    `<option value="${UNKNOWN_INVERTER}"${current === UNKNOWN_INVERTER ? " selected" : ""}>Nie wiem</option>` +
    brands;
  if (current && current !== UNKNOWN_INVERTER) select.value = current;
}

function modelsForBrand(brand) {
  return inverterCatalog.find((b) => b.name === brand)?.models ?? [];
}

function acKwFromKwp(kwp) {
  return kwp / 1.2;
}

function formatAcHint(kwp) {
  if (!Number.isFinite(kwp) || kwp <= 0) return "Moc AC falownika liczymy jako moc PV ÷ 1,2.";
  return `Moc AC falownika: ${fmt(acKwFromKwp(kwp), 1)} kW (moc PV ÷ 1,2).`;
}

function addInstallationRow(prefill) {
  installationCounter += 1;
  const id = installationCounter;

  const row = document.createElement("div");
  row.className = "installation-row";
  row.dataset.installationId = String(id);
  row.innerHTML = `
    <div class="installation-fields">
      <div class="field-grid">
        <div class="field">
          <label>Moc instalacji [kWp]</label>
          <input type="number" step="any" min="0" class="inst-kwp" placeholder="np. 10.8" value="${prefill?.kwp ?? ""}" />
        </div>
        <div class="field">
          <label>Marka falownika</label>
          <select class="inst-inverter"></select>
        </div>
        <div class="field">
          <label>Model falownika</label>
          <select class="inst-model" disabled>
            <option value="">Najpierw wybierz markę</option>
          </select>
        </div>
      </div>
      <p class="ac-hint"></p>
    </div>
    <button type="button" class="remove-installation-btn" title="Usuń instalację">✕</button>
  `;
  installationsList.appendChild(row);

  const advanced = document.createElement("div");
  advanced.className = "advanced-inst";
  advanced.dataset.installationId = String(id);
  advanced.innerHTML = `
    <div class="advanced-inst-title"></div>
    <div class="field-grid">
      <div class="field">
        <label>Status połaci</label>
        <select class="inst-status">
          <option value="existing"${prefill?.planned ? "" : " selected"}>Istniejąca</option>
          <option value="planned"${prefill?.planned ? " selected" : ""}>Do realizacji</option>
        </select>
      </div>
      <div class="field">
        <label>Kąt nachylenia [°]</label>
        <input type="number" step="any" class="inst-tilt" value="${prefill?.tilt ?? 35}" />
      </div>
      <div class="field">
        <label>Azymut [°] <span class="hint">(180 = południe)</span></label>
        <input type="number" step="any" class="inst-azimuth" value="${prefill?.azimuth ?? 180}" />
      </div>
    </div>
  `;
  document.getElementById("installations-advanced").appendChild(advanced);

  const brandSelect = row.querySelector(".inst-inverter");
  fillBrandOptions(brandSelect);
  if (prefill?.inverterBrand) {
    brandSelect.value = prefill.inverterBrand;
    syncModelSelect(row, prefill.inverterModel ?? "");
  }
  brandSelect.addEventListener("change", () => syncModelSelect(row, ""));
  row.querySelector(".inst-kwp").addEventListener("input", () => {
    row.querySelector(".ac-hint").textContent = formatAcHint(parseFloat(row.querySelector(".inst-kwp").value));
    refreshAdvancedHint();
  });
  row.querySelector(".ac-hint").textContent = formatAcHint(parseFloat(row.querySelector(".inst-kwp").value));

  for (const input of advanced.querySelectorAll(".inst-tilt, .inst-azimuth")) {
    input.addEventListener("input", refreshAdvancedHint);
  }

  row.querySelector(".remove-installation-btn").addEventListener("click", () => {
    if (installationsList.children.length <= 1) return;
    advanced.remove();
    row.remove();
    updateInstallationLabels();
  });

  updateInstallationLabels();
}

function syncModelSelect(row, selectedModel) {
  const brand = row.querySelector(".inst-inverter").value;
  const modelSelect = row.querySelector(".inst-model");
  if (brand === UNKNOWN_INVERTER) {
    modelSelect.innerHTML = `<option value="">Nie wiem</option>`;
    modelSelect.disabled = true;
    modelSelect.value = "";
    return;
  }
  const models = modelsForBrand(brand);
  if (models.length === 0) {
    modelSelect.innerHTML = `<option value="">Najpierw wybierz markę</option>`;
    modelSelect.disabled = true;
    return;
  }
  modelSelect.disabled = false;
  modelSelect.innerHTML =
    `<option value="" disabled ${selectedModel ? "" : "selected"}>Wybierz model</option>` +
    models.map((m) => `<option value="${m}"${m === selectedModel ? " selected" : ""}>${m}</option>`).join("");
  if (selectedModel) modelSelect.value = selectedModel;
}

function updateInstallationLabels() {
  const rows = installationsList.querySelectorAll(".installation-row");
  const advancedRows = document.querySelectorAll("#installations-advanced .advanced-inst");
  rows.forEach((row, index) => {
    row.querySelector(".remove-installation-btn").style.display = rows.length > 1 ? "block" : "none";
    const advanced = advancedRows[index];
    if (advanced) {
      const title = advanced.querySelector(".advanced-inst-title");
      if (title) title.textContent = rows.length > 1 ? `Połać ${index + 1}` : "Połać";
    }
  });
}

addInstallationBtn.addEventListener("click", () => addInstallationRow());

addInstallationRow(); // domyślnie jedna instalacja

function collectInstallations() {
  const rows = installationsList.querySelectorAll(".installation-row");
  const installations = [];
  for (const row of rows) {
    const kwp = parseFloat(row.querySelector(".inst-kwp").value);
    if (!Number.isFinite(kwp) || kwp <= 0) continue;
    const id = row.dataset.installationId;
    const advanced = document.querySelector(`#installations-advanced .advanced-inst[data-installation-id="${id}"]`);
    const tiltVal = advanced?.querySelector(".inst-tilt")?.value ?? "35";
    const azimuthVal = advanced?.querySelector(".inst-azimuth")?.value ?? "180";
    const brand = row.querySelector(".inst-inverter").value;
    const model = row.querySelector(".inst-model").value;
    installations.push({
      planned: advanced?.querySelector(".inst-status")?.value === "planned",
      inverterBrand: brand,
      ...(brand !== UNKNOWN_INVERTER && model ? { inverterModel: model } : {}),
      inverterAcKw: acKwFromKwp(kwp),
      kwp,
      tilt: tiltVal !== "" ? parseFloat(tiltVal) : 35,
      azimuth: azimuthVal !== "" ? parseFloat(azimuthVal) : 180,
    });
  }
  return installations;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const phasesSelect = document.getElementById("phases");
const gridConnectionInput = document.getElementById("grid-connection");
const exportLimitInput = document.getElementById("export-limit");
const exportPriceInput = document.getElementById("export-price");
const connectionPowerHint = document.getElementById("connection-power-hint");
let exportLimitTouched = false;
let connectionTouched = false;

function defaultConnectionKw() {
  return PHASE_POWER_KW[phasesSelect.value] ?? 14;
}

function connectionKw() {
  const typed = parseFloat(gridConnectionInput.value);
  if (Number.isFinite(typed) && typed >= 0) return typed;
  return defaultConnectionKw();
}

function updateConnectionHint() {
  connectionPowerHint.textContent = phasesSelect.value === "1"
    ? "Domyślna podpowiedź: 5,75 kW. Wpisz moc z umowy. Przekroczenie daje ostrzeżenie o zmianie warunków przyłączenia."
    : "Domyślna podpowiedź: 14 kW. Wpisz moc z umowy. Przekroczenie daje ostrzeżenie o zmianie warunków przyłączenia.";
}

function applyPhasePower(forceExportLimit) {
  if (!connectionTouched) gridConnectionInput.value = String(defaultConnectionKw());
  updateConnectionHint();
  if (forceExportLimit || !exportLimitTouched) exportLimitInput.value = String(connectionKw());
  refreshAdvancedHint();
}

function refreshAdvancedHint() {
  const hint = document.getElementById("advanced-hint");
  if (!hint) return;
  const path = currentPath();
  let tilt = "35";
  let azimuth = "180";
  if (path === "moj-licznik") {
    const firstTilt = document.querySelector("#installations-advanced .inst-tilt");
    const firstAzimuth = document.querySelector("#installations-advanced .inst-azimuth");
    if (firstTilt?.value) tilt = firstTilt.value;
    if (firstAzimuth?.value) azimuth = firstAzimuth.value;
  } else {
    tilt = document.getElementById("tilt").value || "35";
    azimuth = document.getElementById("azimuth").value || "180";
  }
  const phasesLabel = phasesSelect.value === "1" ? "1 faza" : "3 fazy";
  const price = exportPriceInput.value || "0,30";
  hint.textContent = `kąt ${tilt}°, azymut ${azimuth}°, ${phasesLabel} (${fmt(connectionKw(), 2)} kW), eksport ${price} zł/kWh`;
}

phasesSelect.addEventListener("change", () => applyPhasePower(false));
gridConnectionInput.addEventListener("input", () => {
  connectionTouched = true;
  updateConnectionHint();
  if (!exportLimitTouched) exportLimitInput.value = gridConnectionInput.value;
  refreshAdvancedHint();
});
exportLimitInput.addEventListener("input", () => {
  exportLimitTouched = true;
  refreshAdvancedHint();
});
exportPriceInput.addEventListener("input", refreshAdvancedHint);
document.getElementById("tilt").addEventListener("input", refreshAdvancedHint);
document.getElementById("azimuth").addEventListener("input", refreshAdvancedHint);
applyPhasePower(true);

// ─── Tabela stawek taryfy — domyślne wartości z serwera, edytowalne ───

const tariffSelect = document.getElementById("tariff");
const tariffPriceTableBody = document.getElementById("tariff-price-table-body");
const zoneLabels = {
  jednolita: "Jednolita (całodobowa)",
  dzien: "Dzień",
  noc: "Noc",
  noc_weekend: "Noc + weekend",
  szczyt: "Szczyt",
  pozaszczyt: "Pozaszczyt",
};

function recalcRowTotal(row) {
  const energy = parseFloat(row.querySelector(".zone-energy").value) || 0;
  const distribution = parseFloat(row.querySelector(".zone-distribution").value) || 0;
  row.querySelector(".zone-total").textContent = fmt(energy + distribution, 2);
}

async function loadTariffPriceTable(tariffType) {
  tariffPriceTableBody.innerHTML = `<tr><td colspan="4">Wczytywanie stawek…</td></tr>`;
  try {
    const response = await fetch(`/api/tariff-defaults/${tariffType}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Błąd wczytywania stawek taryfy.");

    tariffPriceTableBody.innerHTML = "";
    const sourceEl = document.getElementById("tariff-price-source");
    if (sourceEl) sourceEl.textContent = data.source ? "Źródło stawek: " + data.source : "";
    for (const [zoneName, prices] of Object.entries(data.zones)) {
      const tr = document.createElement("tr");
      tr.dataset.zone = zoneName;
      tr.innerHTML =
        `<td>${zoneLabels[zoneName] || zoneName}</td>` +
        `<td><input type="number" step="0.01" min="0" class="zone-energy" value="${prices.energyPricePerKwh}" /></td>` +
        `<td><input type="number" step="0.01" min="0" class="zone-distribution" value="${prices.distributionPricePerKwh}" /></td>` +
        `<td class="zone-total">${fmt(prices.energyPricePerKwh + prices.distributionPricePerKwh, 2)}</td>`;
      tariffPriceTableBody.appendChild(tr);

      tr.querySelector(".zone-energy").addEventListener("input", () => recalcRowTotal(tr));
      tr.querySelector(".zone-distribution").addEventListener("input", () => recalcRowTotal(tr));
    }
  } catch (error) {
    tariffPriceTableBody.innerHTML = `<tr><td colspan="4">❌ ${error.message}</td></tr>`;
  }
}

function collectTariffPrices() {
  const zones = {};
  for (const row of tariffPriceTableBody.querySelectorAll("tr[data-zone]")) {
    zones[row.dataset.zone] = {
      energyPricePerKwh: parseFloat(row.querySelector(".zone-energy").value) || 0,
      distributionPricePerKwh: parseFloat(row.querySelector(".zone-distribution").value) || 0,
    };
  }
  return { type: tariffSelect.value, zones };
}

tariffSelect.addEventListener("change", () => loadTariffPriceTable(tariffSelect.value));
loadTariffPriceTable(tariffSelect.value);

// ─── Wyszukiwarka miejscowości z podpowiedziami ───

const citySearchInput = document.getElementById("city-search");
const cityDropdownEl  = document.getElementById("city-dropdown");
const latInput        = document.getElementById("lat");
const lonInput        = document.getElementById("lon");
let selectedCityName  = "";
let activeIndex       = -1;

/** Normalizuje string do porównania: małe litery, bez ogonków. */
function normalize(s) {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

function renderDropdown(matches) {
  activeIndex = -1;
  if (matches.length === 0) { cityDropdownEl.style.display = "none"; return; }
  cityDropdownEl.innerHTML = matches.map((c, i) =>
    `<div class="city-option" role="option" data-i="${i}" data-lat="${c.lat}" data-lon="${c.lon}" data-name="${c.name}">${c.name}</div>`
  ).join("");
  cityDropdownEl.style.display = "block";
}

function selectCity(name, lat, lon) {
  selectedCityName = name;
  citySearchInput.value = name;
  latInput.value = lat;
  lonInput.value = lon;
  document.getElementById("city-name").value = name;
  cityDropdownEl.style.display = "none";
  activeIndex = -1;
}

function setActiveOption(idx) {
  const opts = cityDropdownEl.querySelectorAll(".city-option");
  opts.forEach((o, i) => o.classList.toggle("active", i === idx));
  activeIndex = idx;
  if (opts[idx]) opts[idx].scrollIntoView({ block: "nearest" });
}

citySearchInput.addEventListener("input", () => {
  const raw = citySearchInput.value.trim();
  latInput.value = "";
  lonInput.value = "";
  document.getElementById("city-name").value = "";
  selectedCityName = "";
  if (raw.length < 1) { cityDropdownEl.style.display = "none"; return; }
  const q = normalize(raw);
  const starts = CITIES.filter(c => normalize(c.name).startsWith(q));
  const contains = CITIES.filter(c => !normalize(c.name).startsWith(q) && normalize(c.name).includes(q));
  renderDropdown([...starts, ...contains].slice(0, 10));
});

citySearchInput.addEventListener("keydown", (e) => {
  const opts = cityDropdownEl.querySelectorAll(".city-option");
  if (!opts.length) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    setActiveOption(Math.min(activeIndex + 1, opts.length - 1));
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    setActiveOption(Math.max(activeIndex - 1, 0));
  } else if (e.key === "Enter" && activeIndex >= 0) {
    e.preventDefault();
    const opt = opts[activeIndex];
    selectCity(opt.dataset.name, opt.dataset.lat, opt.dataset.lon);
  } else if (e.key === "Escape") {
    cityDropdownEl.style.display = "none";
  }
});

cityDropdownEl.addEventListener("mousedown", (e) => {
  const opt = e.target.closest(".city-option");
  if (!opt) return;
  e.preventDefault(); // zapobiega utracie focusu przez input
  selectCity(opt.dataset.name, opt.dataset.lat, opt.dataset.lon);
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".city-search-wrapper")) cityDropdownEl.style.display = "none";
});

function showStatus(message, type) {
  statusContainer.innerHTML = `<div class="status-msg ${type}">${message}</div>`;
}

function clearStatus() {
  statusContainer.innerHTML = "";
}

function fmt(n, digits = 0) {
  return Number(n).toLocaleString("pl-PL", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function renderResults(report) {
  resultsStats.innerHTML = "";
  resultsTableBody.innerHTML = "";

  const assumptionsSection = document.getElementById("assumptions-section");
  const assumptionsList = document.getElementById("assumptions-list");
  const assumptionLines = Array.isArray(report.assumptions) ? report.assumptions : [];
  if (assumptionLines.length > 0) {
    assumptionsList.innerHTML = assumptionLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
    assumptionsSection.style.display = "block";
  } else {
    assumptionsSection.style.display = "none";
  }

  const settlementNoteEl = document.getElementById("settlement-note");
  if (report.inputSummary && report.inputSummary.settlementSystem === "opusty") {
    settlementNoteEl.textContent =
      "Wynik policzony dla systemu OPUSTÓW (net-metering): oddana energia jako kredyt w kWh (odbiór 80% do 10 kW, 70% powyżej), " +
      "bilans roczny per strefa, bez ładowania magazynu z sieci. Uproszczony model — współczynniki i zasady rozliczenia strefowego " +
      "do potwierdzenia w umowie z OSD. Uwaga: rozbudowa instalacji może zmienić współczynnik albo wpłynąć na status opustów.";
    settlementNoteEl.style.display = "block";
  } else {
    settlementNoteEl.style.display = "none";
  }

  const dataSourceEl = document.getElementById("data-source-note");
  if (report.dataSource) {
    dataSourceEl.textContent = `📚 Źródło danych: poziom ${report.dataSource.level} z 4 — ${report.dataSource.label}. Niepewność: ${report.dataSource.uncertainty}`;
    dataSourceEl.style.display = "block";
  } else {
    dataSourceEl.style.display = "none";
  }

  const validationEl = document.getElementById("validation-warnings");
  if (report.validationWarnings && report.validationWarnings.length > 0) {
    validationEl.textContent = "⚠️ Walidacja danych: " + report.validationWarnings.join(" ");
    validationEl.style.display = "block";
  } else {
    validationEl.style.display = "none";
  }
  const clippingEl = document.getElementById("inverter-clipping-note");
  if (report.inverterClippingNote) {
    clippingEl.textContent = "🔌 " + report.inverterClippingNote;
    clippingEl.style.display = "block";
  } else {
    clippingEl.style.display = "none";
  }

  const powerLimitNoteEl = document.getElementById("power-limit-note");
  if (report.powerLimitNote) {
    powerLimitNoteEl.textContent = "⚡ Limity mocy: " + report.powerLimitNote;
    powerLimitNoteEl.style.display = "block";
  } else {
    powerLimitNoteEl.style.display = "none";
  }

  const dataQualityWarningEl = document.getElementById("data-quality-warning");
  if (report.dataQualityWarning) {
    dataQualityWarningEl.textContent = "⚠️ Jakość danych: " + report.dataQualityWarning;
    dataQualityWarningEl.style.display = "block";
  } else {
    dataQualityWarningEl.style.display = "none";
  }
  let recommendationExtra = "";
  if (report.pvExpansionSuggestion !== undefined) {
    if (report.pvExpansionSuggestion === null) {
      recommendationExtra = "\n\n⚠️ Nawet zwiększenie instalacji PV (sprawdzono do 100 kWp) nie sprawia, że ten magazyn się zwraca. Ograniczeniem jest pojemność/koszt samego magazynu, nie zbyt mała moc PV — rozważ mniejszy magazyn.";
    } else {
      recommendationExtra = `\n\n💡 Przy PV ≥ ${fmt(report.pvExpansionSuggestion.pvSizeKwp, 1)} kWp ten sam magazyn zwróciłby się w ${fmt(report.pvExpansionSuggestion.paybackYears, 1)} lat.`;
    }
  }
  recommendationText.textContent = report.recommendation + recommendationExtra;

  const best = report.top3[0];
  if (best) {
    const sim = best.simulationResult;
    const bc = sim.bessConfig;

    resultsStats.innerHTML = `
      <div class="result-group">
        <h3>Inwestycja</h3>
        <div class="stat">
          <div class="stat-label">Rekomendowany magazyn</div>
          <div class="stat-value">${bc ? `${bc.product.manufacturer} ${bc.product.model}` : "-"}</div>
          <div class="stat-caption">${bc ? `${bc.moduleCount}× moduł = ${(bc.product.usableCapacityKwh * bc.moduleCount).toFixed(1)} kWh` : ""}</div>
        </div>
        <div class="stat">
          <div class="stat-label">Moc PV</div>
          <div class="stat-value">${fmt(sim.pvSizeKwp, 1)} kWp</div>
          ${report.inputSummary.plannedPvKwp > 0 ? `<div class="stat-caption">w tym ${fmt(report.inputSummary.plannedPvKwp, 1)} kWp do realizacji (koszt PV pominięty)</div>` : ""}
        </div>
        <div class="stat">
          <div class="stat-label">Koszt inwestycji <span class="hint">(${best.priceBasis})</span></div>
          <div class="stat-value">${fmt(best.investmentCostPln)} PLN</div>
          <div class="stat-caption">magazyn: ${fmt(best.bessInvestmentCostPln)} PLN${best.pvInvestmentCostPln > 0 ? ` + rozbudowa PV: ${fmt(best.pvInvestmentCostPln)} PLN` : ""}${best.inverterUpgradeCostPln > 0 ? ` + falownik: ${fmt(best.inverterUpgradeCostPln)} PLN` : ""} + montaż: ${fmt(best.installationCostPln)} PLN</div>
          ${bc && bc.inverterDecisionLabel ? `<div class="stat-caption">${escapeHtml(bc.inverterDecisionLabel)}</div>` : ""}
          ${best.inverterAlternative ? `<div class="stat-caption">Drugi wariant: ${escapeHtml(best.inverterAlternative.label)} NPV ${fmt(best.inverterAlternative.npvPln)} PLN.</div>` : ""}
        </div>
      </div>
      <div class="result-group">
        <h3>Energia</h3>
        <div class="stat">
          <div class="stat-label">Autokonsumpcja</div>
          <div class="stat-value">${fmt(sim.selfConsumptionRate)}%</div>
          <div class="stat-caption">bez magazynu (samo PV): ${fmt(best.referenceSelfConsumptionRate)}%</div>
        </div>
        <div class="stat">
          <div class="stat-label">Pobór z sieci (samo PV → z magazynem)</div>
          <div class="stat-value">${fmt(best.referenceGridImportKwh)} → ${fmt(sim.totalGridImportKwh)} kWh/rok</div>
        </div>
        <div class="stat">
          <div class="stat-label">Cykle magazynu</div>
          <div class="stat-value">${fmt(sim.annualCycles, 1)}/rok</div>
        </div>
      </div>
      <div class="result-group">
        <h3>Finanse</h3>
        <div class="stat">
          <div class="stat-label">Roczne oszczędności (rok 1)</div>
          <div class="stat-value">${fmt(best.annualSavingsYear1Pln)} PLN</div>
        </div>
        <div class="stat">
          <div class="stat-label">Okres zwrotu</div>
          <div class="stat-value">${best.paybackYears === null || best.paybackYears === Infinity ? "nie zwraca się" : fmt(best.paybackYears, 1) + " lat"}</div>
        </div>
        <div class="stat">
          <div class="stat-label">ROI (15 lat)</div>
          <div class="stat-value">${fmt(best.roiPercent)}%</div>
          ${best.replacementYear !== null ? `<div class="stat-caption">${escapeHtml(best.replacementReason)} Koszt ${fmt(best.replacementCostPln)} PLN.</div>` : `<div class="stat-caption">${escapeHtml(best.replacementReason)}</div>`}
        </div>
      </div>
    `;
    const sizing = document.createElement("div");
    sizing.className = "stat";
    sizing.innerHTML = `
      <div class="stat-label">Sugerowany rozmiar z profilu poboru</div>
      <div class="stat-value">${fmt(report.suggestedCapacityKwh, 1)} kWh / ${fmt(report.suggestedPowerKw, 1)} kW</div>
      <div class="stat-caption">pojemność ≈ zużycie 16:00–08:00 w sezonie, moc ≈ 95. percentyl poboru 17:00–22:00</div>
    `;
    resultsStats.querySelector(".result-group")?.appendChild(sizing);
  }

  const rows = [
    { label: "Baseline (bez PV/BESS)", pv: "-", auto: "-", grid: fmt(report.baseline.totalGridImportKwh), cycles: "-", cost: "-", payback: "-" },
    ...(report.top3[0] ? [{ label: "Samo PV (bez magazynu)", pv: fmt(report.top3[0].simulationResult.pvSizeKwp, 1), auto: fmt(report.top3[0].referenceSelfConsumptionRate) + "%", grid: fmt(report.top3[0].referenceGridImportKwh), cycles: "-", cost: "-", payback: "-" }] : []),
    ...report.top3.map((fr, i) => {
      const sim = fr.simulationResult;
      const bc = sim.bessConfig;
      return {
        label: bc ? `#${i + 1} ${bc.product.model} ${(bc.product.usableCapacityKwh * bc.moduleCount).toFixed(1)}kWh` : `#${i + 1}`,
        pv: fmt(sim.pvSizeKwp, 1),
        auto: fmt(sim.selfConsumptionRate) + "%",
        grid: fmt(sim.totalGridImportKwh),
        cycles: fmt(sim.annualCycles, 1),
        cost: fmt(fr.investmentCostPln) + " PLN",
        payback: fr.paybackYears === null || fr.paybackYears === Infinity ? "∞" : fmt(fr.paybackYears, 1),
      };
    }),
  ];

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${row.label}</td><td>${row.pv}</td><td>${row.auto}</td><td>${row.grid}</td><td>${row.cycles}</td><td>${row.cost}</td><td>${row.payback}</td>`;
    resultsTableBody.appendChild(tr);
  }

  renderNpvRanking(report.top3ByNpv);
  renderSensitivity(report.sensitivity);

  const tariffChangeBox = document.getElementById("tariff-change-box");
  if (report.tariffChange) {
    const tc = report.tariffChange;
    tariffChangeBox.textContent =
      `🔄 Sama zmiana taryfy ${tc.currentTariff} → ${tc.targetTariff} (bez inwestycji): koszt energii ` +
      `${fmt(tc.annualCostCurrentPln)} → ${fmt(tc.annualCostTargetPln)} PLN/rok, efekt ${tc.annualEffectPln >= 0 ? "+" : ""}${fmt(tc.annualEffectPln)} PLN/rok. ` +
      `Wyniki magazynu poniżej liczone są w taryfie docelowej i nie zawierają tego efektu.`;
    tariffChangeBox.style.display = "block";
  } else {
    tariffChangeBox.style.display = "none";
  }

  const pvOnlyBox = document.getElementById("pv-only-box");
  if (report.pvOnly) {
    const po = report.pvOnly;
    pvOnlyBox.textContent =
      `☀️ Dla porównania — samo PV ${fmt(po.pvSizeKwp, 1)} kWp bez magazynu: koszt ${fmt(po.investmentCostPln)} PLN, ` +
      `oszczędności ${fmt(po.annualSavingsYear1Pln)} PLN/rok, ` +
      `okres zwrotu ${po.paybackYears === null || po.paybackYears === Infinity ? "nie zwraca się" : fmt(po.paybackYears, 1) + " lat"}, NPV ${fmt(po.npvPln)} PLN.`;
    pvOnlyBox.style.display = "block";
  } else {
    pvOnlyBox.style.display = "none";
  }

  const basisLabel = best ? ` (ceny ${best.priceBasis})` : "";
  document.getElementById("manufacturer-table-title").textContent = `Najlepszy magazyn każdego producenta${basisLabel}`;

  renderManufacturerTable(document.getElementById("manufacturer-table-body"), report.bestPerManufacturer);
  renderCharts(report);

  resultsEl.style.display = "block";
  resultsEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ─── Wykresy (Chart.js) — tylko gdy backend zwrócił dane (adapter moj-licznik-daily) ───

const MONTH_LABELS = ["Sty", "Lut", "Mar", "Kwi", "Maj", "Cze", "Lip", "Sie", "Wrz", "Paź", "Lis", "Gru"];
let zoneBreakdownChart = null;
let pvUsageChart = null;

const CHART_COLORS = {
  zone1Import: "#2dcd84",
  zone1Export: "#2dcd84",
  zone2Import: "#f5a623",
  zone2Export: "#f5a623",
  selfConsumed: "#2dcd84",
  bessChargedFromPv: "#ffd166",
  bessChargedFromGrid: "#c77dff",
  gridExport: "rgba(255,255,255,0.6)",
};

function baseChartOptions(yLabel, isDaily = false) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: {
        stacked: false,
        ticks: {
          color: "rgba(255,255,255,0.6)",
          autoSkip: true,
          maxTicksLimit: isDaily ? 24 : 12,
        },
        grid: { color: "rgba(255,255,255,0.06)" },
      },
      y: {
        beginAtZero: true,
        ticks: { color: "rgba(255,255,255,0.6)" },
        grid: { color: "rgba(255,255,255,0.06)" },
        title: { display: true, text: yLabel, color: "rgba(255,255,255,0.6)" },
      },
    },
    plugins: {
      legend: { labels: { color: "rgba(255,255,255,0.85)" } },
    },
  };
}

let lastReport = null;
let chartResolution = "monthly"; // "monthly" | "daily"

function formatDailyLabel(isoDate) {
  const [, month, day] = isoDate.split("-");
  return `${day}.${month}`;
}

function renderCharts(report) {
  lastReport = report;
  const chartsSection = document.getElementById("charts-section");
  const hasAnyData =
    (report.monthlyZoneBreakdown && report.monthlyZoneBreakdown.length > 0) ||
    (report.monthlyPvUsageBreakdown && report.monthlyPvUsageBreakdown.length > 0);

  if (!hasAnyData) {
    chartsSection.style.display = "none";
    return;
  }
  chartsSection.style.display = "block";
  renderChartsAtResolution(chartResolution);
}

function renderChartsAtResolution(resolution) {
  const report = lastReport;
  if (!report) return;
  chartResolution = resolution;

  for (const btn of document.querySelectorAll(".chart-resolution-btn")) {
    btn.classList.toggle("active", btn.dataset.resolution === resolution);
  }

  const isDaily = resolution === "daily";
  const zoneData = isDaily ? report.dailyZoneBreakdown : report.monthlyZoneBreakdown;
  const pvUsageData = isDaily ? report.dailyPvUsageBreakdown : report.monthlyPvUsageBreakdown;
  const unitLabel = isDaily ? "kWh / dzień" : "kWh / miesiąc";
  const suffix = isDaily ? "(dziennie)" : "(miesięcznie)";
  const labelOf = isDaily
    ? (row) => formatDailyLabel(row.date)
    : (row) => MONTH_LABELS[row.month];

  document.getElementById("chart-zone-breakdown-title").textContent = `Realny pobór i oddanie — strefa 1 i strefa 2 ${suffix}`;
  document.getElementById("chart-pv-usage-title").textContent = `Wykorzystanie produkcji PV z magazynem ${suffix}`;

  const hasZoneData = zoneData && zoneData.length > 0;
  if (hasZoneData) {
    const labels = zoneData.map(labelOf);
    const ctx = document.getElementById("chart-zone-breakdown").getContext("2d");
    if (zoneBreakdownChart) zoneBreakdownChart.destroy();
    zoneBreakdownChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Strefa 1 — pobór", data: zoneData.map((m) => m.zone1ImportKwh), borderColor: CHART_COLORS.zone1Import, backgroundColor: CHART_COLORS.zone1Import, pointRadius: isDaily ? 0 : 3, fill: false, tension: 0.25 },
          { label: "Strefa 1 — oddanie", data: zoneData.map((m) => m.zone1ExportKwh), borderColor: CHART_COLORS.zone1Export, backgroundColor: CHART_COLORS.zone1Export, borderDash: [6, 4], pointRadius: isDaily ? 0 : 3, fill: false, tension: 0.25 },
          { label: "Strefa 2 — pobór", data: zoneData.map((m) => m.zone2ImportKwh), borderColor: CHART_COLORS.zone2Import, backgroundColor: CHART_COLORS.zone2Import, pointRadius: isDaily ? 0 : 3, fill: false, tension: 0.25 },
          { label: "Strefa 2 — oddanie", data: zoneData.map((m) => m.zone2ExportKwh), borderColor: CHART_COLORS.zone2Export, backgroundColor: CHART_COLORS.zone2Export, borderDash: [6, 4], pointRadius: isDaily ? 0 : 3, fill: false, tension: 0.25 },
        ],
      },
      options: baseChartOptions(unitLabel, isDaily),
    });
  }

  const pvUsageSection = document.getElementById("chart-pv-usage-section");
  const hasPvUsageData = pvUsageData && pvUsageData.length > 0;
  if (hasPvUsageData) {
    pvUsageSection.style.display = "block";
    const labels = pvUsageData.map(labelOf);
    const ctx = document.getElementById("chart-pv-usage").getContext("2d");
    if (pvUsageChart) pvUsageChart.destroy();
    pvUsageChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Zużyte na miejscu (bez magazynu)", data: pvUsageData.map((m) => m.selfConsumedKwh), borderColor: CHART_COLORS.selfConsumed, backgroundColor: CHART_COLORS.selfConsumed, pointRadius: isDaily ? 0 : 3, fill: false, tension: 0.25 },
          { label: "Naładowało magazyn — z nadwyżki PV", data: pvUsageData.map((m) => m.bessChargedFromPvKwh), borderColor: CHART_COLORS.bessChargedFromPv, backgroundColor: CHART_COLORS.bessChargedFromPv, pointRadius: isDaily ? 0 : 3, fill: false, tension: 0.25 },
          { label: "Naładowało magazyn — z sieci (arbitraż)", data: pvUsageData.map((m) => m.bessChargedFromGridKwh), borderColor: CHART_COLORS.bessChargedFromGrid, backgroundColor: CHART_COLORS.bessChargedFromGrid, pointRadius: isDaily ? 0 : 3, fill: false, tension: 0.25 },
          { label: "Oddane do sieci", data: pvUsageData.map((m) => m.gridExportKwh), borderColor: CHART_COLORS.gridExport, backgroundColor: CHART_COLORS.gridExport, pointRadius: isDaily ? 0 : 3, fill: false, tension: 0.25 },
        ],
      },
      options: baseChartOptions(unitLabel, isDaily),
    });
  } else {
    pvUsageSection.style.display = "none";
  }
}

for (const btn of document.querySelectorAll(".chart-resolution-btn")) {
  btn.addEventListener("click", () => renderChartsAtResolution(btn.dataset.resolution));
}

function renderSensitivity(sensitivity) {
  const section = document.getElementById("sensitivity-section");
  const rowsEl = document.getElementById("sensitivity-rows");
  rowsEl.innerHTML = "";
  if (!sensitivity || !sensitivity.rows || sensitivity.rows.length === 0) {
    section.style.display = "none";
    return;
  }

  const base = sensitivity.baseNpvPln;
  document.getElementById("sensitivity-desc").textContent =
    `NPV rekomendowanego wariantu przy założeniach bazowych: ${fmt(base)} PLN. Każde założenie przesunięte osobno w dół i w górę — im dłuższy pasek, tym większy wpływ na wynik.`;

  const maxDelta = Math.max(1, ...sensitivity.rows.flatMap((r) => [Math.abs(r.npvLowPln - base), Math.abs(r.npvHighPln - base)]));

  const side = (npv, label) => {
    const delta = npv - base;
    const widthPct = (Math.abs(delta) / maxDelta) * 100;
    const cls = delta >= 0 ? "pos" : "neg";
    return { delta, widthPct, cls, label, npv };
  };

  for (const r of sensitivity.rows) {
    const lo = side(r.npvLowPln, r.lowLabel);
    const hi = side(r.npvHighPln, r.highLabel);
    const row = document.createElement("div");
    row.className = "tornado-row";
    const bar = (s) =>
      `<div class="tornado-bar ${s.cls}" style="width:${s.widthPct}%"></div>`;
    row.innerHTML =
      `<div class="tornado-label">${r.parameter}</div>` +
      `<div class="tornado-track">` +
        `<div class="tornado-half left">${lo.delta < 0 ? bar(lo) : ""}${hi.delta < 0 ? bar(hi) : ""}</div>` +
        `<div class="tornado-axis"></div>` +
        `<div class="tornado-half right">${lo.delta >= 0 ? bar(lo) : ""}${hi.delta >= 0 ? bar(hi) : ""}</div>` +
      `</div>` +
      `<div class="tornado-values">${r.lowLabel}: ${fmt(r.npvLowPln)} PLN · ${r.highLabel}: ${fmt(r.npvHighPln)} PLN</div>`;
    rowsEl.appendChild(row);
  }
  section.style.display = "block";
}

function renderNpvRanking(results) {
  const body = document.getElementById("npv-ranking-body");
  const note = document.getElementById("npv-ranking-note");
  body.innerHTML = "";

  if (!results || results.length === 0) {
    body.innerHTML = `<tr><td colspan="5">Żaden wariant nie zwraca się w horyzoncie analizy.</td></tr>`;
    return;
  }

  note.textContent = results[0].npvPln <= 0
    ? "⚠️ Nawet najlepszy wariant ma NPV ≤ 0 — przy tych założeniach (wymiana po gwarancji, VAT, wartość eksportu) magazyn zwraca się nominalnie, ale nie tworzy wartości netto w horyzoncie analizy."
    : "Ranking po okresie zwrotu faworyzuje najmniejszy magazyn. NPV pokazuje, który wariant daje najwięcej wartości netto (po odjęciu inwestycji i ewentualnej wymiany).";

  for (const [i, fr] of results.entries()) {
    const bc = fr.simulationResult.bessConfig;
    if (!bc) continue;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>#${i + 1} ${bc.product.manufacturer} ${bc.product.model} ${(bc.product.usableCapacityKwh * bc.moduleCount).toFixed(1)}kWh</td>` +
      `<td>${fmt(fr.simulationResult.pvSizeKwp, 1)}</td>` +
      `<td>${fmt(fr.investmentCostPln)} PLN</td>` +
      `<td>${fmt(fr.paybackYears, 1)} lat</td>` +
      `<td>${fmt(fr.npvPln)} PLN</td>`;
    body.appendChild(tr);
  }
}

function renderManufacturerTable(body, results) {
  body.innerHTML = "";

  for (const fr of results || []) {
    const sim = fr.simulationResult;
    const bc = sim.bessConfig;
    if (!bc) continue;

    const payback = fr.paybackYears === null || fr.paybackYears === Infinity ? "∞" : `${fmt(fr.paybackYears, 1)} lat`;
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${bc.product.manufacturer}</td>` +
      `<td>${bc.product.model} ${(bc.product.usableCapacityKwh * bc.moduleCount).toFixed(1)}kWh</td>` +
      `<td>${fmt(sim.pvSizeKwp, 1)}</td>` +
      `<td>${fmt(fr.investmentCostPln)} PLN</td>` +
      `<td>${fmt(fr.annualSavingsYear1Pln)} PLN</td>` +
      `<td>${fmt(sim.annualCycles, 1)}</td>` +
      `<td>${payback}</td>`;
    body.appendChild(tr);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  resultsEl.style.display = "none";

  const lat = parseFloat(latInput.value);
  const lon = parseFloat(lonInput.value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    showStatus("❌ Wybierz miejscowość z listy podpowiedzi.", "error");
    citySearchInput.focus();
    return;
  }

  const path = currentPath();
  const hasCsv = form.querySelector("#csv-file").files.length > 0;
  const declaredAnnual = parseFloat(document.getElementById("annual-consumption").value);
  if (path === "tauron" && !hasCsv && !(Number.isFinite(declaredAnnual) && declaredAnnual > 0)) {
    showStatus("❌ Podaj roczne zużycie energii z sieci.", "error");
    document.getElementById("annual-consumption").focus();
    return;
  }
  if (path === "firma-15min" && !hasCsv) {
    showStatus("❌ Wgraj plik z profilem zużycia.", "error");
    return;
  }

  let installations = [];
  if (path === "moj-licznik") {
    const rows = installationsList.querySelectorAll(".installation-row");
    for (const row of rows) {
      const brand = row.querySelector(".inst-inverter").value;
      const model = row.querySelector(".inst-model").value;
      if (!brand) {
        showStatus("❌ Wybierz markę falownika przy każdej instalacji albo „Nie wiem”.", "error");
        return;
      }
      if (brand !== UNKNOWN_INVERTER && !model) {
        showStatus("❌ Wybierz model falownika albo ustaw markę na „Nie wiem”.", "error");
        return;
      }
    }
    installations = collectInstallations();
    if (installations.length === 0) {
      showStatus("❌ Podaj moc co najmniej jednej instalacji PV.", "error");
      return;
    }
  }

  const submitBtn = form.querySelector(".submit-btn");
  submitBtn.disabled = true;
  showStatus("Trwa analiza… to może potrwać do minuty.", "loading");

  try {
    const formData = new FormData(form);
    // Ścieżka "moj-licznik" w UI zawsze korzysta z dokładniejszych danych
    // dobowych (adapter moj-licznik-daily) — miesięczny "Bilans A+ i A-" nie
    // jest już oferowany w formularzu (za mało dokładny, patrz historia zmian).
    // "Nie mam PV" bez wgranego pliku, ale z deklaracją rocznego zużycia → adapter "declared".
    const useDeclared = path === "tauron" && !hasCsv && Number.isFinite(declaredAnnual) && declaredAnnual > 0;
    formData.set("adapter", path === "moj-licznik" ? "moj-licznik-daily" : useDeclared ? "declared" : path);
    formData.set("appliances", [...document.querySelectorAll(".appliance:checked")].map((c) => c.value).join(","));
    formData.set("lat", String(lat));
    formData.set("lon", String(lon));
    if (path === "moj-licznik") {
      formData.set("installations", JSON.stringify(installations));
    }
    formData.set("tariffPrices", JSON.stringify(collectTariffPrices()));

    const response = await fetch("/api/analyze", { method: "POST", body: formData });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Nieznany błąd analizy.");
    }

    clearStatus();
    renderResults(data);
  } catch (error) {
    showStatus(`❌ ${error.message}`, "error");
  } finally {
    submitBtn.disabled = false;
  }
});
