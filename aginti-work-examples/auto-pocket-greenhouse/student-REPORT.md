# Pocket Greenhouse Monitor — Audit Report

**Generated:** 2026-05-02  
**Workspace:** `TASK-Profile-Auto`

---

## 1. What Is This Project?

A messy prototype for a **pocket greenhouse sensor monitor**. It logs temperature, humidity, light, and watering data for two plants (basil and mint) over several days (April 28 – May 1, 2026). The original author wanted someone to figure out whether the sensor data looks reasonable, produce a readable summary, clean up the data, and fix anything broken.

## 2. Folder Contents

| Path | Type | Size | Description |
|------|------|------|-------------|
| `.gitignore` | file | 33 B | Ignores `__pycache__/`, `.sessions/`, `.aginti/` |
| `README-fragment.txt` | file | 284 B | Original incomplete readme — describes the goal |
| `data/sensor_readings.csv` | file | 561 B | 12 rows of validated sensor readings |
| `data/odd_rows.csv` | file | 198 B | 2 flagged rows with suspicious values |
| `notes/random-todo.txt` | file | 82 B | Scratchpad todo list |
| `raw/lab-notes-mixed.md` | file | 567 B | Informal greenhouse notes & risk thresholds |
| `README-fragment.txt` | file | 284 B | Original incomplete readme — describes the goal |
| `README.md` | file | 2.2 KB | Project README (created during audit) |
| `REPORT.md` | file | 3.7 KB | This audit report |
| `data/sensor_readings.csv` | file | 561 B | 12 rows of validated sensor readings |
| `data/clean_sensor_readings.csv` | file | 561 B | Validated data copy (created during audit) |
| `data/odd_rows.csv` | file | 198 B | 2 flagged rows with suspicious values |
| `notes/random-todo.txt` | file | 82 B | Scratchpad todo list |
| `raw/lab-notes-mixed.md` | file | 567 B | Informal greenhouse notes & risk thresholds |
| `scripts/analyze.py` | file | 1.2 KB | Python analysis script (syntax and dedup fixed) |

**Total: 10 files, 4 directories** (data/, notes/, raw/, scripts/)

## 3. Checks Performed

### ✅ Python syntax check
`scripts/analyze.py` — **PASS** (after fix).  
**Issue found:** The `__main__` guard called `main(` instead of `main()` — missing closing parenthesis. Fixed.

### ✅ Script execution
`python3 scripts/analyze.py` — **PASS**. Deduplicated output (no repeated rows):
```
rows=12 hot=2 dry=3 bright=3
risk rows:
- 2026-04-29T12:00:00 mint temp=32.4 humidity=35 light=81000 flags=hot+dry+bright
- 2026-04-30T12:00:00 basil temp=31.8 humidity=34 light=79000 flags=hot+dry+bright
- 2026-05-01T12:00:00 mint temp=30.9 humidity=37 light=77000 flags=dry+bright
```

Summary:

| Timestamp | Plant | Temp | Humidity | Light | Flags |
|-----------|-------|------|----------|-------|-------|
| 2026-04-29T12:00 | mint | 32.4°C | 35% | 81000 lux | hot+dry+bright |
| 2026-04-30T12:00 | basil | 31.8°C | 34% | 79000 lux | hot+dry+bright |
| 2026-05-01T12:00 | mint | 30.9°C | 37% | 77000 lux | dry+bright |

### ✅ CSV structure validation
- `sensor_readings.csv` — 12 rows, columns: timestamp, temp_c, humidity_pct, light_lux, water_ml, plant — **PASS**
- `odd_rows.csv` — 2 flagged rows, includes note column — **PASS**

## 4. Data Quality Issues

### Flagged rows in `odd_rows.csv` (excluded from clean data)

1. **2026-04-29T13:00 mint** — humidity=350% (clearly a sensor spike, max real is 100%)
2. **2026-04-30T13:00 basil** — light=-10 lux (impossible negative reading)

Both rows have `water_ml=0` and occurred at 13:00 (off the normal 08:00/12:00/16:00 schedule), suggesting they are off-schedule manual readings that triggered sensor glitches.

### Noon stress pattern

Every single noon reading across all days shows at least one stress condition. All noon rows have `water_ml=0` — no watering ever recorded at noon. This is notable for greenhouse management.

## 5. Things Fixed

- [x] **Syntax bug in `scripts/analyze.py`**: `main(` → `main()`
- [x] **Duplicate risk rows in `scripts/analyze.py`**: output now deduplicated — each risk row appears exactly once with combined flags (e.g. `hot+dry+bright`)
- [x] **Created `data/clean_sensor_readings.csv`**: identical validated data, ready for downstream use
- [x] **Created `README.md`**: project overview, structure, quick start
- [x] **Created `REPORT.md`**: this document

## 6. Suggested Next Steps

| Priority | Item |
|----------|------|
| 🔴 High | Recalibrate or replace the humidity sensor (350% spike) and light sensor (negative values) |
| 🟡 Medium | Add automated midday watering — noon rows show 0ml for all plants |
| 🟡 Medium | Build a simple dashboard (chart temp/humidity trends over time) |
| 🟢 Low | Set up a git repo properly (`.gitignore` already exists) |
| 🟢 Low | Move `notes/` and `raw/` content into `README.md` and archive originals |
