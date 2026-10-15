/**
 * Notation du jury — serveur Google Apps Script
 * --------------------------------------------------------------
 * À coller dans le tableur JURY_ASSESSMENT : Extensions → Apps Script.
 * Puis : Déployer → Nouveau déploiement → type « Application web »
 *        Exécuter en tant que : Moi
 *        Qui a accès : Tout le monde
 * Copiez l'URL obtenue (…/exec) et collez-la dans index.html (constante API_URL).
 *
 * Le script crée seul deux onglets :
 *   APP_NOTES   une ligne par juré × équipe (lisible, avec moyenne)
 *   APP_CONFIG  la configuration (jurys, membres, équipes, critères) en JSON
 * Il ne touche pas aux onglets existants (JURY 1, Pax 1…).
 *
 * Mot de passe organisateur par défaut : organisateur
 * (modifiable depuis la page, menu Réglages → Accès organisateur).
 */

const NOTES_SHEET = 'APP_NOTES';
const CONFIG_SHEET = 'APP_CONFIG';
const MAX_CRIT = 8;
const DEFAULT_HASH = 'eb84789239978c5b66ad35a3d0a816b214a1144b44060af4f6be6b5a6c31c7a3'; // "organisateur"
const HEAD = ['id', 'jury', 'member', 'team', 'values', 'comment', 'updatedAt', 'Jury', 'Membre', 'Équipe']
  .concat(Array.from({ length: MAX_CRIT }, (_, i) => 'Note ' + (i + 1)))
  .concat(['Moyenne', 'Commentaire']);

// Configuration de départ (reprise de la page Claude). Utilisée tant que APP_CONFIG est vide.
const DEFAULT_CONFIG = {
  title: 'Présentations des équipes', scale: { min: 1, max: 4 }, locked: false, closed: false,
  juries: [
    { id: 'j1', name: 'Jury 1',
      members: [['m1', 'Albane'], ['m2', 'Sarah'], ['m3', 'Julien'], ['m4', 'Filip'], ['m5', 'Robert'], ['m6', 'Patrick']].map(([id, name]) => ({ id, name })),
      teams: 'ABCDEFGHIJKL'.split('').map(l => ({ id: 't' + l, name: l })),
      criteria: [1, 2, 3, 4].map(i => ({ id: 'c' + i, name: 'Critère ' + i, desc: '', weight: 1 })) },
    { id: 'j2', name: 'Jury 2',
      members: [7, 8, 9, 10, 11, 12].map(i => ({ id: 'm' + i, name: 'Membre ' + i })),
      teams: 'MNOPQRSTUVWX'.split('').map(l => ({ id: 't' + l, name: l })),
      criteria: [1, 2, 3, 4].map(i => ({ id: 'd' + i, name: 'Critère ' + i, desc: '', weight: 1 })) }
  ]
};

// ---------- HTTP ----------
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'state';
  if (action === 'state') return json(getState());
  return json({ ok: false, error: 'unknown_action' });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: 'bad_json' }); }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return json({ ok: false, error: 'busy' });
  try {
    switch (body.action) {
      case 'scores': return json(saveScores(body.docs || []));
      case 'admin': return json({ ok: body.key === adminHash() });
      case 'config':
        if (body.key !== adminHash()) return json({ ok: false, error: 'forbidden' });
        writeConfig(body.cfg);
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

// ---------- state ----------
function adminHash() { return PropertiesService.getScriptProperties().getProperty('ADMIN_HASH') || DEFAULT_HASH; }

function getState() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('state');
  if (hit) return JSON.parse(hit);
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
  const state = { ok: true, cfg: readConfig(), scores, customPassword: !!PropertiesService.getScriptProperties().getProperty('ADMIN_HASH'), ts: new Date().toISOString() };
  try { cache.put('state', JSON.stringify(state), 4); } catch (err) {}
  return state;
}

// ---------- notes ----------
function notesSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(NOTES_SHEET);
  if (!sh) {
    sh = ss.insertSheet(NOTES_SHEET);
    sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideColumns(1, 7); // colonnes techniques
  }
  return sh;
}

function saveScores(docs) {
  const cfg = readConfig();
  const sh = notesSheet();
  const n = Math.max(0, sh.getLastRow() - 1);
  const ids = n ? sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0])) : [];
  const rowOf = {}; ids.forEach((id, i) => { rowOf[id] = i + 2; });
  const saved = [];
  let next = sh.getLastRow() + 1;
  docs.forEach(d => {
    if (!d || !d.id || !/^[\w:.-]+__[\w:.-]+__[\w:.-]+$/.test(d.id)) return;
    const prevAt = rowOf[d.id] ? String(sh.getRange(rowOf[d.id], 7).getValue() || '') : '';
    // Last-writer-wins on the device timestamp: an older queued copy never overwrites a newer one.
    if (prevAt && d.updatedAt && String(d.updatedAt) < prevAt) { saved.push(d.id); return; }
    const row = rowFor(cfg, d);
    const r = rowOf[d.id] || next++;
    sh.getRange(r, 1, 1, row.length).setValues([row]);
    rowOf[d.id] = r;
    saved.push(d.id);
  });
  return { ok: true, saved };
}

function rowFor(cfg, d) {
  const J = (cfg.juries || []).find(j => j.id === d.jury) || { criteria: [], members: [], teams: [] };
  const m = (J.members || []).find(x => x.id === d.member);
  const t = (J.teams || []).find(x => x.id === d.team);
  const vals = d.values || {};
  const notes = [];
  let s = 0, w = 0, filled = 0;
  for (let i = 0; i < MAX_CRIT; i++) {
    const c = (J.criteria || [])[i];
    const v = c ? vals[c.id] : '';
    notes.push(typeof v === 'number' ? v : '');
    if (c && typeof v === 'number') { const wt = +c.weight > 0 ? +c.weight : 1; s += v * wt; w += wt; filled++; }
  }
  const complete = J.criteria && J.criteria.length && filled === J.criteria.length;
  return [d.id, d.jury, d.member, d.team, JSON.stringify(vals), String(d.comment || ''), String(d.updatedAt || new Date().toISOString()),
    J.name || d.jury, m ? m.name : d.member, t ? t.name : d.team]
    .concat(notes).concat([complete ? Math.round(s / w * 100) / 100 : '', String(d.comment || '')]);
}

function clearNotes() {
  const sh = notesSheet();
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.deleteRows(2, n);
}

// ---------- config ----------
function readConfig() {
  const sh = SpreadsheetApp.getActive().getSheetByName(CONFIG_SHEET);
  const raw = sh ? String(sh.getRange('A1').getValue() || '') : '';
  if (!raw) return DEFAULT_CONFIG;
  try { const c = JSON.parse(raw); delete c.adminHash; return c; } catch (err) { return DEFAULT_CONFIG; }
}

function writeConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.juries)) throw new Error('config invalide');
  delete cfg.adminHash;
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(CONFIG_SHEET);
  if (!sh) { sh = ss.insertSheet(CONFIG_SHEET); sh.getRange('B1').setValue('Ne pas modifier à la main : géré par la page de notation.'); }
  sh.getRange('A1').setValue(JSON.stringify(cfg));
}
