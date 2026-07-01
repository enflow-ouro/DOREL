#!/usr/bin/env python3
"""
preprocess_data.py — Elexon CSV → compact JSON for the wind-farm dashboard.

Reads raw B1610, PN, and BOALF CSVs from the elexon_data directory and writes
compact JSON files suitable for a static web dashboard.

Usage:
    python preprocess_data.py                       # process all farms
    python preprocess_data.py --farm Dudgeon        # single farm
    python preprocess_data.py --output ./out        # custom output dir
"""

import argparse
import csv
import json
import os
import sys
import time
from pathlib import Path

# ──────────────────────────────────────────────────────────────────────────────
# Farm metadata
# ──────────────────────────────────────────────────────────────────────────────

WIND_FARM_BM_UNITS = {
    "Aberdeen_Bay":         {"ngc_ids": ["ABRBO-1"],                                             "capacity_mw": 96.8,  "tec_mw": 95.5,  "commissioned": 2018, "lat": 57.2306, "lon": -2.0029},
    "Barrow":               {"ngc_ids": ["BOWLW-1"],                                             "capacity_mw": 90,    "tec_mw": 90,    "commissioned": 2006, "lat": 54.0000, "lon": -3.3014},
    "Beatrice":             {"ngc_ids": ["BEATO-1","BEATO-2","BEATO-3","BEATO-4"],               "capacity_mw": 588,   "tec_mw": 588,   "commissioned": 2019, "lat": 58.6123, "lon": -2.9001},
    "Burbo_Bank":           {"ngc_ids": ["BURBW-1"],                                             "capacity_mw": 90,    "tec_mw": 90,    "commissioned": 2007, "lat": 53.4911, "lon": -3.1892},
    "Burbo_Bank_Extension": {"ngc_ids": ["BRBEO-1"],                                             "capacity_mw": 258,   "tec_mw": 258,   "commissioned": 2017, "lat": 53.4851, "lon": -3.2722},
    "Dudgeon":              {"ngc_ids": ["DDGNO-1","DDGNO-2","DDGNO-3","DDGNO-4"],               "capacity_mw": 402,   "tec_mw": 400,   "commissioned": 2017, "lat": 53.2663, "lon": 1.3725},
    "East_Anglia_ONE":      {"ngc_ids": ["EAAO-1","EAAO-2"],                                     "capacity_mw": 714,   "tec_mw": 680,   "commissioned": 2020, "lat": 52.2412, "lon": 2.4950},
    "Galloper":             {"ngc_ids": ["GAOFO-1","GAOFO-2","GAOFO-3","GAOFO-4"],               "capacity_mw": 353,   "tec_mw": 348,   "commissioned": 2018, "lat": 51.9459, "lon": 2.0319},
    "Greater_Gabbard":      {"ngc_ids": ["GRGBW-1","GRGBW-2","GRGBW-3"],                         "capacity_mw": 504,   "tec_mw": 500,   "commissioned": 2012, "lat": 51.9215, "lon": 1.9256},
    "Gunfleet_Sands_I":     {"ngc_ids": ["GNFSW-1"],                                             "capacity_mw": 108,   "tec_mw": 99.9,  "commissioned": 2010, "lat": 51.7339, "lon": 1.2190},
    "Gunfleet_Sands_II":    {"ngc_ids": ["GNFSW-2"],                                             "capacity_mw": 64.8,  "tec_mw": 64,    "commissioned": 2010, "lat": 51.7339, "lon": 1.2190},
    "Gwynt_y_Mor":          {"ngc_ids": ["GYMRW-1","GYMRW-2","GYMRO-15","GYMRO-17","GYMRO-26","GYMRO-28"], "capacity_mw": 576, "tec_mw": 574, "commissioned": 2015, "lat": 53.4578, "lon": -3.6294},
    "Hornsea_One":          {"ngc_ids": ["HOWAO-1","HOWAO-2","HOWAO-3"],                          "capacity_mw": 1218,  "tec_mw": 1200,  "commissioned": 2020, "lat": 53.8847, "lon": 1.9280},
    "Hornsea_Two":          {"ngc_ids": ["HOWBO-1","HOWBO-2","HOWBO-3"],                          "capacity_mw": 1386,  "tec_mw": 1320,  "commissioned": 2022, "lat": 53.9493, "lon": 1.5811},
    "Humber_Gateway":       {"ngc_ids": ["HMGTO-1","HMGTO-2"],                                   "capacity_mw": 219,   "tec_mw": 220,   "commissioned": 2017, "lat": 53.6525, "lon": 0.2910},
    "Hywind_Scotland":      {"ngc_ids": ["HYWDW-1"],                                             "capacity_mw": 30,    "tec_mw": 30,    "commissioned": 2017, "lat": 57.4883, "lon": -1.3649},
    "Kincardine":           {"ngc_ids": ["KINCW-1"],                                             "capacity_mw": 50,    "tec_mw": 49.6,  "commissioned": 2021, "lat": 57.0082, "lon": -1.8621},
    "Lincs":                {"ngc_ids": ["LNCSO-1","LNCSO-2","LNCSW-3"],                         "capacity_mw": 270,   "tec_mw": 265,   "commissioned": 2013, "lat": 53.1959, "lon": 0.4994},
    "London_Array":         {"ngc_ids": ["LARYO-1","LARYO-2","LARYO-3","LARYO-4"],               "capacity_mw": 630,   "tec_mw": 630,   "commissioned": 2013, "lat": 51.6274, "lon": 1.4865},
    "Moray_East":           {"ngc_ids": ["MOWEO-1","MOWEO-2","MOWEO-3"],                         "capacity_mw": 950,   "tec_mw": 900,   "commissioned": 2022, "lat": 58.1876, "lon": -2.7380},
    "Ormonde":              {"ngc_ids": ["OMNDW-1","OMNDO-1","OMNDD-1"],                         "capacity_mw": 150,   "tec_mw": 150,   "commissioned": 2012, "lat": 54.0904, "lon": -3.4403},
    "Race_Bank":            {"ngc_ids": ["RCBKO-1","RCBKO-2"],                                   "capacity_mw": 573.3, "tec_mw": 565,   "commissioned": 2018, "lat": 53.2684, "lon": 0.8450},
    "Rampion":              {"ngc_ids": ["RMPNO-1","RMPNO-2"],                                   "capacity_mw": 400,   "tec_mw": 400,   "commissioned": 2018, "lat": 50.6766, "lon": -0.2725},
    "Robin_Rigg":           {"ngc_ids": ["RREW-1","RRWW-1"],                                     "capacity_mw": 180,   "tec_mw": 178,   "commissioned": 2010, "lat": 54.7559, "lon": -3.7127},
    "Seagreen":             {"ngc_ids": ["SGRWO-3","SGRWO-4","SGRWO-5","SGRWO-6"],               "capacity_mw": 1075,  "tec_mw": 1075,  "commissioned": 2023, "lat": 56.5931, "lon": -1.7603},
    "Sheringham_Shoal":     {"ngc_ids": ["SHRSW-1","SHRSO-1","SHRSW-2","SHRSO-2"],               "capacity_mw": 317,   "tec_mw": 315,   "commissioned": 2012, "lat": 53.1400, "lon": 1.1426},
    "Thanet":               {"ngc_ids": ["THNTO-1","THNTO-2","THNTW-2","THNTW-1"],               "capacity_mw": 300,   "tec_mw": 300,   "commissioned": 2010, "lat": 51.4320, "lon": 1.6332},
    "Triton_Knoll":         {"ngc_ids": ["TKNEW-1","TKNWW-1"],                                   "capacity_mw": 857,   "tec_mw": 824,   "commissioned": 2022, "lat": 53.4882, "lon": 0.8189},
    "Walney_Extension":     {"ngc_ids": ["WLNYO-2","WLNYO-3","WLNYO-4"],                         "capacity_mw": 659,   "tec_mw": 660,   "commissioned": 2018, "lat": 54.0819, "lon": -3.7028},
    "Walney_One":           {"ngc_ids": ["WLNYW-1"],                                             "capacity_mw": 183.6, "tec_mw": 182,   "commissioned": 2010, "lat": 54.0814, "lon": -3.6090},
    "West_of_Duddon_Sands": {"ngc_ids": ["WDNSO-1","WDNSO-2","WDNSW-1","WDNSW-2"],              "capacity_mw": 389,   "tec_mw": 382,   "commissioned": 2014, "lat": 53.9835, "lon": -3.4655},
    "Westermost_Rough":     {"ngc_ids": ["WTMSO-1","WTMSD-1"],                                   "capacity_mw": 210,   "tec_mw": 206.5, "commissioned": 2015, "lat": 53.8099, "lon": 0.1420},
}

YEARS = range(2020, 2026)

# ──────────────────────────────────────────────────────────────────────────────
# Paths
# ──────────────────────────────────────────────────────────────────────────────

_SCRIPT_DIR = Path(__file__).resolve().parent
_DEFAULT_INPUT = _SCRIPT_DIR.parent / "elexon_data"
_DEFAULT_OUTPUT = _SCRIPT_DIR / "data"

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────


def _write_json(path: Path, obj: object) -> int:
    """Write *obj* as compact JSON and return the file size in bytes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = json.dumps(obj, separators=(",", ":"))
    path.write_text(data, encoding="utf-8")
    return len(data)


def _parse_bool(val: str) -> bool:
    """Parse a string boolean from CSV (e.g. 'True'/'False')."""
    return val.strip().lower() == "true"


def _parse_float(val: str) -> float:
    """Parse a float from CSV, returning 0.0 on failure."""
    try:
        return float(val)
    except (ValueError, TypeError):
        return 0.0


# ──────────────────────────────────────────────────────────────────────────────
# B1610 processing
# ──────────────────────────────────────────────────────────────────────────────


def process_b1610(farm_id: str, year: int, input_dir: Path, output_dir: Path) -> int:
    """
    Read ``{farm_id}_{year}.csv`` and write ``b1610_{year}.json``.

    Returns the number of data rows written, or 0 if the source file is missing.
    """
    src = input_dir / farm_id / f"{farm_id}_{year}.csv"
    if not src.exists():
        return 0

    rows = []
    with open(src, "r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        # Identify column indices by name for robustness
        try:
            ts_idx = header.index("halfHourEndTime")
            mwh_idx = header.index("b1610_MWh")
        except ValueError:
            print(f"  WARNING: unexpected columns in {src.name}, skipping")
            return 0

        for row in reader:
            if len(row) <= max(ts_idx, mwh_idx):
                continue
            ts = row[ts_idx]
            mwh = round(_parse_float(row[mwh_idx]), 1)
            rows.append([ts, mwh])

    if not rows:
        return 0

    out = output_dir / farm_id / f"b1610_{year}.json"
    _write_json(out, {"columns": ["timestamp", "mwh"], "data": rows})
    return len(rows)


# ──────────────────────────────────────────────────────────────────────────────
# PN processing
# ──────────────────────────────────────────────────────────────────────────────


def process_pn(farm_id: str, year: int, input_dir: Path, output_dir: Path) -> int:
    """
    Read ``{farm_id}_PN_{year}.csv``, aggregate ``levelFrom`` per settlement
    period (summing across BM units), and write ``pn_{year}.json``.

    Returns the number of aggregated rows written.
    """
    src = input_dir / farm_id / f"{farm_id}_PN_{year}.csv"
    if not src.exists():
        return 0

    # Accumulate: (settlementDate, settlementPeriod) → { "timeTo": ..., "level_sum": ... }
    agg: dict[tuple[str, str], dict] = {}

    with open(src, "r", encoding="utf-8", newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        try:
            sd_idx = header.index("settlementDate")
            sp_idx = header.index("settlementPeriod")
            time_to_idx = header.index("timeTo")
            lf_idx = header.index("levelFrom")
        except ValueError:
            print(f"  WARNING: unexpected columns in {src.name}, skipping")
            return 0

        for row in reader:
            if len(row) <= max(sd_idx, sp_idx, time_to_idx, lf_idx):
                continue
            key = (row[sd_idx], row[sp_idx])
            level = _parse_float(row[lf_idx])
            entry = agg.get(key)
            if entry is None:
                agg[key] = {"timeTo": row[time_to_idx], "level_sum": level}
            else:
                entry["level_sum"] += level

    if not agg:
        return 0

    # Sort by (settlementDate, settlementPeriod as int)
    sorted_keys = sorted(agg.keys(), key=lambda k: (k[0], int(k[1])))
    rows = []
    for key in sorted_keys:
        entry = agg[key]
        ts = entry["timeTo"]
        # Strip trailing 'Z' if present to match B1610 timestamp style
        if ts.endswith("Z"):
            ts = ts[:-1]
        mw = round(entry["level_sum"], 1)
        rows.append([ts, mw])

    out = output_dir / farm_id / f"pn_{year}.json"
    _write_json(out, {"columns": ["timestamp", "mw"], "data": rows})
    return len(rows)


# ──────────────────────────────────────────────────────────────────────────────
# BOALF processing
# ──────────────────────────────────────────────────────────────────────────────


def process_boalf(farm_id: str, input_dir: Path, output_dir: Path) -> int:
    """
    Read ``{farm_id}_BOALF_{year}.csv`` for all years, combine into a single
    ``boalf.json``.

    Returns the total number of rows written.
    """
    all_rows = []

    for year in YEARS:
        src = input_dir / farm_id / f"{farm_id}_BOALF_{year}.csv"
        if not src.exists():
            continue

        with open(src, "r", encoding="utf-8", newline="") as fh:
            reader = csv.reader(fh)
            header = next(reader)
            try:
                sd_idx = header.index("settlementDate")
                tf_idx = header.index("timeFrom")
                tt_idx = header.index("timeTo")
                lf_idx = header.index("levelFrom")
                lt_idx = header.index("levelTo")
                so_idx = header.index("soFlag")
                unit_idx = header.index("nationalGridBmUnit")
            except ValueError:
                print(f"  WARNING: unexpected columns in {src.name}, skipping")
                continue

            for row in reader:
                if len(row) <= max(sd_idx, tf_idx, tt_idx, lf_idx, lt_idx, so_idx, unit_idx):
                    continue
                all_rows.append([
                    row[sd_idx],
                    row[tf_idx],
                    row[tt_idx],
                    _parse_float(row[lf_idx]),
                    _parse_float(row[lt_idx]),
                    _parse_bool(row[so_idx]),
                    row[unit_idx],
                ])

    if not all_rows:
        return 0

    # Sort by date, timeFrom
    all_rows.sort(key=lambda r: (r[0], r[1]))

    out = output_dir / farm_id / "boalf.json"
    _write_json(out, {
        "columns": ["date", "timeFrom", "timeTo", "levelFrom", "levelTo", "soFlag", "unit"],
        "data": all_rows,
    })
    return len(all_rows)


# ──────────────────────────────────────────────────────────────────────────────
# farms.json
# ──────────────────────────────────────────────────────────────────────────────


def build_farms_json(
    farm_ids: list[str], input_dir: Path, output_dir: Path
) -> None:
    """Write ``farms.json`` with metadata and available years per farm."""
    farms = []
    for fid in sorted(farm_ids):
        meta = WIND_FARM_BM_UNITS[fid]
        available_years = [
            y for y in YEARS
            if (input_dir / fid / f"{fid}_{y}.csv").exists()
        ]
        farms.append({
            "id": fid,
            "name": fid.replace("_", " "),
            "capacity_mw": meta["capacity_mw"],
            "tec_mw": meta["tec_mw"],
            "commissioned": meta["commissioned"],
            "lat": meta["lat"],
            "lon": meta["lon"],
            "bm_units": meta["ngc_ids"],
            "years": available_years,
        })

    _write_json(output_dir / "farms.json", {"farms": farms})
    print(f"  -> farms.json  ({len(farms)} farms)")


# ──────────────────────────────────────────────────────────────────────────────
# Main driver
# ──────────────────────────────────────────────────────────────────────────────


def process_farm(
    farm_id: str, input_dir: Path, output_dir: Path
) -> dict:
    """Process a single farm and return summary counters."""
    stats = {"b1610_rows": 0, "pn_rows": 0, "boalf_rows": 0, "b1610_years": 0, "pn_years": 0}

    # B1610 — per year
    for year in YEARS:
        n = process_b1610(farm_id, year, input_dir, output_dir)
        if n:
            stats["b1610_rows"] += n
            stats["b1610_years"] += 1
            print(f"    B1610 {year}: {n:,} rows")

    # PN — per year
    for year in YEARS:
        n = process_pn(farm_id, year, input_dir, output_dir)
        if n:
            stats["pn_rows"] += n
            stats["pn_years"] += 1
            print(f"    PN    {year}: {n:,} rows")

    # BOALF — all years combined
    n = process_boalf(farm_id, input_dir, output_dir)
    if n:
        stats["boalf_rows"] = n
        print(f"    BOALF combined: {n:,} rows")

    return stats


def dir_size(path: Path) -> int:
    """Return total size of all files under *path*, in bytes."""
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            total += p.stat().st_size
    return total


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Preprocess Elexon CSV data into compact JSON for the wind-farm dashboard."
    )
    parser.add_argument(
        "--farm",
        type=str,
        default=None,
        help="Process only this farm (e.g. Dudgeon). Default: all farms.",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help=f"Output directory. Default: {_DEFAULT_OUTPUT}",
    )
    args = parser.parse_args()

    input_dir = _DEFAULT_INPUT
    output_dir = Path(args.output) if args.output else _DEFAULT_OUTPUT

    if not input_dir.exists():
        print(f"ERROR: input directory not found: {input_dir}")
        sys.exit(1)

    # Determine which farms to process
    if args.farm:
        if args.farm not in WIND_FARM_BM_UNITS:
            print(f"ERROR: unknown farm '{args.farm}'. Valid farms:")
            for fid in sorted(WIND_FARM_BM_UNITS):
                print(f"  {fid}")
            sys.exit(1)
        farm_ids = [args.farm]
    else:
        farm_ids = sorted(WIND_FARM_BM_UNITS.keys())

    print(f"Input:  {input_dir}")
    print(f"Output: {output_dir}")
    print(f"Farms:  {len(farm_ids)}")
    print()

    t0 = time.perf_counter()
    total = {"farms": 0, "b1610_rows": 0, "pn_rows": 0, "boalf_rows": 0}

    for i, fid in enumerate(farm_ids, 1):
        print(f"[{i}/{len(farm_ids)}] {fid}")
        farm_dir = input_dir / fid
        if not farm_dir.exists():
            print("  (directory not found, skipping)")
            continue

        stats = process_farm(fid, input_dir, output_dir)
        total["farms"] += 1
        total["b1610_rows"] += stats["b1610_rows"]
        total["pn_rows"] += stats["pn_rows"]
        total["boalf_rows"] += stats["boalf_rows"]

    # Build the index file
    print()
    print("Building farms.json ...")
    build_farms_json(farm_ids, input_dir, output_dir)

    elapsed = time.perf_counter() - t0
    out_bytes = dir_size(output_dir)

    # Summary
    print()
    print("=" * 60)
    print("SUMMARY")
    print("=" * 60)
    print(f"  Farms processed   : {total['farms']}")
    print(f"  B1610 records     : {total['b1610_rows']:,}")
    print(f"  PN records        : {total['pn_rows']:,}")
    print(f"  BOALF records     : {total['boalf_rows']:,}")
    print(f"  Total records     : {total['b1610_rows'] + total['pn_rows'] + total['boalf_rows']:,}")
    print(f"  Output size       : {out_bytes / 1_048_576:.1f} MB")
    print(f"  Elapsed time      : {elapsed:.1f}s")
    print("=" * 60)


if __name__ == "__main__":
    main()
