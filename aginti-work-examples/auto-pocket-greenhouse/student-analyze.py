from __future__ import annotations

import csv
from pathlib import Path


DATA = Path("data/sensor_readings.csv")


def load_rows():
    with DATA.open(newline="") as handle:
        return list(csv.DictReader(handle))


def main():
    rows = load_rows()
    hot = [row for row in rows if float(row["temp_c"]) > 31]
    dry = [row for row in rows if float(row["humidity_pct"]) < 38]
    bright = [row for row in rows if float(row["light_lux"]) > 76000]
    print(f"rows={len(rows)} hot={len(hot)} dry={len(dry)} bright={len(bright)}")
    print("risk rows:")
    seen = set()
    for row in rows:
        flags = []
        ts = row["timestamp"]
        plant = row["plant"]
        if float(row["temp_c"]) > 31:
            flags.append("hot")
        if float(row["humidity_pct"]) < 38:
            flags.append("dry")
        if float(row["light_lux"]) > 76000:
            flags.append("bright")
        if not flags:
            continue
        key = (ts, plant)
        if key in seen:
            continue
        seen.add(key)
        print(f"- {ts} {plant} temp={row['temp_c']} humidity={row['humidity_pct']} light={row['light_lux']} flags={'+'.join(flags)}")


if __name__ == "__main__":
    main()
