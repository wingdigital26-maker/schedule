/* =========================================================================
   sync.js -- optional device sync for Schedule Hub.

   WHAT SYNCS: schedule blocks, hand-added assignments, done ticks, grades,
   building pins, food favourites and hour overrides, the imported Canvas
   calendar, and every lecture's notes, transcript, flashcards and summary.

   WHAT DOES NOT: lecture AUDIO. A recording is tens of megabytes; it stays
   in the browser that made it. Its notes appear everywhere, and everywhere
   else says so in plain words instead of showing a play button that cannot
   play. Also excluded: the deep-summary endpoint secret (a key of Jack's
   that has no business sitting in a database), and the notification switch
   and its fired-today log, which are properties of one device's permission
   and not of the schedule.

   HOW CONFLICTS RESOLVE: last edit wins, PER ITEM. Every block, tick, grade
   row, pin and lecture carries its own updated_at. Editing one block on the
   phone pushes that block and nothing else, so it can never roll back a
   different block added on the laptop.

   OFFLINE: the app never waits on the network. Local edits are written to
   localStorage/IndexedDB first, as they always were; sync notices them
   afterwards. A failed push leaves the change queued and the status bar
   saying so. Nothing is ever marked synced that was not.

   OPT-IN: with no sync code set, this file registers a status strip that
   reads "Sync off" and otherwise does nothing at all. No network call is
   made, and the app behaves exactly as it did before sync existed.

   This file is loaded after the main script, so it can read the app's
   globals and wrap its render functions without the app having to know
   sync exists. Keeping it separate is deliberate: index.html is edited by
   several people at once.

   SECURITY: this app is served from a public origin, so everything below
   is world-readable. The Supabase anon key is published on purpose -- it
   is designed to be public and grants nothing on its own. The sync code is
   the credential. The table is unreadable to anon (RLS on, zero policies,
   all privileges revoked); the only way in is two SECURITY DEFINER
   functions that take the code and hash it server-side. See
   docs/sync_schema.sql for the full threat model.
   ========================================================================= */
(function(){
'use strict';

if (typeof SCHEDULE === 'undefined' || !SCHEDULE || !SCHEDULE.id) return;

/* ---------------------------------------------------------------- config */

const SB_URL  = 'https://ikgnhieorzjaxtjoneye.supabase.co';
/* Public by design. It is the anon key: it can execute the two sync
   functions and nothing else, and neither works without the sync code.
   A service key must never appear in this file. */
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlrZ25oaWVvcnpqYXh0am9uZXllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU2ODAzMjEsImV4cCI6MjEwMTI1NjMyMX0.j5mExwdSlzS-2jado_5T1XycAp1kO_2Vtz9ZEirV09s';

const ID = SCHEDULE.id;
const P  = 'schedhub.sync.';          // every key this file owns starts here
const K  = {
  code:   P + 'code.'   + ID,   // the sync code, normalised
  shadow: P + 'shadow.' + ID,   // item_key -> {t, h, d}: what we last agreed on
  outbox: P + 'outbox.' + ID,   // item_key -> true: pushed but not confirmed
  device: P + 'device.' + ID,   // this device's name, for the audio message
  state:  P + 'state.'  + ID    // {at, err} so the bar is honest across reloads
};

const PUSH_DEBOUNCE = 1500;     // quiet period after an edit before pushing
const NET_TIMEOUT   = 15000;

/* ------------------------------------------------------------- tiny utils */

function lsGet(k){ try { return localStorage.getItem(k); } catch (e){ return null; } }
function jGet(k, d){ try { return JSON.parse(lsGet(k)) || d; } catch (e){ return d; } }

/* Writes to our own keys must never look like an app edit, or the scanner
   would chase its own tail. rawSet bypasses the patched setItem. */
let RAW_SET = null, RAW_REMOVE = null;
function rawSet(k, v){ try { RAW_SET.call(localStorage, k, v); } catch (e){} }
function jSet(k, v){ rawSet(k, JSON.stringify(v)); }

/* FNV-1a, doubled, for a short stable id. Used to name set members whose
   own text is far too long to be a key, and to spot a changed value. */
function h32(s){
  let a = 0x811c9dc5;
  for (let i = 0; i < s.length; i++){ a ^= s.charCodeAt(i); a = Math.imul(a, 0x01000193) >>> 0; }
  return a >>> 0;
}
function hash(s){ return h32(s).toString(36) + h32(s + '' + s.length).toString(36); }

/* Key order differs between engines, so hashing a plain stringify would
   flag values as changed that are identical. Sort on the way out. */
function stable(v){
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

function esc2(s){
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ---------------------------------------------------------- the sync code */

/* 26 characters of a 32-symbol alphabet is about 130 bits, and the database
   refuses anything under 20, so there is nothing here worth guessing at.
   I, O, 0 and 1 are left out because this gets read off one screen and
   typed into another. */
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeCode(){
  const b = new Uint8Array(26);
  (self.crypto || self.msCrypto).getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += ALPHA[b[i] & 31];
  return s;
}
/* Typed by hand, so accept the spacing and dashes people add. */
function normCode(s){ return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function prettyCode(s){ return (s.match(/.{1,5}/g) || []).join('-'); }

function getCode(){ return lsGet(K.code) || ''; }
function setCode(c){
  if (c) rawSet(K.code, c);
  else { try { RAW_REMOVE.call(localStorage, K.code); } catch (e){} }
}

function deviceName(){
  let n = lsGet(K.device);
  if (n) return n;
  const ua = navigator.userAgent || '';
  n = /iPad/.test(ua) ? 'iPad'
    : /iPhone/.test(ua) ? 'iPhone'
    : /Android/.test(ua) ? 'Android phone'
    : /Macintosh/.test(ua) ? 'Mac'
    : /Windows/.test(ua) ? 'PC'
    : 'another device';
  rawSet(K.device, n);
  return n;
}

/* ------------------------------------------------------------ namespaces

   Each namespace turns one storage location into a flat map of items, and
   turns a map of items back into that storage location. The item, not the
   namespace, is the unit of conflict resolution.

     idlist  array of objects carrying .id   -> one item per object
     strset  array of strings (a set)        -> one item per member
     map     plain object                    -> one item per key
     blob    one value that means nothing
             taken apart                     -> exactly one item
     lec     the IndexedDB lecture store     -> one item per lecture,
                                                minus the audio blob
   ------------------------------------------------------------------------ */

function safeRender(fn){ return function(){ try { fn(); } catch (e){ /* a view that is not built yet */ } }; }
const N_ = () => (typeof campusNow === 'function' ? campusNow() : null);

const NS = [
  { n:'plan',  kind:'idlist', key:() => PLAN_KEY,
    load(){ planBlocks = jGet(PLAN_KEY, []); },
    draw: safeRender(() => renderPlan()) },

  { n:'work',  kind:'idlist', key:() => WORK_KEY,
    load(){ WORK = jGet(WORK_KEY, []); },
    draw: safeRender(() => { renderDue(N_()); }) },

  { n:'done',  kind:'strset', key:() => DONE_KEY,
    draw: safeRender(() => { renderDue(N_()); renderCanvasTab(); }) },

  { n:'grade', kind:'map',    key:() => GRADE_KEY,
    load(){ GRADES = jGet(GRADE_KEY, {}); },
    draw: safeRender(() => renderCourses()) },

  { n:'fav',   kind:'strset', key:() => FAV_KEY,
    load(){ FAVS = jGet(FAV_KEY, []); },
    draw: safeRender(() => renderFood(N_())) },

  { n:'hours', kind:'map',    key:() => HRS_KEY,
    load(){ HRSOVERRIDE = jGet(HRS_KEY, {}); },
    draw: safeRender(() => renderFood(N_())) },

  { n:'pin',   kind:'map',    key:() => PIN_KEY,
    load(){ PINS = loadPins(); },
    draw: safeRender(() => renderBuildings()) },

  { n:'canvas', kind:'blob',  key:() => CANVAS_KEY,
    draw: safeRender(() => { renderCanvasTab(); renderDue(N_()); }) },

  { n:'lec',   kind:'lec',
    draw: safeRender(() => renderLectures()) }
];
const byName = {};
NS.forEach(s => { byName[s.n] = s; });

/* Which namespace owns a localStorage key, so a write can be traced back. */
function nsForKey(k){
  for (const s of NS){ if (s.key && s.key() === k) return s; }
  return null;
}

/* ---- reading a namespace into items ---- */

async function readNS(s){
  const m = new Map();
  if (s.kind === 'lec'){
    let all = [];
    try { all = await dbAll(); } catch (e){ return null; }   // null = could not read
    for (const r of all){
      if (!r || !r.id) continue;
      const o = {};
      for (const k in r) if (k !== 'audio') o[k] = r[k];
      m.set(r.id, o);
    }
    return m;
  }
  const raw = lsGet(s.key());
  if (s.kind === 'blob'){
    if (raw != null) { try { m.set('v', JSON.parse(raw)); } catch (e){} }
    return m;
  }
  let v = null;
  try { v = raw == null ? null : JSON.parse(raw); } catch (e){ v = null; }
  /* Anything that cannot be addressed as an item -- a record with no usable
     id, a set member that is not a string -- is not sync's business. It is
     parked in _extra and written back untouched, so sync never becomes a
     reason for a row to disappear from a device that had it. */
  m._extra = [];
  if (s.kind === 'idlist'){
    /* id 0 is legal. NaN, null, undefined and '' are not. */
    if (Array.isArray(v)) v.forEach(o => {
      if (o && o.id != null && o.id === o.id && o.id !== '') m.set(String(o.id), o);
      else if (o !== undefined) m._extra.push(o);
    });
  } else if (s.kind === 'strset'){
    if (Array.isArray(v)) v.forEach(x => {
      if (typeof x === 'string') m.set(hash(x), x); else m._extra.push(x);
    });
  } else if (s.kind === 'map'){
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.keys(v).forEach(k => m.set(k, v[k]));
  }
  return m;
}

/* ---- writing merged items back ----
   For localStorage kinds this rebuilds the whole value in one go, which is
   safe because the merged map already contains every local item that won.
   Lectures are written one record at a time so an untouched recording is
   never rewritten and its audio blob is never round-tripped. */

async function writeNS(s, m, touched){
  if (s.kind === 'lec'){
    for (const id of touched){
      const inc = m.get(id);
      if (inc === undefined){ try { await dbDel(id); } catch (e){} continue; }
      let cur = null;
      try { cur = await dbGet(id); } catch (e){}
      const rec = {};
      for (const k in inc) rec[k] = inc[k];
      rec.id = id;
      /* The audio never travels. Whatever this device already holds stays
         exactly where it is; a lecture arriving from elsewhere simply has
         none, and syncNoAudio makes the app say so. */
      if (cur && cur.audio){ rec.audio = cur.audio; if (cur.mime) rec.mime = cur.mime; }
      rec.syncNoAudio = !rec.audio;
      if (!rec.notes) rec.notes = [];
      try { await dbPut(rec); } catch (e){}
    }
    return;
  }
  const key = s.key();
  let out;
  if (s.kind === 'idlist' || s.kind === 'strset') out = Array.from(m.values()).concat(m._extra || []);
  else if (s.kind === 'map'){   out = {}; m.forEach((v, k) => { out[k] = v; }); }
  else if (s.kind === 'blob'){
    if (!m.has('v')){ try { RAW_REMOVE.call(localStorage, key); } catch (e){} if (s.load) s.load(); return; }
    out = m.get('v');
  }
  rawSet(key, JSON.stringify(out));
  if (s.load) s.load();
}

/* ---------------------------------------------------------------- shadow

   The shadow is this device's memory of every item it has agreed on:
   its updated_at, a hash of its value, and whether it is a tombstone.
   Comparing the live data against the shadow is how a save anywhere in the
   app turns into "these three items changed" without the app being altered
   to report it. It is also what stops a deleted block coming back: the
   tombstone stays in the shadow after the item is gone. */

function loadShadow(){ return jGet(K.shadow, {}); }
function saveShadow(sh){ jSet(K.shadow, sh); }
function loadOutbox(){ return jGet(K.outbox, {}); }
function saveOutbox(o){ jSet(K.outbox, o); }

/* Walk every namespace, stamp what changed, tombstone what vanished.
   Returns the shadow plus the live item maps, so the caller can push. */
async function scan(){
  const sh = loadShadow();
  const out = loadOutbox();
  const live = {};
  const now = Date.now();
  let dirty = false;

  for (const s of NS){
    const m = await readNS(s);
    if (m === null) continue;                 // store unreadable: change nothing
    live[s.n] = m;

    m.forEach((v, id) => {
      const ik = s.n + ':' + id;
      const h = hash(stable(v));
      const prev = sh[ik];
      if (!prev || prev.d || prev.h !== h){
        sh[ik] = { t: now, h: h, d: false };
        out[ik] = 1; dirty = true;
      }
    });

    const pre = s.n + ':';
    for (const ik in sh){
      if (ik.indexOf(pre) !== 0) continue;
      if (sh[ik].d) continue;
      if (m.has(ik.slice(pre.length))) continue;
      sh[ik] = { t: now, h: '', d: true };    // gone here, so gone everywhere
      out[ik] = 1; dirty = true;
    }
  }

  if (dirty){ saveShadow(sh); saveOutbox(out); }
  return { sh, out, live, dirty };
}

/* ------------------------------------------------------------------- net */

async function rpc(fn, body){
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), NET_TIMEOUT);
  let r;
  try {
    r = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { apikey: SB_ANON, Authorization: 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: c.signal
    });
  } catch (e){
    clearTimeout(t);
    throw new Error(c.signal.aborted ? 'the server did not answer in time' : 'no connection');
  }
  clearTimeout(t);
  const txt = await r.text();
  if (!r.ok){
    let m = '';
    try { m = JSON.parse(txt).message || ''; } catch (e){}
    throw new Error(m || ('the server said ' + r.status));
  }
  return txt ? JSON.parse(txt) : null;
}

/* ----------------------------------------------------------------- state */

const ST = { phase:'off', at:0, err:'', pending:0, running:false };
(function restore(){
  const s = jGet(K.state, null);
  if (s){ ST.at = s.at || 0; ST.err = s.err || ''; }
})();
function keepState(){ jSet(K.state, { at: ST.at, err: ST.err }); }

function ago(ms){
  const d = Math.max(0, Date.now() - ms);
  if (d < 45000) return 'just now';
  const mi = Math.round(d / 60000);
  if (mi < 60) return mi + (mi === 1 ? ' minute ago' : ' minutes ago');
  const h = Math.round(mi / 60);
  if (h < 24) return h + (h === 1 ? ' hour ago' : ' hours ago');
  const dy = Math.round(h / 24);
  return dy + (dy === 1 ? ' day ago' : ' days ago');
}

/* Deliberately never a tick unless a pull and a push both came back clean
   with nothing left waiting. "Synced" has to mean synced. */
function statusText(){
  if (!getCode()) return { tone:'off', text:'Sync off · this device only' };
  if (ST.running) return { tone:'busy', text:'Syncing…' };
  const waiting = ST.pending ? ' · ' + ST.pending + (ST.pending === 1 ? ' change waiting' : ' changes waiting') : '';
  if (ST.err) return { tone:'bad', text:'Not synced — ' + ST.err + waiting };
  if (!ST.at)  return { tone:'bad', text:'Not synced yet' + waiting };
  if (ST.pending) return { tone:'warn', text:'Last synced ' + ago(ST.at) + waiting };
  return { tone:'ok', text:'Synced ' + ago(ST.at) };
}

/* ------------------------------------------------------------------- run */

let pushTimer = null;

function bump(){
  if (!getCode()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { run(false); }, PUSH_DEBOUNCE);
}

/* One pass: notice local changes, pull, merge per item, push what we owe.
   Never throws at the caller and never blocks anything the user is doing. */
async function run(withPull){
  const code = getCode();
  if (!code) { ST.phase = 'off'; paint(); return; }
  if (ST.running) return;
  ST.running = true; paint();

  let sh, out, live;
  try {
    const r = await scan();
    sh = r.sh; out = r.out; live = r.live;
  } catch (e){
    ST.running = false; ST.err = 'could not read local storage'; keepState(); paint(); return;
  }

  try {
    if (withPull !== false){
      /* Always a full pull. updated_at is a client clock, and a cursor
         against clocks on two devices that disagree quietly drops rows.
         This is a few hundred short text rows; correctness wins. */
      const rows = await rpc('schedhub_pull', { p_code: code, p_since: 0 });
      await merge(rows || [], sh, out, live);
    }

    const keys = Object.keys(out);
    if (keys.length){
      const items = [];
      for (const ik of keys){
        const meta = sh[ik];
        if (!meta) { delete out[ik]; continue; }
        const cut = ik.indexOf(':');
        const s = byName[ik.slice(0, cut)], id = ik.slice(cut + 1);
        const v = (!meta.d && s && live[s.n]) ? live[s.n].get(id) : undefined;
        if (!meta.d && v === undefined){ delete out[ik]; continue; }  // vanished mid-pass
        items.push({ k: ik, v: meta.d ? null : v, d: !!meta.d, t: meta.t });
      }
      /* Chunked so one enormous first upload cannot be refused whole. */
      for (let i = 0; i < items.length; i += 500){
        await rpc('schedhub_push', { p_code: code, p_items: items.slice(i, i + 500) });
        items.slice(i, i + 500).forEach(it => { delete out[it.k]; });
        saveOutbox(out);
      }
    }

    ST.at = Date.now(); ST.err = '';
  } catch (e){
    /* The queue and the shadow are untouched, so the edit is not lost --
       it goes out on the next pass. */
    ST.err = (e && e.message) || 'sync failed';
  }

  saveShadow(sh); saveOutbox(out);
  ST.pending = Object.keys(out).length;
  ST.running = false;
  keepState(); paint();
}

/* Per-item last write wins. Remote only replaces local when its own
   updated_at is newer than what this device agreed on for THAT item; a
   local item the server has not seen is left alone and pushed instead. */
async function merge(rows, sh, out, live){
  const touch = {};       // namespace -> Set of item ids to write back

  for (const row of rows){
    const ik = row.item_key;
    const cut = ik.indexOf(':');
    if (cut < 1) continue;
    const s = byName[ik.slice(0, cut)];
    if (!s || !live[s.n]) continue;
    const id = ik.slice(cut + 1);
    const mine = sh[ik];
    const rt = Number(row.updated_at) || 0;

    if (mine && mine.t >= rt){
      /* Mine is the same age or newer. If it differs, mine is the edit the
         server has not caught up with, so make sure it is queued. */
      if (mine.t > rt) out[ik] = 1;
      continue;
    }

    (touch[s.n] || (touch[s.n] = new Set())).add(id);
    if (row.deleted){
      live[s.n].delete(id);
      sh[ik] = { t: rt, h: '', d: true };
    } else {
      live[s.n].set(id, row.value);
      sh[ik] = { t: rt, h: hash(stable(row.value)), d: false };
    }
    delete out[ik];     // the server's copy is now ours; nothing to send
  }

  for (const n in touch){
    await writeNS(byName[n], live[n], touch[n]);
    if (byName[n].draw) byName[n].draw();
  }
  if (Object.keys(touch).length) markAudio();
}

/* --------------------------------------------------- watching for edits

   Every save in this app ends in localStorage.setItem or, for lectures, in
   a render call right after the IndexedDB write. Wrapping those two is
   enough to notice any change without touching a single save site. */

function watch(){
  const proto = Object.getPrototypeOf(localStorage) || Storage.prototype;
  RAW_SET = proto.setItem; RAW_REMOVE = proto.removeItem;
  const mine = k => String(k).indexOf(P) === 0;

  proto.setItem = function(k, v){
    const r = RAW_SET.call(this, k, v);
    if (this === localStorage && !mine(k) && nsForKey(k)) bump();
    return r;
  };
  proto.removeItem = function(k){
    const r = RAW_REMOVE.call(this, k);
    if (this === localStorage && !mine(k) && nsForKey(k)) bump();
    return r;
  };

  /* Lectures. Every dbPut and dbDel in the app is followed by one of these
     two, so they are the seam -- and wrapping them means the recording code
     itself is untouched. */
  ['renderLectures', 'renderLecBody'].forEach(fn => {
    const orig = window[fn];
    if (typeof orig !== 'function') return;
    window[fn] = function(){
      const r = orig.apply(this, arguments);
      Promise.resolve(r).then(() => { markAudio(); bump(); }, () => {});
      return r;
    };
  });
}

/* ------------------------------------------------- audio-lives-elsewhere

   A lecture that arrived from another device has notes and a summary but no
   recording. The app already draws no player and no "Save audio" button in
   that case, which is honest but silent. Say it out loud, in the list and
   in the opened lecture, so nobody hunts for a play button that was never
   going to be there. */

async function markAudio(){
  let all = [];
  try { all = await dbAll(); } catch (e){ return; }
  const away = {};
  all.forEach(r => { if (r && r.syncNoAudio && !r.audio) away[r.id] = true; });
  if (!Object.keys(away).length) return;
  const dev = deviceName();

  document.querySelectorAll('details.lec[data-id]').forEach(d => {
    if (!away[d.dataset.id]) return;
    const m = d.querySelector('.lecmain .m');
    if (m && m.textContent.indexOf('audio stayed') === -1){
      m.textContent = m.textContent.replace(/notes only/, 'audio stayed on the device that recorded it');
    }
    const body = d.querySelector('.lecbody');
    if (body && body.children.length && !body.querySelector('.syncaudio')){
      const p = document.createElement('div');
      p.className = 'recnote syncaudio';
      p.textContent = 'The notes, transcript and summary synced to this ' + dev + '. The audio did ' +
        'not — a recording is far too big to copy between devices, so it stays in the browser that ' +
        'made it. To listen, open this lecture on the device you recorded it on.';
      body.insertBefore(p, body.firstChild);
    }
  });
}

/* --------------------------------------------------------------- the UI

   Built here rather than in index.html so the whole feature is one file.
   Every colour is an existing custom property; the sheet reuses the app's
   own .sheet / .minibtn / .recnote classes so it looks like it belongs. */

function ui(){
  const st = document.createElement('style');
  st.textContent =
    '#syncBar{display:flex;align-items:center;gap:8px;width:100%;margin-top:10px;padding:7px 11px;' +
      'border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--dim);' +
      'font:inherit;font-size:12.5px;line-height:1.35;text-align:left;cursor:pointer;' +
      '-webkit-appearance:none;appearance:none;min-width:0}' +
    '#syncBar .sdot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--dim2)}' +
    '#syncBar .stxt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#syncBar .sgo{flex:0 0 auto;color:var(--accent);font-weight:600}' +
    '#syncBar[data-tone="ok"] .sdot{background:var(--good)}' +
    '#syncBar[data-tone="ok"]{color:var(--tx)}' +
    '#syncBar[data-tone="warn"] .sdot{background:var(--amber)}' +
    '#syncBar[data-tone="bad"] .sdot{background:var(--signal)}' +
    '#syncBar[data-tone="bad"]{color:var(--signal);border-color:var(--signal-line);background:var(--signal-bg)}' +
    '#syncBar[data-tone="busy"] .sdot{background:var(--accent)}' +
    '#syncCode{width:100%;box-sizing:border-box;margin:4px 0 0;padding:11px 12px;border:1px solid var(--line);' +
      'border-radius:12px;background:var(--card2);color:var(--tx);font:600 15px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'letter-spacing:.06em;-webkit-appearance:none;appearance:none;min-width:0}' +
    '#syncSheet .syncshow{margin:4px 0 0;padding:11px 12px;border:1px dashed var(--line);border-radius:12px;' +
      'background:var(--card2);color:var(--tx);font:600 15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'letter-spacing:.06em;word-break:break-all}';
  document.head.appendChild(st);

  const bar = document.createElement('button');
  bar.id = 'syncBar'; bar.type = 'button';
  bar.innerHTML = '<span class="sdot"></span><span class="stxt"></span><span class="sgo">Sync</span>';
  const host = document.querySelector('header .semwrap') || document.querySelector('header');
  if (host && host.parentNode) host.parentNode.insertBefore(bar, host.nextSibling);
  else document.body.appendChild(bar);

  const sheet = document.createElement('div');
  sheet.className = 'sheet'; sheet.id = 'syncSheet';
  sheet.innerHTML =
    '<div class="sheetin">' +
      '<h3>Sync across devices</h3>' +
      '<div class="sd">One code ties your phone and your computer together. Generate it here, ' +
        'type it in over there, and both show the same schedule, assignments, ticks, grades and ' +
        'lecture notes. Off until you set one.</div>' +
      '<div id="syncNow" class="icsmsg"></div>' +
      '<div id="syncMine"></div>' +
      '<label class="aifield" id="syncEntry">Sync code' +
        '<input id="syncCode" type="text" inputmode="latin" autocomplete="off" autocapitalize="characters" ' +
          'spellcheck="false" placeholder="paste or type the code from your other device">' +
      '</label>' +
      '<div class="minibtns">' +
        '<button class="minibtn primary" id="syncUse">Use this code</button>' +
        '<button class="minibtn" id="syncNew">Generate a new code</button>' +
        '<button class="minibtn" id="syncCopy">Copy</button>' +
        '<button class="minibtn" id="syncRun">Sync now</button>' +
        '<button class="minibtn danger" id="syncOff">Turn sync off</button>' +
        '<button class="minibtn" id="syncClose">Close</button>' +
      '</div>' +
      '<div class="recnote">Anyone holding this code can read and change everything above, so treat ' +
        'it like a password. Lecture <b>audio never leaves the device that recorded it</b> — it is ' +
        'far too big — but that lecture’s notes and summary sync like everything else. ' +
        'The deep-summary secret and the notification switch stay on this device too.</div>' +
    '</div>';
  document.body.appendChild(sheet);

  bar.onclick = openSheet;
  sheet.addEventListener('click', e => { if (e.target === sheet) sheet.classList.remove('on'); });
  document.getElementById('syncClose').onclick = () => sheet.classList.remove('on');

  document.getElementById('syncNew').onclick = () => {
    const cur = getCode();
    if (cur && !confirm('Generate a new code? This device stops sharing with anything using the old one, ' +
                        'and you will have to type the new code on your other devices.')) return;
    setCode(makeCode());
    resetShadow();
    openSheet(); run(true);
  };

  document.getElementById('syncUse').onclick = () => {
    const c = normCode(document.getElementById('syncCode').value);
    if (c.length < 20){ msg('That is not a full sync code. They are 26 characters long.', 'bad'); return; }
    setCode(c);
    resetShadow();
    openSheet(); run(true);
  };

  document.getElementById('syncCopy').onclick = async () => {
    const c = getCode();
    if (!c) return;
    try { await navigator.clipboard.writeText(prettyCode(c)); msg('Code copied. Paste it on your other device.', 'ok'); }
    catch (e){ msg('Could not reach the clipboard — read the code above and type it.', 'bad'); }
  };

  document.getElementById('syncRun').onclick = () => { ST.err = ''; run(true); };

  document.getElementById('syncOff').onclick = () => {
    if (!confirm('Turn sync off on this device? Everything already here stays. Nothing more is uploaded ' +
                 'or downloaded until you set a code again.')) return;
    setCode(''); resetShadow();
    ST.at = 0; ST.err = ''; ST.pending = 0; keepState();
    openSheet(); paint();
  };

  paint();
}

/* A fresh code means a fresh conversation: forget which items we had
   agreed on, so the next pass uploads everything this device holds and
   merges in whatever the other device already put there. */
function resetShadow(){
  try { RAW_REMOVE.call(localStorage, K.shadow); } catch (e){}
  try { RAW_REMOVE.call(localStorage, K.outbox); } catch (e){}
}

/* tone: 'bad' | 'ok' | anything else for plain. Green is reserved for a
   sync that actually completed, so "sync is off" is not dressed up as one. */
function msg(t, tone){
  const el = document.getElementById('syncNow');
  if (!el) return;
  el.textContent = t;
  el.style.color = tone === 'bad' ? 'var(--signal)' : tone === 'ok' ? 'var(--good)' : 'var(--dim)';
}

function openSheet(){
  const c = getCode();
  const mine = document.getElementById('syncMine');
  mine.innerHTML = c
    ? '<div class="subhead" style="margin-top:14px">This device’s code</div>' +
      '<div class="syncshow">' + esc2(prettyCode(c)) + '</div>'
    : '';
  document.getElementById('syncEntry').style.display = c ? 'none' : '';
  document.getElementById('syncCopy').style.display  = c ? '' : 'none';
  document.getElementById('syncRun').style.display   = c ? '' : 'none';
  document.getElementById('syncOff').style.display   = c ? '' : 'none';
  document.getElementById('syncUse').style.display   = c ? 'none' : '';
  document.getElementById('syncNew').textContent = c ? 'Replace with a new code' : 'Generate a code';
  const s = statusText();
  msg(c ? s.text : 'Sync is off. Nothing is uploaded.', c ? s.tone : 'plain');
  document.getElementById('syncSheet').classList.add('on');
}

function paint(){
  const bar = document.getElementById('syncBar');
  if (!bar) return;
  const s = statusText();
  bar.dataset.tone = s.tone;
  bar.querySelector('.stxt').textContent = s.text;
  bar.querySelector('.sgo').textContent = getCode() ? 'Manage' : 'Set up';
  if (document.getElementById('syncSheet').classList.contains('on')) msg(s.text, s.tone);
}

/* ------------------------------------------------------------------ boot */

watch();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

function start(){
  ui();
  ST.pending = Object.keys(loadOutbox()).length;
  paint();
  if (getCode()) run(true);

  /* Pull when the app comes back to the front, and when the network does.
     No polling timer: a phone left on a desk has nothing to say. */
  document.addEventListener('visibilitychange', () => { if (!document.hidden) run(true); });
  window.addEventListener('focus', () => run(true));
  window.addEventListener('online', () => run(true));
  /* Keep "synced 3 minutes ago" from going stale on screen. Local only. */
  setInterval(paint, 30000);
}

/* A small handle for the console and for tests. */
window.SchedSync = {
  run, scan, code: getCode, setCode: c => { setCode(normCode(c)); resetShadow(); paint(); },
  state: () => ({ phase: ST.phase, at: ST.at, err: ST.err, pending: ST.pending, running: ST.running }),
  status: statusText
};

})();
