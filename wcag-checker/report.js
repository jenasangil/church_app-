'use strict';

// Report renderers: CSV and a self-contained HTML dashboard.
// Kept dependency-free so the output opens in any browser.

const SEV_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function csvCell(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

function toCsv(results) {
  const rows = [['URL', 'Status', 'Score', 'Severity', 'Rule', 'WCAG / Criterion', 'Impact', 'Occurrences', 'Standards', 'Help URL']];
  for (const r of results) {
    if (r.error) {
      rows.push([r.url, 'ERROR', '', '', r.error, '', '', '', '', '']);
      continue;
    }
    if (!r.violations.length) {
      rows.push([r.url, 'OK', r.score, '', 'No violations detected', '', '', 0, '', '']);
      continue;
    }
    for (const v of r.violations) {
      rows.push([
        r.url, 'ISSUES', r.score, v.impact, v.id, v.wcag, v.impact,
        v.count, v.standards.join(' / '), v.helpUrl,
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function verdict(score, sev) {
  if ((sev.critical || 0) > 0 || score < 70) return { key: 'fail', label: 'Non-compliant' };
  if ((sev.serious || 0) > 0 || score < 90) return { key: 'partial', label: 'Partially compliant' };
  return { key: 'pass', label: 'Compliant' };
}

function standardStatus(result, standardTags) {
  let crit = 0, serious = 0, other = 0;
  for (const v of result.violations || []) {
    if (!v.tags.some((t) => standardTags.includes(t))) continue;
    if (v.impact === 'critical') crit += v.count;
    else if (v.impact === 'serious') serious += v.count;
    else other += v.count;
  }
  if (crit > 0) return { key: 'fail', label: 'Non-compliant', n: crit + serious + other };
  if (serious > 0 || other > 2) return { key: 'partial', label: 'Partially compliant', n: serious + other };
  return { key: 'pass', label: 'Compliant', n: other };
}

function toHtml(results, meta) {
  const standards = meta.standards; // { name: {label, tags} }
  const okResults = results.filter((r) => !r.error);
  const avg = okResults.length
    ? Math.round(okResults.reduce((a, r) => a + r.score, 0) / okResults.length)
    : 0;
  const agg = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const r of okResults) for (const k of Object.keys(agg)) agg[k] += (r.sev[k] || 0);

  const scoreColor = (s) => (s >= 90 ? '#1E7B34' : s >= 70 ? '#8A5A00' : '#B21E1E');
  const badgeCls = { pass: 'st-pass', partial: 'st-partial', fail: 'st-fail' };

  const stdBadges = Object.entries(standards).map(([name, cfg]) => {
    // worst status across all scanned URLs for this standard
    let worst = { key: 'pass', label: 'Compliant', n: 0 };
    const rank = { pass: 0, partial: 1, fail: 2 };
    for (const r of okResults) {
      const st = standardStatus(r, cfg.tags);
      if (rank[st.key] > rank[worst.key]) worst = st;
      else if (rank[st.key] === rank[worst.key]) worst.n = Math.max(worst.n, st.n);
    }
    return `<div class="sbadge">
      <div class="h"><div class="nm">${esc(name)}</div>
      <span class="status ${badgeCls[worst.key]}">${worst.label}</span></div>
      <div class="full">${esc(cfg.label)}</div></div>`;
  }).join('');

  const urlSections = results.map((r, i) => {
    if (r.error) {
      return `<section class="card urlcard"><div class="uh"><h3>${esc(r.url)}</h3>
        <span class="status st-fail">Scan error</span></div>
        <p class="err">${esc(r.error)}</p></section>`;
    }
    const v = verdict(r.score, r.sev);
    const issues = r.violations.slice().sort((a, b) => SEV_ORDER[a.impact] - SEV_ORDER[b.impact]).map((vi) => `
      <details class="issue">
        <summary>
          <span class="sevtag ${vi.impact}">${vi.impact}</span>
          <span class="it">${esc(vi.help)}<span class="sc">${esc(vi.id)} · ${esc(vi.wcag)}</span></span>
          <span class="cnt">${vi.count}×</span>
        </summary>
        <div class="body">
          <p>${esc(vi.description)}</p>
          <div class="k">Affects</div><div class="chips">${vi.standards.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>
          ${vi.sample ? `<div class="k">Example element</div><pre>${esc(vi.sample)}</pre>` : ''}
          <a href="${esc(vi.helpUrl)}" target="_blank" rel="noopener">How to fix →</a>
        </div>
      </details>`).join('');
    return `<section class="card urlcard">
      <div class="uh">
        <h3>${esc(r.url)}</h3>
        <span class="score" style="color:${scoreColor(r.score)};background:${scoreColor(r.score)}1f">${r.score}</span>
        <span class="status ${badgeCls[v.key]}">${v.label}</span>
      </div>
      <div class="sevline">
        <span><b style="color:#B21E1E">${r.sev.critical || 0}</b> critical</span>
        <span><b style="color:#B5480F">${r.sev.serious || 0}</b> serious</span>
        <span><b style="color:#8A5A00">${r.sev.moderate || 0}</b> moderate</span>
        <span><b style="color:#3F6087">${r.sev.minor || 0}</b> minor</span>
      </div>
      ${issues || '<p class="clean">No automated violations detected. Manual review still recommended.</p>'}
    </section>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accessibility Compliance Report</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#eef1f6;color:#12141a;line-height:1.5}
  @media(prefers-color-scheme:dark){body{background:#0f131a;color:#eef1f6}.card{background:#161b23!important;border-color:#262d38!important}pre{background:#1d232c!important}}
  .wrap{max-width:1000px;margin:0 auto;padding:32px 20px}
  h1{font-size:26px;letter-spacing:-.02em;margin:0}
  .meta{color:#697184;font-size:13px;margin-top:6px}
  .card{background:#fff;border:1px solid #dce1ea;border-radius:14px;padding:18px;margin-top:16px}
  .summary{display:flex;gap:24px;flex-wrap:wrap;align-items:center}
  .big{font-size:44px;font-weight:800;letter-spacing:-.02em}
  .sevrow{display:flex;gap:18px;flex-wrap:wrap;font-size:13px;color:#3f4756}
  .sevrow b{font-size:18px}
  .badges{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:14px}
  .sbadge{border:1px solid #dce1ea;border-radius:12px;padding:12px}
  @media(prefers-color-scheme:dark){.sbadge{border-color:#262d38}}
  .sbadge .h{display:flex;justify-content:space-between;gap:8px;align-items:center}
  .nm{font-weight:800}
  .full{font-size:11px;color:#697184;margin-top:4px}
  .status{font-size:11px;font-weight:800;padding:4px 9px;border-radius:999px;white-space:nowrap}
  .st-pass{background:#e3f4e7;color:#1e7b34}.st-partial{background:#fbf0d6;color:#8a5a00}.st-fail{background:#fbe4e4;color:#b21e1e}
  .uh{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .uh h3{margin:0;font-size:15px;word-break:break-all;flex:1;min-width:180px}
  .score{font-weight:800;padding:3px 11px;border-radius:999px;font-variant-numeric:tabular-nums}
  .sevline{display:flex;gap:16px;flex-wrap:wrap;font-size:12.5px;color:#697184;margin:10px 0 6px}
  .issue{border:1px solid #eaedf3;border-radius:11px;margin-top:9px;overflow:hidden}
  @media(prefers-color-scheme:dark){.issue{border-color:#1e242d}}
  .issue summary{display:flex;gap:11px;align-items:center;padding:11px 13px;cursor:pointer}
  .sevtag{font-size:10px;font-weight:800;text-transform:uppercase;padding:3px 8px;border-radius:6px;white-space:nowrap}
  .sevtag.critical{background:#fbe4e4;color:#b21e1e}.sevtag.serious{background:#fbeadf;color:#b5480f}
  .sevtag.moderate{background:#fbf0d6;color:#8a5a00}.sevtag.minor{background:#e7eef7;color:#3f6087}
  .it{flex:1;min-width:0;font-size:13.5px;font-weight:700}
  .it .sc{display:block;font-size:11px;color:#697184;font-weight:600;margin-top:2px}
  .cnt{font-weight:800;color:#697184;font-size:12px}
  .issue .body{padding:0 13px 13px;font-size:13px;color:#3f4756}
  @media(prefers-color-scheme:dark){.issue .body{color:#b3bccb}}
  .k{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#697184;margin-top:10px}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
  .chip{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:6px;background:#f0f3f8;color:#3f4756}
  @media(prefers-color-scheme:dark){.chip{background:#1d232c;color:#b3bccb}}
  pre{background:#f0f3f8;border-radius:8px;padding:9px 11px;font-size:12px;overflow-x:auto;margin-top:5px;font-family:ui-monospace,monospace}
  .clean{color:#1e7b34;font-weight:700;padding:8px 0}
  .err{color:#b21e1e;font-weight:600}
  a{color:#2a63b5}
  footer{margin-top:28px;color:#697184;font-size:12px;text-align:center}
</style></head><body><div class="wrap">
  <h1>Accessibility Compliance Report</h1>
  <div class="meta">${okResults.length} of ${results.length} URL(s) scanned · ${esc(meta.region)} · WCAG level ${esc(meta.level)} · ${esc(meta.date)}</div>

  <div class="card">
    <div class="summary">
      <div><div class="big" style="color:${scoreColor(avg)}">${avg}</div><div class="meta">Average score</div></div>
      <div class="sevrow">
        <span><b style="color:#B21E1E">${agg.critical}</b><br>critical</span>
        <span><b style="color:#B5480F">${agg.serious}</b><br>serious</span>
        <span><b style="color:#8A5A00">${agg.moderate}</b><br>moderate</span>
        <span><b style="color:#3F6087">${agg.minor}</b><br>minor</span>
      </div>
    </div>
    <div class="badges">${stdBadges}</div>
  </div>

  ${urlSections}

  <footer>Generated by wcag-url-checker · axe-core ${esc(meta.axeVersion || '')} + Playwright · Automated checks catch ~30–50% of WCAG issues; combine with manual testing.</footer>
</div></body></html>`;
}

module.exports = { toCsv, toHtml, verdict, standardStatus };
