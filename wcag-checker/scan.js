#!/usr/bin/env node
'use strict';

/*
 * wcag-url-checker — audit a list of URLs for accessibility compliance.
 *
 * Runs axe-core (via Playwright/Chromium) against each URL, maps each finding
 * to WCAG / ADA / EAA / Section 508, scores every page, and writes JSON, CSV
 * and a self-contained HTML report.
 *
 * Usage:
 *   node scan.js https://example.com https://example.com/about
 *   node scan.js --input urls.txt --out report --standards WCAG,ADA,508 --level AA
 *
 * Automated tooling reliably catches ~30–50% of WCAG issues — always pair the
 * output with manual keyboard / screen-reader testing.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// Find an already-installed Chromium under PLAYWRIGHT_BROWSERS_PATH, so the tool
// still runs in sandboxes where Playwright can't download its pinned build.
// On a normal machine this returns null and Playwright uses its managed browser.
function findLocalChromium() {
  if (process.env.PW_CHROMIUM_PATH && fs.existsSync(process.env.PW_CHROMIUM_PATH)) {
    return process.env.PW_CHROMIUM_PATH;
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return null;
  const candidates = [];
  for (const dir of fs.readdirSync(root)) {
    if (!/^chromium(-|_)/.test(dir)) continue;
    candidates.push(
      path.join(root, dir, 'chrome-linux', 'chrome'),
      path.join(root, dir, 'chrome-linux', 'headless_shell'),
      path.join(root, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    );
  }
  // prefer full chrome over headless_shell
  return candidates.find((p) => /chrome$/.test(p) && fs.existsSync(p))
      || candidates.find((p) => fs.existsSync(p))
      || null;
}

async function launchChromium(launchOpts) {
  try {
    return await chromium.launch(launchOpts);
  } catch (err) {
    const local = findLocalChromium();
    if (local) {
      console.warn(`(using pre-installed Chromium at ${local})`);
      return chromium.launch({ ...launchOpts, executablePath: local });
    }
    throw err;
  }
}
const { AxeBuilder } = require('@axe-core/playwright');
const { standardsFor, resolveStandardKey } = require('./standards');
const { toCsv, toHtml } = require('./report');

const SEV_WEIGHT = { critical: 8, serious: 5, moderate: 3, minor: 1 };

function parseArgs(argv) {
  const o = {
    urls: [], input: null, out: 'report', level: 'AA',
    standards: ['WCAG', 'ADA', 'EAA', 'Section 508'],
    concurrency: 3, timeout: 30000, wait: 'load',
    bestPractice: false, region: 'United States', help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-i': case '--input': o.input = next(); break;
      case '-o': case '--out': o.out = next(); break;
      case '--level': o.level = String(next()).toUpperCase(); break;
      case '--standards': o.standards = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--concurrency': o.concurrency = Math.max(1, parseInt(next(), 10) || 3); break;
      case '--timeout': o.timeout = parseInt(next(), 10) || 30000; break;
      case '--wait': o.wait = next(); break;
      case '--region': o.region = next(); break;
      case '--best-practice': o.bestPractice = true; break;
      default:
        if (a.startsWith('-')) { console.error(`Unknown option: ${a}`); process.exit(2); }
        o.urls.push(a);
    }
  }
  return o;
}

const HELP = `wcag-url-checker — accessibility compliance scanner (WCAG · ADA · EAA · Section 508)

USAGE
  node scan.js <url...> [options]
  node scan.js --input urls.txt [options]

OPTIONS
  -i, --input <file>      Read URLs from a file (one per line; # comments allowed)
  -o, --out <dir>         Output directory for reports        (default: report)
      --standards <list>  Comma list: WCAG,ADA,EAA,508        (default: all four)
      --level <A|AA|AAA>  WCAG conformance level              (default: AA)
      --concurrency <n>   Pages scanned in parallel           (default: 3)
      --timeout <ms>      Per-page navigation timeout         (default: 30000)
      --wait <state>      load | domcontentloaded | networkidle (default: load)
      --best-practice     Include axe best-practice rules (beyond WCAG)
      --region <name>     Label shown on the report           (default: United States)
  -h, --help              Show this help

OUTPUT (in --out dir)
  report.json   full machine-readable results
  report.csv    one row per finding
  report.html   shareable dashboard (open in a browser)

Automated checks catch ~30–50% of WCAG issues. Combine with manual testing.`;

function normalizeUrl(u) {
  u = String(u).trim();
  if (!u || u.startsWith('#')) return null;
  // preserve an explicit scheme (http, https, file); only default bare hosts to https
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).href; } catch { return null; }
}

function readUrlList(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(normalizeUrl).filter(Boolean);
}

// Pull the human-readable WCAG success criterion out of a rule's tags,
// e.g. "wcag111" -> "WCAG 1.1.1", "wcag2aa" (level tag) is skipped.
function wcagCriterion(tags) {
  const m = tags.map((t) => /^wcag(\d)(\d)(\d+)$/.exec(t)).find(Boolean);
  if (m) return `WCAG ${m[1]}.${m[2]}.${m[3]}`;
  if (tags.includes('section508')) return 'Section 508';
  if (tags.includes('EN-301-549')) return 'EN 301 549';
  return 'Best practice';
}

function firstSample(nodes) {
  if (!nodes || !nodes.length) return '';
  const html = (nodes[0].html || '').trim();
  return html.length > 220 ? html.slice(0, 217) + '…' : html;
}

async function auditPage(browser, url, opts, standards) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (wcag-url-checker; +accessibility audit)',
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: opts.wait, timeout: opts.timeout });
    // give late-rendering content a moment to settle
    await page.waitForTimeout(400);

    const runTags = new Set();
    for (const key of Object.keys(standards)) standards[key].tags.forEach((t) => runTags.add(t));
    if (opts.bestPractice) runTags.add('best-practice');

    const axe = new AxeBuilder({ page }).withTags(Array.from(runTags));
    const res = await axe.analyze();

    let deduct = 0;
    const sev = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    const violations = res.violations.map((v) => {
      const impact = v.impact || 'minor';
      const count = v.nodes.length;
      sev[impact] = (sev[impact] || 0) + count;
      deduct += (SEV_WEIGHT[impact] || 1) * count;
      const affected = Object.keys(standards).filter((name) =>
        v.tags.some((t) => standards[name].tags.includes(t)));
      return {
        id: v.id, impact, count,
        help: v.help, description: v.description, helpUrl: v.helpUrl,
        wcag: wcagCriterion(v.tags), tags: v.tags,
        standards: affected.length ? affected : ['Best practice'],
        sample: firstSample(v.nodes),
      };
    })
    // keep only findings that touch at least one selected standard (unless best-practice mode)
    .filter((v) => opts.bestPractice || v.standards.some((s) => s !== 'Best practice'));

    const score = Math.max(0, Math.min(100, Math.round(100 - deduct)));
    return {
      url, score, sev, violations,
      passes: res.passes.length, incomplete: res.incomplete.length,
      axeVersion: res.testEngine && res.testEngine.version,
    };
  } catch (err) {
    return { url, error: err.message || String(err), score: 0, sev: {}, violations: [] };
  } finally {
    await context.close();
  }
}

// simple concurrency pool
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return out;
}

function color(s) { return s >= 90 ? '\x1b[32m' : s >= 70 ? '\x1b[33m' : '\x1b[31m'; }
const RESET = '\x1b[0m';

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  let urls = opts.urls.map(normalizeUrl).filter(Boolean);
  if (opts.input) urls = urls.concat(readUrlList(opts.input));
  urls = Array.from(new Set(urls));
  if (!urls.length) { console.error('No valid URLs given. Use --help for usage.'); process.exit(2); }

  // resolve requested standards
  const catalog = standardsFor(opts.level);
  const standards = {};
  for (const s of opts.standards) {
    const key = resolveStandardKey(s);
    if (key && catalog[key]) standards[key] = catalog[key];
    else console.warn(`Skipping unknown standard: "${s}"`);
  }
  if (!Object.keys(standards).length) { console.error('No valid standards selected.'); process.exit(2); }

  console.log(`\nScanning ${urls.length} URL(s) against ${Object.keys(standards).join(', ')} (WCAG ${opts.level})…\n`);

  const launchOpts = { headless: true };
  // Respect an outbound proxy if the environment mandates one.
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (proxy) launchOpts.proxy = { server: proxy };

  const browser = await launchChromium(launchOpts);
  let axeVersion = '';
  const results = await mapPool(urls, opts.concurrency, async (url) => {
    const r = await auditPage(browser, url, opts, standards);
    if (r.axeVersion) axeVersion = r.axeVersion;
    const short = url.replace(/^https?:\/\//, '');
    if (r.error) console.log(`  \x1b[31m✗\x1b[0m ${short} — ${r.error}`);
    else console.log(`  ${color(r.score)}${String(r.score).padStart(3)}${RESET}  ${short}  (${r.violations.length} issue type${r.violations.length === 1 ? '' : 's'})`);
    return r;
  });
  await browser.close();

  // write outputs
  const outDir = path.resolve(opts.out);
  fs.mkdirSync(outDir, { recursive: true });
  const meta = {
    region: opts.region, level: opts.level, date: new Date().toLocaleString(),
    standards, axeVersion,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'),
    JSON.stringify({ meta: { ...meta, standards: Object.keys(standards) }, results }, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.csv'), toCsv(results));
  fs.writeFileSync(path.join(outDir, 'report.html'), toHtml(results, meta));

  const ok = results.filter((r) => !r.error);
  const avg = ok.length ? Math.round(ok.reduce((a, r) => a + r.score, 0) / ok.length) : 0;
  const totals = results.reduce((a, r) => {
    for (const k of ['critical', 'serious', 'moderate', 'minor']) a[k] += (r.sev[k] || 0);
    return a;
  }, { critical: 0, serious: 0, moderate: 0, minor: 0 });

  console.log(`\n─────────────────────────────────────────`);
  console.log(`Average score: ${color(avg)}${avg}${RESET}/100`);
  console.log(`Findings: ${totals.critical} critical · ${totals.serious} serious · ${totals.moderate} moderate · ${totals.minor} minor`);
  console.log(`Reports written to ${path.relative(process.cwd(), outDir) || '.'}/  (report.html · report.csv · report.json)\n`);

  // non-zero exit if any critical issues, useful for CI gating
  if (totals.critical > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
