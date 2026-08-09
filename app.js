(function(){
'use strict';

/* ================= remote storage (jsonblob.com — free, anonymous, no login) ================= */
const API_BASE = 'https://jsonblob.com/api/jsonBlob';

async function createBlob(data){
  const res = await fetch(API_BASE, {
    method:'POST',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify(data)
  });
  if(!res.ok) throw new Error('Create failed: ' + res.status);
  let loc = res.headers.get('Location') || res.headers.get('location');
  if(!loc && res.url && /jsonBlob\//.test(res.url)) loc = res.url;
  if(!loc) throw new Error('No blob id returned');
  const id = loc.split('/').filter(Boolean).pop();
  return id;
}
async function getBlob(id){
  const res = await fetch(API_BASE + '/' + id, { headers:{'Accept':'application/json'} });
  if(!res.ok) throw new Error('Fetch failed: ' + res.status);
  return res.json();
}
async function putBlob(id, data){
  const res = await fetch(API_BASE + '/' + id, {
    method:'PUT',
    headers:{'Content-Type':'application/json','Accept':'application/json'},
    body: JSON.stringify(data)
  });
  if(!res.ok) throw new Error('Update failed: ' + res.status);
  return true;
}

/* ================= local (per-device) storage ================= */
const LS_BLOB_ID = 'sd_blob_id';
const LS_PIN = 'sd_pin';
const LS_DRAFT_PREFIX = 'sd_draft_';

function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); }catch(e){} }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }

/* ================= helpers ================= */
const $ = (sel, root) => (root||document).querySelector(sel);
function uid(){ return Math.random().toString(36).slice(2,9); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function emptyBoard(){ return { title:'Sports Day', events: [] }; }
function stripMeta(b){ const {__publishedAt, ...rest} = b; return rest; }
function showToast(msg, isError){
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(()=>t.classList.remove('show'), 2600);
}
function fmtClock(ms){
  const m = Math.floor(ms/60000);
  const s = Math.floor((ms%60000)/1000);
  const cs = Math.floor((ms%1000)/10);
  return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+'.'+String(cs).padStart(2,'0');
}

const PRESETS = [
  {name:'100m', unit:'s', direction:'asc'},
  {name:'200m', unit:'s', direction:'asc'},
  {name:'400m', unit:'s', direction:'asc'},
  {name:'800m', unit:'s', direction:'asc'},
  {name:'4x100m Relay', unit:'s', direction:'asc'},
  {name:'Long Jump', unit:'m', direction:'desc'},
  {name:'Shot Put', unit:'m', direction:'desc'},
  {name:'High Jump', unit:'m', direction:'desc'},
];

/* ================= state ================= */
let blobId = null;
let draft = emptyBoard();
let published = null;
let activeEventId = null;
let isAdmin = false;
let pollTimer = null;

/* race timer state — keyed per event id so switching events doesn't lose progress */
const raceStates = {};
function getRaceState(ev){
  if(!raceStates[ev.id]){
    raceStates[ev.id] = {
      running:false, startTs:null, laneCount:6,
      laneNames:['Lane 1','Lane 2','Lane 3','Lane 4','Lane 5','Lane 6','Lane 7','Lane 8'].slice(0,6),
      laneTimes:new Array(8).fill(null),
      rafId:null
    };
  }
  return raceStates[ev.id];
}

/* ================= ranking ================= */
function rankedResults(event){
  const withVals = event.results.map(r => ({...r, num: parseFloat(r.value)}));
  const sortable = withVals.filter(r => !isNaN(r.num));
  const unsortable = withVals.filter(r => isNaN(r.num));
  sortable.sort((a,b) => event.direction === 'desc' ? b.num - a.num : a.num - b.num);
  let rank = 0, lastVal = null, seen = 0;
  const rankedSortable = sortable.map(r => {
    seen++;
    if(r.num !== lastVal){ rank = seen; lastVal = r.num; }
    return {...r, rank};
  });
  return rankedSortable.concat(unsortable.map(r => ({...r, rank:null})));
}
function medal(rank){
  if(rank===1) return '<span class="medal">🥇</span>';
  if(rank===2) return '<span class="medal">🥈</span>';
  if(rank===3) return '<span class="medal">🥉</span>';
  return '';
}

/* ================= VIEWER RENDER ================= */
function renderViewer(){
  const board = published || emptyBoard();

  const wrap = $('#viewerContent');
  if(!board.events || board.events.length === 0){
    wrap.innerHTML = `
      <div class="empty">
        <div class="icon">— · —</div>
        <h3>Results Coming Soon</h3>
        <p>Results will be posted here as each event finishes.<br>Check back during the day.</p>
      </div>`;
    return;
  }
  wrap.innerHTML = board.events.map(ev => {
    const ranked = rankedResults(ev);
    const rows = ranked.length ? ranked.map(r => `
      <tr>
        <td class="rank-cell ${r.rank===1?'r1':r.rank===2?'r2':r.rank===3?'r3':''}">${medal(r.rank)}${r.rank ?? '—'}</td>
        <td class="runner-name">${escapeHtml(r.name || 'Unnamed')}</td>
        <td class="time-cell">${r.value !== undefined && r.value !== '' ? escapeHtml(r.value) + (ev.unit? ' '+escapeHtml(ev.unit):'') : '—'}</td>
      </tr>`).join('')
      : `<tr><td colspan="3" class="no-results">No runners recorded yet</td></tr>`;
    return `
      <div class="event-card">
        <div class="event-head">
          <h2>${escapeHtml(ev.name)}</h2>
          <span class="event-unit">${ev.direction === 'asc' ? 'Lowest wins' : 'Highest wins'}</span>
        </div>
        <table class="results"><tbody>${rows}</tbody></table>
      </div>`;
  }).join('');
}

/* ================= ADMIN RENDER ================= */
function markDirty(){
  const dirty = JSON.stringify(draft) !== JSON.stringify(published ? stripMeta(published) : emptyBoard());
  const el = $('#statusTxt');
  if(!draft.events.length){ el.textContent = 'Nothing to publish yet'; el.className = 'status-txt'; }
  else if(dirty){ el.textContent = "Unpublished changes — judges won't see these until you publish"; el.className = 'status-txt dirty'; }
  else { el.textContent = 'Everything published and live'; el.className = 'status-txt'; }
}

function renderEventList(){
  const list = $('#eventList');
  list.innerHTML = draft.events.length ? draft.events.map(ev => `
    <div class="event-list-item ${ev.id===activeEventId?'active':''}" data-id="${ev.id}">
      <span>${escapeHtml(ev.name)}</span>
      <button data-del="${ev.id}" title="Delete event" aria-label="Delete ${escapeHtml(ev.name)}">×</button>
    </div>`).join('')
    : `<div style="font-size:12.5px;color:var(--chalk-dim);padding:6px 4px;">Add your first event below.</div>`;

  $('#presetChips').innerHTML = PRESETS.map(p => `<button type="button" class="preset-chip" data-preset="${escapeHtml(p.name)}">+ ${escapeHtml(p.name)}</button>`).join('');
}

function laneKeyLabel(i){ return String(i+1); }

function renderRacePanel(ev){
  const rs = getRaceState(ev);
  const laneHtml = Array.from({length: rs.laneCount}).map((_,i) => {
    const captured = rs.laneTimes[i] !== null;
    return `
      <button type="button" class="lane-btn ${captured?'captured':''}" data-lane="${i}" ${captured?'disabled':''}>
        <span class="lane-key">Key ${laneKeyLabel(i)}</span>
        <input type="text" class="lane-name-input" data-laneidx="${i}" value="${escapeHtml(rs.laneNames[i])}" ${rs.running || captured ? 'disabled' : ''} onclick="event.stopPropagation()">
        <div class="lane-time">${captured ? fmtClock(rs.laneTimes[i]) : '—'}</div>
      </button>`;
  }).join('');

  return `
    <div class="race-panel">
      <div class="race-controls-top">
        <span class="section-divider" style="padding:0;">Race Timer</span>
        <div class="lane-stepper">
          <span>Lanes</span>
          <button type="button" id="laneMinus" ${rs.running?'disabled':''}>−</button>
          <span id="laneCountLabel">${rs.laneCount}</span>
          <button type="button" id="lanePlus" ${rs.running?'disabled':''}>+</button>
        </div>
      </div>
      <div class="clock-display ${rs.running?'':'idle'}" id="clockDisplay">${rs.running ? fmtClock(performance.now()-rs.startTs) : '00:00.00'}</div>
      <div class="race-buttons">
        ${!rs.running
          ? `<button class="btn btn-amber" id="startRaceBtn">Start Race</button>`
          : `<button class="btn btn-ghost" id="stopRaceBtn">Stop Clock</button>`}
        <button class="btn btn-ghost" id="resetRaceBtn">Reset</button>
        <button class="btn btn-amber" id="saveRaceBtn" ${rs.laneTimes.slice(0,rs.laneCount).every(t=>t===null) ? 'disabled':''}>Save Times to Results</button>
      </div>
      <div class="lane-grid" id="laneGrid">${laneHtml}</div>
      <p class="race-hint">Press number keys 1–${rs.laneCount} as each runner finishes to capture their time. Click a lane name to rename it before starting.</p>
    </div>`;
}

function renderAdminMain(){
  const main = $('#adminMain');
  const ev = draft.events.find(e => e.id === activeEventId);
  if(!ev){
    main.innerHTML = `
      <div class="empty" style="border:none;padding:50px 10px;">
        <div class="icon">＋</div>
        <h3>Select or add an event</h3>
        <p>Pick an event on the left, or add one to start recording times.</p>
      </div>`;
    return;
  }
  const ranked = rankedResults(ev);
  const rows = ranked.map(r => `
    <div class="row-edit" data-rid="${r.id}">
      <span class="rank-cell ${r.rank===1?'r1':r.rank===2?'r2':r.rank===3?'r3':''}">${r.rank ?? '—'}</span>
      <input type="text" class="name-input" data-field="name" data-rid="${r.id}" value="${escapeHtml(r.name)}" placeholder="Runner name">
      <input type="text" class="time-input" data-field="value" data-rid="${r.id}" value="${escapeHtml(r.value ?? '')}" placeholder="0.00" inputmode="decimal">
      <span class="unit-suffix">${escapeHtml(ev.unit||'')}</span>
      <button class="del-row" data-delrow="${r.id}" aria-label="Remove runner">×</button>
    </div>`).join('');

  main.innerHTML = `
    <div class="event-settings">
      <label>Sort:
        <select id="dirSelect">
          <option value="asc" ${ev.direction==='asc'?'selected':''}>Lowest wins (track)</option>
          <option value="desc" ${ev.direction==='desc'?'selected':''}>Highest wins (field)</option>
        </select>
      </label>
      <label>Unit: <input type="text" class="unit-input" id="unitInput" value="${escapeHtml(ev.unit||'')}" placeholder="s"></label>
    </div>
    <div class="event-head" style="border-bottom:none;">
      <h2>${escapeHtml(ev.name)}</h2>
    </div>
    ${ev.direction === 'asc' ? renderRacePanel(ev) : ''}
    <div class="section-divider">Results</div>
    ${rows || `<div class="no-results" style="padding:10px 16px;">No runners yet — add one below or use the race timer above.</div>`}
    <div class="add-runner-row">
      <input type="text" class="name-input" id="newRunnerName" placeholder="Runner name">
      <input type="text" class="time-input" id="newRunnerTime" placeholder="0.00" inputmode="decimal">
      <button class="btn btn-amber btn-sm" id="addRunnerBtn">Add</button>
    </div>
  `;
  wireRaceControls(ev);
}

function renderAdmin(){
  renderEventList();
  renderAdminMain();
  markDirty();
  saveDraftDebounced();
}

/* ---------------- race timer logic ---------------- */
let clockRafId = null;
function tickClock(ev){
  const rs = getRaceState(ev);
  if(!rs.running) return;
  const el = $('#clockDisplay');
  if(el) el.textContent = fmtClock(performance.now() - rs.startTs);
  clockRafId = requestAnimationFrame(() => tickClock(ev));
}

function wireRaceControls(ev){
  const rs = getRaceState(ev);

  const startBtn = $('#startRaceBtn');
  if(startBtn) startBtn.addEventListener('click', () => {
    rs.running = true;
    rs.startTs = performance.now();
    renderAdminMain();
    tickClock(ev);
  });
  const stopBtn = $('#stopRaceBtn');
  if(stopBtn) stopBtn.addEventListener('click', () => {
    rs.running = false;
    cancelAnimationFrame(clockRafId);
    renderAdminMain();
  });
  const resetBtn = $('#resetRaceBtn');
  if(resetBtn) resetBtn.addEventListener('click', () => {
    if(rs.laneTimes.some(t=>t!==null) && !confirm('Clear the current race timer and captured times?')) return;
    rs.running = false;
    rs.startTs = null;
    rs.laneTimes = new Array(8).fill(null);
    cancelAnimationFrame(clockRafId);
    renderAdminMain();
  });
  const saveBtn = $('#saveRaceBtn');
  if(saveBtn) saveBtn.addEventListener('click', () => {
    for(let i=0;i<rs.laneCount;i++){
      if(rs.laneTimes[i] === null) continue;
      const name = rs.laneNames[i] || ('Lane ' + (i+1));
      const seconds = (rs.laneTimes[i]/1000).toFixed(2);
      const existing = ev.results.find(r => r.name === name);
      if(existing) existing.value = seconds;
      else ev.results.push({ id: uid(), name, value: seconds });
    }
    rs.running = false;
    rs.startTs = null;
    rs.laneTimes = new Array(8).fill(null);
    cancelAnimationFrame(clockRafId);
    renderAdmin();
    showToast('Times saved to results — remember to publish');
  });
  const laneMinus = $('#laneMinus');
  if(laneMinus) laneMinus.addEventListener('click', () => { if(rs.laneCount>2){ rs.laneCount--; renderAdminMain(); } });
  const lanePlus = $('#lanePlus');
  if(lanePlus) lanePlus.addEventListener('click', () => { if(rs.laneCount<8){ rs.laneCount++; renderAdminMain(); } });

  const laneGrid = $('#laneGrid');
  if(laneGrid){
    laneGrid.addEventListener('click', e => {
      const btn = e.target.closest('.lane-btn');
      if(!btn || btn.disabled) return;
      captureLane(ev, parseInt(btn.dataset.lane,10));
    });
    laneGrid.querySelectorAll('.lane-name-input').forEach(inp => {
      inp.addEventListener('input', e => {
        rs.laneNames[parseInt(e.target.dataset.laneidx,10)] = e.target.value;
      });
    });
  }
}

function captureLane(ev, idx){
  const rs = getRaceState(ev);
  if(!rs.running) return;
  if(idx >= rs.laneCount) return;
  if(rs.laneTimes[idx] !== null) return;
  rs.laneTimes[idx] = performance.now() - rs.startTs;
  renderAdminMain();
}

/* global keydown for race capture — ignored while typing in a text field */
document.addEventListener('keydown', e => {
  if(!isAdmin) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const ev = draft.events.find(x => x.id === activeEventId);
  if(!ev || ev.direction !== 'asc') return;
  const rs = getRaceState(ev);
  if(!rs.running) return;
  const num = parseInt(e.key, 10);
  if(!isNaN(num) && num >= 1 && num <= rs.laneCount){
    e.preventDefault();
    captureLane(ev, num-1);
  }
});

/* ---------------- draft persistence (per-device, debounced) ---------------- */
let draftSaveTimer = null;
function saveDraftDebounced(){
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    if(blobId) lsSet(LS_DRAFT_PREFIX + blobId, JSON.stringify(draft));
  }, 400);
}

/* ---------------- admin: events & results wiring ---------------- */
$('#addEventForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#newEventName');
  const name = input.value.trim();
  if(!name) return;
  const ev = { id: uid(), name, unit:'s', direction:'asc', results: [] };
  draft.events.push(ev);
  activeEventId = ev.id;
  input.value = '';
  renderAdmin();
});

$('#presetChips').addEventListener('click', e => {
  const btn = e.target.closest('[data-preset]');
  if(!btn) return;
  const p = PRESETS.find(x => x.name === btn.dataset.preset);
  if(!p) return;
  const ev = { id: uid(), name: p.name, unit: p.unit, direction: p.direction, results: [] };
  draft.events.push(ev);
  activeEventId = ev.id;
  renderAdmin();
});

$('#eventList').addEventListener('click', e => {
  const del = e.target.closest('[data-del]');
  if(del){
    const id = del.dataset.del;
    const ev = draft.events.find(x=>x.id===id);
    if(ev && !confirm(`Delete "${ev.name}" and all its results?`)) return;
    draft.events = draft.events.filter(x => x.id !== id);
    delete raceStates[id];
    if(activeEventId === id) activeEventId = draft.events[0]?.id || null;
    renderAdmin();
    return;
  }
  const item = e.target.closest('.event-list-item');
  if(item){ activeEventId = item.dataset.id; renderAdminMain(); }
});

$('#adminMain').addEventListener('click', e => {
  const ev = draft.events.find(x => x.id === activeEventId);
  if(!ev) return;
  if(e.target.id === 'addRunnerBtn'){
    const nameEl = $('#newRunnerName'), timeEl = $('#newRunnerTime');
    const name = nameEl.value.trim();
    if(!name){ nameEl.focus(); return; }
    ev.results.push({ id: uid(), name, value: timeEl.value.trim() });
    renderAdmin();
    return;
  }
  const delRow = e.target.closest('[data-delrow]');
  if(delRow){
    ev.results = ev.results.filter(r => r.id !== delRow.dataset.delrow);
    renderAdmin();
  }
});

$('#adminMain').addEventListener('input', e => {
  const ev = draft.events.find(x => x.id === activeEventId);
  if(!ev) return;
  const t = e.target;
  if(t.id === 'unitInput'){ ev.unit = t.value; saveDraftDebounced(); markDirty(); return; }
  const field = t.dataset.field, rid = t.dataset.rid;
  if(field && rid){
    const r = ev.results.find(x => x.id === rid);
    if(r){ r[field] = t.value; saveDraftDebounced(); markDirty(); }
  }
});
$('#adminMain').addEventListener('change', e => {
  const ev = draft.events.find(x => x.id === activeEventId);
  if(!ev) return;
  if(e.target.id === 'dirSelect'){ ev.direction = e.target.value; renderAdmin(); }
});
$('#adminMain').addEventListener('keydown', e => {
  if(e.key === 'Enter' && (e.target.id === 'newRunnerName' || e.target.id === 'newRunnerTime')){
    e.preventDefault();
    $('#addRunnerBtn').click();
  }
});

$('#publishBtn').addEventListener('click', async () => {
  const btn = $('#publishBtn');
  btn.disabled = true; btn.textContent = 'Publishing…';
  const payload = { ...draft, __publishedAt: Date.now() };
  try{
    await putBlob(blobId, payload);
    published = payload;
    showToast('Published — anyone with the link can now see this');
    markDirty();
    renderViewer();
  }catch(err){
    showToast('Publish failed — check your connection and try again', true);
  }
  btn.disabled = false; btn.textContent = 'Publish Results';
});

/* ---------------- QR + link ---------------- */
function renderQr(){
  const url = window.location.href;
  $('#publicLinkInput').value = url;
  const el = $('#qrcode');
  el.innerHTML = '';
  new QRCode(el, { text: url, width: 132, height: 132, colorDark:'#14171C', colorLight:'#ffffff' });
}
$('#copyLinkBtn').addEventListener('click', async () => {
  try{
    await navigator.clipboard.writeText(window.location.href);
    showToast('Link copied');
  }catch(e){ showToast('Copy failed — select and copy manually', true); }
});

/* ---------------- PIN / mode switching ---------------- */
function openPinModal(){
  $('#pinOverlay').style.display = 'flex';
  $('#pinInput').value = '';
  $('#pinErr').textContent = '';
  const hasPin = !!lsGet(LS_PIN);
  $('#pinDesc').textContent = hasPin ? 'Enter your PIN to edit and publish results.' : 'Set a PIN for this device — you\'ll use it every time you come back here to edit.';
  setTimeout(()=>$('#pinInput').focus(), 50);
}
function closePinModal(){ $('#pinOverlay').style.display = 'none'; }

$('#modeToggleBtn').addEventListener('click', () => {
  if(isAdmin){ isAdmin = false; setMode(false); }
  else openPinModal();
});
$('#pinCancelBtn').addEventListener('click', closePinModal);
$('#pinInput').addEventListener('keydown', e => { if(e.key==='Enter') $('#pinSubmitBtn').click(); });

/* Logging in as organizer also silently sets up the results board on first use,
   so visitors never see a bare "create board" control. */
async function enterAdminMode(){
  const btn = $('#pinSubmitBtn');
  if(!blobId){
    btn.disabled = true; btn.textContent = 'One moment…';
    try{
      const id = await createBlob({ ...emptyBoard(), __publishedAt: null });
      blobId = id;
      lsSet(LS_BLOB_ID, id);
      const url = new URL(window.location.href);
      url.searchParams.set('b', id);
      history.replaceState(null, '', url.toString());
      published = null;
      draft = emptyBoard();
    }catch(err){
      $('#pinErr').textContent = "Couldn't reach the results server. Check your connection and try again.";
      btn.disabled = false; btn.textContent = 'Continue';
      return;
    }
    btn.disabled = false; btn.textContent = 'Continue';
  }
  isAdmin = true;
  closePinModal();
  setMode(true);
}

$('#pinSubmitBtn').addEventListener('click', async () => {
  const entered = $('#pinInput').value.trim();
  if(!entered){ $('#pinErr').textContent = 'Enter a PIN.'; return; }
  const storedPin = lsGet(LS_PIN);
  if(!storedPin){
    lsSet(LS_PIN, entered);
    await enterAdminMode();
    showToast('PIN set for this device. Keep it safe.');
    return;
  }
  if(entered === storedPin){ await enterAdminMode(); }
  else { $('#pinErr').textContent = 'Incorrect PIN.'; }
});

function setMode(admin){
  $('#setupView').style.display = 'none';
  $('#viewerView').style.display = admin ? 'none' : '';
  $('#adminView').style.display = admin ? '' : 'none';
  const modeBtn = $('#modeToggleBtn');
  modeBtn.textContent = admin ? 'Exit to Public View' : '⚙';
  modeBtn.classList.toggle('admin-mode', admin);
  modeBtn.title = admin ? 'Exit to public view' : 'Staff access';
  if(admin){
    stopPolling();
    renderQr();
    renderAdmin();
  } else {
    renderViewer();
    startPolling();
  }
}

/* ---------------- polling for viewer ---------------- */
function startPolling(){
  stopPolling();
  pollTimer = setInterval(async () => {
    if(document.hidden || !blobId) return;
    try{
      const parsed = await getBlob(blobId);
      if(!published || parsed.__publishedAt !== published.__publishedAt){
        published = parsed;
        renderViewer();
      }
    }catch(e){ /* stay on last known data; try again next tick */ }
  }, 5000);
}
function stopPolling(){ if(pollTimer) clearInterval(pollTimer); pollTimer = null; }

/* ---------------- boot ---------------- */
async function boot(){
  const url = new URL(window.location.href);
  const paramId = url.searchParams.get('b');
  blobId = paramId || lsGet(LS_BLOB_ID);

  if(!blobId){
    $('#setupView').style.display = '';
    return;
  }
  if(!paramId){
    url.searchParams.set('b', blobId);
    history.replaceState(null, '', url.toString());
  }
  lsSet(LS_BLOB_ID, blobId);

  try{
    published = await getBlob(blobId);
  }catch(e){
    published = null;
  }

  const savedDraft = lsGet(LS_DRAFT_PREFIX + blobId);
  if(savedDraft){
    try{ draft = JSON.parse(savedDraft); }catch(e){ draft = published ? stripMeta(published) : emptyBoard(); }
  } else {
    draft = published ? stripMeta(published) : emptyBoard();
  }
  if(draft.events && draft.events.length) activeEventId = draft.events[0].id;

  setMode(false);
}

boot();

})();
