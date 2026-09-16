# wcag-url-checker

Audit a **list of website URLs** for accessibility compliance with **WCAG 2.2**,
**ADA**, **EAA (EN 301 549)** and **Section 508** — from the command line.

It drives real Chromium (Playwright) + [axe-core](https://github.com/dequelabs/axe-core),
scores every page, maps each finding to the standards it affects, and writes a
JSON, CSV and shareable HTML report.

> ⚠️ Automated tools reliably catch **~30–50%** of WCAG issues. Treat this as the
> first pass and pair it with manual keyboard + screen-reader testing.

## Install

```bash
cd wcag-checker
npm install
npx playwright install chromium   # first run only, downloads the browser
```

## Usage

```bash
# one or more URLs
node scan.js https://example.com https://example.com/pricing

# a list from a file (one URL per line, # comments allowed)
node scan.js --input urls.txt

# choose standards + level, run 5 in parallel
node scan.js -i urls.txt --standards WCAG,ADA,508 --level AA --concurrency 5
```

Reports are written to `./report/` (override with `-o <dir>`):

| File | What it is |
|------|-----------|
| `report.html` | Shareable dashboard — open in any browser |
| `report.csv`  | One row per finding (spreadsheet / BI friendly) |
| `report.json` | Full machine-readable results (CI, dashboards) |

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `-i, --input <file>` | – | Read URLs from a file |
| `-o, --out <dir>` | `report` | Output directory |
| `--standards <list>` | `WCAG,ADA,EAA,508` | Comma list (aliases: `508`, `en-301-549`) |
| `--level <A\|AA\|AAA>` | `AA` | WCAG conformance level |
| `--concurrency <n>` | `3` | Pages scanned in parallel |
| `--timeout <ms>` | `30000` | Per-page navigation timeout |
| `--wait <state>` | `load` | `load` \| `domcontentloaded` \| `networkidle` |
| `--best-practice` | off | Include axe best-practice rules beyond WCAG |
| `--region <name>` | `United States` | Label shown on the report |

## How standards are mapped

Every regime is anchored on WCAG success criteria; each finding's axe tags are
matched against the tag set for each standard:

| Standard | Baseline | axe tags used |
|----------|----------|---------------|
| WCAG | 2.2 AA | `wcag2a/aa`, `wcag21a/aa`, `wcag22aa` |
| ADA (Title III) | WCAG 2.1 AA | `wcag2a/aa`, `wcag21a/aa` |
| EAA / EN 301 549 | WCAG 2.1 AA | `EN-301-549` + WCAG 2.1 |
| Section 508 | WCAG 2.0 AA | `section508` + WCAG 2.0 |

So a WCAG 2.2-only criterion (e.g. 2.5.8 Target Size) counts against **WCAG** but
not against ADA/EAA/508 — matching how those laws are enforced today.

## Scoring

Each page starts at 100; points are deducted per occurrence by impact
(critical −8, serious −5, moderate −3, minor −1), floored at 0.

- **90–100** Compliant · **70–89** Partially compliant · **<70 or any critical** Non-compliant

## CI usage

The process exits with code **1** when any **critical** issues are found, so it
can gate a pipeline:

```yaml
- run: node wcag-checker/scan.js --input urls.txt --out report
```

## Notes

- Bare hostnames are upgraded to `https://` automatically.
- Set `HTTPS_PROXY` to route Chromium through a proxy; `PW_CHROMIUM_PATH` to point
  at a specific Chromium binary.
