// AFTERGLOW operator TV: the panels around the live map (livemap.js), for a TV in the ops room.
// Modes: Day sweep (patrol), Night sweep (night), Trail pathing (search), Emergency (investigate).
// Every command here comes from a click. Nothing auto-confirms a ping or accepts a leg: the drone
// never decides. "Ping" is the screen word for a pin (an ag/target record).
import { html, render, useState, useEffect, useRef } from './vendor/htm-3.1.1/standalone.module.js';
import { connect } from './store.js';
import { LiveMap, PRIO_COLOR } from './livemap.js';

const MODES = [['patrol', 'Day sweep'], ['night', 'Night sweep'], ['search', 'Trail pathing'], ['investigate', 'Emergency']];
const MODE_NAME = Object.fromEntries(MODES);
const CLS_PLAIN = {
  findmy: 'Lost iPhone or AirTag (Find My)', findhub: 'Lost Android phone or tag (Find Hub)',
  samsung_off: 'Lost Samsung phone', ref: 'Our reference tag', wifi: 'SOS Wi-Fi answer',
};
const CLS_SHORT = { findmy: 'Find My', findhub: 'Find Hub', samsung_off: 'Samsung', ref: 'Ref tag', wifi: 'SOS' };
const CARRY = [['iphone', 'iPhone'], ['airtag', 'AirTag'], ['android', 'Android phone'], ['samsung', 'Samsung phone'], ['unknown', 'Not known']];
const CARRY_NAME = Object.fromEntries(CARRY);
const PRIO_NAME = { 1: 'urgent', 2: 'strong ping', 3: 'possible', 4: 'heard only' };
const STATUS_ORDER = { investigating: 0, new: 1, acknowledged: 2, confirmed: 3, cleared: 4 };
const LIVE_SRC = new Set(['gps', 'waypoint']);
const POSE_STALE_MS = 10000;   // no pose this long: the Wi-Fi link to the pod is down
const ALERT_FRESH_MS = 20000;  // a LoRa alert this recent: LoRa is still getting through
const BLE_SILENT_MS = 15000;
const BIN_M = 10;              // trail progress is counted in 10 m pieces
const FORCE = new URLSearchParams(location.search).get('force');
const NO_CASE = { case: null, ranking: [], route: [], start: null, trail: null };
const FOREST = {
  day: { bg: '#0e1510', camp: '#b9772f', park: '#5f8f52', road: '#7d7a70', casing: '#0b100c' },
  night: { bg: '#080c09', camp: '#b9772f', park: '#3f5f37', road: '#5d5b54', casing: '#060906' },
};

// ---------- helpers ----------
async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok, problems: j.problems || [`HTTP ${r.status}`], data: j };
  } catch (e) {
    return { ok: false, problems: [String(e.message || e)] };
  }
}
const pad = (n) => String(n).padStart(2, '0');
const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour12: false }) : '--:--:--');
const fmtHM = (t) => (t ? new Date(t).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' }) : '--:--');
function fmtDur(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
function fmtAgo(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  const s = ms / 1000;
  if (s < 2) return 'now';
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}
const fmtM = (v) => (v == null || !isFinite(v) ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} km` : v >= 100 ? `${Math.round(v)} m` : `${Math.round(v * 10) / 10} m`);
const pinNum = (p) => Number(String(p).replace(/\D/g, '')) || 0;
const isOpen = (p) => p.status !== 'cleared' && p.status !== 'confirmed';
const prioColor = (p) => PRIO_COLOR[p] || PRIO_COLOR[4];
function loadPref(k, d) { try { const v = localStorage.getItem(`ag.tv.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem(`ag.tv.${k}`, JSON.stringify(v)); } catch { /* private mode */ } }

function segDist(px, py, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
function inRing(px, py, ring) {
  let inside = false;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
    if ((y1 > py) !== (y2 > py) && px < x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
  }
  return inside;
}
function distToCamp(meta, x, y) { // 0 inside a campground, Infinity if there are none
  let best = Infinity;
  for (const z of meta.map.zones) {
    if (z.kind !== 'campground') continue;
    if (inRing(x, y, z.ring)) return 0;
    for (let i = 0; i < z.ring.length - 1; i++) best = Math.min(best, segDist(x, y, z.ring[i], z.ring[i + 1]));
  }
  return best;
}
function nearestTrail(meta, x, y) {
  let best = { name: null, d: Infinity };
  for (const l of meta.map.lines) {
    if (l.kind === 'road' || !l.name) continue;
    for (let i = 0; i < l.pts.length - 1; i++) {
      const d = segDist(x, y, l.pts[i], l.pts[i + 1]);
      if (d < best.d) best = { name: l.name, d };
    }
  }
  return best;
}
const heading = (dx, dy) => (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
function routeBins(route) { // points every BIN_M metres along the route
  const out = [];
  for (let i = 0; i < route.length - 1; i++) {
    const [ax, ay] = route[i], [bx, by] = route[i + 1], seg = Math.hypot(bx - ax, by - ay);
    for (let d = 0; d < seg; d += BIN_M) out.push([ax + (bx - ax) * d / seg, ay + (by - ay) * d / seg]);
  }
  if (route.length) out.push(route[route.length - 1]);
  return out;
}

// ---------- the chime (Web Audio: no sound file) ----------
const Sound = {
  ctx: null,
  on: loadPref('chime', true),
  unlock() {
    try {
      if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    } catch { /* no audio on this device */ }
  },
  ready() { return !!this.ctx && this.ctx.state === 'running'; },
  play(urgent) {
    if (!this.on || !this.ready()) return;
    const c = this.ctx, t0 = c.currentTime + 0.02, notes = urgent ? [880, 660, 880, 660] : [660, 880];
    notes.forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain(), t = t0 + i * 0.22;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(c.destination);
      o.start(t); o.stop(t + 0.22);
    });
  },
};

// ---------- what the page remembers between renders (not part of the bus state) ----------
function makeMemory() {
  return {
    ready: false, known: new Map(), sosSeen: new Set(), firstSeen: {}, events: [], mode: null, modeSince: null,
    alerts: {}, lastAlert: null, lastAlertWall: 0, poseRef: null, lastPoseWall: 0, bleCount: 0, lastBleWall: 0,
    cov: [], covT: null, bins: [], binsHit: null, binsRoute: null, binsPose: null, chimedAt: 0,
  };
}

function track(mem, st, view) {
  const s = st.state, bt = s.bus_t;
  const log = (text) => { mem.events.unshift({ t: bt, text }); mem.events.length = Math.min(mem.events.length, 20); };
  // link watch
  const pose = s.poses.pod || Object.values(s.poses)[0];
  if (pose !== mem.poseRef) { mem.poseRef = pose; if (pose) mem.lastPoseWall = Date.now(); }
  const ble = s.counts['ag/obs/ble'] || 0;
  if (ble !== mem.bleCount) { mem.bleCount = ble; mem.lastBleWall = Date.now(); }
  const al = s.latest['ag/alert'];
  if (al && al !== mem.lastAlert) {
    mem.lastAlert = al; mem.lastAlertWall = Date.now();
    if (al.kind !== 4) mem.alerts[`T${al.track}`] = { ...al, wall: Date.now() };
  }
  // coverage history, for the time-to-finish estimate
  const cov = s.latest['ag/coverage'];
  if (cov && cov.t !== mem.covT) {
    mem.covT = cov.t;
    mem.cov.push([bt || cov.t, cov.pct]);
    if (mem.cov.length > 120) mem.cov.shift();
  }
  // mode changes
  const mode = s.latest['ag/mode']?.mode || 'patrol';
  if (mode !== mem.mode) {
    if (mem.ready && mem.mode) log(`${MODE_NAME[mode] || mode} started`);
    mem.mode = mode; mem.modeSince = bt || null; mem.cov = [];
  }
  if (!mem.modeSince && bt) mem.modeSince = bt;
  // trail progress: which 10 m pieces of the route the pod has passed within the corridor
  const route = view?.route || [];
  if (route !== mem.binsRoute) {
    mem.binsRoute = route; mem.bins = routeBins(route); mem.binsHit = new Uint8Array(mem.bins.length); mem.binsPose = null;
    for (const [x, y] of s.trails.pod || []) hitBins(mem, x, y, st.corridor);
  }
  if (pose && pose !== mem.binsPose) { mem.binsPose = pose; hitBins(mem, pose.x, pose.y, st.corridor); }
  // pings: new ones chime, status changes go in the log
  if (!mem.ready) {
    if (st.link !== 'live') return;
    for (const p of Object.values(s.pins)) { mem.known.set(p.pin, p.status); if (p.sos) mem.sosSeen.add(p.pin); mem.firstSeen[p.pin] = bt; }
    mem.ready = true;
    return;
  }
  let chime = 0;
  for (const p of Object.values(s.pins)) {
    const was = mem.known.get(p.pin);
    if (was === undefined) {
      mem.firstSeen[p.pin] = bt;
      log(`New ping ${p.pin}: ${CLS_SHORT[p.cls] || p.cls}`);
      chime = Math.max(chime, p.prio === 1 ? 2 : 1);
    } else if (was !== p.status) {
      log(`${p.pin} ${p.status}`);
    }
    if (p.sos && !mem.sosSeen.has(p.pin)) {
      mem.sosSeen.add(p.pin);
      log(`SOS answered on ${p.pin}`);
      chime = 2;
    }
    mem.known.set(p.pin, p.status);
  }
  if (chime && Date.now() - mem.chimedAt > 1500) { mem.chimedAt = Date.now(); Sound.play(chime === 2); }
}
function hitBins(mem, x, y, r) {
  const b = mem.bins, h = mem.binsHit;
  for (let i = 0; i < b.length; i++) if (!h[i] && Math.abs(b[i][0] - x) <= r && Math.abs(b[i][1] - y) <= r && Math.hypot(b[i][0] - x, b[i][1] - y) <= r) h[i] = 1;
}

// ---------- app ----------
function App() {
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [, setTick] = useState(0);
  const store = useRef(null);
  const mem = useRef(makeMemory());
  const caseRef = useRef(null);
  const [caseView, setCaseView] = useState(null);
  const [sel, setSel] = useState(null);
  const [follow, setFollow] = useState(() => loadPref('follow', false));
  const [form, setForm] = useState(null); // null, or the case form's starting values
  const [toasts, setToasts] = useState([]);
  const [busy, setBusy] = useState({}); // pin or key -> true while a click is in flight
  const [chimeOn, setChimeOn] = useState(Sound.on);

  useEffect(() => {
    fetch('/api/map').then((r) => r.json()).then((m) => {
      setMeta(m);
      document.title = `AFTERGLOW · ${m.name} · operator TV`;
      const st = connect({
        trailStep: m.trail_step_m,
        on: { case: (v) => { caseRef.current = v; setCaseView(v); } },
        onChange: () => { track(mem.current, st, caseRef.current); setTick((t) => t + 1); },
      });
      st.corridor = m.search?.corridor_m ?? 40;
      store.current = st;
      window.tvStore = st; // for poking at it from the browser console
      setTick((t) => t + 1);
    }).catch((e) => setErr(String(e)));
    const id = setInterval(() => { store.current?.sampleRates(); setTick((t) => t + 1); }, 1000);
    const unlock = () => Sound.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => { clearInterval(id); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);
  useEffect(() => savePref('follow', follow), [follow]);

  const toast = (text, kind = 'info') => {
    const id = Math.random();
    setToasts((ts) => [...ts.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4000);
  };

  if (err) return html`<div class="boot">Can't reach the dashboard server: ${err}<br />Start it with python -m afterglow.dashboard or python tools/local_stack.py.</div>`;
  if (!meta || !store.current) return html`<div class="boot">Loading the map…</div>`;

  const st = store.current, s = st.state, m = mem.current, bt = s.bus_t;
  const mode = s.latest['ag/mode']?.mode || 'patrol';
  const night = mode === 'night';
  document.documentElement.toggleAttribute('data-night', night);
  const pose = s.poses.pod || Object.values(s.poses)[0] || null;
  const cv = caseView || NO_CASE;
  const kase = cv.case;

  // links and health
  const podStale = FORCE === 'lora' || (m.lastPoseWall > 0 && Date.now() - m.lastPoseWall > POSE_STALE_MS) || st.link !== 'live' || !s.broker;
  const loraFresh = FORCE === 'lora' || (m.lastAlertWall > 0 && Date.now() - m.lastAlertWall < ALERT_FRESH_MS);
  const locked = podStale; // commands go over Wi-Fi: none while it's down
  const problems = [];
  if (st.link !== 'live') problems.push('Dashboard server unreachable');
  else if (!s.broker) problems.push('Message broker down');
  else if (podStale) problems.push('Pod Wi-Fi lost');
  const sys = s.latest['ag/sys'];
  if (sys) {
    if (sys.cpu_c >= 80) problems.push(`Pod hot ${Math.round(sys.cpu_c)}°C`);
    if (sys.throttled && sys.throttled !== '0x0') problems.push('Pod throttling');
    if (sys.lora === false) problems.push('LoRa radio down');
    if (typeof sys.disk_free_gb === 'number' && sys.disk_free_gb < 2) problems.push('Pod disk nearly full');
    if (typeof sys.batt_pct === 'number' && sys.batt_pct < 20) problems.push(`Pod battery ${sys.batt_pct}%`);
  }
  if (!podStale && m.bleCount > 0 && Date.now() - m.lastBleWall > BLE_SILENT_MS) problems.push('Bluetooth scanner silent');

  // pings
  const pins = Object.values(s.pins);
  const open = pins.filter(isOpen).sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (a.prio - b.prio) || (pinNum(b.pin) - pinNum(a.pin)));
  // the alert stays on the highest priority, then the one waiting longest, so it doesn't jump about
  const fresh = pins.filter((p) => p.status === 'new').sort((a, b) => (a.prio - b.prio) || ((m.firstSeen[a.pin] ?? 0) - (m.firstSeen[b.pin] ?? 0)) || (pinNum(a.pin) - pinNum(b.pin)));
  const sosPin = pins.filter((p) => p.sos && p.status !== 'cleared').sort((a, b) => pinNum(b.pin) - pinNum(a.pin))[0] || null;
  const investigating = pins.filter((p) => p.status === 'investigating').sort((a, b) => b.t - a.t)[0] || null;
  const selPin = sel && s.pins[sel] ? s.pins[sel] : null;
  const alertPin = fresh.find((p) => !p.sos) || null;
  const focus = selPin || alertPin || (mode !== 'investigate' ? investigating : null);
  const target = mode === 'investigate' ? (selPin || investigating || sosPin) : null;

  // clicks
  const pick = (pin) => setSel(pin); // the map flies to it (MapPane)
  const sendCtrl = async (body, label, key) => {
    setBusy((b) => ({ ...b, [key]: true }));
    const r = await post('/api/ctrl', body);
    setBusy(({ [key]: _, ...rest }) => rest);
    if (!r.ok) toast(`${label} failed: ${r.problems.join('; ')}`, 'bad'); else toast(`Sent: ${label}`);
    return r.ok;
  };
  const pinCmd = (pin, cmd, label) => sendCtrl({ cmd, pin }, `${label} ${pin}`, pin);
  const setMode = async (md) => {
    const r = await post('/api/mode', { mode: md });
    if (!r.ok) toast(`Mode change failed: ${r.problems.join('; ')}`, 'bad');
    return r.ok;
  };
  const saveCase = async (body, startTrail) => {
    const r = await post('/api/case', body);
    if (!r.ok) return r.problems;
    caseRef.current = r.data; setCaseView(r.data);
    if (startTrail && mode !== 'search') await setMode('search');
    setForm(null);
    toast(startTrail ? 'Case opened: trail pathing' : 'Case saved');
    return null;
  };
  const closeCase = async () => {
    const r = await post('/api/case/close', {});
    if (r.ok) { caseRef.current = r.data; setCaseView(r.data); toast('Case closed'); } else toast(`Close failed: ${r.problems.join('; ')}`, 'bad');
  };
  const pickTrail = async (name) => {
    const r = await post('/api/case', { trail: name });
    if (r.ok) { caseRef.current = r.data; setCaseView(r.data); toast(`Trail: ${name}`); } else toast(r.problems.join('; '), 'bad');
  };
  const toggleChime = () => { Sound.unlock(); Sound.on = !Sound.on; savePref('chime', Sound.on); setChimeOn(Sound.on); if (Sound.on) Sound.play(false); };

  const ctx = { meta, st, s, m, bt, mode, pose, cv, kase, locked, busy, pick, pinCmd, sendCtrl, setMode, setForm, closeCase, pickTrail, setSel, sel, open, focus, target };
  const wide = !!focus && mode !== 'investigate';

  return html`
    <div class="tv">
      <${TopBar} ...${ctx} problems=${problems} chimeOn=${chimeOn} toggleChime=${toggleChime} />
      <div class="banners">
        ${podStale && html`<${LoraBanner} m=${m} loraFresh=${loraFresh} />`}
        ${sosPin && html`<${SosBanner} p=${sosPin} mode=${mode} setMode=${setMode} locked=${locked} pick=${pick} />`}
        ${alertPin && html`<${PingBanner} p=${alertPin} m=${m} bt=${bt} kase=${kase} pick=${pick} />`}
      </div>
      <div class=${`grid ${wide ? 'wide-right' : ''}`}>
        <div class="col">${left(ctx)}</div>
        <${MapPane} meta=${meta} s=${s} sel=${sel} follow=${follow} setFollow=${setFollow} night=${night} cv=${cv} podStale=${podStale} m=${m} setSel=${setSel} />
        <div class="col">${right(ctx, podStale)}</div>
      </div>
      ${form && html`<${CaseForm} meta=${meta} init=${form} editing=${!!kase} save=${saveCase} cancel=${() => setForm(null)} />`}
      ${chimeOn && !Sound.ready() && html`<div class="soundhint" role="status">Click anywhere to turn on the ping chime</div>`}
      <div class="toasts">${toasts.map((t) => html`<div key=${t.id} class=${`toast ${t.kind}`}>${t.text}</div>`)}</div>
    </div>`;
}

// ---------- top bar and banners ----------
function TopBar({ meta, s, bt, mode, pose, kase, locked, setMode, problems, chimeOn, toggleChime }) {
  const src = !pose ? null : pose.src === 'sim' ? ['b-sim', 'SIMULATED'] : pose.src === 'replay' ? ['b-replay', 'REPLAY'] : LIVE_SRC.has(pose.src) ? null : ['b-none', pose.src];
  const showCase = kase && (mode === 'search' || mode === 'investigate');
  return html`
    <header class="top">
      <div class="brand"><svg viewBox="0 0 24 24" fill="none" stroke="#e0a43a" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><circle cx="12" cy="12" r="9" stroke-opacity=".5"></circle></svg>AFTERGLOW</div>
      <div class="area">${meta.name}</div>
      ${showCase && html`<div class="casechip">Case · ${kase.name} · <span class="mono">${fmtDur(Date.now() - kase.opened_t)}</span></div>`}
      <div class="spacer"></div>
      <div class="modes" role="group" aria-label="Mode">
        ${MODES.map(([k, label]) => html`<button class=${`${mode === k ? 'on' : ''} ${k === 'investigate' ? 'emerg' : ''}`} aria-pressed=${mode === k}
          disabled=${locked} onClick=${() => mode !== k && setMode(k)}>${label}</button>`)}
      </div>
      ${src && html`<span class=${`badge ${src[0]}`}>${src[1]}</span>`}
      <span class=${`health ${problems.length ? 'bad' : ''}`} title=${problems.join(' · ')}><i></i>${problems.length ? problems[0] + (problems.length > 1 ? ` +${problems.length - 1}` : '') : 'System OK'}</span>
      <button class=${`iconbtn ${chimeOn ? '' : 'off'}`} aria-label=${chimeOn ? 'Chime on: click to mute' : 'Chime muted: click to turn on'} title=${chimeOn ? 'Chime on' : 'Chime muted'} onClick=${toggleChime}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"></path>${chimeOn ? html`<path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M18.5 5.5a9 9 0 0 1 0 13"></path>` : html`<path d="m16 9 5 6"></path><path d="m21 9-5 6"></path>`}</svg>
      </button>
      <div class="clock" title="Bus time: the latest pose's time">${fmtClock(bt)}</div>
    </header>`;
}

function LoraBanner({ m, loraFresh }) {
  const since = m.lastPoseWall ? Date.now() - m.lastPoseWall : null;
  return html`<div class="banner ban-lora" role="status">
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#e0a43a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2 21h20L12 3z"></path><path d="M12 10v5"></path><path d="M12 18h.01"></path></svg>
    <div>
      <div class="big">${loraFresh ? 'LoRa only · ' : ''}Wi-Fi to the pod lost${since != null ? html` <span class="mono" style="color:var(--amber)">${fmtDur(since)}</span> ago` : ''}</div>
      <div class="sub">${loraFresh ? 'Pings and SOS still arrive by LoRa. No video, no coverage, no commands until the link is back.' : 'No LoRa alerts either. Pings on screen are the last known.'}</div>
    </div>
    <div class="spacer"></div>
    ${m.lastAlertWall > 0 && html`<div style="text-align:right"><div class="small dim">Last LoRa packet</div><div class="mono" style="font-size:1.6rem;font-weight:600">${fmtAgo(Date.now() - m.lastAlertWall)}</div></div>`}
  </div>`;
}

function SosBanner({ p, mode, setMode, locked, pick }) {
  const sos = p.sos || {};
  const bits = [sos.hurt ? 'hurt' : 'not hurt', sos.walk ? 'can walk' : "can't walk", sos.count ? `${sos.count} ${sos.count === 1 ? 'person' : 'people'}` : null].filter(Boolean);
  return html`<div class="banner ban-sos" role="alert">
    <span class="chipbig">${p.pin}</span>
    <div><div class="big">SOS answered: ${bits.join(', ')}</div><div class="sub">Priority ${p.prio} · from the pod's SOS Wi-Fi page</div></div>
    <div class="spacer"></div>
    ${mode !== 'investigate'
      ? html`<button disabled=${locked} onClick=${() => { pick(p.pin); setMode('investigate'); }}>Open emergency view</button>`
      : html`<button onClick=${() => pick(p.pin)}>Show on map</button>`}
  </div>`;
}

function PingBanner({ p, m, bt, kase, pick }) {
  const match = kase?.expect_cls && kase.expect_cls === p.cls;
  return html`<div class="banner ban-ping" role="alert" style=${`background:${prioColor(p.prio)}`}>
    <span class="chipbig" style=${`color:${prioColor(p.prio)}`}>${p.pin}</span>
    <div><div class="big">New ping needs a ranger decision</div><div class="sub">${CLS_PLAIN[p.cls] || p.cls}${match ? ' · matches what the person is carrying' : ''}</div></div>
    <div class="spacer"></div>
    <span class="sub">Waiting</span><span class="timer">${fmtDur(bt - (m.firstSeen[p.pin] ?? bt))}</span>
    <button onClick=${() => pick(p.pin)}>Show</button>
  </div>`;
}

// ---------- columns ----------
function left(c) {
  if (c.mode === 'investigate') return html`<${PilotCard} ...${c} /><${SosCard} ...${c} />`;
  if (c.mode === 'search') return c.kase ? html`<${CaseCard} ...${c} /><${TrailsCard} ...${c} />` : html`<${CaseEntry} ...${c} big=${true} />`;
  return html`<${SweepCard} ...${c} /><${RuleCard} mode=${c.mode} meta=${c.meta} /><${CaseEntry} ...${c} />`;
}

function right(c, podStale) {
  const loraList = podStale && Object.keys(c.m.alerts).length ? html`<${LoraPings} m=${c.m} />` : null;
  if (c.mode === 'investigate') {
    return html`${loraList}${c.target ? html`<${CameraCard} ...${c} /><${HandoffCard} ...${c} p=${c.target} />` : html`<div class="p calm"><div class="t">Nothing to investigate</div><div class="lbl">Pick a ping, then press Investigate.</div></div><${PingsCard} ...${c} />`}`;
  }
  if (c.focus) return html`${loraList}<${PingCard} ...${c} p=${c.focus} />`;
  return html`
    ${loraList}
    ${c.mode === 'search' && c.kase && html`<${TrailProgress} ...${c} />`}
    <${LegCard} ...${c} />
    <${PingsCard} ...${c} />
    ${c.mode !== 'search' && html`<${EventsCard} m=${c.m} />`}`;
}

function SweepCard({ s, m, bt, mode }) {
  const cov = s.latest['ag/coverage'];
  const pct = cov ? cov.pct : null;
  let eta = null;
  const h = m.cov;
  if (h.length > 3 && pct != null && pct < 1) {
    const [t0, p0] = h[0], [t1, p1] = h[h.length - 1];
    const rate = (p1 - p0) / Math.max(1, t1 - t0); // share per ms of bus time
    if (rate > 0) eta = (1 - p1) / rate;
  }
  const th = s.latest['ag/thermal'];
  return html`<section class="p grow">
    <h2 class="h">${mode === 'night' ? 'Night sweep' : 'Lawn-mower sweep'}</h2>
    <div style="display:flex;align-items:baseline;gap:0.7rem"><span class="hero">${pct != null ? Math.round(pct * 100) + '%' : '—'}</span><span class="lbl">of the search box covered</span></div>
    <div class="bar"><i style=${`width:${Math.round((pct || 0) * 100)}%`}></i></div>
    <div class="row"><span class="lbl">In this mode</span><span class="num">${fmtDur(m.modeSince ? bt - m.modeSince : null)}</span></div>
    <div class="row"><span class="lbl">Est. to finish</span><span class="num">${eta != null ? '~' + fmtDur(eta) : '—'}</span></div>
    ${mode === 'night' && html`<div class="row"><span class="lbl">Thermal</span><span>${th && bt - th.t < 15000 ? `On · ${Math.round(th.max_c * 10) / 10}°C max` : 'No thermal data'}</span></div>`}
  </section>`;
}

function RuleCard({ mode, meta }) {
  const text = mode === 'night'
    ? 'Any lost-phone beacon outside the campground. Campers’ phones are ignored.'
    : `A lost-phone beacon more than ${meta.offtrail_m} m off trail, heard on 2+ passes, outside campgrounds.`;
  return html`<section class="p"><h2 class="h">Pings on</h2><div style="line-height:1.45">${text}</div></section>`;
}

function CaseEntry({ kase, setForm, setMode, locked, big }) {
  if (kase) {
    return html`<section class="p accent">
      <h2 class="h">Case open</h2>
      <div style="font-size:1.3rem;font-weight:700">${kase.name}${kase.age ? `, ${kase.age}` : ''}</div>
      <button class="btn primary" disabled=${locked} onClick=${() => setMode('search')}>Go to trail pathing</button>
    </section>`;
  }
  return html`<section class=${`p ${big ? 'grow' : ''}`} style=${big ? 'justify-content:center;text-align:center' : ''}>
    <h2 class="h">Missing person reported?</h2>
    <div class="lbl">Open a case to rank the trails from their car park, or from the park entrance if the car isn't found.</div>
    <button class=${`btn ${big ? 'primary big' : ''}`} onClick=${() => setForm({ name: '', age: '', details: '', carrying: 'iphone', car_park: '' })}>Open a case</button>
  </section>`;
}

function CaseCard({ kase, cv, setForm, closeCase }) {
  const [sure, setSure] = useState(false);
  return html`<section class="p">
    <h2 class="h">Case · start point</h2>
    <div style="display:flex;align-items:center;gap:0.8rem">
      <span class="carp" aria-hidden="true">${kase.car_park ? 'P' : 'E'}</span>
      <div><div style="font-size:1.25rem;font-weight:700">${cv.start?.label || 'Park entrance'}</div><div class="lbl small">${kase.car_park ? 'Car found here' : 'Car not found: starting from the entrance'}</div></div>
    </div>
    <div class="row"><span class="lbl">Missing</span><span><b>${kase.name}</b>${kase.age ? `, ${kase.age}` : ''}</span></div>
    <div class="row"><span class="lbl">Reported</span><span class="num">${fmtHM(kase.opened_t)}</span></div>
    <div class="row"><span class="lbl">Carrying</span><span>${CARRY_NAME[kase.carrying] || '—'}</span></div>
    ${kase.details && html`<div class="row"><span class="lbl">Looks like</span><span>${kase.details}</span></div>`}
    <div class="btns even">
      <button class="btn" onClick=${() => setForm({ ...kase })}>Edit case</button>
      ${sure ? html`<button class="btn danger" onClick=${() => { setSure(false); closeCase(); }}>Sure? Close it</button>`
             : html`<button class="btn" onClick=${() => setSure(true)}>Close case</button>`}
    </div>
  </section>`;
}

function TrailsCard({ cv, pickTrail, m }) {
  const flown = m.binsHit ? m.binsHit.reduce((a, v) => a + v, 0) * BIN_M : 0;
  return html`<section class="p grow">
    <h2 class="h">Most likely trails from ${cv.start?.label === 'Park entrance' ? 'the entrance' : 'the car'}</h2>
    ${cv.ranking.map((r, i) => html`<button class=${`trail ${r.name === cv.trail ? 'on' : ''}`} key=${r.name} aria-pressed=${r.name === cv.trail}
        onClick=${() => r.name !== cv.trail && pickTrail(r.name)} title=${r.name === cv.trail ? 'Being flown' : 'Fly this trail instead'}>
      <span class="num" style="font-size:1.1rem;color:${r.name === cv.trail ? 'var(--text)' : 'var(--muted)'}">${i + 1}</span>
      <span><b style="font-weight:${r.name === cv.trail ? 700 : 600}">${r.name}</b><div class="lbl small">${r.name === cv.trail ? `Flying · ${fmtM(Math.min(flown, r.length_m))} of ${fmtM(r.length_m)} flown` : `${r.dist_m < 50 ? 'starts by the car' : `${fmtM(r.dist_m)} from the start`} · ${fmtM(r.length_m)} long`}</div><div class="bar"><i style=${`width:${r.pct}%`}></i></div></span>
      <span class="num" style="font-size:1.25rem;text-align:right">${r.pct}%</span>
    </button>`)}
    <div class="lbl small" style="margin-top:auto">Likelihood = trail popularity × nearness to the start. Sample numbers until the published trail data is in. Click a trail to fly it instead.</div>
  </section>`;
}

function TrailProgress({ cv, m, pose, st, mode }) {
  if (!cv.trail || !m.bins.length) return null;
  const hit = m.binsHit.reduce((a, v) => a + v, 0);
  const total = Math.max(1, m.bins.length - 1) * BIN_M;
  const flown = Math.min(total, hit * BIN_M);
  let off = null;
  if (pose && cv.route.length > 1) { off = Infinity; for (let i = 0; i < cv.route.length - 1; i++) off = Math.min(off, segDist(pose.x, pose.y, cv.route[i], cv.route[i + 1])); }
  const next = cv.ranking.find((r) => r.name !== cv.trail);
  return html`<section class="p">
    <h2 class="h">Following · ${cv.trail}</h2>
    <div style="display:flex;align-items:baseline;gap:0.5rem"><span class="num" style="font-size:3rem;line-height:1">${(flown / 1000).toFixed(1)}</span><span class="lbl">of ${(total / 1000).toFixed(1)} km flown</span></div>
    <div class="bar tan"><i style=${`width:${Math.round((100 * flown) / total)}%`}></i></div>
    <div class="row"><span class="lbl">Trail corridor</span><span class="num">±${st.corridor} m each side</span></div>
    <div class="row"><span class="lbl">Pod from the trail</span><span class="num">${off == null ? '—' : fmtM(off)}</span></div>
    ${next && html`<div class="row"><span class="lbl">Next most likely</span><span>${next.name}</span></div>`}
    ${mode !== 'search' && html`<div class="lbl small">Trail pathing is off.</div>`}
  </section>`;
}

function LegCard({ s, locked, busy, sendCtrl }) {
  const plan = Object.values(s.plans || {}).filter((p) => p.status === 'proposed').sort((a, b) => b.t - a.t)[0];
  if (!plan) return null;
  const leg = plan.legs?.[0] || {};
  const key = `leg:${plan.id}`;
  return html`<section class="p legc">
    <h2 class="h">Next leg · needs ranger</h2>
    <div style="font-size:1.1rem;font-weight:600">${plan.id} · ${plan.kind}${plan.legs?.length > 1 ? ` · ${plan.legs.length} legs` : ''}</div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0.5rem;text-align:center">
      <div><div class="num" style="font-size:1.7rem">${leg.heading_deg != null ? Math.round(leg.heading_deg) + '°' : '—'}</div><div class="lbl small">heading</div></div>
      <div><div class="num" style="font-size:1.7rem">${fmtM(leg.dist_m)}</div><div class="lbl small">distance</div></div>
      <div><div class="num" style="font-size:1.7rem">${leg.alt_m != null ? Math.round(leg.alt_m) + ' m' : '—'}</div><div class="lbl small">altitude</div></div>
    </div>
    <div class="btns even">
      <button class="btn primary" disabled=${locked || busy[key]} onClick=${() => sendCtrl({ cmd: 'accept_leg', id: plan.id }, `Accept ${plan.id}`, key)}>Accept leg</button>
      <button class="btn" disabled=${locked || busy[key]} onClick=${() => sendCtrl({ cmd: 'reject_leg', id: plan.id }, `Reject ${plan.id}`, key)}>Reject</button>
    </div>
  </section>`;
}

function PingsCard({ open, bt, sel, pick, mode }) {
  if (!open.length) {
    return html`<section class="p calm grow">
      <svg viewBox="0 0 24 24" fill="none" stroke="var(--moss)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m8 12 3 3 5-6"></path></svg>
      <div class="t">No pings</div>
      <div class="lbl">${mode === 'night' ? 'A chime plays when one arrives.' : 'Nothing needs the ranger.'}</div>
    </section>`;
  }
  return html`<section class="p grow">
    <h2 class="h">Pings · ${open.length} open</h2>
    <div class="pinglist">
      ${open.map((p) => html`<button class=${`pingrow ${p.pin === sel ? 'sel' : ''}`} key=${p.pin} onClick=${() => pick(p.pin)}>
        <span class="chip" style=${`background:${prioColor(p.prio)}`}>${p.pin}</span>
        <span><div class="l1">${CLS_SHORT[p.cls] || p.cls} · ±${fmtM(p.r95)}</div><div class="l2">${p.off_trail_m != null ? `${p.off_trail_m} m off trail · ` : ''}heard ${fmtAgo(bt - (p.t - (p.last_s || 0) * 1000))}</div></span>
        <span class="st" style=${`color:${p.status === 'new' ? prioColor(p.prio) : 'var(--muted)'}`}>${p.status.toUpperCase()}</span>
      </button>`)}
    </div>
  </section>`;
}

function EventsCard({ m }) {
  const ev = m.events.slice(0, 3);
  return html`<section class="p">
    <h2 class="h">Last 3 events</h2>
    <div class="events">${ev.length ? ev.map((e) => html`<div><span class="mono">${fmtHM(e.t)}</span>${e.text}</div>`) : html`<div class="dim">Nothing yet</div>`}</div>
  </section>`;
}

function PingCard({ p, meta, s, bt, cv, kase, locked, busy, pinCmd, setSel, sel }) {
  const camp = distToCamp(meta, p.x, p.y);
  const start = cv.start && kase ? cv.start : null;
  const fromStart = start ? Math.hypot(p.x - start.x, p.y - start.y) : null;
  const th = s.latest['ag/thermal'];
  const warm = p.flags?.thermal;
  const match = kase?.expect_cls && kase.expect_cls === p.cls;
  const b = busy[p.pin];
  return html`<section class=${`p ping-p${p.prio || 4}`} style="gap:0.9rem">
    <div style="display:flex;align-items:center;gap:0.9rem">
      <span class="chip xl" style=${`background:${prioColor(p.prio)}`}>${p.pin}</span>
      <div style="flex:1"><div style="font-size:1.45rem;font-weight:700">Priority ${p.prio} · ${PRIO_NAME[p.prio] || ''}</div><div class="lbl">${CLS_PLAIN[p.cls] || p.cls}</div></div>
      ${sel === p.pin && html`<button class="link" onClick=${() => setSel(null)}>Back</button>`}
    </div>
    ${match && html`<div style="color:var(--moss);font-weight:600">Matches what the person is carrying</div>`}
    ${p.sos && html`<div style="color:#ff8f93;font-weight:700">SOS: ${p.sos.hurt ? 'hurt' : 'not hurt'}, ${p.sos.walk ? 'can walk' : "can't walk"}, ${p.sos.count || '?'} people</div>`}
    <div class="facts">
      <div class="fact"><b>±${fmtM(p.r95)}</b><span class="lbl">search circle</span></div>
      <div class="fact"><b>${fmtAgo(bt - (p.t - (p.last_s || 0) * 1000))}</b><span class="lbl">last heard</span></div>
      <div class="fact"><b>${p.off_trail_m != null ? `${p.off_trail_m} m` : '—'}</b><span class="lbl">off trail</span></div>
      <div class="fact"><b>${camp === 0 ? 'inside' : fmtM(camp)}</b><span class="lbl">${camp === 0 ? 'the campground' : 'from campground'}</span></div>
      ${fromStart != null && html`<div class="fact"><b>${fmtM(fromStart)}</b><span class="lbl">from ${start.label === 'Park entrance' ? 'the entrance' : 'the car'} (straight line)</span></div>`}
      ${warm && html`<div class="fact warm"><b>${th ? `${Math.round(th.max_c * 10) / 10}°C` : 'warm'}</b><span>thermal: warm spot</span></div>`}
    </div>
    <div style="flex:1"></div>
    ${p.status === 'new' || p.status === 'acknowledged' ? html`
      <div class="btns">
        <button class="btn primary big" disabled=${locked || b} onClick=${() => pinCmd(p.pin, 'investigate', 'Investigate')}>Investigate</button>
        <button class="btn big" disabled=${locked || b} onClick=${() => pinCmd(p.pin, 'clear', 'Clear')}>Clear</button>
      </div>
      <button class="btn" disabled>Confirm person · unlocks while investigating</button>`
    : p.status === 'investigating' ? html`
      <div class="btns">
        <button class="btn danger big" disabled=${locked || b} onClick=${() => pinCmd(p.pin, 'confirm', 'Confirm person')}>Confirm person</button>
        <button class="btn big" disabled=${locked || b} onClick=${() => pinCmd(p.pin, 'clear', 'Clear')}>Clear</button>
      </div>`
    : html`<div class="lbl" style="text-align:center;font-size:1.1rem">${p.status === 'confirmed' ? 'Person confirmed by the ranger' : 'Cleared by the ranger'}</div>`}
    ${locked && html`<div class="lbl small">Commands need the Wi-Fi link to the pod.</div>`}
  </section>`;
}

function PilotCard({ s, pose, target }) {
  const plan = Object.values(s.plans || {}).filter((p) => p.kind === 'homing' && (p.status === 'accepted' || p.status === 'proposed')).sort((a, b) => b.t - a.t)[0];
  const leg = plan?.legs?.[0];
  let hdg = null, dist = null, alt = pose?.z ?? null, how = '';
  if (leg) { hdg = leg.heading_deg; dist = leg.dist_m; alt = leg.alt_m ?? alt; how = `${plan.id} · ${plan.status === 'accepted' ? 'accepted by ranger' : 'proposed, not accepted yet'}`; }
  else if (pose && target) { hdg = heading(target.x - pose.x, target.y - pose.y); dist = Math.hypot(target.x - pose.x, target.y - pose.y); how = `Worked out from the pod to ${target.pin}`; }
  return html`<section class="p podc">
    <h2 class="h">Read to pilot${target ? ` · to ${target.pin}` : ''}</h2>
    ${hdg == null ? html`<div class="lbl">Pick a ping to get a heading.</div>` : html`
      <div style="display:flex;align-items:center;gap:1.1rem">
        <svg class="compass" viewBox="0 0 100 100" role="img" aria-label=${`Heading ${Math.round(hdg)} degrees`}>
          <circle cx="50" cy="50" r="44" fill="none" stroke="var(--line-2)" stroke-width="3"></circle>
          <text x="50" y="17" fill="var(--muted)" font-size="11" text-anchor="middle">N</text>
          <g transform=${`rotate(${hdg} 50 50)`}><path d="M50 14 L60 52 L50 46 L40 52 Z" fill="var(--pod)"></path></g>
        </svg>
        <div><div class="num" style="font-size:4rem;line-height:1">${Math.round(hdg)}°</div><div class="lbl">heading</div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem">
        <div><div class="num" style="font-size:2.3rem">${fmtM(dist)}</div><div class="lbl">to ping</div></div>
        <div><div class="num" style="font-size:2.3rem">${alt != null ? Math.round(alt) + ' m' : '—'}</div><div class="lbl">altitude</div></div>
      </div>
      <div class="lbl small">${how}</div>`}
  </section>`;
}

function SosCard({ target, locked, busy, sendCtrl }) {
  const sos = target?.sos;
  return html`<section class="p grow">
    <h2 class="h">SOS answer</h2>
    ${sos ? html`<div class="sosgrid">
        <div class=${sos.hurt ? 'bad' : ''}><b>Hurt</b><span class="lbl">${sos.hurt ? 'yes' : 'no'}</span></div>
        <div class=${sos.walk ? '' : 'bad'}><b>Walk</b><span class="lbl">${sos.walk ? 'yes' : 'no'}</span></div>
        <div><b>${sos.count ?? '?'}</b><span class="lbl">people</span></div>
      </div>` : html`<div class="lbl">No answer yet. Turn the SOS Wi-Fi page on when the pod is near the ping.</div>`}
    <div style="flex:1"></div>
    <div class="row" style="align-items:center"><span class="lbl">SOS Wi-Fi page</span>
      <span style="display:flex;gap:0.5rem">
        <button class="btn" disabled=${locked || busy.sos} onClick=${() => sendCtrl({ cmd: 'sos_on' }, 'SOS page on', 'sos')}>On</button>
        <button class="btn" disabled=${locked || busy.sos} onClick=${() => sendCtrl({ cmd: 'sos_off' }, 'SOS page off', 'sos')}>Off</button>
      </span></div>
  </section>`;
}

function CameraCard({ s, bt }) {
  const [broken, setBroken] = useState(false);
  const v = s.latest['ag/vision'], th = s.latest['ag/thermal'];
  const src = v?.snap ? `/${v.snap}` : `/live/camera.jpg?t=${Math.floor(Date.now() / 2000)}`;
  return html`<section class="p grow">
    <h2 class="h">Camera check${v ? ` · ${v.kind} ${Math.round(v.conf * 100)}%` : ''}</h2>
    <div class="snap">${broken && !v?.snap ? html`<span>No camera feed</span>` : html`<img src=${src} alt=${v ? `Camera snapshot: ${v.kind}` : 'Live camera'} onError=${() => setBroken(true)} onLoad=${() => setBroken(false)} />`}</div>
    <div class="row"><span class="lbl">Thermal</span><span class="num" style="font-size:1.4rem;color:var(--p3)">${th && bt - th.t < 15000 ? `${Math.round(th.max_c * 10) / 10}°C` : '—'}</span></div>
  </section>`;
}

function HandoffCard({ p, meta, cv, kase, locked, busy, pinCmd }) {
  const nt = nearestTrail(meta, p.x, p.y);
  const start = kase && cv.start ? cv.start : null;
  const b = busy[p.pin];
  return html`<section class="p">
    <h2 class="h">Hand-off to ground team · ${p.pin}</h2>
    <div class="num" style="font-size:1.6rem">${p.lat != null ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : `${Math.round(p.x)} E, ${Math.round(p.y)} N (local m)`}</div>
    <div style="line-height:1.45">±${fmtM(p.r95)}${p.off_trail_m != null ? ` · ${p.off_trail_m} m off trail` : ''}${nt.name ? ` · nearest named trail: ${nt.name}` : ''}${start ? html`<br />From <b>${start.label}</b>: ${fmtM(Math.hypot(p.x - start.x, p.y - start.y))} straight line` : ''}</div>
    ${p.status === 'investigating' ? html`<div class="btns">
        <button class="btn danger big" disabled=${locked || b} onClick=${() => pinCmd(p.pin, 'confirm', 'Confirm person')}>Confirm person</button>
        <button class="btn big" disabled=${locked || b} onClick=${() => pinCmd(p.pin, 'clear', 'Clear')}>Clear</button></div>`
    : p.status === 'new' || p.status === 'acknowledged' ? html`<div class="btns">
        <button class="btn primary big" disabled=${locked || b} onClick=${() => pinCmd(p.pin, 'investigate', 'Investigate')}>Investigate</button>
        <button class="btn big" disabled=${locked || b} onClick=${() => pinCmd(p.pin, 'clear', 'Clear')}>Clear</button></div>`
    : html`<div class="lbl" style="text-align:center">${p.status === 'confirmed' ? 'Person confirmed by the ranger' : 'Cleared'}</div>`}
  </section>`;
}

function LoraPings({ m }) {
  const rows = Object.values(m.alerts).sort((a, b) => (a.prio - b.prio) || (b.wall - a.wall));
  return html`<section class="p" style="border-color:var(--amber)">
    <h2 class="h">Pings from LoRa</h2>
    <div class="pinglist">${rows.map((a) => html`<div class="pingrow" key=${a.track}>
      <span class="chip" style=${`background:${prioColor(a.prio)}`}>T${a.track}</span>
      <span><div class="l1">${a.kind === 2 ? 'SOS' : CLS_SHORT[a.cls] || a.cls || 'Beacon'} · ±${fmtM(a.r95)}</div>
        <div class="l2">${a.sos ? `${a.sos.hurt ? 'hurt' : 'not hurt'}, ${a.sos.walk ? 'can walk' : "can't walk"} · ` : ''}alert ${fmtAgo(Date.now() - a.wall)}</div></span>
    </div>`)}</div>
  </section>`;
}

// ---------- the map: livemap.js, exactly as built, plus the car parks and the trail being flown ----------
function MapPane({ meta, s, sel, follow, setFollow, night, cv, podStale, m, setSel }) {
  const host = useRef(null);
  const lm = useRef(null);
  const extra = useRef({ cars: [], routeKey: null });
  const [mapErr, setMapErr] = useState(null);

  useEffect(() => {
    try {
      lm.current = new LiveMap(host.current, meta, { onPick: (pin) => setSel(pin), status: false, key: 'closed', tools: true, labels: true });
      window.tvMap = lm.current; // for poking at it from the browser console
    } catch (e) { setMapErr(String(e.message || e)); }
    return () => { lm.current?.destroy(); lm.current = null; };
  }, []);

  useEffect(() => { // forest colours and our extra layers, once the map has loaded
    const map = lm.current?.map;
    if (!map) return;
    const go = () => { paintForest(map, night); drawExtras(lm.current, extra.current, meta, cv); };
    if (lm.current.ready) go(); else map.once('load', go);
  }, [night, cv]);

  useEffect(() => { const p = sel && s.pins[sel]; if (p) lm.current?.flyTo(p.x, p.y); }, [sel]);
  lm.current?.update(s, { sel, follow });

  return html`<div class="mapbox">
    <div class="lmhost" ref=${host}></div>
    ${mapErr && html`<div class="boot">Map failed to start: ${mapErr}</div>`}
    <div class="maptag">
      <button class=${follow ? 'on' : ''} aria-pressed=${follow} onClick=${() => setFollow(!follow)}>Follow pod</button>
      ${podStale && m.lastPoseWall > 0 && html`<span class="stale">Pod last seen ${fmtAgo(Date.now() - m.lastPoseWall)}</span>`}
    </div>
  </div>`;
}

function paintForest(map, night) {
  const c = night ? FOREST.night : FOREST.day;
  const set = (id, prop, v) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); };
  set('bg', 'background-color', c.bg);
  set('zones-fill', 'fill-color', c.camp);
  set('zones-line', 'line-color', ['match', ['get', 'kind'], 'park', c.park, c.camp]);
  set('lines-road', 'line-color', c.road);
  set('lines-casing', 'line-color', c.casing);
}

function drawExtras(live, ex, meta, cv) {
  const map = live.map, L = live.toLL;
  // the trail being flown: a wide tan glow under the pod's path
  if (!map.getSource('tv-route')) {
    map.addSource('tv-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({ id: 'tv-route', type: 'line', source: 'tv-route', layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#c9a36a', 'line-width': 12, 'line-opacity': 0.4 } }, map.getLayer('crumbs') ? 'crumbs' : undefined);
  }
  const route = cv?.case && cv.route?.length > 1 ? cv.route : [];
  map.getSource('tv-route').setData({ type: 'FeatureCollection', features: route.length ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.map(([x, y]) => L(x, y)) } }] : [] });
  // car parks: blue P signs; the case's start gets a green ring
  for (const mk of ex.cars) mk.remove();
  ex.cars = [];
  const startLabel = cv?.case ? cv.start?.label : null;
  for (const cp of meta.search?.car_parks || []) {
    const el = document.createElement('div');
    el.className = `carmark ${cp.name === startLabel ? 'start' : ''}`;
    el.textContent = 'P';
    el.title = cp.name;
    ex.cars.push(new maplibregl.Marker({ element: el }).setLngLat(L(cp.x, cp.y)).addTo(map));
  }
}

// ---------- the case form ----------
function CaseForm({ meta, init, editing, save, cancel }) {
  const [v, setV] = useState({ name: '', age: '', details: '', carrying: 'iphone', car_park: '', ...init });
  const [problems, setProblems] = useState(null);
  const [saving, setSaving] = useState(false);
  const first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  const f = (k) => (e) => setV({ ...v, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    if (!v.name.trim()) { setProblems(['A name is needed.']); return; }
    setSaving(true);
    const p = await save({ name: v.name, age: v.age, details: v.details, carrying: v.carrying, car_park: v.car_park }, !editing);
    setSaving(false);
    if (p) setProblems(p);
  };
  return html`<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="case-title" onKeyDown=${(e) => e.key === 'Escape' && cancel()}>
    <form class="form" onSubmit=${submit}>
      <h2 id="case-title">${editing ? 'Edit the case' : 'Open a case'}</h2>
      <div class="lbl">Kept on this laptop only. Never sent over the radio or to the drone.</div>
      <div class="two">
        <label>Name<input ref=${first} value=${v.name} onInput=${f('name')} maxlength="80" required autocomplete="off" /></label>
        <label>Age<input value=${v.age} onInput=${f('age')} maxlength="12" inputmode="numeric" autocomplete="off" /></label>
      </div>
      <label>What they look like (clothing, colours, anything identifying)<textarea value=${v.details} onInput=${f('details')} maxlength="400"></textarea></label>
      <div class="two">
        <label>Car found at<select value=${v.car_park} onChange=${f('car_park')}>
          <option value="">Not found: start from the park entrance</option>
          ${(meta.search?.car_parks || []).map((cp) => html`<option value=${cp.name}>${cp.name}</option>`)}
        </select></label>
        <label>Carrying<select value=${v.carrying} onChange=${f('carrying')}>${CARRY.map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select></label>
      </div>
      ${problems && html`<div class="err" role="alert">${problems.join(' ')}</div>`}
      <div class="btns even">
        <button type="button" class="btn big" onClick=${cancel}>Cancel</button>
        <button type="submit" class="btn primary big" disabled=${saving}>${editing ? 'Save' : 'Save and start trail pathing'}</button>
      </div>
    </form>
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
