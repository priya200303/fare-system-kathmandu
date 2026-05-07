/* ======= MAP INIT ======= */
const map = L.map('map').setView([27.7100, 85.3240], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

/* ======= DOM ======= */
const startInput      = document.getElementById('startInput');
const destInput       = document.getElementById('destInput');
const suggestionsStart = document.getElementById('suggestionsStart');
const suggestionsDest  = document.getElementById('suggestionsDest');
const searchBtn       = document.getElementById('searchBtn');
const resultsDiv      = document.getElementById('results');
const detailPanel     = document.getElementById('detailPanel');
const detailContent   = document.getElementById('detailContent');

/* ======= STATE ======= */
let startCoords = null, destCoords = null;
let startStop   = null, destStop   = null;
let routesFound = [];
let startMarker = null, destMarker = null;
let routeLayer  = null;
let currentRouteIndex = 0;

/* ======= OSRM CACHE ======= */
const osrmCache = new Map();

/* ======= WALK MAP SETUP ======= */
const walkMapContainer = document.createElement('div');
walkMapContainer.id = 'walkMapContainer';
walkMapContainer.innerHTML = `
  <div class="wm-header">
    <button onclick="closeWalkMap()" class="wm-back">← Back</button>
    <strong id="wmTitle">🚶 Walking Navigation</strong>
    <button onclick="startSimulation()" class="wm-sim" id="simBtn">▶ Simulate</button>
  </div>
  <div class="wm-body">
    <div id="walkInstructions"></div>
    <div id="walkMap"></div>
  </div>`;
document.body.appendChild(walkMapContainer);

let walkMapInst = null, fullPathLayer = null, movingDot = null;
let animInterval = null, currentPath = [], currentWalkType = null;
let currentStepIndex = 0, walkSteps = [];

/* ============== OSRM HELPERS  ============== */


async function osrmRoute(lat1, lon1, lat2, lon2, profile = 'foot') {
  const key = `${profile}|${lat1.toFixed(5)},${lon1.toFixed(5)}|${lat2.toFixed(5)},${lon2.toFixed(5)}`;
  if (osrmCache.has(key)) return osrmCache.get(key);

  try {
    const url = `https://router.project-osrm.org/route/v1/${profile}/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error('OSRM error');
    const data = await res.json();
    if (!data.routes || !data.routes[0]) throw new Error('No route');

    const route = data.routes[0];
    const distKm = route.distance / 1000;

    // Use realistic walking pace: 80 m/min 
    const result = {
      distanceKm: distKm,
      durationMin: Math.ceil((distKm * 1000) / 80), // 80 metres per minute
      geometry: route.geometry.coordinates.map(c => [c[1], c[0]]), // [lat, lon]
      steps: route.legs[0].steps
    };
    osrmCache.set(key, result);
    return result;
  } catch {

    // Fallback
    const hav = haversine(lat1, lon1, lat2, lon2);
    const factor = profile === 'foot' ? 1.25 : 1.4;
    const result = {
      distanceKm: hav * factor,
      durationMin: profile === 'foot' ? Math.ceil((hav * factor * 1000) / 80) : Math.ceil(hav * factor * 3),
      geometry: [[lat1, lon1], [lat2, lon2]],
      steps: []
    };
    osrmCache.set(key, result);
    return result;
  }
}


async function calcBusKmReal(stopList) {
  if (stopList.length < 2) return 0;

  // For short segments, use OSRM; for long routes sample every 2 stops
  const stopObjs = stopList.map(id => stops.find(s => s.id === id)).filter(Boolean);
  if (stopObjs.length < 2) return 0;

  // If more than 8 stops, use haversine×1.35 to avoid rate limiting
  if (stopObjs.length > 8) {
    let total = 0;
    for (let i = 1; i < stopObjs.length; i++) {
      total += haversine(stopObjs[i-1].lat, stopObjs[i-1].lon, stopObjs[i].lat, stopObjs[i].lon);
    }
    return total * 1.38; 
  }

  // Small segments: real OSRM calls
  let total = 0;
  for (let i = 1; i < stopObjs.length; i++) {
    try {
      const r = await osrmRoute(stopObjs[i-1].lat, stopObjs[i-1].lon, stopObjs[i].lat, stopObjs[i].lon, 'driving');
      total += r.distanceKm;
    } catch {
      total += haversine(stopObjs[i-1].lat, stopObjs[i-1].lon, stopObjs[i].lat, stopObjs[i].lon) * 1.38;
    }
  }
  return total;
}

/* ======= HAVERSINE ======= */
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function nearestStop(lat, lon) {
  let min = Infinity, best = null;
  stops.forEach(s => {
    if (!s.lat || !s.lon) return;
    const d = haversine(lat, lon, s.lat, s.lon);
    if (d < min) { min = d; best = s; }
  });
  return { stop: best, dist: min };
}

// Synchronous fallback bus km 
function calcBusKmSync(stopList) {
  let total = 0;
  for (let i = 1; i < stopList.length; i++) {
    const a = stops.find(s => s.id === stopList[i-1]);
    const b = stops.find(s => s.id === stopList[i]);
    if (a && b) total += haversine(a.lat, a.lon, b.lat, b.lon);
  }
  return total * 1.38;
}

function getFare(km) {
  if (km <= 5)  return 20;
  if (km <= 10) return 25;
  if (km <= 15) return 30;
  if (km <= 20) return 35;
  if (km <= 25) return 40;
  return 50;
}

function fmtDist(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

function fmtMin(min) {
  if (min < 60) return `${min} min`;
  return `${Math.floor(min/60)}h ${min%60}m`;
}

function getStopName(id) {
  const s = stops.find(x => x.id === id);
  return s ? (s.name || s.id) : id;
}

function makeIcon(html) {
  return L.divIcon({ className: 'map-emoji-icon', html, iconSize: [30, 30], iconAnchor: [15, 15] });
}

/* ======= AUTOCOMPLETE ======= */
function setupAutocomplete(input, sugBox, isStart) {
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { sugBox.style.display = 'none'; return; }

    timer = setTimeout(async () => {
      let html = '';

      const qLow = q.toLowerCase();
      const stopMatches = stops.filter(s => (s.name + ' ' + s.id).toLowerCase().includes(qLow));
      const seenNames = new Set();
      const uniqueStops = stopMatches.filter(s => {
        if (seenNames.has(s.name)) return false;
        seenNames.add(s.name);
        return true;
      }).slice(0, 8);

      if (uniqueStops.length) {
        html += `<div class="suggestion-title">🚌 Bus Stops</div>`;
        uniqueStops.forEach(s => {
          html += `<div class="suggestion-item" data-lat="${s.lat}" data-lon="${s.lon}" data-name="${escQ(s.name)}" data-isstart="${isStart}">
            <div class="sug-icon">🚌</div>
            <div class="sug-text"><strong>${highlight(s.name, q)}</strong><br><small>Bus Stop · ${s.id}</small></div>
          </div>`;
        });
      }

      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ' Kathmandu')}&format=json&limit=5&countrycodes=np&viewbox=85.24,27.60,85.45,27.80&bounded=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        const places = await res.json();
        if (places.length) {
          html += `<div class="suggestion-title">📍 Places</div>`;
          places.forEach(p => {
            const name = p.display_name.split(',').slice(0, 3).join(', ');
            html += `<div class="suggestion-item" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${escQ(name)}" data-isstart="${isStart}">
              <div class="sug-icon">📍</div>
              <div class="sug-text"><strong>${p.display_name.split(',')[0]}</strong><br><small>${p.display_name.split(',').slice(1,3).join(',')}</small></div>
            </div>`;
          });
        }
      } catch(e) {}

      if (!html) html = `<div class="suggestion-item" style="color:#888;padding:12px">No results found</div>`;
      sugBox.innerHTML = html;
      sugBox.style.display = 'block';

      sugBox.querySelectorAll('.suggestion-item[data-lat]').forEach(el => {
        el.addEventListener('click', () => {
          const lat = parseFloat(el.dataset.lat);
          const lon = parseFloat(el.dataset.lon);
          const name = el.dataset.name;
          const isS = el.dataset.isstart === 'true';
          selectLocation(lat, lon, name, isS);
          sugBox.style.display = 'none';
        });
      });
    }, 250);
  });

  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !sugBox.contains(e.target)) {
      sugBox.style.display = 'none';
    }
  });
}

function escQ(s) { return s.replace(/"/g, '&quot;').replace(/'/g, "\\'"); }
function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return text;
  return text.slice(0,i) + `<mark>${text.slice(i, i+q.length)}</mark>` + text.slice(i+q.length);
}

setupAutocomplete(startInput, suggestionsStart, true);
setupAutocomplete(destInput, suggestionsDest, false);

/* ======= SELECT LOCATION ======= */
function selectLocation(lat, lon, name, isStart) {
  if (isStart) {
    startCoords = [lat, lon];
    startInput.value = name;
    if (startMarker) map.removeLayer(startMarker);
    startMarker = L.marker([lat, lon], { icon: makeIcon('🚩') }).addTo(map).bindPopup('Start: ' + name);
  } else {
    destCoords = [lat, lon];
    destInput.value = name;
    if (destMarker) map.removeLayer(destMarker);
    destMarker = L.marker([lat, lon], { icon: makeIcon('🏁') }).addTo(map).bindPopup('Destination: ' + name);
  }
  map.setView([lat, lon], 15);
}

/* ======= CURRENT LOCATION ======= */
document.getElementById('locBtn').onclick = () => {
  if (!navigator.geolocation) return alert('Geolocation not supported');
  navigator.geolocation.getCurrentPosition(pos => {
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    selectLocation(lat, lon, '📍 My Location', true);
  }, () => alert('Could not get location. Please allow location access.'));
};

/* ======= SEARCH ======= */
searchBtn.onclick = async () => {
  if (!startCoords) return alert('Please enter a start location');
  if (!destCoords)  return alert('Please enter a destination');

  searchBtn.textContent = '⏳ Searching…';
  searchBtn.disabled = true;

  const { stop: ss, dist: sdist } = nearestStop(startCoords[0], startCoords[1]);
  const { stop: ds, dist: ddist } = nearestStop(destCoords[0], destCoords[1]);

  if (!ss || !ds) {
    searchBtn.textContent = '🔍 Find Routes';
    searchBtn.disabled = false;
    return alert('No nearby bus stops found.');
  }

  startStop = ss;
  destStop  = ds;

  // walking distances to/from stop
  let realStartWalk, realEndWalk;
  try {
    [realStartWalk, realEndWalk] = await Promise.all([
      osrmRoute(startCoords[0], startCoords[1], ss.lat, ss.lon, 'foot'),
      osrmRoute(ds.lat, ds.lon, destCoords[0], destCoords[1], 'foot')
    ]);
  } catch {
    realStartWalk = { distanceKm: sdist * 1.25, durationMin: Math.ceil(sdist * 15) };
    realEndWalk   = { distanceKm: ddist * 1.25, durationMin: Math.ceil(ddist * 15) };
  }

  routesFound = findRoutes(ss, ds, realStartWalk, realEndWalk);

  searchBtn.textContent = '🔍 Find Routes';
  searchBtn.disabled = false;

  renderResults();
};

/* ======= ROUTE FINDER ======= */
function findRoutes(ss, ds, startWalk, endWalk) {
  const found = [];
  const seenKeys = new Set();

  routes.forEach(r => {
    const a = r.stops.indexOf(ss.id);
    const b = r.stops.indexOf(ds.id);
    if (a === -1 || b === -1 || a === b) return;

    const from = Math.min(a, b), to = Math.max(a, b);
    let sl = r.stops.slice(from, to + 1);
    if (a > b) sl = [...sl].reverse();

    const key = r.company + '|' + sl.join('-');
    if (seenKeys.has(key)) return;
    seenKeys.add(key);

    const busKm = calcBusKmSync(sl);
    found.push({
      type: 'direct',
      company: r.company,
      vehicle: r.vehicle || 'bus',
      segments: [{ stopList: sl, km: busKm, fare: getFare(busKm) }],
      startWalk, endWalk,
      startStop: ss, destStop: ds,
      totalFare: getFare(busKm),
      totalStops: Math.abs(b - a)
    });
  });

  found.sort((a, b) => a.totalStops - b.totalStops || a.segments[0].km - b.segments[0].km);
  if (found.length > 0) return found.slice(0, 3);

  // Transfer routes
  const transferFound = [];
  routes.forEach(r1 => {
    const si = r1.stops.indexOf(ss.id);
    if (si === -1) return;

    for (let ti = 0; ti < r1.stops.length; ti++) {
      if (ti === si) continue;
      const transferId = r1.stops[ti];

      routes.forEach(r2 => {
        if (r1 === r2) return;
        const t2 = r2.stops.indexOf(transferId);
        const di = r2.stops.indexOf(ds.id);
        if (t2 === -1 || di === -1 || t2 === di) return;

        let seg1 = si < ti ? r1.stops.slice(si, ti+1) : [...r1.stops.slice(ti, si+1)].reverse();
        let seg2 = t2 < di ? r2.stops.slice(t2, di+1) : [...r2.stops.slice(di, t2+1)].reverse();

        const key = seg1.join('-') + '||' + seg2.join('-');
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        const km1 = calcBusKmSync(seg1), km2 = calcBusKmSync(seg2);
        const f1 = getFare(km1), f2 = getFare(km2);

        transferFound.push({
          type: 'transfer',
          company: r1.company + ' → ' + r2.company,
          transferStop: transferId,
          segments: [
            { stopList: seg1, km: km1, fare: f1, company: r1.company },
            { stopList: seg2, km: km2, fare: f2, company: r2.company }
          ],
          startWalk, endWalk,
          startStop: ss, destStop: ds,
          totalFare: f1 + f2,
          totalStops: seg1.length + seg2.length - 2,
          totalKm: km1 + km2
        });
      });
    }
  });

  transferFound.sort((a, b) => a.totalStops - b.totalStops || a.totalKm - b.totalKm || a.totalFare - b.totalFare);
  return transferFound.slice(0, 3);
}

/* ======= RENDER RESULTS ======= */
function renderResults() {
  if (!routesFound.length) {
    resultsDiv.innerHTML = `<div class="no-routes">😕 No routes found between these locations.<br>Try selecting nearby bus stops.</div>`;
    return;
  }

  const sw = routesFound[0].startWalk;
  const ew = routesFound[0].endWalk;

  let html = `<div class="result-header">
    <strong>Found ${routesFound.length} route${routesFound.length > 1 ? 's' : ''}</strong>
    <span>🚩 ${startStop.name} → 🏁 ${destStop.name}</span>
  </div>`;

  if (sw.distanceKm > 0.05) {
    html += `<div class="walk-notice">🚶 Walk <strong>${fmtDist(sw.distanceKm)}</strong> (~${sw.durationMin} min) to <strong>${startStop.name}</strong></div>`;
  }

  routesFound.forEach((route, i) => {
    const badge = route.type === 'direct'
      ? `<span class="badge direct">⭐ Direct</span>`
      : `<span class="badge transfer">🔄 1 Transfer</span>`;

    const totalKm   = route.segments.reduce((s, seg) => s + seg.km, 0);
    const walkTotal = sw.durationMin + ew.durationMin;

    html += `<div class="routeCard" onclick="openDetail(${i})">
      <div class="route-top">
        ${badge}
        <span class="route-company">${route.company}</span>
      </div>
      <div class="route-meta">
        <span>🚌 ${route.totalStops} stops</span>
        <span>📏 ${fmtDist(totalKm)}</span>
        ${walkTotal > 0 ? `<span>🚶 ~${walkTotal} min walk</span>` : ''}
      </div>
      <div class="route-fare">
        <span class="fare-amount">NPR ${route.totalFare}</span>
        <span class="fare-walk">+ 🚶 ${fmtDist(sw.distanceKm + ew.distanceKm)} walk</span>
      </div>
      <div class="route-stops-preview">${route.segments[0].stopList.slice(0,3).map(getStopName).join(' → ')}${route.segments[0].stopList.length > 3 ? ' → ...' : ''}</div>
    </div>`;
  });

  if (ew.distanceKm > 0.05) {
    html += `<div class="walk-notice">🚶 Walk <strong>${fmtDist(ew.distanceKm)}</strong> (~${ew.durationMin} min) from <strong>${destStop.name}</strong></div>`;
  }

  resultsDiv.innerHTML = html;
  drawRouteLine(routesFound[0]);
}

/* ======= OPEN DETAIL ======= */
function openDetail(idx) {
  currentRouteIndex = idx;
  const route = routesFound[idx];
  const sw = route.startWalk;
  const ew = route.endWalk;

  let html = `<div class="detail-fare">Total Fare: <strong>NPR ${route.totalFare}</strong></div>`;

  if (sw.distanceKm > 0.02) {
    html += `<div class="timeline-item" onclick="showWalkMap('start')">
      <div class="dot walk"></div>
      <div class="content">
        <strong>🚶 Walk to ${route.startStop.name}</strong><br>
        <small>${fmtDist(sw.distanceKm)} · ~${sw.durationMin} min · <span style="color:#1a6ef5">Tap for navigation ›</span></small>
      </div>
    </div>`;
  } else {
    html += `<div class="timeline-item">
      <div class="dot walk"></div>
      <div class="content"><strong>📍 You are at / near ${route.startStop.name}</strong></div>
    </div>`;
  }

  route.segments.forEach((seg, i) => {
    const company = seg.company || route.company;
    const names = seg.stopList.map(getStopName);
    html += `<div class="timeline-item">
      <div class="dot ride"></div>
      <div class="content">
        <strong>🚌 Board at ${names[0]}</strong><br>
        <small>${company}</small><br>
        <div class="stop-list">${names.join(' <span class="arrow">›</span> ')}</div>
        <div class="seg-meta">
          <span>🛑 ${seg.stopList.length - 1} stops</span>
          <span>📏 ${fmtDist(seg.km)}</span>
          <span>💰 NPR ${seg.fare}</span>
        </div>
        <small style="color:#777">Alight at <strong>${names[names.length-1]}</strong></small>
      </div>
    </div>`;

    if (route.type === 'transfer' && i === 0) {
      html += `<div class="timeline-item">
        <div class="dot transfer"></div>
        <div class="content">🔁 <strong>Transfer</strong> at <strong>${getStopName(route.transferStop)}</strong><br>
        <small>Board ${route.segments[1].company || route.company}</small></div>
      </div>`;
    }
  });

  if (ew.distanceKm > 0.02) {
    html += `<div class="timeline-item" onclick="showWalkMap('end')">
      <div class="dot walk"></div>
      <div class="content">
        <strong>🚶 Walk to your destination</strong><br>
        <small>${fmtDist(ew.distanceKm)} · ~${ew.durationMin} min · <span style="color:#1a6ef5">Tap for navigation ›</span></small>
      </div>
    </div>`;
  } else {
    html += `<div class="timeline-item">
      <div class="dot walk"></div>
      <div class="content"><strong>🏁 You have arrived!</strong></div>
    </div>`;
  }

  html += `<div style="margin-top:16px;padding:12px;background:#fff3cd;border-radius:10px;font-size:13px;">
    ⏰ Buses run approx every <strong>15–20 minutes</strong><br>
    💡 Fare may vary slightly by operator
  </div>`;

  detailContent.innerHTML = html;
  detailPanel.style.display = 'block';
  drawRouteLine(route);
}

window.openDetail = openDetail;

window.closeDetail = function() {
  detailPanel.style.display = 'none';
};

/* ======= DRAW ROUTE ON MAP ======= */
async function drawRouteLine(route) {
  if (routeLayer) map.removeLayer(routeLayer);

  const coords = [];
  if (startCoords) coords.push([startCoords[1], startCoords[0]]);
  route.segments.forEach(seg => {
    seg.stopList.forEach(id => {
      const s = stops.find(x => x.id === id);
      if (s && s.lat && s.lon) coords.push([s.lon, s.lat]);
    });
  });
  if (destCoords) coords.push([destCoords[1], destCoords[0]]);
  if (coords.length < 2) return;

  // OSRM driving route for bus path
  try {
    const waypoints = coords.length > 50
      ? [coords[0], ...coords.slice(1, 49), coords[coords.length-1]]
      : coords;

    const coordStr = waypoints.map(c => `${c[0]},${c[1]}`).join(';');
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordStr}?overview=full&geometries=geojson`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const path = data.routes[0].geometry.coordinates.map(c => [c[1], c[0]]);
    routeLayer = L.polyline(path, { color: '#1a6ef5', weight: 5, opacity: 0.85 }).addTo(map);
  } catch {
    const path = coords.map(c => [c[1], c[0]]);
    routeLayer = L.polyline(path, { color: '#1a6ef5', weight: 5, dashArray: '10,6', opacity: 0.8 }).addTo(map);
  }

  route.segments.forEach(seg => {
    [seg.stopList[0], seg.stopList[seg.stopList.length-1]].forEach(id => {
      const s = stops.find(x => x.id === id);
      if (s) L.circleMarker([s.lat, s.lon], { radius: 6, color: '#1a6ef5', fillColor: '#fff', fillOpacity: 1, weight: 2 })
        .addTo(map).bindPopup(`🚌 ${s.name}`);
    });
  });

  map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
}

/* =============== WALK MAP – Google Maps navigation =============== */
window.showWalkMap = async function(type) {
  currentWalkType = type;
  const route = routesFound[currentRouteIndex];

  let fromCoords, toCoords, toLabel;
  if (type === 'start') {
    fromCoords = startCoords;
    toCoords   = [route.startStop.lat, route.startStop.lon];
    toLabel    = route.startStop.name;
    document.getElementById('wmTitle').textContent = `Walk to ${route.startStop.name}`;
  } else {
    fromCoords = [route.destStop.lat, route.destStop.lon];
    toCoords   = destCoords;
    toLabel    = destInput.value || 'Destination';
    document.getElementById('wmTitle').textContent = `Walk to Destination`;
  }

  walkMapContainer.style.display = 'flex';
  document.getElementById('walkInstructions').innerHTML = `<div style="padding:20px;text-align:center;color:#64748b">⏳ Loading route…</div>`;

  // Init map
  setTimeout(async () => {
    if (!walkMapInst) {
      walkMapInst = L.map('walkMap').setView(fromCoords, 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(walkMapInst);
    } else {
      walkMapInst.invalidateSize();
    }

    if (fullPathLayer) walkMapInst.removeLayer(fullPathLayer);
    if (movingDot) walkMapInst.removeLayer(movingDot);
    if (animInterval) clearInterval(animInterval);
    currentStepIndex = 0; walkSteps = [];

    // Fetch real walking route via OSRM
    let osrmData;
    try {
      const res = await fetch(
        `https://router.project-osrm.org/route/v1/foot/${fromCoords[1]},${fromCoords[0]};${toCoords[1]},${toCoords[0]}?overview=full&geometries=geojson&steps=true&annotations=false`
      );
      if (!res.ok) throw new Error();
      osrmData = await res.json();
    } catch { osrmData = null; }

    if (osrmData && osrmData.routes && osrmData.routes[0]) {
      const r = osrmData.routes[0];
      const distKm  = r.distance / 1000;
      const durMin  = Math.ceil(r.distance / 80); // 80 m/min = 4.8 km/h realistic walking pace
      currentPath   = r.geometry.coordinates.map(c => [c[1], c[0]]);
      walkSteps     = r.legs[0].steps;

      // Draw path
      fullPathLayer = L.polyline(currentPath, { color: '#10b981', weight: 6, opacity: 0.9 }).addTo(walkMapInst);

      // Animate path drawing
      animatePathDraw(currentPath);

      // Markers
      L.marker(fromCoords, { icon: makeIcon('🔵') }).addTo(walkMapInst).bindPopup('You are here').openPopup();
      L.marker(toCoords,   { icon: makeIcon('🏁') }).addTo(walkMapInst).bindPopup(toLabel);
      walkMapInst.fitBounds(fullPathLayer.getBounds(), { padding: [40, 40] });

      renderWalkInstructions(distKm, durMin, walkSteps, toLabel);
    } else {
      // Fallback straight line
      currentPath   = [fromCoords, toCoords];
      const distKm  = haversine(fromCoords[0], fromCoords[1], toCoords[0], toCoords[1]) * 1.25;
      const durMin  = Math.ceil((distKm * 1000) / 80);

      fullPathLayer = L.polyline(currentPath, { color: '#10b981', weight: 5, dashArray: '10,6' }).addTo(walkMapInst);
      L.marker(fromCoords, { icon: makeIcon('🔵') }).addTo(walkMapInst);
      L.marker(toCoords,   { icon: makeIcon('🏁') }).addTo(walkMapInst);
      walkMapInst.fitBounds(L.latLngBounds(currentPath), { padding: [40, 40] });
      renderWalkFallback(distKm, durMin);
    }
  }, 100);
};

/* -------- Google Maps–style instructions -------- */
function renderWalkInstructions(distKm, durMin, steps, toLabel) {
  const maneuverIcon = m => {
    const map = {
      'turn-right': '↪️', 'turn-left': '↩️', 'turn-slight-right': '↗️',
      'turn-slight-left': '↖️', 'turn-sharp-right': '⤵️', 'turn-sharp-left': '⤴️',
      'uturn': '🔄', 'roundabout': '🔃', 'arrive': '🏁', 'depart': '🚶',
      'straight': '⬆️', 'merge': '↪️', 'fork': '🍴', 'end of road': '⛔'
    };
    return map[m] || '⬆️';
  };

  walkSteps = steps; 

  let html = `
    <!-- Summary bar -->
    <div class="nav-summary">
      <div class="nav-summary-row">
        <div class="nav-time">${fmtMin(durMin)}</div>
        <div class="nav-dist">${fmtDist(distKm)}</div>
      </div>
      <div class="nav-dest">📍 ${toLabel}</div>
      <div class="nav-mode">🚶 Walking directions</div>
    </div>

    <!-- Step list -->
    <div class="nav-steps">`;

  steps.forEach((step, i) => {
    const manType = step.maneuver?.type || 'straight';
    const manMod  = step.maneuver?.modifier || '';
    const key     = manMod ? `${manType}-${manMod}`.replace(/ /g,'-') : manType;
    const icon    = maneuverIcon(key) || maneuverIcon(manType) || '⬆️';
    const dist    = step.distance < 1000
      ? `${Math.round(step.distance)} m`
      : `${(step.distance/1000).toFixed(1)} km`;
    const instrText = step.name
      ? (manType === 'arrive' ? `Arrive at <strong>${step.name || toLabel}</strong>` : `${step.maneuver?.modifier ? capFirst(step.maneuver.modifier) + ' onto ' : ''}${step.name ? `<strong>${step.name}</strong>` : 'Continue'}`)
      : (manType === 'arrive' ? `<strong>You have arrived</strong>` : capFirst(manType.replace(/-/g,' ')));

    html += `
      <div class="nav-step ${i === 0 ? 'nav-step-active' : ''}" id="step-${i}" onclick="highlightStep(${i})">
        <div class="nav-step-icon">${icon}</div>
        <div class="nav-step-body">
          <div class="nav-step-instr">${instrText}</div>
          <div class="nav-step-dist">${dist}</div>
        </div>
      </div>`;
  });

  html += `</div>`; // end nav-steps
  document.getElementById('walkInstructions').innerHTML = html;
}

function renderWalkFallback(distKm, durMin) {
  document.getElementById('walkInstructions').innerHTML = `
    <div class="nav-summary">
      <div class="nav-summary-row">
        <div class="nav-time">${fmtMin(durMin)}</div>
        <div class="nav-dist">${fmtDist(distKm)}</div>
      </div>
      <div class="nav-mode">🚶 Approximate walking route</div>
    </div>
    <div style="padding:16px;font-size:13.5px;line-height:1.7;color:#4a5568;">
      <p>🗺️ Head straight toward the <strong>🏁 destination marker</strong> on the map.</p>
      <p style="margin-top:10px">Press <strong>▶ Simulate</strong> to see a walking animation.</p>
      <p style="margin-top:10px;color:#64748b;font-size:12px;">Tip: Enable GPS for turn-by-turn guidance.</p>
    </div>`;
}

/* ============== Animate step highlighting when walking ============== */
function highlightStep(i) {
  document.querySelectorAll('.nav-step').forEach(el => el.classList.remove('nav-step-active'));
  const el = document.getElementById(`step-${i}`);
  if (el) { el.classList.add('nav-step-active'); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  currentStepIndex = i;
  // Pan map to step location
  if (walkSteps[i] && walkSteps[i].maneuver?.location) {
    const loc = walkSteps[i].maneuver.location; // [lon, lat]
    walkMapInst.panTo([loc[1], loc[0]]);
  }
}

window.highlightStep = highlightStep;

function animatePathDraw(path) {
  if (!path.length) return;
  let drawn = [];
  let i = 0;
  const tempLine = L.polyline([], { color: '#10b981', weight: 6 }).addTo(walkMapInst);
  const timer = setInterval(() => {
    if (i >= path.length) { clearInterval(timer); return; }
    drawn.push(path[i++]);
    tempLine.setLatLngs(drawn);
  }, 8);
}

/* ======= SIMULATION ======= */
window.startSimulation = function() {
  if (!currentPath || currentPath.length < 2) return;
  if (animInterval) clearInterval(animInterval);
  if (movingDot) walkMapInst.removeLayer(movingDot);
  currentStepIndex = 0;

  movingDot = L.marker(currentPath[0], { icon: makeIcon('🚶‍♂️') }).addTo(walkMapInst);
  walkMapInst.panTo(currentPath[0]);

  // Precompute cumulative distances for step detection
  const stepCoords = walkSteps.map(s => s.maneuver?.location ? [s.maneuver.location[1], s.maneuver.location[0]] : null).filter(Boolean);

  let progress = 0;
  const totalPts = currentPath.length;
  const simBtn = document.getElementById('simBtn');
  if (simBtn) { simBtn.textContent = '■ Stop'; simBtn.onclick = stopSimulation; }

  animInterval = setInterval(() => {
    progress += 0.5 / totalPts;
    if (progress >= 1) {
      clearInterval(animInterval);
      movingDot.setLatLng(currentPath[totalPts-1]);
      if (simBtn) { simBtn.textContent = '▶ Simulate'; simBtn.onclick = startSimulation; }
      highlightStep(walkSteps.length - 1);
      return;
    }
    const idx  = Math.floor(progress * (totalPts - 1));
    const frac = (progress * (totalPts - 1)) % 1;
    const a    = currentPath[idx];
    const b    = currentPath[Math.min(idx+1, totalPts-1)];
    const pos  = [a[0] + frac*(b[0]-a[0]), a[1] + frac*(b[1]-a[1])];
    movingDot.setLatLng(pos);
    walkMapInst.panTo(pos, { animate: true, duration: 0.3 });

    // Highlight nearest step
    if (stepCoords.length) {
      let nearestStepIdx = 0, minD = Infinity;
      stepCoords.forEach((sc, si) => {
        const d = Math.abs(pos[0]-sc[0]) + Math.abs(pos[1]-sc[1]);
        if (d < minD) { minD = d; nearestStepIdx = si; }
      });
      if (nearestStepIdx !== currentStepIndex) highlightStep(nearestStepIdx);
    }
  }, 40);
};

function stopSimulation() {
  if (animInterval) clearInterval(animInterval);
  const simBtn = document.getElementById('simBtn');
  if (simBtn) { simBtn.textContent = '▶ Simulate'; simBtn.onclick = startSimulation; }
}

window.closeWalkMap = function() {
  walkMapContainer.style.display = 'none';
  if (animInterval) clearInterval(animInterval);
  const simBtn = document.getElementById('simBtn');
  if (simBtn) { simBtn.textContent = '▶ Simulate'; simBtn.onclick = startSimulation; }
};

function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }