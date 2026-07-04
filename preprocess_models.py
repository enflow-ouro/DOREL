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

# ── Load Farm TEC Limits ──────────────────────────────────────────────
FARM_TEC_MAP = {}
if (DATA_DIR / "farms.json").exists():
    with open(DATA_DIR / "farms.json", "r") as f:
        _fj = json.load(f)
        for _f in _fj.get("farms", []):
            if "tec_mw" in _f and _f["tec_mw"] is not None:
                FARM_TEC_MAP[_f["id"]] = float(_f["tec_mw"])


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
                tec = FARM_TEC_MAP.get(farm_id)
                for row in reader:
                    ts = row[0].strip()
                    # Convert space-separated datetime to ISO
                    ts_iso = ts.replace(" ", "T")
                    if tec:
                        values = [min(round(float(v), 1), tec) for v in row[1:]]
                    else:
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
# ERA5 results: map farm slug → (farm_id, subfolder)
# subfolder is relative to ERA5_RESULTS; None means files are in ERA5_RESULTS root
ERA5_FARM_MAP = {
    "dudgeon":          ("Dudgeon",          "dudgeon"),
    "race-bank":        ("Race_Bank",         "race-bank"),
    "sheringham-shoal": ("Sheringham_Shoal",  "sheringham-shoal"),
    "triton-knoll":     ("Triton_Knoll",      "triton-knoll"),
    # Add more as results become available:
    # "east-anglia-one": ("East_Anglia_ONE", "east-anglia-one"),
}

# ERA5 scenarios: csv suffix → dashboard scenario name
ERA5_SCENARIOS = {
    "alone":   "era5_standalone",
    "cluster": "era5_cluster",
}

# Model name mapping: CSV filename fragment → display name
ERA5_MODEL_ORDER = [
    ("NOJ",                "NOJ"),
    ("BastankhahGaussian", "Bastankhah"),
    ("NiayifarGaussian",   "Niayifar"),
    ("TurboNOJ",           "TurboNOJ"),
    ("TurboGaussian",      "TurboGaussian"),
    ("SuperGaussian",      "Blondel"),
    ("GCL",                "GCL"),
    ("ASODiffusion",       "ASO"),
]

def process_pywake_era5():
    """Process ERA5-driven PyWake results (hourly, multi-year, multi-model).

    Discovers per-model CSV files and merges them into multi-column JSON
    matching the MERRA2 format: {models: [...], data: [[ts, v1, v2, ...], ...]}
    """
    print("\n=== Processing PyWake ERA5 ===")
    results = {}  # { farmId: { years: [...], scenarios: [...], models: [...] } }

    if not ERA5_RESULTS.exists():
        print(f"  SKIP: {ERA5_RESULTS} not found")
        return results

    for era5_slug, (farm_id, subfolder) in ERA5_FARM_MAP.items():
        farm_scenarios = []
        all_years = set()
        all_models = []

        # Results can be in a subfolder or directly in ERA5_RESULTS
        farm_results_dir = (ERA5_RESULTS / subfolder) if subfolder else ERA5_RESULTS

        for csv_suffix, scenario_name in ERA5_SCENARIOS.items():
            # Try two naming patterns:
            # 1. {slug}_era5_{Model}_{suffix}_timeseries.csv  (dudgeon style)
            # 2. {slug}_{Model}_{suffix}_timeseries.csv       (new farms style)
            found_models = []  # [(display_name, csv_path), ...]

            for model_key, display_name in ERA5_MODEL_ORDER:
                for pattern in [
                    farm_results_dir / f"{era5_slug}_era5_{model_key}_{csv_suffix}_timeseries.csv",
                    farm_results_dir / f"{era5_slug}_{model_key}_{csv_suffix}_timeseries.csv",
                ]:
                    if pattern.exists():
                        found_models.append((display_name, pattern))
                        break  # use first match

            if not found_models:
                # Try legacy single-model fallbacks
                for pattern in [
                    farm_results_dir / f"{era5_slug}_era5_{csv_suffix}_timeseries.csv",
                    farm_results_dir / f"{era5_slug}_{csv_suffix}_timeseries.csv",
                ]:
                    if pattern.exists():
                        found_models.append(("ERA5", pattern))
                        break

            if not found_models:
                print(f"  SKIP {era5_slug}/{csv_suffix}: no CSV files found")
                continue

            model_names = [m[0] for m in found_models]
            print(f"  Processing {era5_slug} / {csv_suffix}: {len(found_models)} models ({', '.join(model_names)})")

            # Read all model CSVs and merge by timestamp
            # ts_data[ts_iso] = [power_model1, power_model2, ...]
            ts_data = {}
            ts_order = []  # preserve insertion order

            for mi, (display_name, csv_path) in enumerate(found_models):
                with open(csv_path, "r", newline="") as f:
                    reader = csv.reader(f)
                    header = next(reader)
                    power_col = header.index("power_total_MWh")

                    for row in reader:
                        ts = row[0].strip()
                        ts_iso = ts.replace(" ", "T")
                        power_mw = round(float(row[power_col]), 1)
                        tec = FARM_TEC_MAP.get(farm_id)
                        if tec:
                            power_mw = min(power_mw, tec)

                        if ts_iso not in ts_data:
                            ts_data[ts_iso] = [0.0] * len(found_models)
                            ts_order.append(ts_iso)
                        ts_data[ts_iso][mi] = power_mw

            # Split by year and write JSON
            year_data = {}  # { year: [[ts_iso, v1, v2, ...], ...] }
            for ts_iso in ts_order:
                year = ts_iso[:4]
                if year not in year_data:
                    year_data[year] = []
                year_data[year].append([ts_iso] + ts_data[ts_iso])

            out_dir = DATA_DIR / farm_id
            out_dir.mkdir(parents=True, exist_ok=True)

            for year, data in sorted(year_data.items()):
                out_file = out_dir / f"pywake_{scenario_name}_{year}.json"
                with open(out_file, "w") as f:
                    json.dump({"models": model_names, "data": data}, f, separators=(",", ":"))

                size_mb = out_file.stat().st_size / (1024 * 1024)
                print(f"    -> {out_file.name}  ({len(data)} rows, {size_mb:.1f} MB, {len(model_names)} models)")
                all_years.add(int(year))

            farm_scenarios.append(scenario_name)
            all_models = model_names  # same models for all scenarios

        if farm_scenarios:
            results[farm_id] = {
                "years": sorted(all_years),
                "scenarios": farm_scenarios,
                "models": all_models,
            }

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
                        tec = FARM_TEC_MAP.get(fid)
                        if tec:
                            mw = min(mw, tec)
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
                        tec = FARM_TEC_MAP.get("Walney_Extension")
                        if tec:
                            mw_sum = min(mw_sum, tec)
                            
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
            era5_info = era5_results[fid]
            existing["years"] = sorted(set(existing.get("years", []) + era5_info["years"]))
            for sc in era5_info["scenarios"]:
                if sc not in existing.get("scenarios", []):
                    existing["scenarios"] = existing.get("scenarios", []) + [sc]
            # Merge model names (ERA5 now uses same model names as MERRA2)
            for m in era5_info.get("models", []):
                if m not in existing.get("models", []):
                    existing["models"] = existing.get("models", []) + [m]
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
