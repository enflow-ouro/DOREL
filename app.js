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

    if (!this._cache[farmId]) this._cache[farmId] = { b1610: {}, pn: {}, boalf: null };

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
    }
    await Promise.all(fetches);

    // Merge & filter
    const b1610All = neededYears.flatMap(y => this._cache[farmId].b1610[y] || []);
    const pnAll    = neededYears.flatMap(y => this._cache[farmId].pn[y] || []);

    const inRange = (ts) => {
      const d = new Date(ts);
      return d >= startDate && d <= endDate;
    };

    return {
      b1610: b1610All.filter(r => inRange(r[0])),
      pn:    pnAll.filter(r => inRange(r[0]))
    };
  }

  /* ---- BOALF ---- */
  async loadBoalf(farmId) {
    if (!this._cache[farmId]) this._cache[farmId] = { b1610: {}, pn: {}, boalf: null };
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
  constructor(chartId, curtailmentId) {
    this.chartId = chartId;
    this.curtailmentId = curtailmentId;
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
    };
  }

  /**
   * @param {Array} b1610  [[ts, mwh], …]
   * @param {Object} farm  farm info object
   * @param {Object} opts  { showB1610, resolution }
   * @param {Array} boalf  BOALF events array
   * @param {Date} startDate
   * @param {Date} endDate
   */
  renderChart(b1610, farm, opts, boalf, startDate, endDate) {
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
    this.chart = new ChartManager('chart-container', 'curtailment-indicator');
    this.activeFarmId = null;
    this._currentB1610 = [];
    this._currentBoalf = [];
    this._currentFarm  = null;
    this._resolution = '30min'; // '30min' or '1h'
    this._startDate = null;
    this._endDate = null;
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

    // Date range
    document.getElementById('date-from').addEventListener('change', () => this.onDateRangeChanged());
    document.getElementById('date-to').addEventListener('change', () => this.onDateRangeChanged());

    // Download
    document.getElementById('btn-download').addEventListener('click', () => this.downloadCSV());

    // Time resolution
    document.getElementById('res-30min').addEventListener('click', () => this._setResolution('30min'));
    document.getElementById('res-1h').addEventListener('click', () => this._setResolution('1h'));

    // Theme toggle
    document.getElementById('btn-theme-toggle').addEventListener('click', () => this._toggleTheme());
  }

  /* ---- Time resolution ---- */
  _setResolution(res) {
    if (this._resolution === res) return;
    this._resolution = res;
    document.getElementById('res-30min').classList.toggle('active', res === '30min');
    document.getElementById('res-1h').classList.toggle('active', res === '1h');
    // Re-render with current data
    if (this._currentFarm && this._currentB1610.length) {
      const opts = this._getToggleOpts();
      this.chart.renderChart(
        this._currentB1610, this._currentFarm, opts,
        this._currentBoalf, this._startDate, this._endDate
      );
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

    // Determine date range from available years
    const maxYear = Math.max(...farm.years);

    // Default: end = Dec 31 of max year (or today if current year), start = end - 30d
    const now = new Date();
    let endDate = (maxYear >= now.getFullYear()) ? now : new Date(maxYear, 11, 31, 23, 59, 59);
    let startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 30);

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
      const [result, boalf] = await Promise.all([
        this.data.loadFarmData(farm.id, startDate, endDate),
        this.data.loadBoalf(farm.id)
      ]);

      this._currentB1610 = result.b1610;
      this._currentBoalf = boalf;
      this._startDate = startDate;
      this._endDate = endDate;

      const opts = this._getToggleOpts();
      this.chart.renderChart(result.b1610, farm, opts, boalf, startDate, endDate);
      this.updateStats(result.b1610, farm, startDate, endDate);
    } catch (err) {
      this._showError('Error loading data for ' + farm.name.replace(/_/g, ' '));
      console.error(err);
    } finally {
      this.hideLoading();
    }
  }

  /* ---- Toggle changed ---- */
  onToggleChanged() {
    this.chart.updateVisibility(this._getToggleOpts());
  }

  _getToggleOpts() {
    return {
      resolution: this._resolution,
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

    // Only timestamp and b1610_mwh
    const rows = this._currentB1610
      .slice()
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(r => `${r[0]},${r[1]}`);

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
    return d.toISOString().slice(0, 10);
  }
}

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const app = new UIController();
  app.init();
});
