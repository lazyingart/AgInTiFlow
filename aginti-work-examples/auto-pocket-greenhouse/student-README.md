# Pocket Greenhouse Monitor

A lightweight sensor-monitoring prototype for a pocket greenhouse. Logs temperature, humidity, light, and watering data for basil and mint plants, and flags risk conditions (heat, drought, excessive light).

## Project Structure

```
.
├── README.md                       ← this file
├── REPORT.md                       ← audit report & findings
├── .gitignore
├── data/
│   ├── sensor_readings.csv         ← 12 validated sensor rows (Apr 28 – May 1)
│   ├── clean_sensor_readings.csv   ← same data, ready for downstream use
│   └── odd_rows.csv                ← 2 rows flagged as suspect sensor errors
├── notes/
│   └── random-todo.txt             ← old scratchpad todo
├── raw/
│   └── lab-notes-mixed.md          ← informal greenhouse lab notes
└── scripts/
    └── analyze.py                  ← Python analysis script (syntax-fixed)
```

## Quick Start

```bash
python3 scripts/analyze.py
```

Outputs: row count, counts of hot/dry/bright readings, and a list of risk rows.

## Risk Thresholds (from lab notes)

| Condition      | Threshold        |
|----------------|------------------|
| Hot            | temp_c > 31      |
| Dry (low humidity) | humidity_pct < 38 |
| Bright         | light_lux > 76000 |

## Data Quality

- **12 clean rows** in `sensor_readings.csv` – all within plausible sensor ranges.
- **2 flagged rows** in `odd_rows.csv`:
  - 2026-04-29T13:00 mint — humidity=350% (spike, exclude)
  - 2026-04-30T13:00 basil — light=-10 lux (impossible, exclude)

## Notes

The original `README-fragment.txt` and scratchpad `notes/random-todo.txt` are
left in place for history. Their relevant content has been captured here and in
`REPORT.md`.

## Findings (from audit)

- All noon readings on all days showed at least one stress condition.
- Mint on 2026-04-29 noon was the most stressed (hot + dry + bright).
- Plants were never watered at noon (water_ml=0 in all noon rows) — consider automated midday watering.
- The analysis script had a syntax bug (`main(` was missing the closing `)`) — now fixed.
