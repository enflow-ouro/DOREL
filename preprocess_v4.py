import csv
import json
import os
from pathlib import Path

DASHBOARD_DIR = Path(__file__).resolve().parent
DATA_DIR = DASHBOARD_DIR / "data"
RESULTS_V4_DIR = DASHBOARD_DIR.parent / "benchmarks" / "results_v4"

FARM_TEC_MAP = {}
FARMS_JSON_PATH = DATA_DIR / "farms.json"
if FARMS_JSON_PATH.exists():
    with open(FARMS_JSON_PATH, "r") as f:
        _fj = json.load(f)
        for _f in _fj.get("farms", []):
            if "tec_mw" in _f and _f["tec_mw"] is not None:
                FARM_TEC_MAP[_f["id"]] = float(_f["tec_mw"])

SCENARIOS = {
    "isolated": "isolated",
    "cluster_2023": "cluster_2023",
    "cluster_2030": "cluster_2030",
    "single_turbine": "single_turbine"
}

def process_v4():
    print("=== Processing PyWake results_v4 ===")
    results = {}
    
    for farm_dir in RESULTS_V4_DIR.iterdir():
        if not farm_dir.is_dir():
            continue
        
        farm_id = farm_dir.name
        csv_dir = farm_dir / "csv"
        if not csv_dir.exists():
            continue
            
        print(f"Processing {farm_id}...")
        
        farm_scenarios = []
        all_models = []
        
        for scen_key, scen_val in SCENARIOS.items():
            csv_path = csv_dir / f"all_models_farm_power_{scen_key}.csv"
            if not csv_path.exists():
                continue
                
            with open(csv_path, "r", newline="") as f:
                reader = csv.reader(f)
                header = next(reader)
                
                models = header[1:]
                if not all_models:
                    all_models = models
                    
                data = []
                for row in reader:
                    ts = row[0].strip().replace(" ", "T")
                    tec = FARM_TEC_MAP.get(farm_id)
                    
                    pw_vals = []
                    for val in row[1:]:
                        try:
                            v = round(float(val), 1)
                            if tec:
                                v = min(v, tec)
                            pw_vals.append(v)
                        except ValueError:
                            pw_vals.append(0.0)
                            
                    data.append([ts] + pw_vals)
                    
            out_dir = DATA_DIR / farm_id
            out_dir.mkdir(parents=True, exist_ok=True)
            out_json = out_dir / f"pywake_{scen_val}_2023.json"
            
            with open(out_json, "w") as f:
                json.dump({"models": models, "data": data}, f, separators=(",", ":"))
                
            farm_scenarios.append(scen_val)
            print(f"  -> {out_json.name} ({len(data)} rows, {len(models)} models)")
            
        if farm_scenarios:
            results[farm_id] = {
                "scenarios": farm_scenarios,
                "models": all_models
            }
            
    print("\n=== Updating farms.json ===")
    with open(FARMS_JSON_PATH, "r") as f:
        farms_json = json.load(f)
        
    for farm in farms_json["farms"]:
        fid = farm["id"]
        if fid in results:
            res = results[fid]
            existing = farm.get("pywake", {"years": [], "scenarios": [], "models": []})
            
            existing["years"] = sorted(list(set(existing.get("years", []) + [2023])))
            existing["scenarios"] = sorted(list(set(existing.get("scenarios", []) + res["scenarios"])))
            existing["models"] = sorted(list(set(existing.get("models", []) + res["models"])))
            
            farm["pywake"] = existing
            
    with open(FARMS_JSON_PATH, "w") as f:
        json.dump(farms_json, f, indent=2, ensure_ascii=False)
        
    print("Done!")

if __name__ == "__main__":
    process_v4()

