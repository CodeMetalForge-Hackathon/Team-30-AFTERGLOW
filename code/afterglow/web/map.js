// The park map in local metres: Leaflet with CRS.Simple, so 1 map unit = 1 m,
// lat = y (north) and lng = x (east). No tiles: everything is drawn from /api/map.
/* global L */

export const PRIO_COLOR = { 1: '#e5484d', 2: '#f76b15', 3: '#f5c13d', 4: '#8b95a3' };
const POD = '#3db9ff';
const TRAIL = '#b07a45';
const ROAD = '#7d838c';
const CAMP = '#d6912f';
const PARK = '#5f8f52';

const ll = (x, y) => [y, x];

export class MapView {
  constructor(el, meta, { onPick, onWaypoint }) {
    this.meta = meta;
    this.onPick = onPick;
    this.onWaypoint = onWaypoint;
    const b = meta.map.bounds;
    this.big = Math.max(b[2] - b[0], b[3] - b[1]) > 200; // park scale vs the taped indoor park

    const map = (this.map = L.map(el, {
      crs: L.CRS.Simple, minZoom: -6, maxZoom: 7, zoomSnap: 0.25, zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90, attributionControl: true,
    }));
    map.attributionControl.setPrefix(false);
    if (meta.map.credit) map.attributionControl.addAttribution(meta.map.credit.replace('(c)', '©'));
    [['zones', 210], ['coverage', 220], ['lines', 230], ['trail', 240], ['rings', 250], ['marks', 260]]
      .forEach(([name, z]) => { map.createPane(name).style.zIndex = z; });

    this.fit(); // the view must exist before vector layers are added, or their renderers have no bounds
    this.drawStatic();

    this.layers = {
      coverage: L.imageOverlay(blankPng(), [[0, 0], [1, 1]], { pane: 'coverage', className: 'coverage-img', opacity: 1 }).addTo(map),
      trail: L.polyline([], { pane: 'trail', color: POD, weight: 2, opacity: 0.55, interactive: false }).addTo(map),
      detect: L.circle([0, 0], { pane: 'rings', radius: meta.detect_m, color: POD, weight: 1, dashArray: '3 5',
                                 fill: false, interactive: false }),
      tracks: L.layerGroup().addTo(map),
      pins: L.layerGroup().addTo(map),
    };
    this.pod = null;
    this.pinLayers = {};
    this.trackLayers = {};
    this.covT = null;
    this.covKey = '';
    this.trailLen = -1;
    this.followAt = 0;
    this.canvas = document.createElement('canvas');

    this.scale = L.control({ position: 'bottomleft' });
    this.scale.onAdd = () => (this.scaleEl = L.DomUtil.create('div', 'm-scale'));
    this.scale.addTo(map);
    this.cursor = L.control({ position: 'bottomright' });
    this.cursor.onAdd = () => (this.cursorEl = L.DomUtil.create('div', 'm-cursor'));
    this.cursor.addTo(map);
    map.on('zoomend', () => this.updateScale());
    map.on('mousemove', (e) => {
      this.cursorEl.textContent = `x ${e.latlng.lng.toFixed(this.big ? 0 : 1)}  y ${e.latlng.lat.toFixed(this.big ? 0 : 1)} m`;
    });
    map.on('mouseout', () => { this.cursorEl.textContent = ''; });
    this.updateScale();
  }

  destroy() { this.map.remove(); }

  fit() {
    const [x0, y0, x1, y1] = this.meta.map.bounds;
    this.map.fitBounds([ll(x0, y0), ll(x1, y1)], { padding: [24, 24] });
  }

  drawStatic() {
    const { map: m, waypoints } = this.meta;
    const zones = [...m.zones].sort((a, b) => (a.kind === 'park' ? -1 : 0) - (b.kind === 'park' ? -1 : 0));
    this.static = { roads: L.layerGroup().addTo(this.map) };
    for (const z of zones) {
      const camp = z.kind === 'campground';
      const poly = L.polygon(z.ring.map(([x, y]) => ll(x, y)), {
        pane: 'zones', color: camp ? CAMP : PARK, weight: camp ? 1.5 : 1, opacity: camp ? 0.9 : 0.6,
        fillColor: camp ? CAMP : PARK, fillOpacity: camp ? 0.16 : 0.06, interactive: camp,
      }).addTo(this.map);
      if (camp) poly.bindTooltip(z.name || 'Campground', { sticky: true, className: 'm-tip' });
    }
    for (const ln of m.lines) {
      const road = ln.kind === 'road';
      const line = L.polyline(ln.pts.map(([x, y]) => ll(x, y)), {
        pane: 'lines', color: road ? ROAD : TRAIL, weight: road ? (this.big ? 1.5 : 3) : (this.big ? 2.5 : 7),
        opacity: road ? 0.75 : 0.95, lineCap: 'round',
      });
      if (ln.name) line.bindTooltip(ln.name, { sticky: true, className: 'm-tip' });
      line.addTo(road ? this.static.roads : this.map);
    }
    const wps = Object.entries(waypoints).map(([n, [x, y]]) => [Number(n), x, y]).sort((a, b) => a[0] - b[0]);
    if (wps.length > 1) {
      const route = wps.map(([, x, y]) => ll(x, y));
      L.polyline([...route, route[0]], { pane: 'lines', color: '#9aa4b2', weight: 1, dashArray: '4 4', interactive: false }).addTo(this.map);
    }
    for (const [n, x, y] of wps) {
      L.circleMarker(ll(x, y), { pane: 'marks', radius: 11, color: '#9aa4b2', weight: 1.5, fillColor: '#1c232b', fillOpacity: 0.9 })
        .bindTooltip(String(n), { permanent: true, direction: 'center', className: 'wp-label' })
        .on('click', () => this.onWaypoint(n))
        .addTo(this.map);
    }
  }

  setLayer(name, on) {
    // Coverage and probability share one image; drawCoverage paints whichever are on.
    if (name === 'coverage' || name === 'probability') return;
    const layer = name === 'roads' ? this.static.roads : this.layers[name];
    if (!layer) return;
    if (on && !this.map.hasLayer(layer)) layer.addTo(this.map);
    if (!on && this.map.hasLayer(layer)) layer.remove();
  }

  updateScale() {
    const mPerPx = 1 / 2 ** this.map.getZoom();
    const target = 110 * mPerPx;
    const nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((v) => v >= target * 0.6) || 5000;
    this.scaleEl.innerHTML = `<div class="bar" style="width:${nice / mPerPx}px"></div><span>${nice >= 1000 ? nice / 1000 + ' km' : nice + ' m'}</span>`;
  }

  update(s, { sel, layers, follow }) {
    this.drawCoverage(s.latest['ag/coverage'], layers);
    this.drawPod(s, follow, layers);
    this.drawTracks(s, layers.tracks);
    this.drawPins(s, sel);
  }

  drawPod(s, follow) {
    const pose = s.poses.pod || Object.values(s.poses)[0];
    const trail = s.trails.pod || Object.values(s.trails)[0] || [];
    if (trail.length !== this.trailLen) {
      this.layers.trail.setLatLngs(trail.map(([x, y]) => ll(x, y)));
      this.trailLen = trail.length;
    }
    if (!pose) return;
    let heading = pose.course;
    if (heading == null && trail.length > 1) {
      const [x0, y0] = trail[trail.length - 2], [x1, y1] = trail[trail.length - 1];
      heading = (Math.atan2(x1 - x0, y1 - y0) * 180) / Math.PI;
    }
    const at = ll(pose.x, pose.y);
    if (!this.pod) {
      const icon = L.divIcon({ className: 'pod-icon', iconSize: [26, 26], iconAnchor: [13, 13],
        html: '<svg viewBox="-13 -13 26 26"><circle r="11" class="pod-halo"/><path d="M0,-9 L6,7 L0,3 L-6,7 Z" class="pod-arrow"/></svg>' });
      this.pod = L.marker(at, { icon, zIndexOffset: 1000, keyboard: false }).addTo(this.map);
      this.pod.bindTooltip('Pod', { direction: 'top', offset: [0, -12], className: 'm-tip' });
      if (!this.layers.detect._map) this.layers.detect.addTo(this.map);
    }
    this.pod.setLatLng(at);
    this.layers.detect.setLatLng(at);
    const svg = this.pod.getElement()?.querySelector('svg');
    if (svg) svg.style.transform = `rotate(${heading || 0}deg)`;
    if (follow && Date.now() - this.followAt > 800) {
      this.followAt = Date.now();
      this.map.panTo(at, { animate: true, duration: 0.6 });
    }
  }

  drawCoverage(cov, layers) {
    const key = `${layers.coverage}${layers.probability}`;
    if (!cov || (cov.t === this.covT && key === this.covKey)) return;
    this.covT = cov.t;
    this.covKey = key;
    const { nx, ny, x0, y0, cell_m, covered, p } = cov;
    const c = this.canvas;
    c.width = nx;
    c.height = ny;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(nx, ny);
    for (let r = 0; r < ny; r++) {
      for (let col = 0; col < nx; col++) {
        const i = r * nx + col;
        const o = ((ny - 1 - r) * nx + col) * 4; // grid row 0 is the south edge; canvas row 0 is the top
        let R = 0, G = 0, B = 0, A = 0;
        if (layers.coverage && covered[i]) { R = 61; G = 185; B = 255; A = 44; }
        const v = layers.probability ? p[i] / 255 : 0;
        if (v > 0.03) { R = 255; G = Math.round(210 - 170 * v); B = 40; A = Math.round(50 + 170 * v); }
        img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B; img.data[o + 3] = A;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.layers.coverage.setUrl(c.toDataURL());
    this.layers.coverage.setBounds([ll(x0, y0), ll(x0 + nx * cell_m, y0 + ny * cell_m)]);
  }

  drawTracks(s, show) {
    const pinned = new Set(Object.values(s.pins).map((p) => p.track));
    const seen = new Set();
    if (show) {
      for (const t of Object.values(s.tracks)) {
        if (t.with_drone || pinned.has(t.track)) continue;
        seen.add(t.track);
        let m = this.trackLayers[t.track];
        if (!m) {
          m = this.trackLayers[t.track] = L.circleMarker(ll(t.x, t.y), {
            pane: 'marks', radius: 4, color: '#8b95a3', weight: 1.5, fillOpacity: 0, dashArray: '2 2',
          }).bindTooltip('', { direction: 'top', className: 'm-tip' }).addTo(this.layers.tracks);
        }
        m.setLatLng(ll(t.x, t.y));
        m.setTooltipContent(`${t.track} · ${t.cls} · ${t.state} ±${fmt(t.r95)} m`);
      }
    }
    for (const id of Object.keys(this.trackLayers)) {
      if (!seen.has(id)) { this.trackLayers[id].remove(); delete this.trackLayers[id]; }
    }
  }

  drawPins(s, sel) {
    const seen = new Set();
    for (const p of Object.values(s.pins)) {
      seen.add(p.pin);
      const color = PRIO_COLOR[p.prio] || PRIO_COLOR[4];
      const faded = p.status === 'cleared';
      const selected = p.pin === sel;
      let L_ = this.pinLayers[p.pin];
      if (!L_) {
        L_ = this.pinLayers[p.pin] = {
          ring: L.circle(ll(p.x, p.y), { pane: 'rings', radius: p.r95, weight: 1.5 }).addTo(this.layers.pins),
          dot: L.circleMarker(ll(p.x, p.y), { pane: 'marks', radius: 7, weight: 2, fillOpacity: 1 })
            .bindTooltip(p.pin, { permanent: true, direction: 'right', offset: [8, 0], className: 'pin-label' })
            .on('click', () => this.onPick(p.pin))
            .addTo(this.layers.pins),
          msg: null, sel: null,
        };
        L_.ring.on('click', () => this.onPick(p.pin));
      }
      if (L_.msg === p && L_.sel === selected) continue;
      L_.msg = p;
      L_.sel = selected;
      L_.ring.setLatLng(ll(p.x, p.y)).setRadius(p.r95).setStyle({
        color, fillColor: color, opacity: faded ? 0.3 : 0.9, fillOpacity: faded ? 0.03 : selected ? 0.22 : 0.1,
        dashArray: p.state === 'heard' ? '5 5' : null, weight: selected ? 2.5 : 1.5,
      });
      L_.dot.setLatLng(ll(p.x, p.y)).setStyle({
        color: selected ? '#ffffff' : '#11161c', fillColor: color, opacity: faded ? 0.4 : 1, fillOpacity: faded ? 0.4 : 1,
        weight: selected ? 3 : 2,
      });
      L_.dot.setRadius(selected ? 9 : 7);
      L_.dot.getTooltip()?.getElement()?.classList.toggle('sel', selected);
    }
    for (const id of Object.keys(this.pinLayers)) {
      if (!seen.has(id)) {
        this.pinLayers[id].ring.remove();
        this.pinLayers[id].dot.remove();
        delete this.pinLayers[id];
      }
    }
  }

  flyTo(x, y) {
    const z = Math.max(this.map.getZoom(), this.big ? 0 : 5);
    this.map.flyTo(ll(x, y), z, { duration: 0.6 });
  }
}

function fmt(v) { return v == null ? '—' : v >= 10 ? Math.round(v) : v.toFixed(1); }

function blankPng() {
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
}
