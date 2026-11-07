# Vendored front-end libraries

Saved here so the dashboard runs with no internet and no CDN. Don't upgrade during the hackathon.

| Folder | Package | Source | License |
|---|---|---|---|
| `htm-3.1.1/` | htm 3.1.1, `preact/standalone.module.js` (bundles Preact 10 + hooks) | `cdn.jsdelivr.net/npm/htm@3.1.1/preact/standalone.module.js` | Apache-2.0 (Preact is MIT) |
| `leaflet-1.9.4/` | Leaflet 1.9.4, `dist/leaflet.js`, `leaflet.css`, `images/` | `cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/` | BSD-2-Clause |
| `maplibre-gl-4.7.1/` | MapLibre GL JS 4.7.1, `dist/maplibre-gl.js`, `maplibre-gl.css` (the live map feed, `livemap.js`) | `cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/` | BSD-3-Clause |

## Use

```html
<link rel="stylesheet" href="vendor/leaflet-1.9.4/leaflet.css">
<script src="vendor/leaflet-1.9.4/leaflet.js"></script>   <!-- sets window.L -->
<script type="module" src="app.js"></script>
```

```js
import { html, render, useState, useEffect, useRef } from './vendor/htm-3.1.1/standalone.module.js';
```

The bundle has no imports of its own. It exports `h`, `html`, `render`, `Component`, `createContext` and the hooks (`useState`, `useReducer`, `useEffect`, `useLayoutEffect`, `useRef`, `useMemo`, `useCallback`, `useContext`, …).

## SHA-256

```
72284e8e9079c87817145df1110f74e8a2aa040b2fc384922e18dfcb46fc1fd7  htm-3.1.1/standalone.module.js
db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a  leaflet-1.9.4/leaflet.js
a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6  leaflet-1.9.4/leaflet.css
be9633c4d870e26fb37f1cfe5c5a77181667114003ea16207ac7850d8da8add1  maplibre-gl-4.7.1/maplibre-gl.js
576b085fdd9487a65a19215328c1e086c07ce5bf6da09b666b3806d3d008dae9  maplibre-gl-4.7.1/maplibre-gl.css
```
