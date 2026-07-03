#!/usr/bin/env python3
"""
preprocess_models.py — Convert PyWake & WRF source data into dashboard-ready JSON.

Outputs go to  data/{farmId}/pywake_standalone_2023.json
                data/{farmId}/pywake_cluster_2023.json
                data/{farmId}/wrf_fitch_2023.json
                data/{farmId}/wrf_ghost_2023.json

Also patches  data/farms.json  with model-availability flags.
"""

import csv, json, os, sys
from datetime import datetime, timedelta
from pathlib import Path

# ── Paths ─────────────────────────────────────────────────────────────
DASHBOARD_DIR  = Path(__file__).resolve().parent
DATA_DIR       = DASHBOARD_DIR / "data"

PYWAKE_BASE    = DASHBOARD_DIR.parent / "benchmarks" / "results"
ERA5_RESULTS   = DASHBOARD_DIR.parent / "benchmarks" / "era5" / "results"
WRF_DIR        = Path(r"C:\Users\Usuario\Documents\POUNDS\density_power_csv")

# ── PyWake farm mapping  (results dir name → dashboard farm id) ──────
PYWAKE_FARMS = {
    "Dudgeon":          "Dudgeon",
    "East_Anglia":      "East_Anglia_ONE",
    "Race_Bank":        "Race_Bank",
    "Sheringham_Shoal": "Sheringham_Shoal",
    "Triton_Knoll":     "Triton_Knoll",
    # Outer_Dowsing excluded (no Elexon data)
}

# Files per farm (some have different naming)
PYWAKE_FILES = {
    "Dudgeon":          {"standalone": "all_models_farm_power_standalone.csv", "cluster": "all_models_farm_power_cluster.csv"},
    "East_Anglia":      {"standalone": "farm_power_timeseries.csv"},  # only standalone
    "Race_Bank":        {"standalone": "all_models_farm_power_standalone.csv", "cluster": "all_models_farm_power_cluster.csv"},
    "Sheringham_Shoal": {"standalone": "all_models_farm_power_standalone.csv", "cluster": "all_models_farm_power_cluster.csv"},
    "Triton_Knoll":     {"standalone": "all_models_farm_power_standalone.csv", "cluster": "all_models_farm_power_cluster.csv"},
}

# ── WRF column name → dashboard farm ID mapping ─────────────────────
WRF_FARM_MAP = {
    "Aberdeen (MW)":             "Aberdeen_Bay",
    "Barrow (MW)":               "Barrow",
    "Beatrice (MW)":             "Beatrice",
    "Burbo Bank (MW)":           "Burbo_Bank",
    "Burbo Bank extension (MW)": "Burbo_Bank_Extension",
    "Dudgeon (MW)":              "Dudgeon",
    "East Anglia ONE (MW)":      "East_Anglia_ONE",
    "Galloper (MW)":             "Galloper",
    "Greater-Gabbard (MW)":      "Greater_Gabbard",
    "Gunfleet-sands-1 (MW)":     "Gunfleet_Sands_I",
    "Gunfleet-sands-2 (MW)":     "Gunfleet_Sands_II",
    "Gwynt Y Mor (MW)":          "Gwynt_y_Mor",
    "Hornsea 1 (MW)":            "Hornsea_One",
    "Hornsea Project 2 (MW)":    "Hornsea_Two",
    "Humber Gateway (MW)":       "Humber_Gateway",
    "Hywind Scotland (MW)":      "Hywind_Scotland",
    "Lincs (MW)":                "Lincs",
    "London-Array (MW)":         "London_Array",
    "Moray East (MW)":           "Moray_East",
    "Ormonde (MW)":              "Ormonde",
    "Race Bank (MW)":            "Race_Bank",
    "Rampion (MW)":              "Rampion",
    "Robin Rigg (MW)":           "Robin_Rigg",
    "Scroby Sands (MW)":         None,  # not in dashboard
    "Seagreen (MW)":             "Seagreen",
    "Sheringham Shoal (MW)":     "Sheringham_Shoal",
    "Thanet (MW)":               "Thanet",
    "Triton Knoll (MW)":         "Triton_Knoll",
    "Walney - phase 1 (MW)":     "Walney_One",
    "Walney - phase 2 (MW)":     None,  # no separate Walney Two in dashboard
    "Walney Extension I (MW)":   "Walney_Extension",   # will sum I+II
    "Walney Extension II (MW)":  "Walney_Extension",   # will sum I+II
    "West of Duddon Sands (MW)": "West_of_Duddon_Sands",
    "Westermost Rough (MW)":     "Westermost_Rough",
    # Continental farms → skip
    "North Hoyle (MW)":          None,
    "Rhyl Flats (MW)":           None,
    "Lynn (MW)":                 None,
    "Inner Dowsing (MW)":        None,
    "Teesside (MW)":             None,
    "Kentish-flats-1 (MW)":      None,
    "Kentish-flats-2 (MW)":      None,
    "Gunfleet-sands-3 (MW)":     None,
}

# WRF monthly CSV files → month index (1-based)
WRF_MONTHS_FITCH = {
    "power_generation_monthly_JAN.csv": 1,
    "power_generation_monthly_FEB.csv": 2,
    "power_generation_monthly_MAR.csv": 3,
    "power_generation_monthly_APR.csv": 4,
    "power_generation_monthly_MAY.csv": 5,
    "power_generation_monthly_JUN.csv": 6,
    "power_generation_monthly_JUL.csv": 7,
    "power_generation_monthly_AUG.csv": 8,
    "power_generation_monthly_SEP.csv": 9,
    "power_generation_monthly_OCT.csv": 10,
    "power_generation_monthly_NOV.csv": 11,
    "power_generation_monthly_DIC.csv": 12,
}

WRF_MONTHS_GHOST = {
    "2023-JAN-ghost.csv": 1,
    "2023-FEB-ghost.csv": 2,
    "2023-MAR-ghost.csv": 3,
    "2023-APR-ghost.csv": 4,
    "2023-MAY-ghost.csv": 5,
    "2023-JUN-ghost.csv": 6,
    "2023-JUL-ghost.csv": 7,
    "2023-AUG-ghost.csv": 8,
    "2023-SEP-ghost.csv": 9,
    "2023-OCT-ghost.csv": 10,
    "2023-NOV-ghost.csv": 11,
    "2023-DEC-ghost.csv": 12,
}


# =====================================================================
#  PyWake preprocessing
# =====================================================================
def process_pywake():
    print("\n=== Processing PyWake data ===")
    results = {}  # { farmId: { scenarios: [...], models: [...] } }

    for pw_dir, farm_id in PYWAKE_FARMS.items():
        farm_base = PYWAKE_BASE / pw_dir / "csv"
        if not farm_base.exists():
            print(f"  SKIP {pw_dir}: no csv/ directory")
            continue

        files = PYWAKE_FILES.get(pw_dir, {})
        scenarios_done = []

        for scenario, filename in files.items():
            filepath = farm_base / filename
            if not filepath.exists():
                print(f"  SKIP {pw_dir}/{scenario}: {filename} not found")
                continue

            print(f"  Processing {pw_dir} / {scenario} ...")

            with open(filepath, "r", newline="") as f:
                reader = csv.reader(f)
                header = next(reader)
                # header: datetime, Model1, Model2, ...
                models = header[1:]

                data = []
                for row in reader:
                    ts = row[0].strip()
                    # Convert space-separated datetime to ISO
                    ts_iso = ts.replace(" ", "T")
                    values = [round(float(v), 1) for v in row[1:]]
                    data.append([ts_iso] + values)

            out_dir = DATA_DIR / farm_id
            out_dir.mkdir(parents=True, exist_ok=True)
            out_file = out_dir / f"pywake_{scenario}_2023.json"

            with open(out_file, "w") as f:
                json.dump({"models": models, "data": data}, f, separators=(",", ":"))

            size_mb = out_file.stat().st_size / (1024 * 1024)
            print(f"    -> {out_file.name}  ({len(data)} rows, {size_mb:.1f} MB, {len(models)} models)")
            scenarios_done.append(scenario)

        if scenarios_done:
            results[farm_id] = {
                "scenarios": scenarios_done,
                "models": models,
            }

    return results


# =====================================================================
#  ERA5 PyWake preprocessing
# =====================================================================
# ERA5 results CSV name → dashboard farm ID
ERA5_FARM_MAP = {
    "dudgeon": "Dudgeon",
    # Add more as results become available:
    # "east-anglia-one": "East_Anglia_ONE",
    # "race-bank": "Race_Bank",
    # "sheringham-shoal": "Sheringham_Shoal",
    # "triton-knoll": "Triton_Knoll",
}

def process_pywake_era5():
    """Process ERA5-driven PyWake results (hourly, multi-year)."""
    print("\n=== Processing PyWake ERA5 ===")
    results = {}  # { farmId: { years: [...] } }

    if not ERA5_RESULTS.exists():
        print(f"  SKIP: {ERA5_RESULTS} not found")
        return results

    for era5_name, farm_id in ERA5_FARM_MAP.items():
        csv_file = ERA5_RESULTS / f"{era5_name}_era5_timeseries.csv"
        if not csv_file.exists():
            print(f"  SKIP {era5_name}: {csv_file.name} not found")
            continue

        print(f"  Processing {era5_name} -> {farm_id} ...")

        # Read CSV: columns are timestamp, ws_hub_ms, wd_deg, power_total_MWh, WT_01..WT_N
        year_data = {}  # { year: [[ts_iso, power_mw], ...] }

        with open(csv_file, "r", newline="") as f:
            reader = csv.reader(f)
            header = next(reader)
            # power_total_MWh is column index 3
            power_col = header.index("power_total_MWh")

            for row in reader:
                ts = row[0].strip()  # "2020-01-01 00:00:00"
                year = ts[:4]
                ts_iso = ts.replace(" ", "T")  # "2020-01-01T00:00:00"
                # Value is MWh over 1 hour = average MW during that hour
                power_mw = round(float(row[power_col]), 1)

                if year not in year_data:
                    year_data[year] = []
                year_data[year].append([ts_iso, power_mw])

        # Write per-year JSON files
        out_dir = DATA_DIR / farm_id
        out_dir.mkdir(parents=True, exist_ok=True)
        years_done = []

        for year, data in sorted(year_data.items()):
            out_file = out_dir / f"pywake_era5_{year}.json"
            with open(out_file, "w") as f:
                json.dump({"models": ["ERA5"], "data": data}, f, separators=(",", ":"))

            size_mb = out_file.stat().st_size / (1024 * 1024)
            print(f"    -> {out_file.name}  ({len(data)} rows, {size_mb:.1f} MB)")
            years_done.append(int(year))

        if years_done:
            results[farm_id] = {"years": sorted(years_done)}

    return results


# =====================================================================
#  WRF preprocessing
# =====================================================================
def process_wrf_set(month_files, variant_name):
    """Process a set of WRF monthly CSVs into per-farm JSON."""
    print(f"\n=== Processing WRF {variant_name} ===")

    # Accumulate data per farm across months
    farm_data = {}  # { farmId: [[ts, mw], ...] }

    for filename, month_num in sorted(month_files.items(), key=lambda x: x[1]):
        filepath = WRF_DIR / filename
        if not filepath.exists():
            print(f"  SKIP: {filename} not found")
            continue

        # Month start datetime
        month_start = datetime(2023, month_num, 1)

        print(f"  Reading {filename} (month {month_num}) ...")

        with open(filepath, "r", newline="") as f:
            reader = csv.reader(f)
            header = next(reader)
            # header[0] = "Time", rest are farm columns

            # Build column index → farm_id mapping
            col_map = {}  # col_index → farm_id
            walney_ext_cols = []  # indices for Walney Extension I & II (to sum)

            for i, col in enumerate(header[1:], start=1):
                col_clean = col.strip()
                if col_clean in WRF_FARM_MAP:
                    farm_id = WRF_FARM_MAP[col_clean]
                    if farm_id is not None:
                        if col_clean in ("Walney Extension I (MW)", "Walney Extension II (MW)"):
                            walney_ext_cols.append(i)
                        else:
                            col_map[i] = farm_id
                # Skip unmapped columns (continental farms etc.)

            for row in reader:
                try:
                    hours = float(row[0].strip())
                except (ValueError, IndexError):
                    continue

                # Convert fractional hours to datetime
                ts = month_start + timedelta(hours=hours)
                ts_iso = ts.strftime("%Y-%m-%dT%H:%M:%S")

                # Regular farms
                for col_idx, fid in col_map.items():
                    try:
                        mw = round(float(row[col_idx].strip()), 1)
                    except (ValueError, IndexError):
                        continue
                    if fid not in farm_data:
                        farm_data[fid] = []
                    farm_data[fid].append([ts_iso, mw])

                # Walney Extension: sum I + II
                if len(walney_ext_cols) == 2:
                    try:
                        mw_sum = round(
                            float(row[walney_ext_cols[0]].strip()) +
                            float(row[walney_ext_cols[1]].strip()), 1
                        )
                        if "Walney_Extension" not in farm_data:
                            farm_data["Walney_Extension"] = []
                        farm_data["Walney_Extension"].append([ts_iso, mw_sum])
                    except (ValueError, IndexError):
                        pass

    # Write per-farm JSON
    farms_with_data = []
    for farm_id, data in sorted(farm_data.items()):
        out_dir = DATA_DIR / farm_id
        out_dir.mkdir(parents=True, exist_ok=True)
        suffix = "fitch" if variant_name == "Fitch" else "ghost"
        out_file = out_dir / f"wrf_{suffix}_2023.json"

        with open(out_file, "w") as f:
            json.dump({"data": data}, f, separators=(",", ":"))

        size_mb = out_file.stat().st_size / (1024 * 1024)
        print(f"  {farm_id}: {len(data)} rows, {size_mb:.1f} MB")
        farms_with_data.append(farm_id)

    return farms_with_data


# =====================================================================
#  Update farms.json
# =====================================================================
def update_farms_json(pywake_results, wrf_fitch_farms, wrf_ghost_farms, era5_results=None):
    print("\n=== Updating farms.json ===")
    farms_file = DATA_DIR / "farms.json"

    with open(farms_file, "r") as f:
        farms_json = json.load(f)

    era5_results = era5_results or {}

    for farm in farms_json["farms"]:
        fid = farm["id"]

        # PyWake (MERRA2-based benchmarks)
        if fid in pywake_results:
            pw = pywake_results[fid]
            existing = farm.get("pywake", {"years": [], "scenarios": [], "models": []})
            existing["years"] = sorted(set(existing.get("years", []) + [2023]))
            existing["scenarios"] = sorted(set(existing.get("scenarios", []) + pw["scenarios"]))
            existing["models"] = pw["models"]
            farm["pywake"] = existing

        # ERA5 PyWake
        if fid in era5_results:
            existing = farm.get("pywake", {"years": [], "scenarios": [], "models": []})
            era5_years = era5_results[fid]["years"]
            existing["years"] = sorted(set(existing.get("years", []) + era5_years))
            if "era5" not in existing.get("scenarios", []):
                existing["scenarios"] = existing.get("scenarios", []) + ["era5"]
            # ERA5 has a single model; merge with existing models list
            if "ERA5" not in existing.get("models", []):
                existing["models"] = existing.get("models", []) + ["ERA5"]
            farm["pywake"] = existing

        # WRF
        wrf_variants = []
        if fid in wrf_fitch_farms:
            wrf_variants.append("fitch")
        if fid in wrf_ghost_farms:
            wrf_variants.append("ghost")
        if wrf_variants:
            farm["wrf"] = {
                "years": [2023],
                "variants": wrf_variants,
            }

    with open(farms_file, "w") as f:
        json.dump(farms_json, f, indent=2, ensure_ascii=False)

    print(f"  Updated {len(farms_json['farms'])} farms")


# =====================================================================
#  Main
# =====================================================================
if __name__ == "__main__":
    print("DOREL — Model Data Preprocessing")
    print("=" * 50)

    # 1. PyWake (MERRA2-based)
    pywake_results = process_pywake()
    print(f"\nPyWake: {len(pywake_results)} farms processed")

    # 2. PyWake ERA5
    era5_results = process_pywake_era5()
    print(f"\nPyWake ERA5: {len(era5_results)} farms processed")

    # 3. WRF Fitch
    wrf_fitch_farms = process_wrf_set(WRF_MONTHS_FITCH, "Fitch")
    print(f"\nWRF Fitch: {len(wrf_fitch_farms)} farms processed")

    # 4. WRF Ghost
    wrf_ghost_farms = process_wrf_set(WRF_MONTHS_GHOST, "Ghost")
    print(f"\nWRF Ghost: {len(wrf_ghost_farms)} farms processed")

    # 5. Update farms.json
    update_farms_json(pywake_results, wrf_fitch_farms, wrf_ghost_farms, era5_results)

    print("\nDone!")
