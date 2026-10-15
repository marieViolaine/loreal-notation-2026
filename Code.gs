/**
 * Jury scoring — Google Apps Script server
 * --------------------------------------------------------------
 * STANDALONE script (My Drive, not bound, not in a Shared Drive), pushed with clasp.
 * It opens the JURY_ASSESSMENT spreadsheet by id — see doc() and config.gs.
 * Deploy → New deployment → type "Web app" (appsscript.json already sets
 * "Execute as: Me" and "Who has access: Anyone").
 * The /exec URL serves BOTH the scoring page and its data: there is nothing to host
 * elsewhere and no API_URL to fill in — doGet() injects it into index.html.
 *
 * SOURCE OF TRUTH = THE SPREADSHEET
 *   Every tab whose name starts with "Jury" (JURY 1, Jury 2, Jury 3…) is a jury.
 *   Row 1: headers. Column A: group (team). Column B: jury member.
 *   Columns C onwards, up to "Average" / "Moyenne" / "Completion": the criteria.
 *   → Groups = the runs of identical values in column A, read as they come and in sheet order;
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
const WEIGHT_SHEET = 'PONDERATION-JURY'; // NOM_CRITERE | JURY | PONDERATION | Vue_coup_coeur
// Column D marks the criteria that also feed the "Favourite" average. Accepts the
// spellings a spreadsheet actually produces, in either language.
const FAV_YES = /^(true|vrai|oui|yes|x|o|y|1|\u2713|\u2714)$/i;
const WRITE_BACK = true; // also write scores into the "Jury N" tabs
const MAX_CRIT = 10;
const DEFAULT_HASH = 'eb84789239978c5b66ad35a3d0a816b214a1144b44060af4f6be6b5a6c31c7a3'; // "organisateur"
const DEFAULT_SETTINGS = { title: 'Business lab', scale: { min: 1, max: 4 }, locked: false, closed: false, crit: {} };
const HEAD = ['id', 'jury', 'member', 'team', 'values', 'comment', 'updatedAt', 'Jury', 'Member', 'Team']
  .concat(Array.from({ length: MAX_CRIT }, (_, i) => 'Score ' + (i + 1)))
  .concat(['Average', 'Comment']);

/**
 * The spreadsheet this app reads and writes.
 * SHEET_ID lives in config.gs, which is NOT versioned (public repo) — see README.
 *
 * Deliberately a STANDALONE script opening the sheet by id, not a bound script:
 * a script bound to a file inside a Shared Drive makes Google check Shared Drive
 * membership for every signed-in visitor, which fails with "Impossible d'ouvrir le
 * fichier pour le moment" for jurors. A standalone script in My Drive has no such check.
 */
var DOC_ = null;
function doc() { return DOC_ || (DOC_ = SpreadsheetApp.openById(SHEET_ID)); }

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
    .setTitle('Business lab')
    .addMetaTag('viewport', 'width=device-width,initial-scale=1,viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'bad_json' }); }
  if (body.action === 'admin') return json({ ok: body.key === adminHash() });
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(45000)) return json({ ok: false, error: 'busy' });
  try {
    switch (body.action) {
      case 'join': return json(joinJury(body.jury, body.name));
      case 'leave': return json(leaveJury(body.jury, body.member));
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
  doc().getSheets().forEach(sh => {
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

    // Column A holds one run of identical letters per group: a run is a group block.
    // The Nth row of EVERY block belongs to the same jury member, so claiming a seat
    // takes that row in every group at once -- a member scores all the groups.
    const groups = [], usedT = {};
    for (let r = 1; r < data.length; r++) {
      const v = String(data[r][0] || '').trim();
      if (!v) continue;
      const k = norm(v);
      const last = groups.length ? groups[groups.length - 1] : null;
      if (last && last.key === k) { last.rows.push(r + 1); continue; } // same run = same group block
      let tid = 't-' + slug(v); while (usedT[tid]) tid += '_'; usedT[tid] = 1;
      groups.push({ key: k, id: tid, name: v, rows: [r + 1] });
    }
    const seats = groups.reduce((a, b) => Math.max(a, b.rows.length), 0);

    // Sheet order, not alphabetical: the groups are whatever column A says, so any
    // sort we invent here would reorder them against the organiser's own layout
    // (and "Group 10" would land before "Group 2").
    const teams = groups.map(b => ({ id: b.id, name: b.name }));

    const members = [], rows = {}, seatRows = [], cells = {};
    for (let s = 0; s < seats; s++) {
      const mid = 'm-s' + (s + 1);
      let who = '';
      const mine = [];
      groups.forEach(b => {
        if (s >= b.rows.length) return; // a shorter block simply has no row for this seat
        const row = b.rows[s];
        mine.push({ team: b.id, row: row });
        if (!who) { const v = String(data[row - 1][1] || '').trim(); if (v) who = v; }
      });
      mine.forEach(x => {
        rows[x.team + '|' + mid] = x.row;
        // What the tab itself holds. The spreadsheet is the source of truth, so a
        // score typed straight into the grid has to show up in the app.
        const vals = {};
        criteria.forEach(c => {
          const raw = String(data[x.row - 1][c.col - 1] == null ? '' : data[x.row - 1][c.col - 1]).trim().replace(',', '.');
          const n = parseFloat(raw);
          if (raw !== '' && isFinite(n)) vals[c.id] = n;
        });
        if (Object.keys(vals).length) cells[mid + '|' + x.team] = vals;
      });
      seatRows.push({ id: mid, seat: s, name: who, rows: mine.map(x => x.row) });
      if (who) members.push({ id: mid, name: who, seat: s });
    }
    out.push({ id, name: name.trim(), sheet: name, members, teams, criteria, rows, cells, seats, seatRows });
  });
  return out;
}

/** Matches the JURY column against a jury, accepting "JURY F", "F" or "jury f". */
function matchJury(juries, name) {
  const q = norm(name);
  if (!q) return null;
  const bare = t => norm(t).replace(/^jury\s*/, '');
  return juries.filter(J => norm(J.name) === q)[0]
      || juries.filter(J => bare(J.name) === bare(q))[0]
      || null;
}

/**
 * Per-jury, per-criterion weights read from the PONDERATION-JURY tab.
 *
 * Returns the weights keyed "<juryId>|<critId>", plus the rows it could not
 * match: a mistyped criterion name would otherwise silently leave that
 * criterion at weight 1, which is invisible and changes every average.
 */
function readWeights(juries) {
  const out = { byKey: {}, favByKey: {}, ignored: [] };
  const sh = doc().getSheetByName(WEIGHT_SHEET);
  if (!sh) return out;
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 3) return out;
  const width = Math.min(4, lastCol);
  const data = sh.getRange(2, 1, lastRow - 1, width).getDisplayValues();
  data.forEach((r, i) => {
    const cname = String(r[0] || '').trim();
    const jname = String(r[1] || '').trim();
    const raw = String(r[2] || '').trim();
    // getDisplayValues returns what the cell SHOWS, and parseFloat happily takes a
    // numeric prefix: "25%" became 25, "1/4" became 1, "1 000" became 1. Demand a
    // clean number, decimal comma allowed, and report anything else.
    const num = raw.replace(',', '.');
    const w = /^[0-9]+(\.[0-9]+)?$/.test(num) ? parseFloat(num) : NaN;
    if (!cname && !jname && !raw) return; // blank filler row
    const J = matchJury(juries, jname);
    const c = J ? J.criteria.filter(x => norm(x.name) === norm(cname))[0] : null;
    if (!J || !c) {
      out.ignored.push({ row: i + 2, criterion: cname, jury: jname, weight: raw, why: !J ? 'jury' : 'criterion' });
      return;
    }
    // The row points at a real criterion, so honour its Favourite mark even if the
    // weight itself is unusable -- the two are independent.
    if (width >= 4 && FAV_YES.test(String(r[3] || '').trim())) out.favByKey[J.id + '|' + c.id] = true;
    if (!isFinite(w) || w <= 0) {
      out.ignored.push({ row: i + 2, criterion: cname, jury: jname, weight: raw, why: 'weight' });
      return;
    }
    out.byKey[J.id + '|' + c.id] = w;
  });
  return out;
}

/** Configuration sent to the page: spreadsheet structure + page settings. */
function buildConfig(juries) {
  const st = readSettings();
  const W = readWeights(juries);
  return {
    weightProblems: W.ignored,
    source: 'sheet',
    title: st.title, scale: st.scale, locked: !!st.locked, closed: !!st.closed,
    juries: juries.map(J => ({
      id: J.id, name: J.name,
      members: J.members, teams: J.teams,
      seats: J.seats, free: Math.max(0, J.seats - J.members.length),
      criteria: J.criteria.map(c => {
        const o = ((st.crit || {})[J.id] || {})[c.id] || {};
        // The PONDERATION-JURY tab wins over whatever the Settings page stored:
        // the spreadsheet is the source of truth.
        const fromSheet = W.byKey[J.id + '|' + c.id];
        return { id: c.id, name: c.name, desc: o.desc || '',
          weight: fromSheet != null ? fromSheet : (+o.weight > 0 ? +o.weight : 1),
          fav: !!W.favByKey[J.id + '|' + c.id] };
      })
    }))
  };
}

// ---------- state ----------
function getState() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('state');
  if (hit) return JSON.parse(hit);
  const juries = readJuries();
  const cfg = buildConfig(juries);
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
  // The jury tabs win over APP_NOTES for the scores themselves: APP_NOTES keeps the
  // comments, the timestamps and anything the tabs no longer carry, but a cell typed
  // or cleared by hand in the tab is what the app shows.
  juries.forEach(J => J.members.forEach(m => J.teams.forEach(t => {
    const key = J.id + '__' + m.id + '__' + t.id;
    const vals = (J.cells || {})[m.id + '|' + t.id];
    const prev = scores[key];
    if (vals) {
      scores[key] = { jury: J.id, member: m.id, team: t.id, values: vals,
        comment: prev ? prev.comment : '', updatedAt: prev ? prev.updatedAt : '' };
      return;
    }
    if (!prev) return;
    // The tab holds no value here. Only treat that as "cleared by hand" when the tab
    // COULD have held one: a jury whose headers broke has no criteria at all, and a
    // seat with no row in this group has nowhere to be written. Deleting in those
    // cases wipes scores the spreadsheet never had a chance to store.
    if (!J.criteria.length || !J.rows[t.id + '|' + m.id]) return;
    // A comment lives only in APP_NOTES, so it must survive an empty grid row.
    if (prev.comment) { scores[key] = { jury: J.id, member: m.id, team: t.id, values: {}, comment: prev.comment, updatedAt: prev.updatedAt }; return; }
    delete scores[key];
  })));

  const state = { ok: true, cfg, scores, customPassword: !!PropertiesService.getScriptProperties().getProperty('ADMIN_HASH'), ts: new Date().toISOString() };
  try { cache.put('state', JSON.stringify(state), 4); } catch (err) {}
  return state;
}

// ---------- seats ----------
/**
 * Claims a seat on a jury for a self-declared first name, and writes that name
 * into column B on the member's row of every group. One seat = one row index
 * across all the group blocks, so the member scores every group.
 */
function joinJury(juryId, rawName) {
  const nm = String(rawName == null ? '' : rawName).replace(/\s+/g, ' ').trim();
  if (!nm) return { ok: false, error: 'no_name' };
  if (nm.length > 40) return { ok: false, error: 'name_too_long' };
  const J = readJuries().find(j => j.id === juryId);
  if (!J) return { ok: false, error: 'unknown_jury' };
  if (!J.seats) return { ok: false, error: 'no_seats' };
  // The same name coming back -- another phone, a reload -- reuses its seat
  // instead of burning a new one.
  const again = J.seatRows.find(x => x.name && norm(x.name) === norm(nm));
  if (again) return { ok: true, jury: J.id, member: { id: again.id, name: again.name }, reused: true };
  const free = J.seatRows.find(x => !x.name);
  if (!free) return { ok: false, error: 'jury_full', seats: J.seats };
  const sh = doc().getSheetByName(J.sheet);
  wipeSeat(J, free); // a freed seat must not hand its history to whoever sits down next
  // One call for every group row of the seat: 12 setValue() in a row is the kind
  // of cost that makes the lock overflow when a whole jury signs in at once.
  sh.getRangeList(free.rows.map(r => 'B' + r)).setValue(nm);
  return { ok: true, jury: J.id, member: { id: free.id, name: nm }, reused: false };
}

/**
 * Empties a seat: its APP_NOTES rows and its criteria cells in the jury tab.
 *
 * Scores are keyed by seat, not by name, so without this the next occupant of a
 * seat inherits the previous one's scores -- which is exactly what happens when
 * column B is cleared to start over.
 */
function wipeSeat(J, seat) {
  const prefix = J.id + '__' + seat.id + '__';
  const sh = notesSheet();
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    const ids = sh.getRange(2, 1, n, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) { // bottom-up: deleting shifts the rows below
      if (String(ids[i][0] || '').indexOf(prefix) === 0) sh.deleteRow(i + 2);
    }
  }
  if (!J.criteria.length || !seat.rows.length) return;
  const cols = J.criteria.map(c => c.col);
  const first = Math.min.apply(null, cols), last = Math.max.apply(null, cols);
  const js = doc().getSheetByName(J.sheet);
  if (js) seat.rows.forEach(r => js.getRange(r, first, 1, last - first + 1).clearContent());
}

/**
 * Gives a seat back: clears the name from column B on all of its group rows.
 *
 * Refused as soon as the seat holds a single score, because a seat without a
 * name is a free seat and the next person to claim it wipes its history. Someone
 * who picked the wrong jury can undo it; someone who has started scoring cannot
 * undo it by accident.
 */
function leaveJury(juryId, memberId) {
  const J = readJuries().find(j => j.id === juryId);
  if (!J) return { ok: false, error: 'unknown_jury' };
  const seat = J.seatRows.find(x => x.id === memberId);
  if (!seat) return { ok: false, error: 'unknown_seat' };
  if (!seat.name) return { ok: true, already: true };
  // A row on its own is not a score: a comment creates one with empty values, and
  // refusing on it stranded the seat for good. Check the values, and check the tab
  // too, since a score typed straight into the grid never reaches APP_NOTES.
  if (Object.keys(J.cells || {}).some(k => k.indexOf(seat.id + '|') === 0)) return { ok: false, error: 'has_scores' };
  const prefix = J.id + '__' + seat.id + '__';
  const sh = notesSheet();
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    const rowsN = sh.getRange(2, 1, n, 5).getValues();
    for (let i = 0; i < rowsN.length; i++) {
      if (String(rowsN[i][0] || '').indexOf(prefix) !== 0) continue;
      let v = {};
      try { v = JSON.parse(rowsN[i][4] || '{}'); } catch (err) {}
      if (Object.keys(v).length) return { ok: false, error: 'has_scores' };
    }
  }
  const js = doc().getSheetByName(J.sheet);
  if (js && seat.rows.length) js.getRangeList(seat.rows.map(r => 'B' + r)).clearContent();
  return { ok: true };
}

// ---------- scores ----------
function notesSheet() {
  const ss = doc();
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
  const sh = doc().getSheetByName(J.sheet); if (!sh) return;
  const vals = d.values || {};
  // The criteria columns are contiguous, so write the whole row in one call.
  const cols = J.criteria.map(c => c.col);
  const first = Math.min.apply(null, cols), last = Math.max.apply(null, cols);
  if (last - first + 1 === cols.length) {
    const line = [];
    for (let c = first; c <= last; c++) {
      const crit = J.criteria.find(x => x.col === c);
      const v = crit ? vals[crit.id] : '';
      line.push(typeof v === 'number' ? v : '');
    }
    sh.getRange(r, first, 1, line.length).setValues([line]);
  } else {
    J.criteria.forEach(c => {
      const v = vals[c.id];
      sh.getRange(r, c.col).setValue(typeof v === 'number' ? v : '');
    });
  }
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
    const s = doc().getSheetByName(J.sheet);
    const last = s.getLastRow();
    if (last > 1) J.criteria.forEach(c => s.getRange(2, c.col, last - 1, 1).clearContent());
  });
}

// ---------- settings ----------
function readSettings() {
  const sh = doc().getSheetByName(CONFIG_SHEET);
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
  const ss = doc();
  let sh = ss.getSheetByName(CONFIG_SHEET);
  if (!sh) { sh = ss.insertSheet(CONFIG_SHEET); sh.getRange('B1').setValue('Do not edit by hand: settings managed by the scoring page.'); }
  sh.getRange('A1').setValue(JSON.stringify(st));
}
