/* =============================================================
   DOREL – UK Offshore Wind Analytics  |  Application Logic
   ============================================================= */

const DATA_BASE = './data';

// ─────────────────────────────────────────────
//  DataManager – fetching, caching, filtering
// ─────────────────────────────────────────────
class DataManager {
  constructor() {
    /** @type {Array} */
    this.farms = [];
    /** cache: { farmId: { b1610: { year: [...] }, pn: { year: [...] }, boalf: [...] | null } } */
    this._cache = {};
  }

  /* ---- farms.json ---- */
  async loadFarms() {
    const res = await fetch(`${DATA_BASE}/farms.json`);
    if (!res.ok) throw new Error('Failed to load farms.json');
    const json = await res.json();
    this.farms = json.farms.sort((a, b) => a.name.localeCompare(b.name));
    return this.farms;
  }

  /* ---- B1610 + PN for a date range ---- */
  async loadFarmData(farmId, startDate, endDate) {
    const farm = this.farms.find(f => f.id === farmId);
    if (!farm) throw new Error(`Farm "${farmId}" not found`);

    if (!this._cache[farmId]) this._cache[farmId] = { b1610: {}, pn: {}, mels: {}, boalf: null };

    const startYear = startDate.getFullYear();
    const endYear   = endDate.getFullYear();
    const neededYears = farm.years.filter(y => y >= startYear && y <= endYear);

    // Fetch missing years in parallel
    const fetches = [];
    for (const y of neededYears) {
      if (!this._cache[farmId].b1610[y]) {
        fetches.push(
          fetch(`${DATA_BASE}/${farmId}/b1610_${y}.json`)
            .then(r => { if (!r.ok) throw new Error(`b1610_${y}`); return r.json(); })
            .then(j => { this._cache[farmId].b1610[y] = j.data; })
            .catch(() => { this._cache[farmId].b1610[y] = []; })
        );
      }
      if (!this._cache[farmId].pn[y]) {
        fetches.push(
          fetch(`${DATA_BASE}/${farmId}/pn_${y}.json`)
            .then(r => { if (!r.ok) throw new Error(`pn_${y}`); return r.json(); })
            .then(j => { this._cache[farmId].pn[y] = j.data; })
            .catch(() => { this._cache[farmId].pn[y] = []; })
        );
      }
      if (!this._cache[farmId].mels[y]) {
        fetches.push(
          fetch(`${DATA_BASE}/${farmId}/mels_${y}.json`)
            .then(r => { if (!r.ok) throw new Error(`mels_${y}`); return r.json(); })
            .then(j => { this._cache[farmId].mels[y] = j.data; })
            .catch(() => { this._cache[farmId].mels[y] = []; })
        );
      }
    }
    await Promise.all(fetches);

    // Merge & filter
    const b1610All = neededYears.flatMap(y => this._cache[farmId].b1610[y] || []);
    const pnAll    = neededYears.flatMap(y => this._cache[farmId].pn[y] || []);
    const melsAll  = neededYears.flatMap(y => this._cache[farmId].mels[y] || []);

    const inRange = (ts) => {
      const d = new Date(ts);
      return d >= startDate && d <= endDate;
    };

    return {
      b1610: b1610All.filter(r => inRange(r[0])),
      pn:    pnAll.filter(r => inRange(r[0])),
      mels:  melsAll.filter(r => inRange(r[0]))
    };
  }

  /* ---- BOALF ---- */
  async loadBoalf(farmId) {
    if (!this._cache[farmId]) this._cache[farmId] = { b1610: {}, pn: {}, mels: {}, boalf: null };
    if (this._cache[farmId].boalf !== null) return this._cache[farmId].boalf;

    try {
      const res = await fetch(`${DATA_BASE}/${farmId}/boalf.json`);
      if (!res.ok) throw new Error();
      const json = await res.json();
      this._cache[farmId].boalf = json.data || [];
    } catch {
      this._cache[farmId].boalf = [];
    }
    return this._cache[farmId].boalf;
  }

  /* ---- PyWake data ---- */
  async loadPyWake(farmId, scenario) {
    const key = `pywake_${scenario}`;
    if (!this._cache[farmId]) this._cache[farmId] = { b1610: {}, pn: {}, mels: {}, boalf: null };
    if (this._cache[farmId][key]) return this._cache[farmId][key];

    const url = `${DATA_BASE}/${farmId}/pywake_${scenario}_2023.json`;
    console.log(`[DOREL] Fetching PyWake: ${url}`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      console.log(`[DOREL] PyWake loaded: ${json.models?.length} models, ${json.data?.length} rows`);
      this._cache[farmId][key] = json; // { models: [...], data: [[ts, v1, v2, ...], ...] }
    } catch (err) {
      console.error(`[DOREL] PyWake fetch failed:`, err);
      this._cache[farmId][key] = { models: [], data: [] };
    }
    return this._cache[farmId][key];
  }

  /* ---- WRF data ---- */
  async loadWRF(farmId, variant) {
    const key = `wrf_${variant}`;
    if (!this._cache[farmId]) this._cache[farmId] = { b1610: {}, pn: {}, mels: {}, boalf: null };
    if (this._cache[farmId][key]) return this._cache[farmId][key];

    const url = `${DATA_BASE}/${farmId}/wrf_${variant}_2023.json`;
    console.log(`[DOREL] Fetching WRF ${variant}: ${url}`);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      console.log(`[DOREL] WRF ${variant} loaded: ${json.data?.length} rows`);
      this._cache[farmId][key] = json.data || []; // [[ts, mw], ...]
    } catch (err) {
      console.error(`[DOREL] WRF ${variant} fetch failed:`, err);
      this._cache[farmId][key] = [];
    }
    return this._cache[farmId][key];
  }
}

// ─────────────────────────────────────────────
//  Data utilities
// ─────────────────────────────────────────────

/** Aggregate half-hourly data to hourly by averaging consecutive pairs */
function aggregateToHourly(data, isMWh) {
  if (data.length < 2) return data;

  const result = [];
  let i = 0;
  while (i < data.length) {
    if (i + 1 < data.length) {
      const ts1 = data[i][0];
      const ts2 = data[i + 1][0];
      const d1 = new Date(ts1);
      const d2 = new Date(ts2);
      // Check if these two half-hours are in the same hour
      if (d1.getHours() === d2.getHours() || (d2 - d1) <= 1800001) {
        if (isMWh) {
          // For MWh: sum both half-hours to get hourly MWh
          result.push([ts2, data[i][1] + data[i + 1][1]]);
        } else {
          // For MW: average the two half-hour values
          result.push([ts2, (data[i][1] + data[i + 1][1]) / 2]);
        }
        i += 2;
        continue;
      }
    }
    result.push(data[i]);
    i++;
  }
  return result;
}


// ─────────────────────────────────────────────
//  ChartManager – Plotly rendering
// ─────────────────────────────────────────────
class ChartManager {
  constructor(chartId, curtailmentId, scatterSectionId) {
    this.chartId = chartId;
    this.curtailmentId = curtailmentId;
    this.scatterSectionId = scatterSectionId;
  }

  /** Get current theme colors from CSS custom properties */
  _getThemeColors() {
    const s = getComputedStyle(document.documentElement);
    return {
      paper:  s.getPropertyValue('--chart-paper').trim(),
      plot:   s.getPropertyValue('--chart-plot').trim(),
      grid:   s.getPropertyValue('--chart-grid').trim(),
      line:   s.getPropertyValue('--chart-line').trim(),
      font:   s.getPropertyValue('--chart-font').trim(),
      cyan:   s.getPropertyValue('--accent-cyan').trim(),
      amber:  s.getPropertyValue('--accent-amber').trim(),
      red:    s.getPropertyValue('--accent-red').trim(),
      pywake: s.getPropertyValue('--accent-pywake').trim(),
      wrfF:   s.getPropertyValue('--accent-wrf-f').trim(),
      wrfG:   s.getPropertyValue('--accent-wrf-g').trim(),
    };
  }

  /**
   * @param {Array} b1610  [[ts, mwh], ...]
   * @param {Object} farm  farm info object
   * @param {Object} opts  { resolution }
   * @param {Array} boalf  BOALF events array
   * @param {Array} mels   [[ts, mw], ...] MELS data
   * @param {Date} startDate
   * @param {Date} endDate
   * @param {Object} modelData  { pywake, wrfFitch, wrfGhost, show* }
   */
  renderChart(b1610, farm, opts, boalf, mels, startDate, endDate, modelData) {
    const tc = this._getThemeColors();

    // Apply time resolution
    let plotB1610 = b1610;
    if (opts.resolution === '1h') {
      plotB1610 = aggregateToHourly(b1610, true);
    }

    const b1610X = plotB1610.map(r => r[0]);

    // If hourly: b1610 MWh was summed for 2 half-hours, so hourly MWh. MW = MWh/1h = MWh
    const mwMultiplier = opts.resolution === '1h' ? 1 : 2;
    const b1610Y_mw = plotB1610.map(r => r[1] * mwMultiplier);

    const traces = [];

    // B1610 area
    traces.push({
      x: b1610X, y: b1610Y_mw,
      type: 'scatter', mode: 'lines',
      name: 'B1610 Generation',
      line: { color: tc.cyan, width: 1.5 },
      fill: 'tozeroy',
      fillcolor: this._hexToRgba(tc.cyan, 0.08),
    });

    // TEC (always visible)
    if (farm.tec_mw && b1610X.length) {
      traces.push({
        x: [b1610X[0], b1610X[b1610X.length - 1]],
        y: [farm.tec_mw, farm.tec_mw],
        type: 'scatter', mode: 'lines',
        name: `TEC (${farm.tec_mw} MW)`,
        line: { color: tc.red, width: 1.5, dash: 'dash' },
      });
    }

    // MELS (togglable, with user-selectable color)
    if (opts.showMels && mels && mels.length > 0) {
      traces.push({
        x: mels.map(r => r[0]),
        y: mels.map(r => r[1]),
        type: 'scatter', mode: 'lines',
        name: 'MELS',
        line: { color: opts.melsColor || tc.amber, width: 1.2, dash: 'dashdot' },
      });
    }

    // Capacity
    if (b1610X.length) {
      traces.push({
        x: [b1610X[0], b1610X[b1610X.length - 1]],
        y: [farm.capacity_mw, farm.capacity_mw],
        type: 'scatter', mode: 'lines',
        name: `Capacity (${farm.capacity_mw} MW)`,
        line: { color: this._hexToRgba(tc.font, 0.3), width: 1, dash: 'dot' },
        showlegend: true
      });
    }

    // ── Model traces ──
    const md = modelData || {};
    const inRange = (ts) => { const d = new Date(ts); return d >= startDate && d <= endDate; };

    // PyWake
    if (md.showPyWake && md.pywake && md.pywake.data.length > 0) {
      const mi = md.pywakeModelIndex || 0;
      const modelName = md.pywake.models[mi] || 'PyWake';
      const filtered = md.pywake.data.filter(r => inRange(r[0]));
      traces.push({
        x: filtered.map(r => r[0]),
        y: filtered.map(r => r[1 + mi]),  // data[0]=ts, data[1..]=model values
        type: 'scatter', mode: 'lines',
        name: `PyWake ${modelName}`,
        line: { color: tc.pywake, width: 1.4 },
      });
    }

    // WRF Fitch
    if (md.showWrfFitch && md.wrfFitch && md.wrfFitch.length > 0) {
      const filtered = md.wrfFitch.filter(r => inRange(r[0]));
      traces.push({
        x: filtered.map(r => r[0]),
        y: filtered.map(r => r[1]),
        type: 'scatter', mode: 'lines',
        name: 'WRF Fitch',
        line: { color: tc.wrfF, width: 1.4 },
      });
    }

    // WRF Ghost
    if (md.showWrfGhost && md.wrfGhost && md.wrfGhost.length > 0) {
      const filtered = md.wrfGhost.filter(r => inRange(r[0]));
      traces.push({
        x: filtered.map(r => r[0]),
        y: filtered.map(r => r[1]),
        type: 'scatter', mode: 'lines',
        name: 'WRF Ghost',
        line: { color: tc.wrfG, width: 1.4 },
      });
    }

    const layout = {
      paper_bgcolor: tc.paper,
      plot_bgcolor:  tc.plot,
      font: { family: 'Inter, sans-serif', color: tc.font, size: 12 },
      margin: { t: 32, r: 24, b: 52, l: 62 },
      legend: {
        orientation: 'h', x: 0, y: 1.12,
        font: { size: 11, color: tc.font },
        bgcolor: 'rgba(0,0,0,0)',
      },
      xaxis: {
        type: 'date',
        gridcolor: tc.grid,
        linecolor: tc.line,
        tickfont: { size: 11 },
        rangeslider: { bgcolor: tc.plot, bordercolor: tc.line, thickness: 0.06 },
      },
      yaxis: {
        title: { text: 'Power (MW)', font: { size: 12, color: tc.font } },
        gridcolor: tc.grid,
        linecolor: tc.line,
        tickfont: { size: 11 },
        rangemode: 'tozero',
      },
      hovermode: 'x unified',
      hoverlabel: { bgcolor: tc.paper, bordercolor: tc.line, font: { family: 'Inter', size: 12, color: tc.font } }
    };

    const config = {
      responsive: true,
      displayModeBar: true,
      modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };

    Plotly.newPlot(this.chartId, traces, layout, config);

    // Render curtailment strip
    this._renderCurtailmentStrip(boalf, startDate, endDate, b1610X, tc);

    // Render daily scatter comparison
    this._renderDailyScatter(b1610, startDate, endDate, modelData, tc);
  }

  /** Render BOALF curtailment events as red marks in the strip below the chart */
  _renderCurtailmentStrip(boalf, startDate, endDate, b1610X, tc) {
    if (!b1610X || b1610X.length === 0) {
      Plotly.purge(this.curtailmentId);
      return;
    }

    // Filter BOALF to date range
    const filtered = (boalf || []).filter(r => {
      const d = new Date(r[0]);
      return d >= startDate && d <= endDate;
    });

    // Create marks for each BOALF event
    const shapes = [];
    for (const evt of filtered) {
      const from = evt[1]; // timeFrom
      const to = evt[2];   // timeTo
      if (from && to) {
        shapes.push({
          type: 'rect',
          xref: 'x', yref: 'paper',
          x0: from, x1: to,
          y0: 0, y1: 1,
          fillcolor: tc.red,
          opacity: 0.6,
          line: { width: 0 },
        });
      }
    }

    // Create an empty trace to establish the x-axis range
    const curtailTrace = {
      x: [b1610X[0], b1610X[b1610X.length - 1]],
      y: [0, 0],
      type: 'scatter',
      mode: 'lines',
      line: { width: 0 },
      showlegend: false,
      hoverinfo: 'skip',
    };

    const layout = {
      paper_bgcolor: tc.paper,
      plot_bgcolor: tc.plot,
      font: { family: 'Inter, sans-serif', size: 10, color: tc.font },
      margin: { t: 0, r: 24, b: 0, l: 62 },
      xaxis: {
        type: 'date',
        range: [b1610X[0], b1610X[b1610X.length - 1]],
        showticklabels: false,
        showgrid: false,
        zeroline: false,
        linecolor: tc.line,
      },
      yaxis: {
        showticklabels: false,
        showgrid: false,
        zeroline: false,
        range: [0, 1],
        fixedrange: true,
      },
      shapes: shapes,
      hovermode: false,
      height: 40,
    };

    Plotly.newPlot(this.curtailmentId, [curtailTrace], layout, {
      responsive: true,
      displayModeBar: false,
      staticPlot: true,
    });

    // Sync x-axis zoom from main chart to curtailment strip
    const mainChart = document.getElementById(this.chartId);
    const curtChart = this.curtailmentId;
    if (mainChart) {
      mainChart.on('plotly_relayout', (eventData) => {
        const update = {};
        if (eventData['xaxis.range[0]'] && eventData['xaxis.range[1]']) {
          update['xaxis.range'] = [eventData['xaxis.range[0]'], eventData['xaxis.range[1]']];
          Plotly.relayout(curtChart, update);
        }
        if (eventData['xaxis.range']) {
          update['xaxis.range'] = eventData['xaxis.range'];
          Plotly.relayout(curtChart, update);
        }
        if (eventData['xaxis.autorange']) {
          Plotly.relayout(curtChart, { 'xaxis.autorange': true });
        }
      });
    }
  }

  /** Render daily + weekly scatter comparison with R², Bias, RMSE */
  _renderDailyScatter(b1610, startDate, endDate, modelData, tc) {
    const section = document.getElementById(this.scatterSectionId);
    const md = modelData || {};

    // Build list of active model sources
    const sources = [];
    if (md.showPyWake && md.pywake && md.pywake.data.length > 0) {
      const mi = md.pywakeModelIndex || 0;
      sources.push({
        label: 'PyWake ' + (md.pywake.models[mi] || ''),
        series: md.pywake.data.map(r => ({ ts: r[0], mw: r[1 + mi] || 0 })),
        color: tc.pywake,
      });
    }
    if (md.showWrfFitch && md.wrfFitch && md.wrfFitch.length > 0) {
      sources.push({ label: 'WRF Fitch', series: md.wrfFitch.map(r => ({ ts: r[0], mw: r[1] || 0 })), color: tc.wrfF });
    }
    if (md.showWrfGhost && md.wrfGhost && md.wrfGhost.length > 0) {
      sources.push({ label: 'WRF Ghost', series: md.wrfGhost.map(r => ({ ts: r[0], mw: r[1] || 0 })), color: tc.wrfG });
    }

    if (sources.length === 0 || b1610.length === 0) {
      section.style.display = 'none';
      Plotly.purge('scatter-daily');
      Plotly.purge('scatter-weekly');
      document.getElementById('scatter-metrics').innerHTML = '';
      return;
    }
    section.style.display = '';

    const inRange = (ts) => { const d = new Date(ts); return d >= startDate && d <= endDate; };

    // Helper: compute stats
    const computeStats = (xArr, yArr) => {
      const n = xArr.length;
      if (n < 2) return { r2: NaN, bias: NaN, rmse: NaN };
      const mx = xArr.reduce((s, v) => s + v, 0) / n;
      const my = yArr.reduce((s, v) => s + v, 0) / n;
      let ssRes = 0, ssTot = 0, sumErr = 0, sumErr2 = 0;
      for (let i = 0; i < n; i++) {
        const err = yArr[i] - xArr[i];
        sumErr += err;
        sumErr2 += err * err;
        ssRes += (yArr[i] - xArr[i]) ** 2;
        ssTot += (xArr[i] - mx) ** 2;
      }
      return {
        r2: ssTot > 0 ? 1 - ssRes / ssTot : NaN,
        bias: sumErr / n,
        rmse: Math.sqrt(sumErr2 / n),
      };
    };

    // Helper: get ISO week key
    const weekKey = (dateStr) => {
      const d = new Date(dateStr + 'T12:00:00');
      const jan4 = new Date(d.getFullYear(), 0, 4);
      const dayOfYear = Math.ceil((d - new Date(d.getFullYear(), 0, 1)) / 86400000);
      const weekNum = Math.ceil((dayOfYear + jan4.getDay()) / 7);
      return d.getFullYear() + '-W' + String(weekNum).padStart(2, '0');
    };

    // Elexon daily
    const elexonDaily = {};
    for (const r of b1610) {
      if (!inRange(r[0])) continue;
      const day = r[0].slice(0, 10);
      elexonDaily[day] = (elexonDaily[day] || 0) + r[1];
    }

    // Build per-source data for daily & weekly
    const allMetrics = [];

    const buildScatterPlot = (containerId, title, xLabel, yLabel, sourcesData) => {
      const traces = [];
      let globalMax = 0;
      const annotations = [];

      for (const sd of sourcesData) {
        if (sd.x.length > 0) {
          globalMax = Math.max(globalMax, ...sd.x, ...sd.y);
          traces.push({
            x: sd.x, y: sd.y,
            type: 'scatter', mode: 'markers',
            name: sd.label,
            text: sd.hover, hoverinfo: 'text',
            marker: { color: sd.color, size: 5, opacity: 0.7 },
          });
        }
      }

      if (traces.length === 0) { Plotly.purge(containerId); return; }

      const maxVal = globalMax * 1.05;
      traces.push({
        x: [0, maxVal], y: [0, maxVal],
        type: 'scatter', mode: 'lines', name: '1:1',
        line: { color: tc.font, width: 1, dash: 'dot' },
        hoverinfo: 'skip', showlegend: true,
      });

      // R² annotations
      let annotY = 0.97;
      for (const sd of sourcesData) {
        if (sd.stats && !isNaN(sd.stats.r2)) {
          annotations.push({
            x: 0.03, y: annotY, xref: 'paper', yref: 'paper',
            text: `<b>${sd.label}</b>: R²=${sd.stats.r2.toFixed(3)}`,
            showarrow: false, font: { size: 10, color: sd.color },
            xanchor: 'left',
          });
          annotY -= 0.07;
        }
      }

      const layout = {
        paper_bgcolor: tc.paper, plot_bgcolor: tc.plot,
        font: { family: 'Inter, sans-serif', color: tc.font, size: 11 },
        margin: { t: 36, r: 16, b: 52, l: 56 },
        title: { text: title, font: { size: 13 } },
        xaxis: {
          title: { text: xLabel, font: { size: 10 } },
          gridcolor: tc.grid, linecolor: tc.line,
          range: [0, maxVal],
        },
        yaxis: {
          title: { text: yLabel, font: { size: 10 } },
          gridcolor: tc.grid, linecolor: tc.line,
          range: [0, maxVal],
          scaleanchor: 'x', scaleratio: 1,
        },
        height: 340,
        showlegend: true,
        legend: { x: 0.98, y: 0.02, xanchor: 'right', yanchor: 'bottom', bgcolor: 'rgba(0,0,0,0)', font: { size: 10 } },
        hovermode: 'closest',
        annotations: annotations,
      };

      Plotly.newPlot(containerId, traces, layout, { responsive: true, displayModeBar: false });
    };

    // Process each source
    const dailyData = [];
    const weeklyData = [];

    for (const src of sources) {
      // Daily model
      const modelDaily = {};
      for (const r of src.series) {
        if (!inRange(r.ts)) continue;
        const day = r.ts.slice(0, 10);
        modelDaily[day] = (modelDaily[day] || 0) + r.mw * (10 / 60);
      }

      // Daily matched pairs
      const dDays = Object.keys(elexonDaily).filter(d => d in modelDaily).sort();
      const dX = dDays.map(d => elexonDaily[d] / 1000);
      const dY = dDays.map(d => modelDaily[d] / 1000);
      const dHover = dDays.map((d, i) => d + '<br>Elexon: ' + dX[i].toFixed(2) + '<br>' + src.label + ': ' + dY[i].toFixed(2) + ' GWh');
      const dStats = computeStats(dX, dY);

      dailyData.push({ label: src.label, color: src.color, x: dX, y: dY, hover: dHover, stats: dStats });

      // Weekly: aggregate daily to weekly
      const elexonWeekly = {}, modelWeekly = {};
      for (const d of dDays) {
        const wk = weekKey(d);
        elexonWeekly[wk] = (elexonWeekly[wk] || 0) + elexonDaily[d] / 1000;
        modelWeekly[wk] = (modelWeekly[wk] || 0) + modelDaily[d] / 1000;
      }
      const wks = Object.keys(elexonWeekly).sort();
      const wX = wks.map(w => elexonWeekly[w]);
      const wY = wks.map(w => modelWeekly[w]);
      const wHover = wks.map((w, i) => w + '<br>Elexon: ' + wX[i].toFixed(2) + '<br>' + src.label + ': ' + wY[i].toFixed(2) + ' GWh');
      const wStats = computeStats(wX, wY);

      weeklyData.push({ label: src.label, color: src.color, x: wX, y: wY, hover: wHover, stats: wStats });

      allMetrics.push({ label: src.label, color: src.color, daily: dStats, weekly: wStats });
    }

    // Render both plots
    buildScatterPlot('scatter-daily', 'Daily Production', 'Elexon B1610 (GWh/day)', 'Model (GWh/day)', dailyData);
    buildScatterPlot('scatter-weekly', 'Weekly Production', 'Elexon B1610 (GWh/week)', 'Model (GWh/week)', weeklyData);

    // Render metrics table
    const fmt = (v, d = 3) => isNaN(v) ? '—' : v.toFixed(d);
    let metricsHtml = '';
    for (const m of allMetrics) {
      metricsHtml += `<div class="metrics-block">
        <div class="metrics-block-title"><span class="dot" style="background:${m.color}"></span>${m.label}</div>
        <table class="metrics-table">
          <tr><th></th><th style="text-align:right">Daily</th><th style="text-align:right">Weekly</th></tr>
          <tr><th>R²</th><td>${fmt(m.daily.r2)}</td><td>${fmt(m.weekly.r2)}</td></tr>
          <tr><th>Bias (GWh)</th><td>${fmt(m.daily.bias)}</td><td>${fmt(m.weekly.bias)}</td></tr>
          <tr><th>RMSE (GWh)</th><td>${fmt(m.daily.rmse)}</td><td>${fmt(m.weekly.rmse)}</td></tr>
        </table>
      </div>`;
    }
    document.getElementById('scatter-metrics').innerHTML = metricsHtml;
  }

  updateVisibility(opts) {
    const el = document.getElementById(this.chartId);
    if (!el || !el.data) return;

    const vis = el.data.map(() => true);
    Plotly.restyle(this.chartId, { visible: vis });
  }

  /** Re-render chart with current theme */
  updateTheme() {
    const tc = this._getThemeColors();
    const chartEl = document.getElementById(this.chartId);
    if (!chartEl || !chartEl.data) return;

    Plotly.relayout(this.chartId, {
      paper_bgcolor: tc.paper,
      plot_bgcolor: tc.plot,
      'font.color': tc.font,
      'xaxis.gridcolor': tc.grid,
      'xaxis.linecolor': tc.line,
      'xaxis.rangeslider.bgcolor': tc.plot,
      'xaxis.rangeslider.bordercolor': tc.line,
      'yaxis.gridcolor': tc.grid,
      'yaxis.linecolor': tc.line,
      'yaxis.title.font.color': tc.font,
      'legend.font.color': tc.font,
      'hoverlabel.bgcolor': tc.paper,
      'hoverlabel.bordercolor': tc.line,
      'hoverlabel.font.color': tc.font,
    });

    // Update curtailment strip theme
    const curtEl = document.getElementById(this.curtailmentId);
    if (curtEl && curtEl.data) {
      Plotly.relayout(this.curtailmentId, {
        paper_bgcolor: tc.paper,
        plot_bgcolor: tc.plot,
        'xaxis.linecolor': tc.line,
      });
    }
  }

  _hexToRgba(hex, alpha) {
    // Handle already-rgb values
    if (hex.startsWith('rgb')) {
      return hex.replace('rgb', 'rgba').replace(')', `,${alpha})`);
    }
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}

// ─────────────────────────────────────────────
//  UIController – orchestration & DOM
// ─────────────────────────────────────────────
class UIController {
  constructor() {
    this.data  = new DataManager();
    this.chart = new ChartManager('chart-container', 'curtailment-indicator', 'scatter-section');
    this.activeFarmId = null;
    this._currentB1610 = [];
    this._currentBoalf = [];
    this._currentMels  = [];
    this._currentFarm  = null;
    this._resolution = '30min'; // '30min' or '1h'
    this._startDate = null;
    this._endDate = null;
    // Model data state
    this._pywakeData = null;    // { models: [...], data: [...] }
    this._wrfFitchData = null;  // [[ts, mw], ...]
    this._wrfGhostData = null;  // [[ts, mw], ...]
  }

  /* ---- Bootstrap ---- */
  async init() {
    try {
      // Restore theme preference
      const savedTheme = localStorage.getItem('dorel-theme') || 'dark';
      document.documentElement.setAttribute('data-theme', savedTheme);
      this._updateThemeIcon(savedTheme);

      const farms = await this.data.loadFarms();
      this.renderFarmList(farms);
      this._bindEvents();

      // Select first farm
      if (farms.length) {
        this.onFarmSelected(farms[0].id);
      }
    } catch (err) {
      this._showError('Failed to load farm list. Check data/farms.json.');
      console.error(err);
      this.hideLoading();
    }
  }

  /* ---- Farm list ---- */
  renderFarmList(farms) {
    const ul = document.getElementById('farm-list');
    ul.innerHTML = '';
    farms.forEach(f => {
      const li = document.createElement('li');
      li.className = 'farm-item';
      li.dataset.farmId = f.id;
      li.innerHTML = `
        <span class="farm-name">${f.name.replace(/_/g, ' ')}</span>
        <span class="farm-meta">
          <span class="farm-capacity">${f.capacity_mw} MW</span>
          <span class="farm-year">${f.commissioned || ''}</span>
        </span>`;
      li.addEventListener('click', () => this.onFarmSelected(f.id));
      ul.appendChild(li);
    });
  }

  _highlightFarm(farmId) {
    document.querySelectorAll('.farm-item').forEach(el => {
      el.classList.toggle('active', el.dataset.farmId === farmId);
    });
  }

  /* ---- Event binding ---- */
  _bindEvents() {
    // Search
    document.getElementById('farm-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.farm-item').forEach(el => {
        const name = el.querySelector('.farm-name').textContent.toLowerCase();
        el.style.display = name.includes(q) ? '' : 'none';
      });
    });

    // Date range (debounced – browsers fire 'change' on each segment edit)
    this._dateDebounceTimer = null;
    const debouncedDateChange = () => {
      clearTimeout(this._dateDebounceTimer);
      this._dateDebounceTimer = setTimeout(() => this.onDateRangeChanged(), 800);
    };
    document.getElementById('date-from').addEventListener('change', debouncedDateChange);
    document.getElementById('date-to').addEventListener('change', debouncedDateChange);

    // Download
    document.getElementById('btn-download').addEventListener('click', () => this.downloadCSV());

    // Time resolution
    document.getElementById('res-30min').addEventListener('click', () => this._setResolution('30min'));
    document.getElementById('res-1h').addEventListener('click', () => this._setResolution('1h'));

    // Theme toggle
    document.getElementById('btn-theme-toggle').addEventListener('click', () => this._toggleTheme());

    // Model toggles
    document.getElementById('toggle-pywake').addEventListener('change', () => this._onModelToggleChanged());
    document.getElementById('toggle-wrf-fitch').addEventListener('change', () => this._onModelToggleChanged());
    document.getElementById('toggle-wrf-ghost').addEventListener('change', () => this._onModelToggleChanged());

    // PyWake scenario change
    document.getElementById('sel-pywake-scenario').addEventListener('change', () => this._onPyWakeScenarioChanged());
    // PyWake model change
    document.getElementById('sel-pywake-model').addEventListener('change', () => this._onModelToggleChanged());

    // MELS toggle + color picker
    document.getElementById('toggle-mels').addEventListener('change', () => this._reRender());
    document.getElementById('mels-color').addEventListener('input', () => this._reRender());
  }

  /* ---- Time resolution ---- */
  _setResolution(res) {
    if (this._resolution === res) return;
    this._resolution = res;
    document.getElementById('res-30min').classList.toggle('active', res === '30min');
    document.getElementById('res-1h').classList.toggle('active', res === '1h');
    // Re-render with current data
    if (this._currentFarm && this._currentB1610.length) {
      this._reRender();
    }
  }

  /* ---- Theme toggle ---- */
  _toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('dorel-theme', next);
    this._updateThemeIcon(next);
    // Update Plotly chart colors
    setTimeout(() => this.chart.updateTheme(), 50);
  }

  _updateThemeIcon(theme) {
    const btn = document.getElementById('btn-theme-toggle');
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }

  /* ---- Farm selected ---- */
  async onFarmSelected(farmId) {
    if (this.activeFarmId === farmId) return;
    this.activeFarmId = farmId;
    this._highlightFarm(farmId);
    this.showLoading();

    const farm = this.data.farms.find(f => f.id === farmId);
    this._currentFarm = farm;

    // Update model controls for this farm
    this._updateModelControls(farm);

    // Default date range: 1 Jan 2023 – 30 Mar 2023
    let startDate = new Date(2023, 0, 1);   // Jan 1
    let endDate   = new Date(2023, 2, 30, 23, 59, 59); // Mar 30

    document.getElementById('date-from').value = this._toDateStr(startDate);
    document.getElementById('date-to').value   = this._toDateStr(endDate);

    await this._loadAndRender(farm, startDate, endDate);
  }

  /* ---- Date range changed ---- */
  async onDateRangeChanged() {
    if (!this._currentFarm) return;
    const start = new Date(document.getElementById('date-from').value);
    const end   = new Date(document.getElementById('date-to').value + 'T23:59:59');
    if (isNaN(start) || isNaN(end) || start > end) return;
    this.showLoading();
    await this._loadAndRender(this._currentFarm, start, end);
  }

  /* ---- Load & render (core) ---- */
  async _loadAndRender(farm, startDate, endDate) {
    try {
      // Base data
      const [result, boalf] = await Promise.all([
        this.data.loadFarmData(farm.id, startDate, endDate),
        this.data.loadBoalf(farm.id)
      ]);

      this._currentB1610 = result.b1610;
      this._currentBoalf = boalf;
      this._currentMels  = result.mels || [];
      this._startDate = startDate;
      this._endDate = endDate;

      // Load model data in parallel
      const modelFetches = [];

      // PyWake
      if (farm.pywake) {
        const scenario = document.getElementById('sel-pywake-scenario').value || 'standalone';
        modelFetches.push(
          this.data.loadPyWake(farm.id, scenario).then(d => { this._pywakeData = d; })
        );
      } else {
        this._pywakeData = null;
      }

      // WRF Fitch
      if (farm.wrf && farm.wrf.variants.includes('fitch')) {
        modelFetches.push(
          this.data.loadWRF(farm.id, 'fitch').then(d => { this._wrfFitchData = d; })
        );
      } else {
        this._wrfFitchData = null;
      }

      // WRF Ghost
      if (farm.wrf && farm.wrf.variants.includes('ghost')) {
        modelFetches.push(
          this.data.loadWRF(farm.id, 'ghost').then(d => { this._wrfGhostData = d; })
        );
      } else {
        this._wrfGhostData = null;
      }

      await Promise.all(modelFetches);

      const opts = this._getToggleOpts();
      this.chart.renderChart(result.b1610, farm, opts, boalf, this._currentMels, startDate, endDate, this._buildModelData());
      this.updateStats(result.b1610, farm, startDate, endDate);
    } catch (err) {
      this._showError('Error loading data for ' + farm.name.replace(/_/g, ' '));
      console.error(err);
    } finally {
      this.hideLoading();
    }
  }

  /* ---- Re-render chart with current data (model toggle / option changed) ---- */
  _reRender() {
    if (!this._currentFarm || !this._currentB1610.length) return;
    const opts = this._getToggleOpts();
    this.chart.renderChart(
      this._currentB1610, this._currentFarm, opts,
      this._currentBoalf, this._currentMels, this._startDate, this._endDate,
      this._buildModelData()
    );
  }

  /* ---- Build model data object for ChartManager ---- */
  _buildModelData() {
    const modelSelect = document.getElementById('sel-pywake-model');
    const mi = modelSelect ? parseInt(modelSelect.value) || 0 : 0;
    const pwData = this._pywakeData;
    console.log(`[DOREL] _buildModelData: showPyWake=${document.getElementById('toggle-pywake').checked}, modelIndex=${mi}, modelDropdownVal="${modelSelect?.value}", pywakeData=${pwData ? pwData.data?.length + ' rows' : 'null'}`);
    return {
      showPyWake:   document.getElementById('toggle-pywake').checked,
      showWrfFitch: document.getElementById('toggle-wrf-fitch').checked,
      showWrfGhost: document.getElementById('toggle-wrf-ghost').checked,
      pywake:       pwData,
      pywakeModelIndex: mi,
      wrfFitch:     this._wrfFitchData,
      wrfGhost:     this._wrfGhostData,
    };
  }

  /* ---- PyWake scenario changed — reload data ---- */
  async _onPyWakeScenarioChanged() {
    if (!this._currentFarm || !this._currentFarm.pywake) return;
    const scenario = document.getElementById('sel-pywake-scenario').value;
    // Clear cache for old scenario so it re-fetches
    const cacheKey = `pywake_${scenario}`;
    if (this.data._cache[this._currentFarm.id]) {
      delete this.data._cache[this._currentFarm.id][cacheKey];
    }
    this._pywakeData = await this.data.loadPyWake(this._currentFarm.id, scenario);
    // Update model dropdown from loaded data
    if (this._pywakeData && this._pywakeData.models) {
      const pwModel = document.getElementById('sel-pywake-model');
      const prevVal = pwModel.value;
      pwModel.innerHTML = '';
      this._pywakeData.models.forEach((m, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = m;
        if (m === 'ASO') opt.selected = true;
        pwModel.appendChild(opt);
      });
    }
    this._onModelToggleChanged();
  }

  /* ---- Update model controls for selected farm ---- */
  _updateModelControls(farm) {
    const controlsEl = document.getElementById('model-controls');
    const indicatorsEl = document.getElementById('model-indicators');
    const hasPW = !!farm.pywake;
    const hasWRF = !!farm.wrf;
    const hasAny = hasPW || hasWRF;

    // Show/hide model controls bar
    controlsEl.style.display = hasAny ? '' : 'none';

    // PyWake controls
    const pwToggle = document.getElementById('toggle-pywake');
    const pwScenario = document.getElementById('sel-pywake-scenario');
    const pwModel = document.getElementById('sel-pywake-model');

    pwToggle.disabled = !hasPW;
    pwScenario.disabled = !hasPW;
    pwModel.disabled = !hasPW;

    if (!hasPW) {
      pwToggle.checked = false;
    }

    // Populate scenario dropdown
    if (hasPW) {
      pwScenario.innerHTML = '';
      for (const s of farm.pywake.scenarios) {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s.charAt(0).toUpperCase() + s.slice(1);
        pwScenario.appendChild(opt);
      }

      // Populate model dropdown
      pwModel.innerHTML = '';
      const models = farm.pywake.models || [];
      console.log(`[DOREL] Populating model dropdown: ${models.length} models:`, models);
      models.forEach((m, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = m;
        // Default to ASO
        if (m === 'ASO') opt.selected = true;
        pwModel.appendChild(opt);
      });
      console.log(`[DOREL] Model dropdown value after populate: "${pwModel.value}" (${pwModel.options.length} options)`);
    }

    // WRF toggles
    const wrfFitchToggle = document.getElementById('toggle-wrf-fitch');
    const wrfGhostToggle = document.getElementById('toggle-wrf-ghost');

    const hasFitch = hasWRF && farm.wrf.variants.includes('fitch');
    const hasGhost = hasWRF && farm.wrf.variants.includes('ghost');

    wrfFitchToggle.disabled = !hasFitch;
    wrfGhostToggle.disabled = !hasGhost;
    if (!hasFitch) wrfFitchToggle.checked = false;
    if (!hasGhost) wrfGhostToggle.checked = false;

    // Update sidebar indicators
    let indHtml = '';
    if (hasPW) {
      indHtml += '<div class="model-ind-row"><span class="model-dot pywake"></span>PyWake (2023)</div>';
    }
    if (hasFitch) {
      indHtml += '<div class="model-ind-row"><span class="model-dot wrf-fitch"></span>WRF Fitch (2023)</div>';
    }
    if (hasGhost) {
      indHtml += '<div class="model-ind-row"><span class="model-dot wrf-ghost"></span>WRF Ghost (2023)</div>';
    }
    if (!hasAny) {
      indHtml = '<div class="model-ind-row"><span class="model-dot none"></span>No model data</div>';
    }
    indicatorsEl.innerHTML = indHtml;
  }

  /* ---- Toggle changed ---- */
  onToggleChanged() {
    this.chart.updateVisibility(this._getToggleOpts());
  }

  _getToggleOpts() {
    return {
      resolution: this._resolution,
      showMels: document.getElementById('toggle-mels').checked,
      melsColor: document.getElementById('mels-color').value,
    };
  }

  /* ---- Stats ---- */
  updateStats(b1610, farm, startDate, endDate) {
    const totalMWh = b1610.reduce((s, r) => s + r[1], 0);
    const totalGWh = totalMWh / 1000;

    // Hours in range
    const msRange = endDate - startDate;
    const hoursRange = msRange / (1000 * 60 * 60);
    const cf = hoursRange > 0 ? (totalMWh / (farm.capacity_mw * hoursRange)) * 100 : 0;

    // Curtailment events (BOALF rows in range)
    const boalfInRange = (this._currentBoalf || []).filter(r => {
      const d = new Date(r[0]);
      return d >= startDate && d <= endDate;
    });

    const peakMW = b1610.length ? Math.max(...b1610.map(r => r[1] * 2)) : 0;

    this._animateStat('stat-generation', totalGWh, 1, 'GWh');
    this._animateStat('stat-cf', cf, 1, '%');
    this._animateStat('stat-curtailment', boalfInRange.length, 0, '');
    this._animateStat('stat-peak', peakMW, 0, 'MW');

    // Update model KPIs
    this._updateModelStats(farm, startDate, endDate, hoursRange);
  }

  /* ---- Model KPI stats ---- */
  _updateModelStats(farm, startDate, endDate, hoursRange) {
    const md = this._buildModelData();
    const inRange = (ts) => { const d = new Date(ts); return d >= startDate && d <= endDate; };
    const statsRow = document.getElementById('model-stats-row');
    let showRow = false;

    // PyWake
    if (md.showPyWake && md.pywake && md.pywake.data.length > 0) {
      const mi = md.pywakeModelIndex || 0;
      const filtered = md.pywake.data.filter(r => inRange(r[0]));
      // PyWake data is 10-min resolution; each value is MW => MWh = MW * (10/60)
      const pwMWh = filtered.reduce((s, r) => s + (r[1 + mi] || 0) * (10 / 60), 0);
      const pwGWh = pwMWh / 1000;
      const pwCF = hoursRange > 0 ? (pwMWh / (farm.capacity_mw * hoursRange)) * 100 : 0;
      this._animateStat('stat-pywake-gen', pwGWh, 1, 'GWh');
      this._animateStat('stat-pywake-cf', pwCF, 1, '%');
      showRow = true;
    } else {
      document.getElementById('stat-pywake-gen').innerHTML = '--<span class="stat-unit">GWh</span>';
      document.getElementById('stat-pywake-cf').innerHTML = '--<span class="stat-unit">%</span>';
    }

    // WRF Fitch
    if (md.showWrfFitch && md.wrfFitch && md.wrfFitch.length > 0) {
      const filtered = md.wrfFitch.filter(r => inRange(r[0]));
      // WRF data is 10-min resolution; MW => MWh = MW * (10/60)
      const wrfMWh = filtered.reduce((s, r) => s + (r[1] || 0) * (10 / 60), 0);
      const wrfGWh = wrfMWh / 1000;
      this._animateStat('stat-wrf-fitch-gen', wrfGWh, 1, 'GWh');
      showRow = true;
    } else {
      document.getElementById('stat-wrf-fitch-gen').innerHTML = '--<span class="stat-unit">GWh</span>';
    }

    // WRF Ghost
    if (md.showWrfGhost && md.wrfGhost && md.wrfGhost.length > 0) {
      const filtered = md.wrfGhost.filter(r => inRange(r[0]));
      const wrfMWh = filtered.reduce((s, r) => s + (r[1] || 0) * (10 / 60), 0);
      const wrfGWh = wrfMWh / 1000;
      this._animateStat('stat-wrf-ghost-gen', wrfGWh, 1, 'GWh');
      showRow = true;
    } else {
      document.getElementById('stat-wrf-ghost-gen').innerHTML = '--<span class="stat-unit">GWh</span>';
    }

    statsRow.style.display = showRow ? '' : 'none';
  }

  /* ---- Model toggle changed (re-render + update KPIs) ---- */
  async _onModelToggleChanged() {
    if (!this._currentFarm) return;
    const farm = this._currentFarm;

    // Ensure model data is loaded when toggled on
    const pwChecked = document.getElementById('toggle-pywake').checked;
    const wrfFChecked = document.getElementById('toggle-wrf-fitch').checked;
    const wrfGChecked = document.getElementById('toggle-wrf-ghost').checked;

    const reloads = [];

    if (pwChecked && farm.pywake && (!this._pywakeData || this._pywakeData.data.length === 0)) {
      const scenario = document.getElementById('sel-pywake-scenario').value || 'standalone';
      // Clear stale empty cache so it re-fetches
      const key = `pywake_${scenario}`;
      if (this.data._cache[farm.id] && this.data._cache[farm.id][key] && this.data._cache[farm.id][key].data.length === 0) {
        delete this.data._cache[farm.id][key];
      }
      reloads.push(this.data.loadPyWake(farm.id, scenario).then(d => { this._pywakeData = d; }));
    }
    if (wrfFChecked && farm.wrf && farm.wrf.variants.includes('fitch') && (!this._wrfFitchData || this._wrfFitchData.length === 0)) {
      const key = 'wrf_fitch';
      if (this.data._cache[farm.id] && this.data._cache[farm.id][key] && this.data._cache[farm.id][key].length === 0) {
        delete this.data._cache[farm.id][key];
      }
      reloads.push(this.data.loadWRF(farm.id, 'fitch').then(d => { this._wrfFitchData = d; }));
    }
    if (wrfGChecked && farm.wrf && farm.wrf.variants.includes('ghost') && (!this._wrfGhostData || this._wrfGhostData.length === 0)) {
      const key = 'wrf_ghost';
      if (this.data._cache[farm.id] && this.data._cache[farm.id][key] && this.data._cache[farm.id][key].length === 0) {
        delete this.data._cache[farm.id][key];
      }
      reloads.push(this.data.loadWRF(farm.id, 'ghost').then(d => { this._wrfGhostData = d; }));
    }

    if (reloads.length > 0) {
      await Promise.all(reloads);
    }

    this._reRender();
    if (this._startDate && this._endDate) {
      const msRange = this._endDate - this._startDate;
      const hoursRange = msRange / (1000 * 60 * 60);
      this._updateModelStats(farm, this._startDate, this._endDate, hoursRange);
    }
  }

  _animateStat(elId, target, decimals, unit) {
    const el = document.getElementById(elId);
    const unitSpan = unit ? `<span class="stat-unit">${unit}</span>` : '';
    const duration = 600;
    const steps = 30;
    const interval = duration / steps;
    let step = 0;

    const tick = () => {
      step++;
      const t = step / steps;
      const eased = 1 - Math.pow(1 - t, 3);
      const current = target * eased;

      const formatted = current.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      });
      el.innerHTML = `${formatted}${unitSpan}`;

      if (step < steps) {
        requestAnimationFrame(() => setTimeout(tick, interval));
      }
    };

    tick();
  }

  /* ---- CSV download ---- */
  downloadCSV() {
    if (!this._currentB1610.length) {
      this._showError('No data to export.');
      return;
    }

    // Only timestamp and b1610_mwh — format as "YYYY-MM-DD HH:MM:SS"
    const fmtTs = (iso) => iso.replace('T', ' ');
    const rows = this._currentB1610
      .slice()
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(r => `${fmtTs(r[0])},${r[1]}`);

    const csv = 'timestamp,b1610_mwh\n' + rows.join('\n');

    // Filename includes farm name and date range: FarmId_YYYYMMDD_YYYYMMDD.csv
    const fromStr = document.getElementById('date-from').value.replace(/-/g, '');
    const toStr   = document.getElementById('date-to').value.replace(/-/g, '');
    const filename = `${this.activeFarmId || 'export'}_${fromStr}_${toStr}.csv`;

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ---- Loading state ---- */
  showLoading() {
    document.getElementById('loading-overlay').classList.remove('hidden');
  }
  hideLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
  }

  /* ---- Error toast ---- */
  _showError(msg) {
    const el = document.getElementById('error-toast');
    el.textContent = msg;
    el.classList.add('visible');
    setTimeout(() => el.classList.remove('visible'), 5000);
  }

  /* ---- Helpers ---- */
  _toDateStr(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const app = new UIController();
  app.init();
});
