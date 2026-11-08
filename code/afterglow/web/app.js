// AFTERGLOW dashboard: Preact + htm panels around a Leaflet map in local metres.
// Every command here comes from a click. Nothing auto-confirms a pin or accepts a leg.
import { html, render, useState, useEffect, useRef } from './vendor/htm-3.1.1/standalone.module.js';
import { connect } from './store.js';
import { MapView, PRIO_COLOR } from './map.js';

const CLS = {
  findmy: 'Find My', findhub: 'Find Hub', samsung_off: 'Samsung offline', ref: 'Reference tag',
  wifi: 'Wi-Fi', apple_other: 'Apple (live)', other: 'Other',
};
const CLS_LONG = {
  findmy: 'Apple Find My: a separated iPhone or AirTag', findhub: 'Google Find Hub: an offline Android phone or tag',
  samsung_off: 'Samsung lost mode', ref: 'Our reference beacon', wifi: 'Wi-Fi (SOS page)',
};
const RULE = { day_offtrail: 'Off-trail (day)', night_outside_camp: 'Outside camp (night)', search: 'Active search', sos: 'SOS answer' };
const STATUS_ORDER = { investigating: 0, new: 1, acknowledged: 2, confirmed: 3, cleared: 4 };
const MODES = [['patrol', 'Patrol'], ['night', 'Night'], ['investigate', 'Investigate'], ['search', 'Search']];
const LIVE_SRC = new Set(['gps', 'waypoint', 'imu']); // the real pod (imu: the indoor walk, position.py)
const STALE_MS = 5000;
const NO_ANSWER_MS = 6000;

// ---------- helpers ----------
async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok, problems: j.problems || [`HTTP ${r.status}`], msg: j.msg };
  } catch (e) {
    return { ok: false, problems: [String(e.message || e)] };
  }
}
const ago = (busT, t) => (t == null || !busT ? null : Math.max(0, busT - t));
function fmtAge(ms) {
  if (ms == null) return '—';
  const s = ms / 1000;
  if (s < 1) return 'now';
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
const agoText = (ms) => (ms == null ? '—' : ms < 1000 ? 'just now' : `${fmtAge(ms)} ago`);
const fmtM = (v, big) => (v == null ? '—' : big || Math.abs(v) >= 100 ? `${Math.round(v)} m` : `${v.toFixed(1)} m`);
const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour12: false }) : '--:--:--');
const pinNum = (p) => Number(String(p).replace(/\D/g, '')) || 0;
function loadPref(k, d) { try { const v = localStorage.getItem(`ag.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } }
function savePref(k, v) { try { localStorage.setItem(`ag.${k}`, JSON.stringify(v)); } catch { /* private mode */ } }

// ---------- app ----------
function App() {
  const [meta, setMeta] = useState(null);
  const [err, setErr] = useState(null);
  const [, setTick] = useState(0);
  const store = useRef(null);
  const [sel, setSel] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [pending, setPending] = useState({}); // pin -> {cmd, wall, status}
  const [layers, setLayers] = useState(() => loadPref('layers', { coverage: true, probability: true, trail: true, tracks: true, roads: true }));
  const [follow, setFollow] = useState(false);
  const [theme, setTheme] = useState(() => loadPref('theme', null));
  const mapRef = useRef(null);

  useEffect(() => {
    fetch('/api/map').then((r) => r.json()).then((m) => {
      setMeta(m);
      document.title = `AFTERGLOW · ${m.name}`;
      store.current = connect({ trailStep: m.trail_step_m, onChange: () => setTick((t) => t + 1) });
    }).catch((e) => setErr(String(e)));
    const id = setInterval(() => { store.current?.sampleRates(); setTick((t) => t + 1); }, 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    savePref('theme', theme);
  }, [theme]);
  useEffect(() => savePref('layers', layers), [layers]);

  const toast = (text, kind = 'info') => {
    const id = Math.random();
    setToasts((ts) => [...ts.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4000);
  };

  if (err) return html`<div class="boot">Can't reach the dashboard server: ${err}</div>`;
  if (!meta || !store.current) return html`<div class="boot">Loading map…</div>`;
  const st = store.current;
  const s = st.state;
  const big = mapRef.current?.big ?? false;

  // Pending pin commands: done once geofence changes the status, flagged if it never does.
  for (const [pin, p] of Object.entries(pending)) {
    if (s.pins[pin] && s.pins[pin].status !== p.status) {
      setTimeout(() => setPending(({ [pin]: _, ...rest }) => rest));
    }
  }

  const sendCtrl = async (body, label) => {
    const r = await post('/api/ctrl', body);
    if (!r.ok) { toast(`${label} failed: ${r.problems.join('; ')}`, 'bad'); return false; }
    toast(`Sent: ${label}`);
    return true;
  };
  const pinCmd = async (pin, cmd, label) => {
    const before = s.pins[pin]?.status;
    if (await sendCtrl({ cmd, pin }, `${label} ${pin}`)) setPending((p) => ({ ...p, [pin]: { cmd, label, wall: Date.now(), status: before } }));
  };
  const setMode = async (mode) => {
    const r = await post('/api/mode', { mode });
    if (r.ok) toast(`Mode: ${mode}`); else toast(`Mode change failed: ${r.problems.join('; ')}`, 'bad');
  };
  const waypoint = (n) => sendCtrl({ cmd: 'waypoint', n }, `pod at waypoint ${n}`);
  const pick = (pin) => {
    setSel(pin);
    const p = s.pins[pin];
    if (p) mapRef.current?.flyTo(p.x, p.y);
  };

  return html`
    <div class="app">
      <${TopBar} meta=${meta} st=${st} theme=${theme} setTheme=${setTheme} setMode=${setMode} />
      <div class="main">
        <${MapPane} meta=${meta} st=${st} sel=${sel} layers=${layers} setLayers=${setLayers}
          follow=${follow} setFollow=${setFollow} onPick=${pick} onWaypoint=${waypoint} mapRef=${mapRef} />
        <div class="side">
          <${PinsPanel} s=${s} sel=${sel} pick=${pick} pending=${pending} pinCmd=${pinCmd} big=${big} />
          <${PodPanel} meta=${meta} st=${st} big=${big} waypoint=${waypoint} />
          <${ObsPanel} s=${s} st=${st} big=${big} />
        </div>
      </div>
      <div class="toasts">${toasts.map((t) => html`<div key=${t.id} class=${`toast ${t.kind}`}>${t.text}</div>`)}</div>
    </div>`;
}

// ---------- top bar ----------
function sourceOf(st) {
  const pose = st.state.poses.pod || Object.values(st.state.poses)[0];
  if (!pose) return ['none', 'No pose'];
  if (pose.src === 'sim') return ['sim', 'Simulated'];
  if (pose.src === 'replay') return ['replay', 'Replay'];
  if (LIVE_SRC.has(pose.src)) return ['live', `Live · ${pose.src}`];
  return ['none', pose.src || '?'];
}

function TopBar({ meta, st, theme, setTheme, setMode }) {
  const s = st.state;
  const [srcKind, srcLabel] = sourceOf(st);
  const stale = st.link === 'live' && st.lastMsgWall && Date.now() - st.lastMsgWall > STALE_MS;
  const mode = s.latest['ag/mode']?.mode;
  const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? null : 'dark';
  return html`
    <header class="top">
      <div class="brand"><span class="logo">◉</span> AFTERGLOW <span class="sub">search-assist</span></div>
      <div class="profile" title=${`Profile: ${meta.profile}.toml · origin ${meta.origin.join(', ')}`}>
        ${meta.name}<span class="dim"> · ${meta.profile}</span>
      </div>
      <span class=${`badge src-${srcKind}`} title="From ag/pose src. Live = the real pod.">${srcLabel}</span>
      ${stale && html`<span class="badge bad" title="No message for over 5 s">No data ${fmtAge(Date.now() - st.lastMsgWall)}</span>`}
      <div class="spacer"></div>
      <div class="modes" role="group" aria-label="Mode">
        ${MODES.map(([m, label]) => html`
          <button class=${mode === m ? 'on' : ''} onClick=${() => mode !== m && setMode(m)}
            title=${mode ? `Switch to ${label}` : 'No mode set yet (geofence assumes patrol)'}>${label}</button>`)}
      </div>
      <div class="links">
        <span class=${`dot ${st.link === 'live' ? 'ok' : 'bad'}`}></span>Server
        <span class=${`dot ${s.broker ? 'ok' : 'bad'}`}></span>MQTT
      </div>
      <div class="clock" title="Bus time: the latest pose's t (runs fast with fake_bus --speed)">${fmtClock(s.bus_t)}</div>
      <button class="icon" title=${`Theme: ${theme || 'system'}`} onClick=${() => setTheme(nextTheme)}>
        ${theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
      </button>
    </header>`;
}

// ---------- map ----------
function MapPane({ meta, st, sel, layers, setLayers, follow, setFollow, onPick, onWaypoint, mapRef }) {
  const el = useRef(null);
  const cb = useRef({});
  cb.current = { onPick, onWaypoint };
  useEffect(() => {
    let v;
    try {
      v = new MapView(el.current, meta, {
        onPick: (p) => cb.current.onPick(p), onWaypoint: (n) => cb.current.onWaypoint(n),
      });
    } catch (e) {
      console.error('map failed to start', e);
      return undefined;
    }
    mapRef.current = v;
    return () => { mapRef.current = null; v.destroy(); };
  }, [meta]);
  useEffect(() => {
    const v = mapRef.current;
    if (!v) return;
    for (const [k, on] of Object.entries(layers)) v.setLayer(k, on);
  }, [layers]);
  useEffect(() => { mapRef.current?.update(st.state, { sel, layers, follow }); });

  const toggle = (k) => setLayers({ ...layers, [k]: !layers[k] });
  const hasRoads = meta.map.lines.some((l) => l.kind === 'road');
  return html`
    <div class="mapwrap">
      <div id="map" ref=${el}></div>
      <div class="maptools">
        <button onClick=${() => mapRef.current?.fit()} title="Fit the whole map">Fit</button>
        <button class=${follow ? 'on' : ''} onClick=${() => setFollow(!follow)} title="Keep the pod in view">Follow pod</button>
        <span class="sep"></span>
        ${[['coverage', 'Coverage'], ['probability', 'Probability'], ['trail', 'Pod path'], ['tracks', 'Tracks'],
           ...(hasRoads ? [['roads', 'Roads']] : [])].map(([k, label]) => html`
          <button class=${layers[k] ? 'on' : ''} onClick=${() => toggle(k)}>${label}</button>`)}
      </div>
      <div class="legend">
        ${[1, 2, 3, 4].map((p) => html`<span><i class="sw" style=${`background:${PRIO_COLOR[p]}`}></i>P${p === 4 ? '4 heard' : p}</span>`)}
        <span><i class="sw cov"></i>Covered</span>
        <span><i class="sw heat"></i>Probability</span>
        <span><i class="sw pod"></i>Pod</span>
      </div>
      ${Object.keys(meta.waypoints).length > 0 && html`<div class="maphint">Click a waypoint when the pod reaches it</div>`}
    </div>`;
}

// ---------- pins ----------
function PinsPanel({ s, sel, pick, pending, pinCmd, big }) {
  const [showCleared, setShowCleared] = useState(false);
  const all = Object.values(s.pins).sort((a, b) =>
    (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.prio - b.prio || pinNum(a.pin) - pinNum(b.pin));
  const cleared = all.filter((p) => p.status === 'cleared').length;
  const pins = showCleared ? all : all.filter((p) => p.status !== 'cleared');
  const selected = sel && s.pins[sel];
  return html`
    <section class="panel pins">
      <h2>Pins <span class="count">${all.length - cleared} open${cleared ? ` · ${cleared} cleared` : ''}</span>
        ${cleared > 0 && html`<button class="link" onClick=${() => setShowCleared(!showCleared)}>${showCleared ? 'Hide' : 'Show'} cleared</button>`}
      </h2>
      <div class="pinlist">
        ${pins.length === 0 && html`<div class="empty">No pins yet. Pins appear when geofence (or the fake bus) publishes ag/target.</div>`}
        ${pins.map((p) => html`
          <button key=${p.pin} class=${`pinrow ${p.pin === sel ? 'sel' : ''} st-${p.status}`} onClick=${() => pick(p.pin)}>
            <span class="chip" style=${`background:${PRIO_COLOR[p.prio] || PRIO_COLOR[4]}`}>${p.pin}</span>
            <span class="main">
              <span class="l1"><b>${CLS[p.cls] || p.cls}</b> · ${p.state} ±${fmtM(p.r95, big)} · ${Math.round((p.c || 0) * 100)}%</span>
              <span class="l2">${p.off_trail_m != null ? `${p.off_trail_m} m off trail · ` : ''}${RULE[p.rule] || p.rule || '—'} · heard ${agoText(ago(s.bus_t, p.t - (p.last_s || 0) * 1000))}</span>
            </span>
            <span class="flags">${flagIcons(p)}</span>
            <span class=${`status s-${p.status}`}>${pending[p.pin] ? '…' : p.status}</span>
          </button>`)}
      </div>
      ${selected && html`<${PinDetail} key=${selected.pin} p=${selected} s=${s} pending=${pending[selected.pin]} pinCmd=${pinCmd} big=${big} />`}
    </section>`;
}

function flagIcons(p) {
  const f = p.flags || {};
  return [['sos', 'SOS'], ['thermal', 'HEAT'], ['camera', 'CAM'], ['radar', 'RADAR']]
    .filter(([k]) => f[k]).map(([k, label]) => html`<i class=${`flag f-${k}`}>${label}</i>`);
}

function PinDetail({ p, s, pending, pinCmd, big }) {
  const [arm, setArm] = useState(0); // Confirm takes two clicks within 4 s
  useEffect(() => { if (arm) { const id = setTimeout(() => setArm(0), 4000); return () => clearTimeout(id); } }, [arm]);
  const tr = s.tracks[p.track];
  const st = p.status;
  const noAnswer = pending && Date.now() - pending.wall > NO_ANSWER_MS;
  const rows = [
    ['Position', `x ${fmtM(p.x, big)}, y ${fmtM(p.y, big)}`],
    ['Lat, lon', p.lat != null ? `${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}` : '—'],
    ['95% radius', fmtM(p.r95, big)],
    ['Confidence', `${Math.round((p.c || 0) * 100)}%`],
    ['Off trail', p.off_trail_m != null ? `${p.off_trail_m} m` : '—'],
    ['Zone', p.zone || '—'],
    ['Beacon', CLS_LONG[p.cls] || p.cls],
    ['Track', `${p.track}${tr ? ` · ${tr.passes ?? '?'} passes · ${(tr.ids || []).length} key(s)` : ''}`],
    ['Last heard', agoText(ago(s.bus_t, p.t - (p.last_s || 0) * 1000))],
    ['Why', RULE[p.rule] || p.rule || '—'],
  ];
  if (p.sos) rows.push(['SOS', `${p.sos.hurt ? 'HURT' : 'not hurt'} · ${p.sos.walk ? 'can walk' : "can't walk"} · ${p.sos.count} people`]);
  if (p.br) rows.push(['Breathing', `${p.br}/min`]);
  return html`
    <div class="detail">
      <div class="dhead">
        <span class="chip big" style=${`background:${PRIO_COLOR[p.prio] || PRIO_COLOR[4]}`}>${p.pin}</span>
        <div><b>Priority ${p.prio}</b> · ${p.state}<div class="dim">status: ${st}</div></div>
      </div>
      <dl>${rows.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
      <div class="actions">
        <button disabled=${st !== 'new'} onClick=${() => pinCmd(p.pin, 'ack', 'Acknowledge')}>Acknowledge</button>
        <button disabled=${!['new', 'acknowledged'].includes(st)} onClick=${() => pinCmd(p.pin, 'investigate', 'Investigate')}>Investigate</button>
        <button disabled=${['cleared', 'confirmed'].includes(st)} onClick=${() => pinCmd(p.pin, 'clear', 'Clear')}>Clear</button>
        <button class=${`confirm ${arm ? 'armed' : ''}`} disabled=${st !== 'investigating'}
          title=${st === 'investigating' ? 'Confirm a person is here (two clicks)' : 'Investigate first, then confirm what you see'}
          onClick=${() => { if (arm) { setArm(0); pinCmd(p.pin, 'confirm', 'Confirm person at'); } else setArm(1); }}>
          ${arm ? 'Click again to confirm' : 'Confirm person'}
        </button>
      </div>
      ${pending && html`<div class=${`pending ${noAnswer ? 'bad' : ''}`}>
        ${noAnswer ? `No answer to "${pending.label}" from geofence. Is geofence.py running?` : `Sent "${pending.label}", waiting for geofence…`}
      </div>`}
    </div>`;
}

// ---------- pod ----------
function PodPanel({ meta, st, big, waypoint }) {
  const s = st.state;
  const pose = s.poses.pod || Object.values(s.poses)[0];
  const cov = s.latest['ag/coverage'];
  const sys = s.latest['ag/sys'];
  const th = s.latest['ag/thermal'], vis = s.latest['ag/vision'], rad = s.latest['ag/radar'];
  const wps = Object.entries(meta.waypoints);
  const nearWp = pose && wps.find(([, [x, y]]) => Math.hypot(pose.x - x, pose.y - y) < 0.75)?.[0];
  const drones = Object.keys(s.poses).length;
  return html`
    <section class="panel">
      <h2>Pod <span class="count">${drones > 1 ? `${drones} drones` : pose ? `pose ${agoText(ago(s.bus_t, pose.t))}` : 'no pose yet'}</span></h2>
      <div class="kv">
        <div><label>Position</label><span>${pose ? `${fmtM(pose.x, big)}, ${fmtM(pose.y, big)}` : '—'}</span></div>
        <div><label>Height</label><span>${pose ? `${pose.z} m` : '—'}</span></div>
        <div><label>Source</label><span>${pose?.src || '—'}${pose?.n != null ? ` (wp ${pose.n})` : ''}</span></div>
        <div><label>Coverage</label><span>${cov ? html`<span class="meter"><i style=${`width:${Math.round(cov.pct * 100)}%`}></i></span> ${Math.round(cov.pct * 100)}%` : '—'}</span></div>
      </div>
      ${wps.length > 0 && html`
        <div class="wps"><label>Pod at waypoint</label>
          ${wps.map(([n]) => html`<button class=${nearWp === n ? 'here' : ''} onClick=${() => waypoint(Number(n))}>${n}</button>`)}
        </div>`}
      <div class="kv health">
        ${sys ? html`
          <div><label>CPU</label><span class=${sys.cpu_c > 80 ? 'warn' : ''}>${sys.cpu_c != null ? `${sys.cpu_c.toFixed(0)} °C` : '—'}</span></div>
          <div><label>Throttled</label><span class=${sys.throttled && sys.throttled !== '0x0' ? 'warn' : ''}>${sys.throttled ?? '—'}</span></div>
          <div><label>LoRa</label><span class=${sys.lora === false ? 'warn' : ''}>${sys.lora == null ? '—' : sys.lora ? 'ok' : 'down'}</span></div>
          <div><label>GPS fix</label><span>${sys.gps_fix == null ? '—' : sys.gps_fix ? 'yes' : 'no'}</span></div>
          <div><label>Disk free</label><span>${sys.disk_free_gb != null ? `${sys.disk_free_gb} GB` : '—'}</span></div>
          <div><label>Battery</label><span>${sys.batt_pct == null ? 'unknown' : `${sys.batt_pct}%`}</span></div>`
        : html`<div class="empty wide">No pod health yet (ag/sys from the health module).</div>`}
      </div>
      <div class="sensors">
        <span class=${`sensor ${th ? (th.hot ? 'hot' : 'on') : ''}`} title="ag/thermal">Thermal ${th ? `${th.max_c?.toFixed(1)} °C${th.hot ? ' HOT' : ''}` : '—'}</span>
        <span class=${`sensor ${vis ? 'on' : ''}`} title="ag/vision">Camera ${vis ? `${vis.kind} ${Math.round(vis.conf * 100)}%` : '—'}</span>
        <span class=${`sensor ${rad?.present ? 'hot' : rad ? 'on' : ''}`} title="ag/radar">Radar ${rad ? (rad.present ? `${rad.br ?? '?'}/min` : 'clear') : '—'}</span>
      </div>
      <div class="rates">${Object.entries(st.rates).filter(([, r]) => r > 0).sort().map(([k, r]) =>
        html`<span>${k.replace('ag/', '')} <b>${r < 10 ? r.toFixed(1) : Math.round(r)}</b>/s</span>`)}</div>
    </section>`;
}

// ---------- raw observations ----------
function ObsPanel({ s, st, big }) {
  const [tab, setTab] = useState(() => loadPref('obsTab', 'devices'));
  useEffect(() => savePref('obsTab', tab), [tab]);
  const devices = Object.values(s.obs).sort((a, b) => (b.t || 0) - (a.t || 0));
  const tracks = Object.values(s.tracks).sort((a, b) => pinNum(a.track) - pinNum(b.track));
  const pinOf = Object.fromEntries(Object.values(s.pins).map((p) => [p.track, p.pin]));
  const rate = (st.rates['ag/obs/ble'] || 0) + (st.rates['ag/obs/wifi'] || 0);
  return html`
    <section class="panel obs">
      <h2>
        <span class="tabs">
          ${[['devices', `Heard ${devices.length}`], ['tracks', `Tracks ${tracks.length}`], ['log', 'Log']].map(([k, label]) =>
            html`<button class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${label}</button>`)}
        </span>
        <span class="count">${rate.toFixed(1)} obs/s</span>
      </h2>
      <div class="obsbody">
        ${tab === 'devices' && html`
          <table>
            <thead><tr><th>ID</th><th>Type</th><th>RSSI</th><th class="r">Best</th><th class="r">#</th><th class="r">Ago</th></tr></thead>
            <tbody>${devices.slice(0, 120).map((o) => html`
              <tr key=${o.id}>
                <td class="mono">${o.id}</td><td>${CLS[o.cls] || o.cls}</td>
                <td><span class="rssi"><i style=${`width:${rssiPct(o.rssi)}%`}></i></span><span class="mono">${o.rssi}</span></td>
                <td class="r mono">${o.best}</td><td class="r mono">${o.n}</td><td class="r">${fmtAge(ago(s.bus_t, o.t))}</td>
              </tr>`)}</tbody>
          </table>
          ${devices.length === 0 && html`<div class="empty">Nothing heard yet (ag/obs/ble, ag/obs/wifi).</div>`}`}
        ${tab === 'tracks' && html`
          <table>
            <thead><tr><th>Track</th><th>Type</th><th>State</th><th class="r">±</th><th class="r">Passes</th><th class="r">Last</th><th></th></tr></thead>
            <tbody>${tracks.map((t) => html`
              <tr key=${t.track} class=${t.with_drone || t.baseline ? 'dim' : ''}>
                <td class="mono">${t.track}</td><td>${CLS[t.cls] || t.cls}</td><td>${t.state}</td>
                <td class="r mono">${fmtM(t.r95, big)}</td><td class="r mono">${t.passes ?? '—'}</td><td class="r">${t.last_s} s</td>
                <td>${t.with_drone ? html`<i class="flag">ON POD</i>` : t.baseline ? html`<i class="flag">BASELINE</i>`
                  : pinOf[t.track] ? html`<i class="flag f-pin">${pinOf[t.track]}</i>` : ''}</td>
              </tr>`)}</tbody>
          </table>
          ${tracks.length === 0 && html`<div class="empty">No tracks yet (ag/track from tracker.py).</div>`}`}
        ${tab === 'log' && html`
          <div class="log mono">${s.obs_log.map((e, i) => html`
            <div key=${i}><span class="dim">${fmtClock(e.msg.t)}</span> ${e.topic.replace('ag/obs/', '')} ${e.msg.id} ${e.msg.cls ?? ''} ${e.msg.rssi} dBm</div>`)}
          </div>`}
      </div>
    </section>`;
}
const rssiPct = (r) => Math.max(0, Math.min(100, ((r ?? -100) + 100) * (100 / 60)));

render(html`<${App} />`, document.getElementById('app'));
