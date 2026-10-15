/**
 * Jury scoring — Google Apps Script server
 * --------------------------------------------------------------
 * Bound to the JURY_ASSESSMENT spreadsheet (Extensions → Apps Script), pushed with clasp.
 * Deploy → New deployment → type "Web app" (appsscript.json already sets
 * "Execute as: Me" and "Who has access: Anyone").
 * The /exec URL serves BOTH the scoring page and its data: there is nothing to host
 * elsewhere and no API_URL to fill in — doGet() injects it into index.html.
 *
 * SOURCE OF TRUTH = THE SPREADSHEET
 *   Every tab whose name starts with "Jury" (JURY 1, Jury 2, Jury 3…) is a jury.
 *   Row 1: headers. Column A: group (team). Column B: jury member.
 *   Columns C onwards, up to "Average" / "Moyenne" / "Completion": the criteria.
 *   → Teams = distinct values of column A, limited to the 12 groups A to L (anything else is ignored);
 *     members = distinct values of column B (duplicates and case ignored); criteria = headers.
 *     Adding a "Jury N" tab or a name in the spreadsheet is enough: the page updates by itself (10 to 30 s).
 *
 * Scores entered in the page are written:
 *   - to the APP_NOTES tab (one row per juror × team, full log);
 *   - to the matching row (group + member) of the "Jury N" tab, criteria columns,
 *     so the existing formulas (Average, Completion, Pax tabs…) stay up to date.
 *
 * Settings managed by the page (APP_CONFIG tab, do not edit by hand): title, scale,
 * closing, criteria weights and descriptions.
 *
 * Default organiser password: organisateur (change it from the page).
 */

const JURY_PREFIX = /^\s*jury\b/i;
const STOP_HEADERS = /^(average|moyenne|completion|compl[eé]tion|total|rang|rank)$/i;
const NOTES_SHEET = 'APP_NOTES';
const CONFIG_SHEET = 'APP_CONFIG';
const WRITE_BACK = true; // also write scores into the "Jury N" tabs
const MAX_CRIT = 10;
const TEAMS = /^[A-L]$/i; // the 12 groups, A to L
const DEFAULT_HASH = 'eb84789239978c5b66ad35a3d0a816b214a1144b44060af4f6be6b5a6c31c7a3'; // "organisateur"
const DEFAULT_SETTINGS = { title: 'Team presentations', scale: { min: 1, max: 4 }, locked: false, closed: false, crit: {} };
const HEAD = ['id', 'jury', 'member', 'team', 'values', 'comment', 'updatedAt', 'Jury', 'Member', 'Team']
  .concat(Array.from({ length: MAX_CRIT }, (_, i) => 'Score ' + (i + 1)))
  .concat(['Average', 'Comment']);

// ---------- HTTP ----------
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || '';
  if (!action) return page();                 // no action: serve the scoring page itself
  if (action === 'state') return json(getState());
  return json({ ok: false, error: 'unknown_action' });
}

/**
 * Serves index.html from this script, with its API_URL set to this very deployment.
 * Nothing to host elsewhere and nothing to fill in by hand: the page and the data
 * live behind the same /exec URL.
 */
function page() {
  // getUrl() returns the domain-scoped form (/a/<domain>/macros/...) inside a Workspace
  // account; strip it so jurors signed into any other Google account are not sent to an
  // account chooser.
  const url = ScriptApp.getService().getUrl().replace(/\/a\/[^/]+\/macros\//, '/macros/');
  const src = HtmlService.createHtmlOutputFromFile('index').getContent();
  const out = src.replace(/const\s+API_URL\s*=\s*'[^']*'\s*;/, 'const API_URL = ' + JSON.stringify(url) + ';');
  if (out === src) throw new Error('API_URL assignment not found in index.html');
  return HtmlService.createHtmlOutput(out)
    .setTitle('Jury scoring')
    .addMetaTag('viewport', 'width=device-width,initial-scale=1,viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'bad_json' }); }
  if (body.action === 'admin') return json({ ok: body.key === adminHash() });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return json({ ok: false, error: 'busy' });
  try {
    switch (body.action) {
      case 'scores': return json(saveScores(body.docs || []));
      case 'config':
        if (body.key !== adminHash()) return json({ ok: false, error: 'forbidden' });
        writeSettings(body.cfg);
        if (body.newHash) PropertiesService.getScriptProperties().setProperty('ADMIN_HASH', String(body.newHash));
        return json({ ok: true, key: adminHash() });
      case 'clear':
        if (body.key !== adminHash()) return json({ ok: false, error: 'forbidden' });
        clearNotes();
        return json({ ok: true });
      default: return json({ ok: false, error: 'unknown_action' });
    }
  } finally {
    CacheService.getScriptCache().remove('state');
    lock.releaseLock();
  }
}

function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function adminHash() { return PropertiesService.getScriptProperties().getProperty('ADMIN_HASH') || DEFAULT_HASH; }

// ---------- reading the "Jury N" tabs ----------
function norm(s) { return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function slug(s) { return norm(s).replace(/ /g, '-') || 'x'; }

/** Builds the juries from the spreadsheet. Returns [{ id, name, sheet, members, teams, criteria, rows }]. */
function readJuries() {
  const out = [];
  const used = {};
  SpreadsheetApp.getActive().getSheets().forEach(sh => {
    const name = sh.getName();
    if (!JURY_PREFIX.test(name)) return;
    const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
    if (lastRow < 1 || lastCol < 2) return;
    const data = sh.getRange(1, 1, lastRow, lastCol).getDisplayValues();
    const head = data[0];
    const criteria = [];
    for (let c = 2; c < head.length && criteria.length < MAX_CRIT; c++) {
      const h = String(head[c] || '').trim();
      if (!h) { if (criteria.length) break; else continue; }
      if (STOP_HEADERS.test(h)) break;
      criteria.push({ id: 'c' + (criteria.length + 1), name: h, col: c + 1 });
    }
    let id = 'j-' + slug(name); while (used[id]) id += '_'; used[id] = 1;
    const members = [], teams = [], seenM = {}, seenT = {}, rows = {};
    for (let r = 1; r < data.length; r++) {
      const g0 = String(data[r][0] || '').trim(), m = String(data[r][1] || '').trim();
      const g = TEAMS.test(g0) ? g0.toUpperCase() : ''; // only groups A to L
      if (g && !seenT[norm(g)]) { seenT[norm(g)] = 1; teams.push({ id: 't-' + slug(g), name: g }); }
      if (m && !seenM[norm(m)]) { seenM[norm(m)] = 1; members.push({ id: 'm-' + slug(m), name: m }); }
      if (g && m) rows['t-' + slug(g) + '|m-' + slug(m)] = r + 1;
    }
    teams.sort((a, b) => a.name.localeCompare(b.name));
    out.push({ id, name: name.trim(), sheet: name, members, teams, criteria, rows });
  });
  return out;
}

/** Configuration sent to the page: spreadsheet structure + page settings. */
function buildConfig(juries) {
  const st = readSettings();
  return {
    source: 'sheet',
    title: st.title, scale: st.scale, locked: !!st.locked, closed: !!st.closed,
    juries: juries.map(J => ({
      id: J.id, name: J.name,
      members: J.members, teams: J.teams,
      criteria: J.criteria.map(c => {
        const o = ((st.crit || {})[J.id] || {})[c.id] || {};
        return { id: c.id, name: c.name, desc: o.desc || '', weight: +o.weight > 0 ? +o.weight : 1 };
      })
    }))
  };
}

// ---------- state ----------
function getState() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('state');
  if (hit) return JSON.parse(hit);
  const cfg = buildConfig(readJuries());
  const sh = notesSheet();
  const scores = {};
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    sh.getRange(2, 1, n, 7).getValues().forEach(r => {
      if (!r[0]) return;
      let values = {};
      try { values = JSON.parse(r[4] || '{}'); } catch (err) {}
      scores[r[0]] = { jury: r[1], member: r[2], team: r[3], values, comment: r[5] || '', updatedAt: r[6] ? String(r[6]) : '' };
    });
  }
  const state = { ok: true, cfg, scores, customPassword: !!PropertiesService.getScriptProperties().getProperty('ADMIN_HASH'), ts: new Date().toISOString() };
  try { cache.put('state', JSON.stringify(state), 4); } catch (err) {}
  return state;
}

// ---------- scores ----------
function notesSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(NOTES_SHEET);
  if (!sh) {
    sh = ss.insertSheet(NOTES_SHEET);
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideColumns(1, 7); // technical columns
  }
  return sh;
}

function saveScores(docs) {
  const juries = readJuries();
  const cfg = buildConfig(juries);
  const sh = notesSheet();
  const n = Math.max(0, sh.getLastRow() - 1);
  const existing = n ? sh.getRange(2, 1, n, 7).getValues() : [];
  const rowOf = {}, atOf = {};
  existing.forEach((r, i) => { rowOf[String(r[0])] = i + 2; atOf[String(r[0])] = String(r[6] || ''); });
  const saved = [];
  let next = sh.getLastRow() + 1;
  docs.forEach(d => {
    if (!d || !d.id || !/^[\w:.-]+__[\w:.-]+__[\w:.-]+$/.test(d.id)) return;
    // Last write wins (device timestamp): an older copy never overwrites a newer one.
    if (atOf[d.id] && d.updatedAt && String(d.updatedAt) < atOf[d.id]) { saved.push(d.id); return; }
    const row = rowFor(cfg, d);
    const r = rowOf[d.id] || next++;
    sh.getRange(r, 1, 1, row.length).setValues([row]);
    rowOf[d.id] = r; atOf[d.id] = String(d.updatedAt || '');
    if (WRITE_BACK) writeBack(juries, d);
    saved.push(d.id);
  });
  return { ok: true, saved };
}

/** Copies the scores into the (group, member) row of the "Jury N" tab. */
function writeBack(juries, d) {
  const J = juries.find(j => j.id === d.jury); if (!J || !J.criteria.length) return;
  const r = J.rows[d.team + '|' + d.member]; if (!r) return;
  const sh = SpreadsheetApp.getActive().getSheetByName(J.sheet); if (!sh) return;
  const vals = d.values || {};
  J.criteria.forEach(c => {
    const v = vals[c.id];
    sh.getRange(r, c.col).setValue(typeof v === 'number' ? v : '');
  });
}

function rowFor(cfg, d) {
  const J = (cfg.juries || []).find(j => j.id === d.jury) || { criteria: [], members: [], teams: [] };
  const m = J.members.find(x => x.id === d.member);
  const t = J.teams.find(x => x.id === d.team);
  const vals = d.values || {};
  const notes = [];
  let s = 0, w = 0, filled = 0;
  for (let i = 0; i < MAX_CRIT; i++) {
    const c = J.criteria[i];
    const v = c ? vals[c.id] : '';
    notes.push(typeof v === 'number' ? v : '');
    if (c && typeof v === 'number') { const wt = +c.weight > 0 ? +c.weight : 1; s += v * wt; w += wt; filled++; }
  }
  const complete = J.criteria.length && filled === J.criteria.length;
  return [d.id, d.jury, d.member, d.team, JSON.stringify(vals), String(d.comment || ''), String(d.updatedAt || new Date().toISOString()),
    J.name || d.jury, m ? m.name : d.member, t ? t.name : d.team]
    .concat(notes).concat([complete ? Math.round(s / w * 100) / 100 : '', String(d.comment || '')]);
}

function clearNotes() {
  const sh = notesSheet();
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.deleteRows(2, n);
  if (!WRITE_BACK) return;
  readJuries().forEach(J => {
    const s = SpreadsheetApp.getActive().getSheetByName(J.sheet);
    const last = s.getLastRow();
    if (last > 1) J.criteria.forEach(c => s.getRange(2, c.col, last - 1, 1).clearContent());
  });
}

// ---------- settings ----------
function readSettings() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG_SHEET);
  const raw = sh ? String(sh.getRange('A1').getValue() || '') : '';
  if (!raw) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  try { return Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), JSON.parse(raw)); } catch (err) { return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); }
}

/** Keeps only what the page is allowed to change from the received configuration. */
function writeSettings(cfg) {
  if (!cfg) throw new Error('invalid config');
  const crit = {};
  (cfg.juries || []).forEach(J => {
    crit[J.id] = {};
    (J.criteria || []).forEach(c => { crit[J.id][c.id] = { weight: +c.weight > 0 ? +c.weight : 1, desc: String(c.desc || '') }; });
  });
  const st = {
    title: String(cfg.title || DEFAULT_SETTINGS.title),
    scale: { min: Math.round(+((cfg.scale || {}).min) || 1), max: Math.round(+((cfg.scale || {}).max) || 4) },
    locked: !!cfg.locked, closed: !!cfg.closed, crit
  };
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CONFIG_SHEET);
  if (!sh) { sh = ss.insertSheet(CONFIG_SHEET); sh.getRange('B1').setValue('Do not edit by hand: settings managed by the scoring page.'); }
  sh.getRange('A1').setValue(JSON.stringify(st));
}
