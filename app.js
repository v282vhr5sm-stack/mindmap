'use strict';
// 아이패드용 마인드맵 — 키보드 입력 + 애플펜슬 손글씨, 곡선 화살표 연결. 데이터는 이 기기(IndexedDB)에 저장.

const $ = s => document.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const stage = $('#stage'), world = $('#world'), nodesLayer = $('#nodes');
const edgeGroup = $('#edgeGroup'), tmpEdge = $('#tmpEdge'), edgeDel = $('#edgeDel');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const r1 = v => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------- 저장 (IndexedDB) ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('mindmap', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('boards', { keyPath: 'id' });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(mode, fn) {
    return new Promise(res => {
      try { const r = fn(this.db.transaction('boards', mode).objectStore('boards')); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }
      catch { res(null); }
    });
  },
  all() { return this.req('readonly', s => s.getAll()).then(v => v || []); },
  put(b) { return this.req('readwrite', s => s.put(b)); },
  del(id) { return this.req('readwrite', s => s.delete(id)); },
};

// ---------- 상태 ----------
let board = null;          // { id, title, nodes: {id: {id,x,y,text,ink:[{p:[[x,y],...]}]}}, edges: [{id,from,to}], view: {x,y,z}, updated }
let sel = null;            // { type: 'node'|'edge', id }
let editing = null;        // 편집 중인 상자 id
let editMode = null;       // 'kbd' | 'pen'
let editSnap = false;      // 이번 편집에서 되돌리기 기록을 남겼는지
let undoStack = [], redoStack = [];
let lastPtr = 'touch';     // 마지막으로 누른 입력 종류
let pendingFocus = null;
const els = new Map(), sizes = new Map();

const CE = (() => { const d = document.createElement('div'); try { d.contentEditable = 'plaintext-only'; } catch {} return d.contentEditable === 'plaintext-only' ? 'plaintext-only' : 'true'; })();

// ---------- 되돌리기 ----------
const snap = () => JSON.stringify({ nodes: board.nodes, edges: board.edges });
function pushUndo() { undoStack.push(snap()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; updateBar(); }
function restore(s) {
  const o = JSON.parse(s); board.nodes = o.nodes; board.edges = o.edges;
  if (sel && (sel.type === 'node' ? !board.nodes[sel.id] : !board.edges.some(e => e.id === sel.id))) sel = null;
  render(); save();
}
function undo() { exitEdit(); if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); }
function redo() { exitEdit(); if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); }

// ---------- 보기(이동/확대) ----------
function applyView() {
  const v = board.view;
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.z})`;
  stage.style.backgroundPosition = `${v.x}px ${v.y}px`;
  stage.style.backgroundSize = `${24 * v.z}px ${24 * v.z}px`;
}
const toWorld = (cx, cy) => ({ x: (cx - board.view.x) / board.view.z, y: (cy - board.view.y) / board.view.z });
function zoomAt(cx, cy, z) {
  const v = board.view, w = toWorld(cx, cy);
  v.z = clamp(z, 0.25, 3); v.x = cx - w.x * v.z; v.y = cy - w.y * v.z; applyView();
}
function fit() {
  const ids = Object.keys(board.nodes);
  if (!ids.length) { board.view = { x: 0, y: 0, z: 1 }; applyView(); save(); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of ids) { const r = rect(id); x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
  const W = innerWidth, H = innerHeight, pad = 90;
  const z = clamp(Math.min((W - pad * 2) / (x1 - x0), (H - pad * 2) / (y1 - y0), 1.2), 0.25, 3);
  board.view = { z, x: (W - (x1 - x0) * z) / 2 - x0 * z, y: (H - (y1 - y0) * z) / 2 - y0 * z + 20 };
  applyView(); save();
}

// ---------- 상자 ----------
function rect(id) {
  const n = board.nodes[id], s = sizes.get(id) || { w: 120, h: 46 };
  return { x: n.x, y: n.y, w: s.w, h: s.h };
}
function inkExtent(n) {
  let w = 0, h = 0;
  for (const s of n.ink) for (const [x, y] of s.p) { if (x > w) w = x; if (y > h) h = y; }
  return n.ink.length ? { w: w + 16, h: h + 14 } : { w: 0, h: 0 };
}
function strokeD(p) {
  if (p.length < 3) { const a = p[0], b = p[p.length - 1]; return `M${a[0]} ${a[1]} L${b[0] + 0.01} ${b[1]}`; }
  let d = `M${p[0][0]} ${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const mx = r1((p[i][0] + p[i + 1][0]) / 2), my = r1((p[i][1] + p[i + 1][1]) / 2);
    d += ` Q${p[i][0]} ${p[i][1]} ${mx} ${my}`;
  }
  const l = p[p.length - 1];
  return d + ` L${l[0]} ${l[1]}`;
}

function makeNodeEl(n) {
  const el = document.createElement('div');
  el.className = 'node'; el.dataset.id = n.id;
  el.innerHTML = `<div class="txt" data-ph="입력하거나 펜슬로 쓰기" spellcheck="false" autocapitalize="off"></div>
    <svg class="ink" xmlns="${NS}"></svg>
    <button class="nb plus" data-act="child" aria-label="아래로 꼬리 잇기">+</button>
    <button class="nb minus" data-act="sibling" aria-label="같은 줄에 추가">−</button>
    <button class="nb del" data-act="delete" aria-label="상자 삭제">×</button>`;
  const t = el.firstElementChild;
  let shift = false;
  t.addEventListener('keydown', e => {
    shift = e.shiftKey;
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') { e.preventDefault(); finishSoon(n.id); }
  });
  t.addEventListener('beforeinput', e => {
    if (e.inputType === 'insertParagraph' || (e.inputType === 'insertLineBreak' && !shift)) { e.preventDefault(); finishSoon(n.id); return; }
    if (editing === n.id && !editSnap) { pushUndo(); editSnap = true; }
  });
  t.addEventListener('input', () => {
    const m = board.nodes[n.id]; if (!m || editing !== n.id) return;
    m.text = t.innerText.replace(/ /g, ' ');
    measure(); drawEdges(); save();
  });
  t.addEventListener('paste', e => {
    if (CE === 'plaintext-only') return;
    e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
  });
  return el;
}

function updateNodeEl(n, el) {
  const isEd = editing === n.id, t = el.firstElementChild;
  el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
  if (!isEd && t.textContent !== n.text) t.textContent = n.text;
  if (el._ink !== n.ink || el._inkN !== n.ink.length) {
    const svg = el.querySelector('.ink'); svg.textContent = '';
    for (const s of n.ink) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', strokeD(s.p)); svg.appendChild(p); }
    el._ink = n.ink; el._inkN = n.ink.length;
  }
  const ext = inkExtent(n);
  el.style.minWidth = (isEd ? Math.max(280, ext.w + 110) : Math.max(56, ext.w)) + 'px';
  el.style.minHeight = (isEd ? Math.max(140, ext.h + 90) : ext.h) + 'px';
  el.classList.toggle('editing', isEd);
  el.classList.toggle('selected', !!sel && sel.type === 'node' && sel.id === n.id);
  el.classList.toggle('has-ink', n.ink.length > 0);
}

function render() {
  for (const [id, el] of els) if (!board.nodes[id]) { el.remove(); els.delete(id); sizes.delete(id); }
  for (const n of Object.values(board.nodes)) {
    let el = els.get(n.id);
    if (!el) { el = makeNodeEl(n); els.set(n.id, el); nodesLayer.appendChild(el); }
    updateNodeEl(n, el);
  }
  measure(); drawEdges(); applyView(); updateBar();
  $('#hint').hidden = Object.keys(board.nodes).length > 0;
}
function measure() { for (const [id, el] of els) sizes.set(id, { w: el.offsetWidth, h: el.offsetHeight }); }

// ---------- 곡선 화살표 ----------
function curve(a, b, gap = 7) {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  let p1, p2, c1, c2, k;
  if (b.y >= a.y + a.h + 14) {            // 아래
    p1 = [acx, a.y + a.h]; p2 = [bcx, b.y - gap]; k = Math.max(30, (p2[1] - p1[1]) * 0.55);
    c1 = [p1[0], p1[1] + k]; c2 = [p2[0], p2[1] - k];
  } else if (b.y + b.h <= a.y - 14) {     // 위
    p1 = [acx, a.y]; p2 = [bcx, b.y + b.h + gap]; k = Math.max(30, (p1[1] - p2[1]) * 0.55);
    c1 = [p1[0], p1[1] - k]; c2 = [p2[0], p2[1] + k];
  } else if (bcx >= acx) {                // 오른쪽
    p1 = [a.x + a.w, acy]; p2 = [b.x - gap, bcy]; k = Math.max(30, (p2[0] - p1[0]) * 0.55);
    c1 = [p1[0] + k, p1[1]]; c2 = [p2[0] - k, p2[1]];
  } else {                                // 왼쪽
    p1 = [a.x, acy]; p2 = [b.x + b.w + gap, bcy]; k = Math.max(30, (p1[0] - p2[0]) * 0.55);
    c1 = [p1[0] - k, p1[1]]; c2 = [p2[0] + k, p2[1]];
  }
  const f = v => r1(v);
  const mid = [0, 1].map(i => 0.125 * p1[i] + 0.375 * c1[i] + 0.375 * c2[i] + 0.125 * p2[i]);
  return { d: `M${f(p1[0])} ${f(p1[1])} C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`, mid };
}
function drawEdges() {
  edgeGroup.textContent = '';
  let delAt = null;
  for (const e of board.edges) {
    if (!board.nodes[e.from] || !board.nodes[e.to]) continue;
    const c = curve(rect(e.from), rect(e.to)), isSel = sel && sel.type === 'edge' && sel.id === e.id;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', c.d); p.setAttribute('class', 'edge' + (isSel ? ' sel' : ''));
    p.setAttribute('marker-end', `url(#${isSel ? 'arrowSel' : 'arrow'})`);
    const h = document.createElementNS(NS, 'path');
    h.setAttribute('d', c.d); h.setAttribute('class', 'ehit'); h.dataset.edge = e.id;
    edgeGroup.append(p, h);
    if (isSel) delAt = c.mid;
  }
  edgeDel.hidden = !delAt;
  if (delAt) { edgeDel.style.left = delAt[0] + 'px'; edgeDel.style.top = delAt[1] + 'px'; }
}

// ---------- 편집 ----------
function focusEnd(t) {
  t.focus({ preventScroll: true });
  const r = document.createRange(); r.selectNodeContents(t); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function startEdit(id, mode) {
  if (editing && editing !== id) finishEdit();
  if (!board.nodes[id]) return;
  editing = id; editMode = mode; editSnap = false; sel = { type: 'node', id };
  render();
  const t = els.get(id).firstElementChild;
  t.contentEditable = CE;
  if (mode === 'kbd') { focusEnd(t); pendingFocus = t; }
  else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}
// 편집 표시만 끄기 (빈 상자 정리 없이)
function exitEdit() {
  if (!editing) return;
  const el = els.get(editing);
  editing = null; editMode = null; pendingFocus = null;
  if (el) { const t = el.firstElementChild; t.blur(); t.contentEditable = 'false'; }
  render();
}
function finishEdit(opts = {}) {
  if (!editing) return;
  const id = editing, n = board.nodes[id], el = els.get(id);
  editing = null; editMode = null; pendingFocus = null;
  if (el) {
    const t = el.firstElementChild; t.blur();
    if (n) n.text = t.innerText.replace(/ /g, ' ').replace(/^\s*\n/, '').replace(/\s+$/, '');
    t.contentEditable = 'false'; t.textContent = n ? n.text : '';
  }
  if (n) {
    if (!n.text && !n.ink.length && !opts.keepEmpty) { removeNode(id); if (sel && sel.id === id) sel = null; }
    else if (n.ink.length && !n.text) {           // 손글씨만 있으면 상자를 글씨에 딱 맞게
      let mx = Infinity, my = Infinity;
      for (const s of n.ink) for (const [x, y] of s.p) { if (x < mx) mx = x; if (y < my) my = y; }
      const dx = r1(mx - 16), dy = r1(my - 12);
      if (dx || dy) { n.ink = n.ink.map(s => ({ p: s.p.map(([x, y]) => [r1(x - dx), r1(y - dy)]) })); n.x = r1(n.x + dx); n.y = r1(n.y + dy); }
    }
  }
  render(); save();
}
function finishSoon(id) {
  const el = els.get(id); if (el) el.firstElementChild.blur();   // 한글 조합 중인 글자 확정
  setTimeout(() => { if (editing === id) finishEdit(); }, 30);
}

function createNode(x, y) {
  const n = { id: uid(), x: r1(x), y: r1(y), text: '', ink: [] };
  board.nodes[n.id] = n; return n;
}
function removeNode(id) {
  delete board.nodes[id];
  board.edges = board.edges.filter(e => e.from !== id && e.to !== id);
}
function addEdge(from, to) {
  if (from === to || board.edges.some(e => e.from === from && e.to === to)) return false;
  board.edges.push({ id: uid(), from, to }); return true;
}
function freeSpot(x, y, w = 130, h = 48) {
  const hit = (x, y) => Object.keys(board.nodes).some(id => {
    const r = rect(id); return x < r.x + r.w + 16 && x + w + 16 > r.x && y < r.y + r.h + 16 && y + h + 16 > r.y;
  });
  for (let i = 0; i < 200 && hit(x, y); i++) x += 30;
  return [x, y];
}
function addChild(pid) {
  const p = rect(pid);
  const kids = board.edges.filter(e => e.from === pid && board.nodes[e.to]).map(e => rect(e.to)).filter(r => r.y > p.y + p.h);
  let x, y;
  if (!kids.length) { x = p.x + p.w / 2 - 60; y = p.y + p.h + 76; }
  else { const last = kids.reduce((a, b) => (b.x + b.w > a.x + a.w ? b : a)); x = last.x + last.w + 30; y = last.y; }
  [x, y] = freeSpot(x, y);
  const n = createNode(x, y); addEdge(pid, n.id); return n;
}
function addSibling(id) {
  const r = rect(id), parent = board.edges.find(e => e.to === id && board.nodes[e.from]);
  const [x, y] = freeSpot(r.x + r.w + 30, r.y);
  const n = createNode(x, y);
  if (parent) addEdge(parent.from, n.id);
  return n;
}

// ---------- 포인터(손가락·펜슬) ----------
const ptrs = new Map();
let g = null;        // 진행 중인 한 손가락/펜 동작
let pinch = null;
let lastTap = null;
const touchList = () => [...ptrs.values()].filter(p => p.type === 'touch');

function cancelGesture() {
  if (!g) return;
  if (g.kind === 'ink') { g.path.remove(); undoStack.pop(); updateBar(); }
  if (g.connect) tmpEdge.setAttribute('d', '');
  g = null;
}
function startPinch() {
  cancelGesture();
  const [a, b] = touchList();
  pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, c0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v0: { ...board.view } };
}
function movePinch() {
  const [a, b] = touchList(); if (!b) return;
  const { v0, c0, d0 } = pinch, z = clamp(v0.z * Math.hypot(a.x - b.x, a.y - b.y) / d0, 0.25, 3);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, wx = (c0.x - v0.x) / v0.z, wy = (c0.y - v0.y) / v0.z;
  board.view = { z, x: cx - wx * z, y: cy - wy * z }; applyView();
}

window.addEventListener('pointerdown', e => { lastPtr = e.pointerType; }, true);

stage.addEventListener('pointerdown', e => {
  if (e.target.closest('button')) return;
  const pen = e.pointerType !== 'touch';
  const nodeEl = e.target.closest('.node'), nid = nodeEl && nodeEl.dataset.id;
  const edgeId = e.target.closest('.ehit')?.dataset.edge;

  if (!pen) {
    if (g && g.pen) return;                                 // 펜슬 쓰는 중엔 손바닥 무시
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: 'touch' });
    if (touchList().length === 2) { startPinch(); return; }
    if (g || pinch) return;
    if (editing && nid === editing) return;                 // 편집 중인 글자는 기본 동작(커서 이동)
    if (editing && editMode === 'pen') return;              // 손글씨 중엔 한 손가락(손바닥) 무시
  } else {
    if (g && !g.pen) cancelGesture();                       // 펜슬이 손가락보다 우선
    if (g) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: 'pen' });
    if (editing && nid === editing) { e.preventDefault(); startInk(e, nid); return; }
    if (editing) finishEdit();                              // 상자 밖을 펜슬로 터치 → 쓰기 끝
  }
  const kind = nid && board.nodes[nid] ? 'node' : edgeId ? 'edge' : 'empty';
  g = { kind, id: kind === 'node' ? nid : edgeId, pen, pid: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false };
  if (kind === 'node') { g.ox = board.nodes[nid].x; g.oy = board.nodes[nid].y; }
  else { g.vx = board.view.x; g.vy = board.view.y; }
  try { stage.setPointerCapture(e.pointerId); } catch {}
});

function startInk(e, id) {
  pushUndo();
  const path = document.createElementNS(NS, 'path');
  els.get(id).querySelector('.ink').appendChild(path);
  g = { kind: 'ink', id, pen: true, pid: e.pointerId, pts: [], path };
  try { stage.setPointerCapture(e.pointerId); } catch {}
  addInkPoint(e);
}
function addInkPoint(e) {
  const n = board.nodes[g.id], w = toWorld(e.clientX, e.clientY);
  const pt = [r1(w.x - n.x), r1(w.y - n.y)], last = g.pts[g.pts.length - 1];
  if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.7) return;
  g.pts.push(pt); g.path.setAttribute('d', strokeD(g.pts));
}

stage.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; }
  if (pinch) { if (p && p.type === 'touch') movePinch(); return; }
  if (!g || g.pid !== e.pointerId) return;
  if (g.kind === 'ink') { const ce = e.getCoalescedEvents ? e.getCoalescedEvents() : []; for (const c of ce.length ? ce : [e]) addInkPoint(c); return; }
  const dx = e.clientX - g.sx, dy = e.clientY - g.sy, z = board.view.z;
  if (!g.moved && Math.hypot(dx, dy) > (g.pen ? 6 : 9)) {
    g.moved = true;
    if (g.kind === 'node' && !g.pen) pushUndo();
    if (g.kind === 'node' && g.pen) g.connect = true;
  }
  if (!g.moved) return;
  if (g.kind === 'node' && g.connect) {
    const w = toWorld(e.clientX, e.clientY);
    tmpEdge.setAttribute('d', curve(rect(g.id), { x: w.x, y: w.y, w: 0, h: 0 }, 0).d);
  } else if (g.kind === 'node') {
    const n = board.nodes[g.id]; n.x = r1(g.ox + dx / z); n.y = r1(g.oy + dy / z);
    const el = els.get(g.id); el.style.left = n.x + 'px'; el.style.top = n.y + 'px';
    drawEdges();
  } else {
    board.view.x = g.vx + dx; board.view.y = g.vy + dy; applyView();
  }
});

function endPointer(e, cancelled) {
  ptrs.delete(e.pointerId);
  if (pinch) { if (touchList().length < 2) { pinch = null; save(); } return; }
  if (!g || g.pid !== e.pointerId) return;
  const cur = g; g = null;
  if (cancelled) { g = cur; cancelGesture(); return; }

  if (cur.kind === 'ink') {
    const n = board.nodes[cur.id];
    if (n && cur.pts.length) { n.ink.push({ p: cur.pts.length === 1 ? [cur.pts[0], cur.pts[0]] : cur.pts }); render(); save(); }
    else { cur.path.remove(); undoStack.pop(); updateBar(); }
    return;
  }
  if (cur.kind === 'node') {
    if (cur.connect) {
      tmpEdge.setAttribute('d', '');
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node')?.dataset.id;
      if (hit && hit !== cur.id) { pushUndo(); if (!addEdge(cur.id, hit)) undoStack.pop(); sel = { type: 'node', id: hit }; render(); save(); }
      else if (!hit) {                                        // 빈 곳에 놓으면 새 상자
        pushUndo();
        const w = toWorld(e.clientX, e.clientY), n = createNode(w.x - 20, w.y - 22);
        addEdge(cur.id, n.id); render(); startEdit(n.id, 'pen'); save();
      }
      return;
    }
    if (cur.moved) { save(); return; }
    startEdit(cur.id, cur.pen ? 'pen' : 'kbd');                // 탭 → 편집 (손가락: 키보드, 펜슬: 손글씨)
    return;
  }
  if (cur.moved) { save(); return; }
  if (cur.kind === 'edge') { if (editing) finishEdit(); sel = { type: 'edge', id: cur.id }; render(); return; }

  // 빈 곳 탭
  const now = Date.now();
  if (lastTap && now - lastTap.t < 380 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
    lastTap = null;
    if (editing) finishEdit();
    pushUndo();
    const w = toWorld(e.clientX, e.clientY), n = createNode(w.x - 60, w.y - 24);
    render(); startEdit(n.id, cur.pen ? 'pen' : 'kbd'); save();
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
  if (editing) finishEdit();
  if (sel) { sel = null; render(); }
}
stage.addEventListener('pointerup', e => endPointer(e, false));
stage.addEventListener('pointercancel', e => endPointer(e, true));

// 펜슬 터치는 기본 동작 막기 (iPad 손글씨→텍스트 자동변환·스크롤 방지)
for (const type of ['touchstart', 'touchmove']) {
  stage.addEventListener(type, e => {
    if (e.target.closest('button')) return;
    for (const t of e.changedTouches) if (t.touchType === 'stylus') { e.preventDefault(); return; }
  }, { passive: false });
}
// 키보드 올리기 보조 (iOS는 사용자 탭 안에서만 키보드가 열림)
document.addEventListener('click', () => {
  if (pendingFocus && editing && document.activeElement !== pendingFocus && pendingFocus.isConnected) focusEnd(pendingFocus);
  pendingFocus = null;
});
document.addEventListener('gesturestart', e => e.preventDefault());
stage.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) zoomAt(e.clientX, e.clientY, board.view.z * Math.exp(-e.deltaY * 0.01));
  else { board.view.x -= e.deltaX; board.view.y -= e.deltaY; applyView(); }
  save();
}, { passive: false });

// 상자 버튼 (+ / − / ×)
nodesLayer.addEventListener('click', e => {
  const b = e.target.closest('.nb'); if (!b) return;
  const id = b.closest('.node').dataset.id, act = b.dataset.act;
  const mode = lastPtr === 'touch' ? 'kbd' : 'pen';
  if (act === 'delete') { exitEdit(); pushUndo(); removeNode(id); sel = null; render(); save(); return; }
  if (editing) finishEdit({ keepEmpty: true });
  if (!board.nodes[id]) return;
  pushUndo();
  const n = act === 'child' ? addChild(id) : addSibling(id);
  render(); startEdit(n.id, mode); save();
});
edgeDel.addEventListener('click', () => {
  if (!sel || sel.type !== 'edge') return;
  pushUndo(); board.edges = board.edges.filter(x => x.id !== sel.id); sel = null; render(); save();
});
edgeDel.addEventListener('pointerdown', e => e.stopPropagation());

// ---------- 상단 버튼 ----------
function updateBar() {
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;
  $('#titleBtn').textContent = board ? board.title : '마인드맵';
}
$('#undoBtn').onclick = undo;
$('#redoBtn').onclick = redo;
$('#fitBtn').onclick = () => { if (editing) finishEdit(); fit(); };
$('#addBtn').onclick = () => {
  if (editing) finishEdit();
  pushUndo();
  const w = toWorld(innerWidth / 2, innerHeight / 2);
  const [x, y] = freeSpot(w.x - 60, w.y - 24);
  const n = createNode(x, y);
  render(); startEdit(n.id, lastPtr === 'touch' ? 'kbd' : 'pen'); save();
};
$('#titleBtn').onclick = () => {
  const t = prompt('마인드맵 이름', board.title);
  if (t && t.trim()) { board.title = t.trim(); updateBar(); save(); }
};

// ---------- 목록 ----------
async function openDrawer() {
  if (editing) finishEdit();
  await flush();
  const list = (await DB.all()).sort((a, b) => b.updated - a.updated);
  const box = $('#boardList'); box.textContent = '';
  for (const b of list) {
    const row = document.createElement('div'); row.className = 'brow' + (b.id === board.id ? ' cur' : '');
    const d = new Date(b.updated);
    row.innerHTML = `<button class="open"><b></b><small>${d.getMonth() + 1}월 ${d.getDate()}일 · 상자 ${Object.keys(b.nodes).length}개</small></button><button class="rm" aria-label="삭제">🗑</button>`;
    row.querySelector('b').textContent = b.title;
    row.querySelector('.open').onclick = () => { loadBoard(b); closeDrawer(); };
    row.querySelector('.rm').onclick = async () => {
      if (!confirm(`'${b.title}'을(를) 삭제할까요? 되돌릴 수 없어요.`)) return;
      await DB.del(b.id);
      if (b.id === board.id) { const rest = list.filter(x => x.id !== b.id); loadBoard(rest[0] || newBoard()); }
      openDrawer();
    };
    box.appendChild(row);
  }
  $('#drawer').hidden = false;
}
function closeDrawer() { $('#drawer').hidden = true; }
$('#menuBtn').onclick = openDrawer;
$('#closeDrawer').onclick = closeDrawer;
$('#drawer').addEventListener('click', e => { if (e.target.id === 'drawer') closeDrawer(); });
$('#newBoard').onclick = async () => { await flush(); loadBoard(newBoard()); closeDrawer(); };

function newBoard() {
  const d = new Date();
  const b = { id: uid(), title: `마인드맵 ${d.getMonth() + 1}.${d.getDate()}`, nodes: {}, edges: [], view: { x: 0, y: 0, z: 1 }, updated: Date.now() };
  DB.put(b); return b;
}
function loadBoard(b) {
  editing = null; editMode = null; sel = null; g = null; pinch = null;
  undoStack = []; redoStack = [];
  for (const el of els.values()) el.remove();
  els.clear(); sizes.clear();
  board = b;
  for (const n of Object.values(b.nodes))                    // 쓰다 만 빈 상자 정리
    if (!n.text && !n.ink.length && !b.edges.some(e => e.from === n.id)) removeNode(n.id);
  try { localStorage.setItem('mm.current', b.id); } catch {}
  render();
}

// ---------- 저장 ----------
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 400); }
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!board) return Promise.resolve();
  board.updated = Date.now();
  return DB.put(JSON.parse(JSON.stringify(board)));
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
window.addEventListener('pagehide', flush);
window.addEventListener('resize', () => { measure(); drawEdges(); });

// ---------- 시작 ----------
(async () => {
  try { await DB.open(); } catch { alert('이 브라우저에서는 저장이 안 될 수 있어요. (개인정보 보호 모드인지 확인해 주세요)'); DB.all = async () => []; DB.put = DB.del = async () => {}; }
  const list = await DB.all();
  let cur = null; try { cur = localStorage.getItem('mm.current'); } catch {}
  const b = list.find(x => x.id === cur) || list.sort((a, b) => b.updated - a.updated)[0] || newBoard();
  loadBoard(b);
  if (!['localhost', '127.0.0.1'].includes(location.hostname) && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();
