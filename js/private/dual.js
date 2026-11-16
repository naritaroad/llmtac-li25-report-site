// dual.js — two windows of the report on one computer, one in the presenter's language, one in English on the
// projector, kept on the same page, the same stage and the same 3D state. Private build only: the public site
// never gets this file or the <script> that loads it (tools/publish_site.py drops js/private/ and strips the tag).
//
// Shift+D  in an ordinary window: it becomes the lead window and opens the follower (index.html?dual=follow&lang=en).
//          Press it again in the lead window to stop. In the follower it leaves follow mode.
// The follower ignores mouse, wheel and keys from its own screen, except L, T, P (language, theme, projector text,
// all kept local and not saved) and the browser's own keys (F11 for full screen).
//
// What travels over BroadcastChannel('msgraph-dual'), lead → follower:
//   scroll     the block at the reading line and how far into it, never pixels: the two languages wrap differently
//   ui         stage view, stage size, KP list open, how many boxes are open (sent after input and every second)
//   pref       sync, live, swap, split (not lang, theme, big, timer)
//   act        article buttons and Space / R on the stage (Stage.run, dispatch, primary)
//   click      other buttons, words, symbols and formulas, found by a path from the nearest id; inside a language
//              span by what it is (data-term, data-sym, ...) and its order among those in the same block
//   input      sliders, selects, check boxes;  toggle  <details>;  dclose  a <dialog> closing
//   media      play, pause, seek, rate of a <video>;  escroll  scroll position inside a panel
//   mview      camera and picked part of each 3D model cell
//   lab        3D lab in lockstep: every input to the simulation (commands, parameters, plan, reset, a part carried
//              by the pointer) tagged with the tick it happened at; the follower steps its own simulation to the
//              lead's tick, applies each input at the same tick and gets the same physics and the same panels.
//              Every tenth tick message carries the lead's poses; if the follower ever differs it draws the lead's
//              poses instead (puppet) until the next reset. Joining resets the lab in both windows.
//   cam        3D lab camera: preset name, eye, target

import * as prefs from '../ui/prefs.js';

const CHANNEL = 'msgraph-dual';
const SYNC_PREFS = ['sync', 'live', 'swap', 'split'];
const LOCAL_KEYS = { l: 'lang', t: 'theme', p: 'big' };
const ROOTS = '#cover, #article, #thanks, #site-footer';
const DYNAMIC = '.eq-live, .lv, .model3d > *, [data-dual-ghost]';   // drawn late or by state: not an anchor
const BLOCK = ':is(h1,h2,h3,h4,h5,h6,p,li,figure,table,tr,pre,blockquote,dt,dd,hr,details,summary,section,aside,header,footer,.model3d)';
const CLICKABLE = 'button, a[href], [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="option"], '
  + '[data-act], [data-sym], [data-el], [data-goto], .term, .gl, .sym-ref, .eq-body, .eq-inline, .lv-math, .pop-formula';
const NO_CLICK = '#settings, #settings-btn, #keys-dialog, #hud-timer, #hud-reset, #keys-open, .stage-tabs, #stage-full, #stage-min, '
  + '.stage-bar, #sync-btn, summary, canvas, video, input, select, textarea, label, [data-dual="local"]';
const SEMANTIC = ['data-term', 'data-sym', 'data-el', 'data-goto', 'data-act', 'data-model', 'data-m3', 'data-ctl', 'data-hud', 'data-stage'];
const LAB_CHECK_EVERY = 10;         // tick messages between pose comparisons
const LAB_MAX_TICKS = 720;          // per frame when the follower catches up (3 s of simulation)

const root = document.documentElement;
const me = Math.random().toString(36).slice(2, 10);
const q0 = new URLSearchParams(location.search);
let role = q0.get('dual') === 'follow' ? 'follow' : 'off';
let leader = null;                  // id of the lead window, as the follower knows it
let lastFromLeader = 0;
let replaying = false;              // the follower is applying a message (nothing it does is sent)
let bc = null;
try { bc = new BroadcastChannel(CHANNEL); } catch { /* very old browser: the feature is simply absent */ }

const S = () => window.Stage;
const send = (t, d = {}) => { if (bc) bc.postMessage({ ...d, t, from: me }); };
const leading = () => role === 'lead';
const following = () => role === 'follow';

// ───────────────────────────────── small helpers

function toast(en, zh, ms = 3200) {
  let el = document.getElementById('dual-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dual-toast';
    el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:200;max-width:min(92vw,560px);'
      + 'padding:10px 16px;border-radius:12px;font:500 14px/1.45 var(--font-ui, system-ui, sans-serif);color:var(--ink);'
      + 'background:var(--glass-bg-strong, var(--paper));border:1px solid var(--rule-strong, currentColor);'
      + 'box-shadow:0 6px 24px rgba(10,17,30,.18);backdrop-filter:blur(10px);pointer-events:none;transition:opacity .3s';
    document.body.append(el);
  }
  el.innerHTML = `<span class="en">${en}</span><span class="zh">${zh}</span>`;
  el.style.opacity = '1';
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.style.opacity = '0'; }, ms);
}

function setRoleAttr() {
  if (role === 'off') delete root.dataset.dual; else root.dataset.dual = role;
}
{
  const st = document.createElement('style');
  st.textContent = 'html[data-dual="follow"] :is(#settings-btn, #settings, #hud-timer, #hud-reset) { display: none !important; }';
  document.head.append(st);
}

const visible = (el) => !!el && el.getClientRects().length > 0;
const isTyping = (t) => t instanceof Element && !!t.closest('input:not([type="range"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]');

/** Path from the nearest element with a unique id: { id, s: [child indexes] }. */
function pathOf(el) {
  const s = [];
  let n = el;
  while (n && n !== document.body && n !== root) {
    if (n.id && document.getElementById(n.id) === n) return { id: n.id, s: s.reverse() };
    const parent = n.parentElement;
    if (!parent) break;
    s.push(Array.prototype.indexOf.call(parent.children, n));
    n = parent;
  }
  return { id: null, s: s.reverse() };
}
function resolvePath(p) {
  if (!p) return null;
  let n = p.id ? document.getElementById(p.id) : document.body;
  for (const i of p.s || []) { n = n?.children[i]; if (!n) return null; }
  return n;
}

const langSpan = (el) => el.closest('span.en, span.zh, .en, .zh');
function semanticSel(el) {
  for (const a of SEMANTIC) if (el.hasAttribute(a)) return `[${a}="${CSS.escape(el.getAttribute(a))}"]`;
  const cls = [...el.classList].find((c) => !/^is-/.test(c));
  return el.tagName.toLowerCase() + (cls ? `.${CSS.escape(cls)}` : '');
}
/** Where an element is, in a form the other window can find even when it shows the other language. */
function locate(el) {
  const ls = langSpan(el);
  if (!ls) return { p: pathOf(el) };
  let block = ls.parentElement;
  while (block && langSpan(block)) block = block.parentElement;
  if (!block) return { p: pathOf(el) };
  const lang = ls.classList.contains('zh') ? 'zh' : 'en';
  const sel = semanticSel(el);
  const same = [...block.querySelectorAll(sel)].filter((x) => langSpan(x)?.classList.contains(lang));
  return { p: pathOf(block), sel, n: Math.max(0, same.indexOf(el)) };
}
function find(loc) {
  if (!loc) return null;
  const base = resolvePath(loc.p);
  if (!base || !loc.sel) return base;
  const mine = prefs.lang() === 'zh' ? 'zh' : 'en';
  const pick = (scope, n) => {
    const shown = [...scope.querySelectorAll(loc.sel)].filter(visible);
    const inMine = shown.filter((x) => { const s = langSpan(x); return !s || s.classList.contains(mine); });
    return inMine[n] || inMine[0] || null;
  };
  const here = pick(base, loc.n);
  if (here) return here;
  // A word is made pressable once per block and language, so this language may have it elsewhere, or not at all.
  // A word box needs an anchor near the spot: borrow the attributes on an invisible stand-in in this block.
  if (/^\[data-(?:term|sym|el)=/.test(loc.sel)) {
    const proto = document.querySelector(loc.sel);
    const host = [...base.children].find((c) => c.matches?.(`.${mine}`) && visible(c)) || base;
    if (proto) {
      const ghost = proto.cloneNode(false);
      ghost.dataset.dualGhost = '1';
      ghost.classList.remove('is-open', 'is-same');
      ghost.removeAttribute('id');
      ghost.style.cssText = 'display:inline-block;width:1px;height:1em;overflow:hidden;vertical-align:baseline;opacity:0;pointer-events:none';
      host.append(ghost);
      return ghost;
    }
  }
  const sec = base.closest('section.kp, figure, aside, .pop');
  return (sec && pick(sec, 0)) || null;
}
function dropGhosts() { for (const g of document.querySelectorAll('[data-dual-ghost]')) if (!g.classList.contains('is-open')) g.remove(); }

// ───────────────────────────────── scroll: the block at the reading line

let blocks = null;
let blocksDirty = true;
let lastBlock = 0;
function getBlocks() {
  if (blocks && !blocksDirty) return blocks;
  const out = [];
  for (const r of document.querySelectorAll(ROOTS)) {
    out.push(r);
    for (const el of r.querySelectorAll(BLOCK)) if (!langSpan(el) && !el.closest(DYNAMIC)) out.push(el);
  }
  blocks = out; blocksDirty = false;
  return blocks;
}
// Live formulas re-render all the time; only a block coming or going changes the list.
const isBlockish = (n) => n instanceof Element && (n.matches(BLOCK) || !!n.querySelector(BLOCK));
new MutationObserver((recs) => {
  if (blocksDirty) return;
  for (const r of recs) {
    if (!(r.target instanceof Element) || !r.target.closest(ROOTS)) continue;
    for (const n of r.addedNodes) if (isBlockish(n)) { blocksDirty = true; return; }
    for (const n of r.removedNodes) if (isBlockish(n)) { blocksDirty = true; return; }
  }
}).observe(document.body, { childList: true, subtree: true });

function readingLine() {
  const top = parseFloat(getComputedStyle(root).getPropertyValue('--sticky-top')) || 0;
  const vh = window.innerHeight || 800;
  return top + Math.max(40, (vh - top) * 0.3);
}
function anchor() {
  const list = getBlocks();
  if (!list.length) return null;
  const line = readingLine();
  const topOf = (i) => { const el = list[i]; return visible(el) ? el.getBoundingClientRect().top : null; };
  let i = Math.min(lastBlock, list.length - 1);
  const t0 = topOf(i);
  if (t0 === null || t0 > line) {
    // walk back to the last visible block that starts above the line
    while (i > 0) { i--; const t = topOf(i); if (t !== null && t <= line) break; }
  }
  for (let j = i + 1; j < list.length; j++) {
    const t = topOf(j);
    if (t === null) continue;
    if (t > line) break;
    i = j;
  }
  lastBlock = i;
  const el = list[i], r = el.getBoundingClientRect();
  if (r.bottom > line) return { p: pathOf(el), i, f: r.height > 0 ? (line - r.top) / r.height : 0 };
  // The line sits between this block and the next one (a margin, or content that is not a block of its own):
  // say how far along that gap, so a window that wraps the text differently lands at the same share of it.
  for (let j = i + 1; j < list.length; j++) {
    const nb = list[j];
    if (!visible(nb)) continue;
    const nr = nb.getBoundingClientRect();
    return { p: pathOf(el), p2: pathOf(nb), i, g: Math.min(1, (line - r.bottom) / Math.max(1, nr.top - r.bottom)) };
  }
  return { p: pathOf(el), i, f: 1, px: line - r.bottom };
}
let lastAnchor = null;
function applyAnchor(a) {
  if (!a) return;
  lastAnchor = a;
  // the same element by its path from the nearest id; if this window lacks it, the closest ancestor that it has
  const reach = (p) => {
    const steps = [...(p?.s || [])];
    let exact = true;
    for (;;) {
      const el = resolvePath({ id: p?.id || null, s: steps });
      if (el && visible(el)) return { el, exact };
      if (!steps.length) return null;
      steps.pop(); exact = false;
    }
  };
  const A = reach(a.p);
  if (!A) return;
  const r = A.el.getBoundingClientRect();
  let y;
  if (a.p2 && A.exact) {
    const B = reach(a.p2);
    y = B && B.exact ? r.bottom + a.g * (B.el.getBoundingClientRect().top - r.bottom) : r.bottom;
  } else if (A.exact) y = r.top + (a.f ?? 0) * r.height + (a.px || 0);
  else y = r.top;
  const want = window.scrollY + y - readingLine();
  const top = Math.max(0, Math.round(want));
  if (Math.abs(top - window.scrollY) >= 1) window.scrollTo({ top, behavior: 'instant' });
}

// ───────────────────────────────── state sent as a whole

function uiState() {
  const st = S();
  return {
    view: st?.current, size: st?.size?.(), rail: !!st?.nav?.railOpen?.(), pops: st?.pop?.openCount ?? 0,
  };
}
function applyUi(u) {
  const st = S();
  if (!st || !u) return;
  if (u.size && st.size() !== u.size) st.setSize(u.size);
  if (u.view && st.current !== u.view) st.show(u.view);
  if (st.nav && st.nav.railOpen() !== u.rail) st.nav.setRail(u.rail);
  let guard = 8;
  while (st.pop && st.pop.openCount > u.pops && guard--) st.pop.closeLast();
  dropGhosts();
}
let uiTimer = 0;
function sendUiSoon() {
  if (!leading()) return;
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => send('ui', { u: uiState() }), 60);
}

const detailsIn = () => [...document.querySelectorAll('#article details, #stage details')];
const videos = () => [...document.querySelectorAll('video')];
function mediaState(v) { return { loc: locate(v), time: v.currentTime, paused: v.paused, rate: v.playbackRate }; }
function applyMedia(m) {
  const v = find(m.loc);
  if (!(v instanceof HTMLMediaElement)) return;
  v.muted = true;
  if (v.playbackRate !== m.rate) v.playbackRate = m.rate;
  if (Math.abs(v.currentTime - m.time) > 0.3) { try { v.currentTime = m.time; } catch { /* not loaded yet */ } }
  if (m.paused && !v.paused) v.pause();
  else if (!m.paused && v.paused) v.play().catch(() => {});
}
const modelSlots = () => [...document.querySelectorAll('.model3d[data-models]')];

function snapshot() {
  return {
    prefs: Object.fromEntries(SYNC_PREFS.map((k) => [k, prefs.get(k)])),
    u: uiState(),
    scroll: anchor(),
    details: detailsIn().map((d) => ({ loc: locate(d), open: d.open })),
    media: videos().filter((v) => !v.paused || v.currentTime > 0).map(mediaState),
    mviews: modelSlots().map((s, i) => (s.__viewer ? { i, v: s.__viewer.getView(), pick: s.__viewer.picked } : null)).filter(Boolean),
  };
}
function applySnapshot(s) {
  for (const [k, v] of Object.entries(s.prefs || {})) prefs.set(k, v, { persist: false });
  S()?.pop?.close?.();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  applyUi(s.u);
  for (const d of s.details || []) { const el = find(d.loc); if (el instanceof HTMLDetailsElement && el.open !== d.open) el.open = d.open; }
  for (const m of s.media || []) applyMedia(m);
  for (const m of s.mviews || []) mview.set(m);
  requestAnimationFrame(() => applyAnchor(s.scroll));
}

// ───────────────────────────────── 3D model cells

const mview = {
  want: new Map(), last: new Map(),
  set(m) { this.want.set(m.i, m); },
  tickLead() {
    modelSlots().forEach((s, i) => {
      const v = s.__viewer;
      if (!v) return;
      const view = v.getView(), pick = v.picked;
      const key = view.p.concat(view.t).map((x) => x.toFixed(4)).join(',') + '|' + pick;
      if (this.last.get(i) === key) return;
      this.last.set(i, key);
      send('mview', { m: { i, v: view, pick } });
    });
  },
  tickFollow() {
    if (!this.want.size) return;
    const slots = modelSlots();
    for (const [i, m] of this.want) {
      const v = slots[i]?.__viewer;
      if (!v) continue;
      v.setView(m.v);
      if (v.picked !== m.pick) { try { v.pick(m.pick); } catch { /* model differs for a moment */ } }
      this.want.delete(i);
    }
  },
};

// ───────────────────────────────── 3D lab: lockstep

const LAB = { lab: null, sim: null, rig: null, orig: null };
const L = {                         // lead side
  linked: false, wantLock: false, epoch: 0, lastTick: -1, lastCam: '',
};
const F = {                         // follower side
  locked: false, waitReset: false, epoch: 0, queue: [], pose: null, count: 0, puppet: false, cam: null, camPreset: null,
};
const labTick = () => Math.round(LAB.sim.time / LAB.sim.dt);
const followLocked = () => following() && F.locked;

function installLab(lab) {
  const { sim, rig } = lab.debug;
  LAB.lab = lab; LAB.sim = sim; LAB.rig = rig;
  const orig = LAB.orig = {
    cmd: { ...sim.command }, setParam: sim.setParam, loadPlan: sim.loadPlan, reset: sim.reset, advance: sim.advance,
    setPartPose: sim.physics.setPartPose,
    setJoints: rig.robot.setJoints, setGripper: rig.robot.setGripper, rigPartPose: rig.setPartPose,
    setCameraPreset: rig.setCameraPreset, setOrbit: rig.setOrbit,
  };
  const rec = (op, a) => { if (leading() && L.linked) send('lab', { e: L.epoch, k: labTick(), op, a }); };
  // what the follower's own buttons would have done locally: the answer, but no effect
  const dry = (name) => (name === 'pause' || name === 'resume' || name === 'stop' || name === 'runPlan') ? undefined : !sim.busy;

  for (const name of Object.keys(orig.cmd)) {
    sim.command[name] = (...a) => {
      if (followLocked()) return dry(name);
      rec('cmd', [name, a]);
      return orig.cmd[name](...a);
    };
  }
  sim.setParam = (...a) => { if (followLocked()) return true; rec('param', a); return orig.setParam(...a); };
  sim.loadPlan = (...a) => { if (followLocked()) return undefined; rec('plan', a); return orig.loadPlan(...a); };
  sim.reset = (...a) => {
    if (followLocked()) return undefined;
    if (leading() && L.linked) { send('lab', { e: L.epoch, k: labTick(), op: 'reset', a }); L.epoch++; }
    return orig.reset(...a);
  };
  sim.physics.setPartPose = (...a) => { if (followLocked()) return undefined; rec('pose', a); return orig.setPartPose(...a); };
  lab.on('grab', (d) => rec('grav', [d.part, d.state === 'held' ? 0 : 1]));
  sim.advance = (sec) => (followLocked() ? lockAdvance() : orig.advance(sec));

  // picture: in puppet mode the follower draws the lead's poses
  const rb = rig.robot;
  rb.setJoints = (qv) => orig.setJoints.call(rb, followLocked() && F.puppet && F.pose ? F.pose.q : qv);
  rb.setGripper = (w) => orig.setGripper.call(rb, followLocked() && F.puppet && F.pose ? F.pose.w : w);
  rig.setPartPose = (k, p, quat) => {
    const pp = followLocked() && F.puppet && F.pose ? F.pose.parts[k] : null;
    return pp ? orig.rigPartPose(k, pp.slice(0, 3), pp.slice(3)) : orig.rigPartPose(k, p, quat);
  };
  // camera: the follower's own acts do not move its camera; the lead's camera does
  rig.setCameraPreset = (n, o) => (followLocked() ? true : orig.setCameraPreset(n, o));
  rig.setOrbit = (on) => (followLocked() ? undefined : orig.setOrbit(on));

  if (following()) send('labhello');
  if (leading() && L.wantLock) lockLab();
}

function lockLab() {
  if (!LAB.lab) { L.wantLock = true; return; }
  L.wantLock = false;
  L.linked = true; L.lastTick = -1; L.lastCam = '';
  send('lablock');
  LAB.lab.reset();
}

function applyLabOp(m) {
  const o = LAB.orig, sim = LAB.sim;
  switch (m.op) {
    case 'reset': o.reset(...m.a); F.epoch = m.e + 1; F.puppet = false; F.count = 0; break;
    case 'cmd': o.cmd[m.a[0]]?.(...m.a[1]); break;
    case 'param': o.setParam(...m.a); break;
    case 'plan': o.loadPlan(...m.a); break;
    case 'pose': o.setPartPose(...m.a); break;
    case 'grav': {
      const b = sim.physics.parts.get(m.a[0])?.body;
      b?.setGravityScale(m.a[1], true);
      if (m.a[1] === 1) b?.wakeUp?.();
      break;
    }
    default:
  }
}
function comparePose(p) {
  const st = LAB.sim.state;
  let d = 0;
  for (let j = 0; j < 6; j++) d = Math.max(d, Math.abs(st.q[j] - p.q[j]));
  for (const [k, v] of Object.entries(p.parts)) {
    const s = st.parts[k];
    if (!s) continue;
    for (let j = 0; j < 3; j++) d = Math.max(d, Math.abs(s.p[j] - v[j]));
  }
  if (d > 1e-6) {
    F.puppet = true;
    console.warn(`[dual] the follower's lab differs from the lead's by ${d.toExponential(2)} at tick ${p.k}; drawing the lead's poses until the next reset`);
  }
}
function lockAdvance() {
  const out = [];
  const sim = LAB.sim, o = LAB.orig;
  let budget = LAB_MAX_TICKS;
  while (budget > 0 && !F.waitReset) {
    const h = F.queue[0];
    if (!h) break;
    if (h.e < F.epoch) { F.queue.shift(); continue; }
    if (h.e > F.epoch) { F.queue.shift(); F.puppet = true; continue; }          // a reset went missing
    const cur = labTick();
    if (cur < h.k) {
      const evs = o.advance(Math.min(h.k - cur, budget) * sim.dt);
      for (const e of evs) out.push(e);
      const moved = labTick() - cur;
      budget -= Math.max(1, moved);
      if (evs.some((e) => e.type === 'observe')) return out;                  // the lab answers, then calls again
      if (moved <= 0) break;
      continue;
    }
    F.queue.shift();
    if (h.t === 'tick') {
      F.pose = h.pose;
      if (!F.puppet && ++F.count % LAB_CHECK_EVERY === 0) comparePose({ ...h.pose, k: h.k });
    } else applyLabOp(h);
  }
  return out;
}

function onLabMessage(m) {
  if (!LAB.lab || !F.locked) return;
  if (m.t === 'tick') {
    if (m.pose) F.pose = m.pose;
    if (F.waitReset) return;
    F.queue.push(m);
    if (F.queue.length > 20000) { F.queue.length = 0; F.puppet = true; }
    return;
  }
  if (F.waitReset) {
    if (m.op === 'reset') { applyLabOp(m); F.waitReset = false; }
    return;
  }
  F.queue.push(m);
}
function lockFollower() {
  if (!LAB.lab) return;
  F.locked = true; F.waitReset = true; F.queue = []; F.puppet = false; F.count = 0; F.camPreset = null;
  LAB.lab.grab?.setEnabled?.(false);
  LAB.lab.reset();                          // clears the overlays here; the simulation waits for the lead's reset
}
function unlockFollower() {
  if (!F.locked) return;
  F.locked = false; F.waitReset = false; F.queue = []; F.puppet = false;
  LAB.lab?.grab?.setEnabled?.(true);
  if (LAB.rig) LAB.rig.controls.enabled = LAB.rig.getCameraPreset?.() !== 'wrist';
}

function labLeadFrame() {
  if (!leading() || !L.linked || !LAB.sim) return;
  const sim = LAB.sim, rig = LAB.rig;
  const k = labTick();
  if (k !== L.lastTick) {
    L.lastTick = k;
    const st = sim.state;
    const parts = {};
    for (const [key, v] of Object.entries(st.parts)) parts[key] = [...v.p, ...v.quat];
    send('tick', { e: L.epoch, k, pose: { q: st.q, w: st.gripper.width, parts } });
  }
  const cam = { preset: rig.getCameraPreset?.() || 'free', eye: rig.camera.position.toArray(), target: rig.controls.target.toArray() };
  const key = cam.preset + cam.eye.concat(cam.target).map((x) => x.toFixed(5)).join(',');
  if (key !== L.lastCam) { L.lastCam = key; send('cam', { cam }); }
}
function labFollowFrame() {
  if (!followLocked() || !F.cam || !LAB.rig) return;
  const rig = LAB.rig, o = LAB.orig, c = F.cam;
  if (c.preset === 'wrist') {
    if (rig.getCameraPreset?.() !== 'wrist') o.setCameraPreset('wrist', { animate: false });
    F.camPreset = 'wrist';
    return;
  }
  if (c.preset !== F.camPreset || rig.getCameraPreset?.() === 'wrist') {
    o.setCameraPreset(c.preset, { animate: false });
    F.camPreset = c.preset;
  }
  rig.camera.position.fromArray(c.eye);
  rig.controls.target.fromArray(c.target);
  rig.controls.enabled = false;
  rig.controls.update();
}

// ───────────────────────────────── lead: watch what the presenter does

function wrapStage() {
  const st = S();
  if (!st || st.__dual) return;
  st.__dual = true;
  const run = st.run, dispatch = st.dispatch, primary = st.primary;
  st.__orig = { run, dispatch, primary };
  st.run = (str, opts = {}) => { if (leading() && opts.user) send('act', { act: str }); return run(str, opts); };
  st.dispatch = (c, a, args = [], opts = {}) => { if (leading() && !opts.auto) send('dispatch', { c, a, args }); return dispatch(c, a, args, opts); };
  st.primary = () => { if (leading()) send('primary'); return primary(); };
  st.bus?.on?.('stage:show', sendUiSoon);
  st.bus?.on?.('stage:size', sendUiSoon);
}

let scrollQueued = false;
function onScroll() {
  if (!leading() || scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => { scrollQueued = false; send('scroll', { a: anchor() }); });
}
const innerScrolls = new Map();
function onInnerScroll(e) {
  const el = e.target;
  if (!leading() || !(el instanceof Element) || !el.closest('#stage, .pop, dialog, #rail, .table-wrap')) return;
  if (innerScrolls.has(el)) return;
  innerScrolls.set(el, requestAnimationFrame(() => {
    innerScrolls.delete(el);
    const y = el.scrollHeight - el.clientHeight, x = el.scrollWidth - el.clientWidth;
    send('escroll', { loc: locate(el), y: y > 0 ? el.scrollTop / y : 0, x: x > 0 ? el.scrollLeft / x : 0 });
  }));
}

function onClickLead(e) {
  if (!leading() || !e.isTrusted || !(e.target instanceof Element)) return;
  const el = e.target.closest(CLICKABLE);
  if (el && !el.closest(NO_CLICK) && !el.closest('[data-act]') && !(el.matches('a[href]') && !el.getAttribute('href').startsWith('#'))) {
    const r = el.getBoundingClientRect();
    send('click', { loc: locate(el), rx: r.width ? (e.clientX - r.left) / r.width : 0.5, ry: r.height ? (e.clientY - r.top) / r.height : 0.5 });
  }
  sendUiSoon();
}
function onInputLead(e) {
  const el = e.target;
  if (!leading() || !e.isTrusted || !(el instanceof HTMLElement) || el.closest('#settings, [data-dual="local"]')) return;
  if (!el.matches('input, select, textarea')) return;
  send('input', { loc: locate(el), type: e.type, v: el.value, c: el.checked });
}
function onToggleLead(e) {
  const el = e.target;
  if (!leading() || !(el instanceof HTMLDetailsElement) || !el.closest('#article, #stage, .pop')) return;
  send('toggle', { loc: locate(el), open: el.open });
}
function onDialogCloseLead(e) {
  if (!leading() || !(e.target instanceof HTMLDialogElement) || e.target.id === 'keys-dialog') return;
  send('dclose', { loc: locate(e.target) });
}
function onMediaLead(e) {
  if (!leading() || !(e.target instanceof HTMLMediaElement)) return;
  send('media', { m: mediaState(e.target) });
}

// ───────────────────────────────── follower: apply

function synthClick(el, rx = 0.5, ry = 0.5) {
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + rx * r.width, clientY: r.top + ry * r.height };
  el.dispatchEvent(new MouseEvent('click', o));
}
function apply(m) {
  const st = S();
  replaying = true;
  try {
    switch (m.t) {
      case 'snap': applySnapshot(m.s); break;
      case 'scroll': applyAnchor(m.a); break;
      case 'ui': applyUi(m.u); break;
      case 'pref': prefs.set(m.k, m.v, { persist: false }); break;
      case 'act': st?.__orig?.run(m.act, { user: true }); break;
      case 'dispatch': st?.__orig?.dispatch(m.c, m.a, m.args, { user: true }); break;
      case 'primary': st?.__orig?.primary(); break;
      case 'click': { const el = find(m.loc); if (el) synthClick(el, m.rx, m.ry); break; }
      case 'input': {
        const el = find(m.loc);
        if (!(el instanceof HTMLElement)) break;
        if ('checked' in el && (el.type === 'checkbox' || el.type === 'radio')) el.checked = m.c; else el.value = m.v;
        el.dispatchEvent(new Event(m.type, { bubbles: true }));
        break;
      }
      case 'toggle': { const el = find(m.loc); if (el instanceof HTMLDetailsElement && el.open !== m.open) el.open = m.open; break; }
      case 'dclose': { const el = find(m.loc); if (el instanceof HTMLDialogElement && el.open) el.close(); break; }
      case 'media': applyMedia(m.m); break;
      case 'escroll': {
        const el = find(m.loc);
        if (!el) break;
        el.scrollTop = m.y * (el.scrollHeight - el.clientHeight);
        el.scrollLeft = m.x * (el.scrollWidth - el.clientWidth);
        break;
      }
      case 'mview': mview.set(m.m); break;
      case 'lablock': lockFollower(); break;
      case 'lab': case 'tick': onLabMessage(m); break;
      case 'cam': F.cam = m.cam; break;
      default:
    }
  } catch (err) {
    console.warn('[dual]', m.t, err);
  } finally {
    replaying = false;
  }
}

// The follower's own screen: no clicks, no wheel, no keys except its own language, theme and text size.
const BLOCKED = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'keyup'];
function blockInput(e) {
  if (!following() || !e.isTrusted) return;
  e.stopImmediatePropagation();
  if (e.cancelable) e.preventDefault();
}

// ───────────────────────────────── roles

let openTimer = 0;
let heardFollower = 0;
function startLead() {
  role = 'lead'; setRoleAttr();
  leader = me;
  send('lead');
  wrapStage();
  heardFollower = 0;
  const started = performance.now();
  clearTimeout(openTimer);
  openTimer = setTimeout(() => { if (leading() && heardFollower < started) openFollower(); }, 350);
  toast('Dual screen: this window leads. Shift+D stops.', '雙螢幕：這個視窗主控。再按 Shift+D 停止。');
}
function stopLead() {
  send('bye');
  role = 'off'; setRoleAttr();
  L.linked = false; L.wantLock = false;
  toast('Dual screen stopped.', '雙螢幕已停止。');
}
function startFollow() {
  role = 'follow'; setRoleAttr();
  send('hello');
  toast('Follower: shows what the lead window does. F11 for full screen, Shift+D to leave.', '跟隨視窗：照主控視窗顯示。F11 全螢幕，Shift+D 離開。', 6000);
}
function stopFollow() {
  role = 'off'; setRoleAttr();
  leader = null;
  unlockFollower();
  send('left');
  toast('This window no longer follows.', '這個視窗不再跟隨。');
}

async function openFollower() {
  const url = new URL(location.href);
  url.search = ''; url.hash = '';
  url.searchParams.set('dual', 'follow');
  url.searchParams.set('lang', 'en');
  let feat = 'popup,width=1280,height=760';
  let other = null, details = null;
  try {
    if ('getScreenDetails' in window) {
      const p = await navigator.permissions.query({ name: 'window-management' }).catch(() => null);
      if (p?.state === 'granted') {
        details = await window.getScreenDetails();
        other = details.screens.find((s) => s !== details.currentScreen) || null;
        if (other) feat = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
      }
    }
  } catch { /* no permission: the window opens on this screen */ }
  const w = window.open(url.href, 'msgraph-dual-follow', feat);
  if (!w) {
    toast('The browser blocked the new window. Allow pop-ups, or open index.html?dual=follow yourself.', '瀏覽器擋下了新視窗。請允許彈出視窗，或自己開 index.html?dual=follow。', 7000);
    return;
  }
  if (!other && 'getScreenDetails' in window) {
    // first time: ask for the screens, then move the follower to the other one
    try {
      details = await window.getScreenDetails();
      other = details.screens.find((s) => s !== details.currentScreen) || null;
      if (other) { w.moveTo(other.availLeft, other.availTop); w.resizeTo(other.availWidth, other.availHeight); }
    } catch { /* declined: drag the window to the projector */ }
  }
}

// ───────────────────────────────── messages

function onMessage(ev) {
  const m = ev.data;
  if (!m || m.from === me) return;
  if (leading()) {
    switch (m.t) {
      case 'hello': heardFollower = performance.now(); send('snap', { s: snapshot() }); break;
      case 'labhello': lockLab(); break;
      case 'lead': role = 'off'; setRoleAttr(); L.linked = false; toast('Another window leads now.', '另一個視窗接手主控。'); break;
      default:
    }
    return;
  }
  if (!following()) return;
  if (m.t === 'lead') { leader = m.from; lastFromLeader = performance.now(); unlockFollower(); send('hello'); return; }
  if (m.t === 'bye' && m.from === leader) { unlockFollower(); leader = null; toast('The lead window stopped. Waiting.', '主控視窗已停止，等待中。'); return; }
  if (m.t === 'snap') { leader = m.from; }
  if (m.from !== leader) return;
  lastFromLeader = performance.now();
  if (m.t === 'ping') return;
  if (m.t === 'snap' && LAB.lab) { apply(m); send('labhello'); return; }
  apply(m);
}

// ───────────────────────────────── start

function onKey(e) {
  if (e.defaultPrevented && !following()) return;
  const t = e.target;
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'D' || e.key === 'd') && !isTyping(t)) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (!bc) { toast('This browser has no BroadcastChannel.', '這個瀏覽器沒有 BroadcastChannel。'); return; }
    if (leading()) stopLead();
    else if (following()) stopFollow();
    else startLead();
    return;
  }
  if (!following() || !e.isTrusted) {
    if (leading()) setTimeout(sendUiSoon, 0);
    return;
  }
  // follower: its own language, theme and text size; the browser's function keys; nothing else
  const k = e.key.toLowerCase();
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && LOCAL_KEYS[k]) {
    e.preventDefault(); e.stopImmediatePropagation();
    const name = LOCAL_KEYS[k];
    if (name === 'theme') prefs.set('theme', prefs.theme() === 'dark' ? 'light' : 'dark', { persist: false });
    else if (name === 'big') prefs.set('big', prefs.get('big') ? 0 : 1, { persist: false });
    else { const list = prefs.CHOICES.lang; prefs.set('lang', list[(list.indexOf(prefs.lang()) + 1) % list.length], { persist: false }); }
    return;
  }
  if (/^F\d+$/.test(e.key)) return;
  e.stopImmediatePropagation();
  e.preventDefault();
}

function frame() {
  if (leading()) { labLeadFrame(); mview.tickLead(); }
  else if (following()) { labFollowFrame(); mview.tickFollow(); }
  requestAnimationFrame(frame);
}

function boot() {
  if (!S()?.nav) { setTimeout(boot, 120); return; }
  wrapStage();
  window.addEventListener('keydown', onKey, true);
  for (const type of BLOCKED) window.addEventListener(type, blockInput, { capture: true, passive: false });
  window.addEventListener('click', onClickLead, true);
  window.addEventListener('input', onInputLead, true);
  window.addEventListener('change', onInputLead, true);
  window.addEventListener('toggle', onToggleLead, true);
  window.addEventListener('close', onDialogCloseLead, true);
  for (const type of ['play', 'pause', 'seeked', 'ratechange']) window.addEventListener(type, onMediaLead, true);
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('scroll', onInnerScroll, { capture: true, passive: true });
  window.addEventListener('resize', () => { if (leading()) onScroll(); if (following() && lastAnchor) requestAnimationFrame(() => applyAnchor(lastAnchor)); });
  for (const k of SYNC_PREFS) prefs.on(k, (v) => { if (leading() && !replaying) send('pref', { k, v }); });
  // the follower re-places itself when its own layout changes (language, text size, fonts, late formulas)
  prefs.on('lang', () => { blocksDirty = true; if (following() && lastAnchor) requestAnimationFrame(() => applyAnchor(lastAnchor)); });
  prefs.on('big', () => { if (following() && lastAnchor) requestAnimationFrame(() => applyAnchor(lastAnchor)); });
  if (bc) bc.onmessage = onMessage;

  setInterval(() => {
    if (leading()) {
      send('ping');
      send('ui', { u: uiState() });
      for (const v of videos()) if (!v.paused) send('media', { m: mediaState(v) });
    } else if (following()) {
      if (lastAnchor) applyAnchor(lastAnchor);
      if (F.locked && performance.now() - lastFromLeader > 4000) { unlockFollower(); toast('Lost the lead window. Waiting.', '找不到主控視窗，等待中。'); }
      if (!leader || performance.now() - lastFromLeader > 4000) send('hello');
    }
  }, 1000);

  // the 3D lab is made when the stage first shows it; pick it up when it appears (or is made again)
  setInterval(() => { const lab = window.__lab; if (lab && lab !== LAB.lab && lab.debug?.sim) installLab(lab); }, 250);

  setRoleAttr();
  if (following()) startFollow();
  requestAnimationFrame(frame);
}

/** For tools/smoke_dual.py and the console. */
window.__dual = {
  get role() { return role; },
  anchor,
  lab: () => ({
    locked: F.locked, waitReset: F.waitReset, puppet: F.puppet, checks: Math.floor(F.count / LAB_CHECK_EVERY), epoch: F.epoch,
    queue: F.queue.length, linked: L.linked, leadEpoch: L.epoch, tick: LAB.sim ? labTick() : null,
  }),
};
boot();
