/* global Chart */

// ============================================================
// CONFIG
// ============================================================
const ALPHA_VANTAGE_BASE = "https://www.alphavantage.co";
const UNIRATE_BASE       = "https://api.unirateapi.com";

const AV_KEY = "K6Q4CQ9EA1330COW";
const UR_KEY = "vfcxDAbH14iTFYsVSW5bH6HlVOPXKDLw3aml0qIYeqIHk2qL1LHcHARwpxL7365i";

// Every pair is fetched as USD → X.
// Cross rates are derived: A→B = rates[B] / rates[A]
const REQUIRED_QUOTES = ["NGN","ZAR","KES","GBP","EUR","GHS","EGP","CAD","AED","JPY","CNY","MAD"];

const TICKER_PAIRS = [
  ["GBP","NGN"],
  ["USD","ZAR"],
  ["USD","KES"],
  ["USD","NGN"],
  ["EUR","NGN"],
];

const CACHE_KEY    = "fxglobal:v7:snapshot";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ============================================================
// CURRENCY META
// ============================================================
const CURRENCY_NAMES = {
  AED:"UAE Dirham",       CAD:"Canadian Dollar",  CNY:"Chinese Yuan",
  EGP:"Egyptian Pound",   ETB:"Ethiopian Birr",   EUR:"Euro",
  GBP:"British Pound",    GHS:"Ghanaian Cedi",    JPY:"Japanese Yen",
  KES:"Kenyan Shilling",  MAD:"Moroccan Dirham",  NGN:"Nigerian Naira",
  TZS:"Tanzanian Shilling", UGX:"Ugandan Shilling",
  USD:"US Dollar",        XAF:"Central African CFA", XOF:"West African CFA",
  ZAR:"South African Rand",
};

// ============================================================
// IN-MEMORY STORE
// ============================================================
let store = null;

// ============================================================
// HELPERS
// ============================================================
function isoDate(d) { return d.toISOString().slice(0, 10); }

function fmt(value, digits = 4) {
  if (!Number.isFinite(value) || value === 0) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(value);
}

function parseCode(raw) {
  if (typeof raw !== "string") return "";
  const first = raw.trim().split(/\s/)[0].replace(/[^A-Za-z]/g, "").toUpperCase();
  return first.length === 3 ? first : "";
}

function usdTo(quote) {
  if (!store) return NaN;
  if (quote === "USD") return 1;
  return Number(store.rates[quote]) || NaN;
}

function crossRate(base, quote) {
  if (!store) return NaN;
  if (base === quote) return 1;
  const uBase  = usdTo(base);
  const uQuote = usdTo(quote);
  if (!Number.isFinite(uBase) || !Number.isFinite(uQuote)) return NaN;
  return uQuote / uBase;
}

function crossHistory(base, quote) {
  if (!store) return null;
  const getH = (q) => store.history[q] ?? null;

  if (base === "USD") return getH(quote);

  if (quote === "USD") {
    const h = getH(base);
    if (!h) return null;
    return { labels: h.labels, data: h.data.map((v) => (v ? 1 / v : null)) };
  }

  const hBase  = getH(base);
  const hQuote = getH(quote);
  if (!hBase || !hQuote) return null;
  const len = Math.min(hBase.labels.length, hQuote.labels.length);
  return {
    labels: hQuote.labels.slice(-len),
    data: hQuote.data.slice(-len).map((qv, i) => {
      const bv = hBase.data[hBase.data.length - len + i];
      return bv && qv ? qv / bv : null;
    }),
  };
}

function changePct(base, quote) {
  const h = crossHistory(base, quote);
  if (!h || h.data.length < 2) return null;
  const recent = h.data.filter((v) => Number.isFinite(v)).slice(-2);
  if (recent.length < 2 || !recent[0]) return null;
  return ((recent[1] - recent[0]) / recent[0]) * 100;
}

// Returns which quotes are still missing valid rate or history
function getMissingQuotes(rates, history, target = REQUIRED_QUOTES) {
  return target.filter(q => {
    const hasRate    = Number.isFinite(Number(rates[q])) && Number(rates[q]) > 0;
    const hasHistory = history[q]?.labels?.length > 0;
    return !hasRate || !hasHistory;
  });
}

// ============================================================
// CACHE
// ============================================================
function saveCache(s) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(s)); } catch { /* quota */ }
}
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.ts || !p?.rates || !p?.history) return null;
    return p;
  } catch { return null; }
}
function isFresh(s) { return !!s && Date.now() - s.ts < CACHE_TTL_MS; }

// ============================================================
// SIMULATION — only used when we have a rate but no history
// ============================================================
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function simulate(quote, anchor, days) {
  const rand = rng(hashStr(quote + isoDate(new Date())));
  const labels = [], data = [];
  let v = anchor;
  const start = new Date();
  start.setDate(start.getDate() - days + 1);
  for (let i = 0; i < days; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    labels.push(isoDate(d));
    v = Math.max(0.000001, v * (1 + (rand() - 0.5) * 0.012));
    data.push(parseFloat(v.toFixed(6)));
  }
  return { labels, data };
}

// ============================================================
// ALPHA VANTAGE — fetch specific quotes (USD → each)
// Returns { rates, history, succeeded, failed }
// ============================================================
async function fetchAV_quotes(quotes) {
  const rates   = {};
  const history = {};

  console.group(`[AV] Fetching ${quotes.length} quotes: ${quotes.join(", ")}`);

  const results = await Promise.allSettled(
    quotes.map(async (quote) => {
      const url = `${ALPHA_VANTAGE_BASE}/query?function=FX_DAILY` +
        `&from_symbol=USD&to_symbol=${quote}&outputsize=compact` +
        `&apikey=${localStorage.getItem("alphaVantageKey") || AV_KEY}`;

      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();

      if (json?.Note) {
        console.warn(`[AV] ${quote}: Rate-limit hit —`, json.Note);
        throw new Error("AV rate-limit");
      }
      if (json?.["Error Message"]) {
        console.warn(`[AV] ${quote}: Error message —`, json["Error Message"]);
        throw new Error("AV pair unsupported");
      }
      if (json?.["Information"]) {
        console.warn(`[AV] ${quote}: Info block (likely daily limit) —`, json["Information"]);
        throw new Error("AV info block");
      }

      const series = json?.["Time Series FX (Daily)"];
      if (!series) {
        console.warn(`[AV] ${quote}: No time series in response. Full response:`, json);
        throw new Error("AV no series");
      }

      const entries = Object.entries(series)
        .map(([d, row]) => [d, parseFloat(row?.["4. close"])])
        .filter(([, v]) => Number.isFinite(v))
        .sort(([a], [b]) => a.localeCompare(b));

      if (!entries.length) throw new Error("AV empty series");

      rates[quote]   = entries[entries.length - 1][1];
      history[quote] = { labels: entries.map(([d]) => d), data: entries.map(([, v]) => v) };
      console.log(`[AV] ✓ ${quote}: rate = ${rates[quote]} (${entries.length} days)`);
    })
  );

  const succeeded = quotes.filter((_, i) => results[i].status === "fulfilled");
  const failed    = quotes.filter((_, i) => results[i].status === "rejected");

  results.forEach((r, i) => {
    if (r.status === "rejected")
      console.warn(`[AV] ✗ ${quotes[i]}: ${r.reason?.message}`);
  });

  console.log(`[AV] Summary — succeeded: [${succeeded.join(", ")}] | failed: [${failed.join(", ")}]`);
  console.groupEnd();

  return { rates, history, succeeded, failed };
}

// ============================================================
// UNIRATE — fetch specific quotes
// Returns { rates, history, succeeded, failed }
// ============================================================
async function fetchUR_quotes(quotes) {
  const rates   = {};
  const history = {};
  const key     = localStorage.getItem("uniRateKey") || UR_KEY;

  console.group(`[UR] Fetching ${quotes.length} quotes: ${quotes.join(", ")}`);

  // Latest rates — one bulk call
  const latestEndpoints = [
    `${UNIRATE_BASE}/api/rates?api_key=${key}&base=USD`,
    `${UNIRATE_BASE}/rates?api_key=${key}&base=USD`,
  ];

  let latestRaw = null;
  for (const url of latestEndpoints) {
    try {
      console.log(`[UR] Trying latest endpoint: ${url}`);
      const res  = await fetch(url, { headers: { Accept: "application/json" } });
      const json = await res.json();
      const r    = json?.rates ?? json?.results;
      if (r && typeof r === "object") {
        latestRaw = r;
        console.log(`[UR] Latest rates — available keys (${Object.keys(r).length} total):`, Object.keys(r).join(", "));
        break;
      } else {
        console.warn(`[UR] Unexpected response shape from ${url}:`, json);
      }
    } catch (e) {
      console.warn(`[UR] Endpoint failed (${url}):`, e.message);
    }
  }

  if (!latestRaw) {
    console.error("[UR] All latest rate endpoints failed");
    console.groupEnd();
    throw new Error("UR: latest rates failed");
  }

  const succeeded = [];
  const failed    = [];

  for (const q of quotes) {
    const val = Number(latestRaw[q]);
    if (Number.isFinite(val) && val > 0) {
      rates[q] = val;
      console.log(`[UR] ✓ ${q}: rate = ${val}`);
      succeeded.push(q);
    } else {
      console.warn(`[UR] ✗ ${q}: not in response (raw value: ${latestRaw[q] ?? "undefined"})`);
      failed.push(q);
    }
  }

  // Timeseries for quotes we got rates for
  const end   = new Date();
  const start = new Date(); start.setDate(end.getDate() - 99);
  const s = isoDate(start), e = isoDate(end);

  await Promise.allSettled(succeeded.map(async (quote) => {
    const endpoints = [
      `${UNIRATE_BASE}/api/historical/timeseries?start_date=${s}&end_date=${e}&base=USD&currencies=${quote}&api_key=${key}`,
      `${UNIRATE_BASE}/v1/timeseries?start_date=${s}&end_date=${e}&base=USD&currencies=${quote}&api_key=${key}`,
    ];

    for (const url of endpoints) {
      try {
        const res  = await fetch(url, { headers: { Accept: "application/json" } });
        const json = await res.json();
        const r    = json?.rates;
        if (!r) { console.warn(`[UR] ${quote} timeseries: no "rates" key`, json); continue; }

        const entries = Object.entries(r)
          .map(([d, row]) => [d, Number(row?.[quote])])
          .filter(([, v]) => Number.isFinite(v))
          .sort(([a], [b]) => a.localeCompare(b));

        if (!entries.length) { console.warn(`[UR] ${quote} timeseries: 0 valid entries`); continue; }

        history[quote] = { labels: entries.map(([d]) => d), data: entries.map(([, v]) => v) };
        console.log(`[UR] ✓ ${quote} timeseries: ${entries.length} days`);
        return;
      } catch (err) {
        console.warn(`[UR] ${quote} timeseries endpoint failed:`, err.message);
      }
    }

    // Have rate but couldn't get history — simulate from the live rate
    console.warn(`[UR] ${quote}: timeseries unavailable — simulating history from live rate ${rates[quote]}`);
    history[quote] = simulate(quote, rates[quote], 100);
  }));

  console.log(`[UR] Summary — succeeded: [${succeeded.join(", ")}] | failed: [${failed.join(", ")}]`);
  console.groupEnd();

  return { rates, history, succeeded, failed };
}

// ============================================================
// BOOTSTRAP
//
// Per-currency cross-API fallback flow:
//  1. Fresh cache → use it
//  2. AV for ALL required quotes
//  3. UR for only the quotes AV missed
//  4. Stale cache for anything still missing
//  5. If we have a rate but no history → simulate history only
//  6. If we have neither → leave undefined (UI shows "—", honest)
// ============================================================
async function bootstrap() {
  setStatus("loading…", "loading");

  // 1. Fresh cache
  const cached = loadCache();
  if (isFresh(cached)) {
    store = cached;
    const missing = getMissingQuotes(cached.rates, cached.history);
    if (missing.length) {
      console.warn("[BOOT] Cache is fresh but missing quotes:", missing);
    } else {
      console.log("[BOOT] Cache is fresh, all quotes present — skipping network");
    }
    setStatus(`cached · ${new Date(cached.ts).toLocaleTimeString()}`, "idle");
    return;
  }

  const rates   = { USD: 1 };
  const history = {};
  let   source  = "unknown";

  // 2. AlphaVantage for all required quotes
  console.group("[BOOT] Phase 1 — AlphaVantage");
  let afterAV_missing = REQUIRED_QUOTES;
  try {
    const av = await fetchAV_quotes(REQUIRED_QUOTES);
    Object.assign(rates,   av.rates);
    Object.assign(history, av.history);
    afterAV_missing = getMissingQuotes(rates, history);
    source = "alphavantage";
    console.log("[BOOT] After AV — still missing:", afterAV_missing.length ? afterAV_missing : "none ✓");
  } catch (err) {
    console.error("[BOOT] AV fetch threw entirely:", err.message);
    afterAV_missing = REQUIRED_QUOTES;
  }
  console.groupEnd();

  // 3. UniRate for quotes AV missed
  if (afterAV_missing.length > 0) {
    console.group(`[BOOT] Phase 2 — UniRate for [${afterAV_missing.join(", ")}]`);
    try {
      const ur = await fetchUR_quotes(afterAV_missing);

      for (const q of afterAV_missing) {
        if (ur.rates[q]   && (!rates[q] || !Number.isFinite(rates[q])))     rates[q]   = ur.rates[q];
        if (ur.history[q] && (!history[q] || !history[q].labels?.length))   history[q] = ur.history[q];
      }

      const afterUR_missing = getMissingQuotes(rates, history, afterAV_missing);

      if (source === "alphavantage" && ur.succeeded.length > 0) source = "alphavantage+unirate";
      else if (source === "unknown" && ur.succeeded.length > 0) source = "unirate";

      console.log("[BOOT] After UR — still missing:", afterUR_missing.length ? afterUR_missing : "none ✓");
    } catch (err) {
      console.error("[BOOT] UR fetch threw:", err.message);
    }
    console.groupEnd();
  }

  // 4. Stale cache for anything still missing
  const afterAPIs_missing = getMissingQuotes(rates, history);
  if (afterAPIs_missing.length > 0 && cached) {
    console.group(`[BOOT] Phase 3 — Stale cache for [${afterAPIs_missing.join(", ")}]`);
    for (const q of afterAPIs_missing) {
      if (Number.isFinite(cached.rates?.[q]) && cached.rates[q] > 0) {
        rates[q] = cached.rates[q];
        console.log(`[BOOT] ${q}: rate filled from stale cache (${rates[q]})`);
      } else {
        console.warn(`[BOOT] ${q}: not in stale cache either`);
      }
      if (cached.history?.[q]?.labels?.length) {
        history[q] = cached.history[q];
        console.log(`[BOOT] ${q}: history filled from stale cache (${history[q].labels.length} days)`);
      } else {
        console.warn(`[BOOT] ${q}: no history in stale cache`);
      }
    }
    console.groupEnd();
  }

  // 5. Have rate but no history → simulate history only
  // 6. Have neither → leave undefined, UI shows "—"
  const finalMissing = getMissingQuotes(rates, history);
  if (finalMissing.length > 0) {
    console.group(`[BOOT] Phase 4 — Final gap check for [${finalMissing.join(", ")}]`);
    for (const q of finalMissing) {
      const hasRate    = Number.isFinite(rates[q]) && rates[q] > 0;
      const hasHistory = history[q]?.labels?.length > 0;

      if (hasRate && !hasHistory) {
        console.warn(`[BOOT] ${q}: has rate (${rates[q]}) but no history — simulating history`);
        history[q] = simulate(q, rates[q], 100);
      } else if (!hasRate) {
        console.error(`[BOOT] ✗ ${q}: NO rate from any source (AV, UR, cache) — will show "—" in UI`);
      }
    }
    console.groupEnd();
  }

  // Status badge
  const missingRates = REQUIRED_QUOTES.filter(q => !Number.isFinite(rates[q]) || rates[q] <= 0);
  if (missingRates.length === 0) {
    setStatus(`live · ${source}`, "idle");
  } else {
    setStatus(`partial · ${source} · missing: ${missingRates.join(",")}`, "error");
    console.error("[BOOT] Final missing rates:", missingRates);
  }

  const snap = { ts: Date.now(), source, rates, history };
  store = snap;
  saveCache(snap);

  // Final summary table
  console.group("[BOOT] ✅ Final store summary");
  console.table(
    REQUIRED_QUOTES.reduce((acc, q) => {
      acc[q] = {
        rate:        rates[q] ?? "MISSING",
        historyDays: history[q]?.labels?.length ?? 0,
        source:      rates[q] ? source : "NONE",
      };
      return acc;
    }, {})
  );
  console.groupEnd();
}

// ============================================================
// DOM REFS
// ============================================================
const els = {
  apiStatus:       document.getElementById("apiStatus"),
  lastUpdated:     document.getElementById("lastUpdated"),
  form:            document.getElementById("converterForm"),
  amount:          document.getElementById("amount"),
  from:            document.getElementById("fromCurrency"),
  to:              document.getElementById("toCurrency"),
  convertBtn:      document.getElementById("convertBtn"),
  swapBtn:         document.getElementById("swapBtn"),
  resultValue:     document.getElementById("resultValue"),
  rateLine:        document.getElementById("rateLine"),
  chartSubtitle:   document.getElementById("chartSubtitle"),
  chartFootnote:   document.getElementById("chartFootnote"),
  refreshChartBtn: document.getElementById("refreshChartBtn"),
  rangeButtons:    Array.from(document.querySelectorAll(".range-btn[data-range]")),
  chartCanvas:     document.getElementById("rateChart"),
  marketsBody:     document.getElementById("marketsBody"),
  tickerTrack:     document.getElementById("tickerTrack"),
  currencyList:    document.getElementById("currencyList"),
};

function setStatus(text, kind = "idle") {
  if (!els.apiStatus) return;
  els.apiStatus.textContent = `API: ${text}`;
  els.apiStatus.style.borderColor = kind === "error" ? "rgba(186,26,26,.35)" : "rgba(194,198,216,.8)";
  els.apiStatus.style.background  = kind === "error" ? "rgba(186,26,26,.08)" : "rgba(237,237,251,.85)";
}

// ============================================================
// DATALIST
// ============================================================
function populateCurrencyList() {
  if (!els.currencyList) return;
  els.currencyList.innerHTML = "";
  for (const code of Object.keys(CURRENCY_NAMES).sort()) {
    const opt   = document.createElement("option");
    opt.value   = code;
    opt.label   = `${code} — ${CURRENCY_NAMES[code]}`;
    els.currencyList.appendChild(opt);
  }
  if (!els.from.value) els.from.value = "NGN";
  if (!els.to.value)   els.to.value   = "USD";
}

// ============================================================
// CONVERTER
// ============================================================
function runConverter() {
  const amount = parseFloat(els.amount.value);
  const from   = parseCode(els.from.value);
  const to     = parseCode(els.to.value);

  if (!Number.isFinite(amount) || amount < 0) {
    els.resultValue.textContent = "Enter a valid amount."; return;
  }
  if (!from || !to) {
    els.resultValue.textContent = "Type a 3-letter currency code (e.g. NGN)."; return;
  }
  if (from === to) {
    els.resultValue.textContent = `${fmt(amount, 2)} ${to}`;
    els.rateLine.textContent    = `1 ${from} = 1 ${to}`; return;
  }

  const rate = crossRate(from, to);
  if (!Number.isFinite(rate)) {
    console.warn(`[CONVERTER] crossRate(${from}, ${to}) = NaN — usdTo(${from})=${usdTo(from)}, usdTo(${to})=${usdTo(to)}`);
    els.resultValue.textContent = `Rate unavailable for ${from} → ${to}.`;
    els.rateLine.textContent    = `${from} or ${to} data was not available from any source.`;
    return;
  }

  els.resultValue.textContent = `${fmt(amount * rate, 4)} ${to}`;
  els.rateLine.textContent    = `1 ${from} = ${fmt(rate, 6)} ${to}`;
  if (els.lastUpdated && store)
    els.lastUpdated.textContent = `Last updated: ${isoDate(new Date(store.ts))}`;
}

// ============================================================
// CHART
// ============================================================
let chartObj      = null;
let selectedRange = 7;
let chartBase     = "USD";
let chartQuote    = "NGN";

function setActiveRange(days) {
  selectedRange = days;
  for (const btn of els.rangeButtons)
    btn.classList.toggle("is-active", Number(btn.dataset.range) === days);
}

function renderChart() {
  const base  = chartBase;
  const quote = chartQuote;

  if (els.chartSubtitle)
    els.chartSubtitle.textContent = `${base} → ${quote} · last ${selectedRange} days`;

  const full = crossHistory(base, quote);
  if (!full?.labels?.length) {
    if (els.chartFootnote) els.chartFootnote.textContent = "No history for this pair.";
    console.warn(`[CHART] No history for ${base}/${quote}`);
    return;
  }

  const labels = full.labels.slice(-selectedRange);
  const data   = full.data.slice(-selectedRange);
  const values = data.filter(Number.isFinite);

  if (!values.length) {
    if (els.chartFootnote) els.chartFootnote.textContent = "Insufficient data.";
    return;
  }

  const min      = Math.min(...values);
  const max      = Math.max(...values);
  const delta    = values[values.length - 1] - values[0];
  const deltaPct = values[0] ? (delta / values[0]) * 100 : 0;
  const sign     = deltaPct >= 0 ? "+" : "";

  if (els.chartFootnote)
    els.chartFootnote.textContent =
      `Range: ${fmt(min, 4)} – ${fmt(max, 4)} | Change: ${fmt(delta, 4)} (${sign}${fmt(deltaPct, 2)}%)`;

  if (chartObj) {
    chartObj.data.labels            = labels;
    chartObj.data.datasets[0].label = `${base}/${quote}`;
    chartObj.data.datasets[0].data  = data;
    chartObj.update();
    return;
  }

  chartObj = new Chart(els.chartCanvas.getContext("2d"), {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: `${base}/${quote}`,
        data,
        borderColor:     "rgba(0,80,204,0.9)",
        backgroundColor: "rgba(0,80,204,0.08)",
        pointRadius: 0, tension: 0.3, fill: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${fmt(ctx.parsed.y, 6)} ${quote}` } },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 7, color: "rgba(66,70,86,.85)" }, grid: { color: "rgba(194,198,216,.45)" } },
        y: { position: "right", ticks: { color: "rgba(66,70,86,.85)", callback: (v) => fmt(v, 4) }, grid: { color: "rgba(194,198,216,.45)" } },
      },
    },
  });
}

// ============================================================
// MARKETS TABLE
// ============================================================
function renderMarkets() {
  if (!els.marketsBody) return;
  for (const row of els.marketsBody.querySelectorAll("tr[data-pair]")) {
    const parts = (row.getAttribute("data-pair") || "").split("/").map((s) => s.trim());
    const base  = parts[0];
    const quote = parts[1];

    const rate     = crossRate(base, quote);
    const rateCell = row.querySelector('[data-field="rate"]');
    if (rateCell) rateCell.textContent = Number.isFinite(rate) ? fmt(rate, 6) : "—";

    const pct        = changePct(base, quote);
    const changeCell = row.querySelector('[data-field="change"] span');
    if (changeCell) {
      if (!Number.isFinite(pct)) {
        changeCell.textContent = "—";
        changeCell.className   = "px-2 py-1 rounded-full text-xs bg-surface-container text-on-surface-variant border border-outline-variant/60";
      } else {
        const s = pct >= 0 ? "+" : "";
        changeCell.textContent = `${s}${fmt(pct, 2)}%`;
        changeCell.className   = pct >= 0
          ? "px-2 py-1 rounded-full text-xs bg-emerald-50 text-emerald-700 border border-emerald-200"
          : "px-2 py-1 rounded-full text-xs bg-red-50 text-red-700 border border-red-200";
      }
    }
  }
}

// ============================================================
// TICKER
// ============================================================
function renderTicker() {
  if (!els.tickerTrack) return;
  const items = TICKER_PAIRS.map(([base, quote]) => {
    const rate = crossRate(base, quote);
    const pct  = changePct(base, quote);
    let pctHtml = "";
    if (Number.isFinite(pct)) {
      const s   = pct >= 0 ? "+" : "";
      const cls = pct >= 0 ? "text-emerald-300 font-extrabold" : "text-red-300 font-extrabold";
      pctHtml = ` <span class="${cls}">${s}${fmt(pct, 2)}%</span>`;
    }
    return `<span class="ticker__item">${base}/${quote} <span class="ticker__muted">${Number.isFinite(rate) ? fmt(rate, 4) : "—"}</span>${pctHtml}</span>`;
  });
  els.tickerTrack.innerHTML = [...items, ...items].join("");
}

// ============================================================
// EVENT WIRING
// ============================================================
function swapCurrencies() {
  const a = els.from.value; els.from.value = els.to.value; els.to.value = a;
}

function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function syncChart() {
  const from = parseCode(els.from.value);
  const to   = parseCode(els.to.value);
  if (from && to && from !== to) { chartBase = from; chartQuote = to; }
}

function fullUpdate() { syncChart(); runConverter(); renderChart(); }

function wireEvents() {
  els.form.addEventListener("submit", (e) => { e.preventDefault(); fullUpdate(); });
  els.swapBtn.addEventListener("click", () => { swapCurrencies(); fullUpdate(); });

  const debounced = debounce(fullUpdate, 350);
  els.from.addEventListener("input",  debounced);
  els.to.addEventListener("input",    debounced);
  els.from.addEventListener("change", fullUpdate);
  els.to.addEventListener("change",   fullUpdate);

  for (const btn of els.rangeButtons)
    btn.addEventListener("click", () => { setActiveRange(Number(btn.dataset.range)); renderChart(); });

  if (els.refreshChartBtn)
    els.refreshChartBtn.addEventListener("click", () => {
      if (chartObj) { chartObj.destroy(); chartObj = null; }
      renderChart();
    });

  if (els.marketsBody) {
    els.marketsBody.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLElement) || target.getAttribute("data-action") !== "chart") return;
      const row = target.closest("tr[data-pair]");
      if (!row) return;
      const parts = (row.getAttribute("data-pair") || "").split("/").map((s) => s.trim());
      els.from.value = parts[0];
      els.to.value   = parts[1];
      chartBase      = parts[0];
      chartQuote     = parts[1];
      runConverter();
      if (chartObj) { chartObj.destroy(); chartObj = null; }
      renderChart();
      document.getElementById("charts")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

// ============================================================
// BOOT
// ============================================================
async function boot() {
  await bootstrap();
  populateCurrencyList();
  setActiveRange(7);
  syncChart();
  runConverter();
  renderMarkets();
  renderTicker();
  renderChart();
  wireEvents();
}

void boot();

// ============================================================
// DEBUG (browser console)
// ============================================================
window.__FX_DEBUG__ = {
  clearCache()   { localStorage.removeItem(CACHE_KEY); console.log("Cache cleared — reload to re-fetch."); },
  store()        { return store; },
  source()       { return store?.source ?? "none"; },
  rates()        { return store?.rates ?? {}; },
  age()          { return store ? Math.round((Date.now() - store.ts) / 60000) + " min old" : "no cache"; },
  missingRates() { return REQUIRED_QUOTES.filter(q => !Number.isFinite(store?.rates?.[q])); },
  summary() {
    if (!store) { console.log("No store yet"); return; }
    console.table(REQUIRED_QUOTES.reduce((acc, q) => {
      acc[q] = { rate: store.rates[q] ?? "MISSING", historyDays: store.history[q]?.labels?.length ?? 0 };
      return acc;
    }, {}));
  },
};