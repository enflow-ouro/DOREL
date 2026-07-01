# DOREL — UK Offshore Wind Farm Dashboard

[![GitHub Pages](https://img.shields.io/badge/Live-Dashboard-00d4ff?style=for-the-badge&logo=github)](https://enflow-ouro.github.io/DOREL/)

An interactive dashboard for visualising Elexon electricity market data across **32 UK offshore wind farms** (2020–2025). Built as a static site for GitHub Pages — no server required.

## Features

- 📊 **Half-hourly generation data** (B1610 metered output) plotted as interactive time series
- ⚡ **Physical Notifications** (PN) overlay showing planned generation vs actual
- 🔴 **TEC limit** (Transmission Entry Capacity) displayed as reference line
- 🟡 **Curtailment detection** — visual shading where actual output falls below planned
- 📋 **BOALF events table** — ESO curtailment instructions with timestamps
- 📥 **CSV download** — export generation data for any farm and date range
- 🔍 **Searchable farm list** with capacity and commissioning info
- 🌙 **Premium dark theme** with responsive layout

## Data Sources

All data is sourced from the [Elexon Insights API](https://data.elexon.co.uk/):

| Dataset | Description |
|---------|-------------|
| **B1610** | Half-hourly metered generation (MWh) |
| **PN** | Physical Notifications — planned output per BM unit (MW) |
| **BOALF** | Bid-Offer Acceptance Level Flagged — curtailment instructions |

TEC values sourced from National Grid ESO connection registers.

## Project Structure

```
dashboard/
├── index.html          # Main dashboard page
├── index.css           # Dark theme design system
├── app.js              # Application logic (data loading, charts, UI)
├── preprocess_data.py  # Python script to generate JSON from raw CSVs
├── README.md
└── data/
    ├── farms.json      # Farm metadata (capacity, TEC, location, etc.)
    └── {FarmName}/     # Per-farm data directories
        ├── b1610_2023.json   # Metered generation (one file per year)
        ├── pn_2023.json      # Physical Notifications (one file per year)
        └── boalf.json        # BOALF curtailment events (all years)
```

## Updating Data

### Prerequisites

- Python 3.8+
- Raw Elexon CSV files in `../elexon_data/` (downloaded via `download_elexon_data.py` and `download_elexon_supplementary.py`)

### Regenerate JSON data

```bash
cd dashboard
python preprocess_data.py
```

Options:
```bash
python preprocess_data.py --farm Dudgeon     # Process single farm
python preprocess_data.py --output ./data    # Custom output directory
```

### Deploy to GitHub Pages

1. Push the `dashboard/` contents to the `main` branch of the [DOREL repo](https://github.com/enflow-ouro/DOREL)
2. Enable GitHub Pages in repo settings (source: `main` branch, root `/`)
3. The dashboard will be live at `https://enflow-ouro.github.io/DOREL/`

## Future Roadmap

- **PyWake model data** — production predictions from PyWake wake models
- **WRF model data** — Weather Research and Forecasting model outputs
- **Cross-farm comparison** — side-by-side analysis of multiple farms
- **Monthly/annual aggregation** — summary statistics and trends
- **Map view** — geographic visualisation of farm locations and output

## Technology

- **Frontend**: Vanilla HTML/CSS/JavaScript (no framework dependencies)
- **Charts**: [Plotly.js](https://plotly.com/javascript/) for interactive time series
- **Hosting**: GitHub Pages (static site)
- **Data**: JSON files preprocessed from Elexon API CSVs

## Credits

Developed by **EnFlow Ltd & University of Manchester** as part of the DOREL project.

Data provided by [Elexon](https://www.elexon.co.uk/) via the BMRS Insights API.

## License

© EnFlow Ltd & University of Manchester. All rights reserved.
