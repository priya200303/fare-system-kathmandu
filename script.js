/* =====================================================================
   FindMyVehicle KTM – script.js
   Features:
   - Autocomplete: bus stops first, then Nominatim places (Kathmandu)
   - Route search: direct + 1-transfer routes, sorted by stops
   - Fare calculation (Nepal govt rates)
   - Walk navigation: start→stop and stop→destination
   - Walking simulation on map
   - Route polyline on main map
   ===================================================================== */

const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjY5YzJiOGFhYmQ3ZDA3MTk4MzM5MTYyZTMwMGNkMzdjNGYyZDFkZGY4NGVkOTFhNTA2ZmQzZDdkIiwiaCI6Im11cm11cjY0In0=";

/* ======= MAP INIT ======= */
const map = L.map('map').setView([27.7100, 85.3240], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

/* ======= DOM ======= */
const startInput     = document.getElementById('startInput');
const destInput      = document.getElementById('destInput');
const suggestionsStart = document.getElementById('suggestionsStart');
const suggestionsDest  = document.getElementById('suggestionsDest');
const searchBtn      = document.getElementById('searchBtn');
const resultsDiv     = document.getElementById('results');
const detailPanel    = document.getElementById('detailPanel');
const detailContent  = document.getElementById('detailContent');

/* ======= STATE ======= */
let startCoords = null, destCoords = null;
let startStop   = null, destStop   = null;
let routesFound = [];
let startMarker = null, destMarker = null;
let routeLayer  = null;
let currentRouteIndex = 0;

/* ======= WALK MAP SETUP ======= */
const walkMapContainer = document.createElement('div');
walkMapContainer.id = 'walkMapContainer';
walkMapContainer.innerHTML = `
  <div class="wm-header">
    <button onclick="closeWalkMap()" class="wm-back">← Back</button>
    <strong id="wmTitle">🚶 Walking Navigation</strong>
    <button onclick="startSimulation()" class="wm-sim">▶ Simulate</button>
  </div>
  <div class="wm-body">
    <div id="walkInstructions"></div>
    <div id="walkMap"></div>
  </div>`;
document.body.appendChild(walkMapContainer);

let walkMapInst = null, fullPathLayer = null, movingDot = null;
let animInterval = null, currentPath = [], currentWalkType = null;

/* ======= HELPERS ======= */
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

function calcBusKm(stopList) {
  let total = 0;
  for (let i = 1; i < stopList.length; i++) {
    const a = stops.find(s => s.id === stopList[i-1]);
    const b = stops.find(s => s.id === stopList[i]);
    if (a && b) total += haversine(a.lat, a.lon, b.lat, b.lon);
  }
  return total;
}

function getFare(km) {
  // Nepal Yatayat govt fare structure (NPR)
  if (km <= 5)  return 20;
  if (km <= 10) return 25;
  if (km <= 15) return 30;
  if (km <= 20) return 35;
  if (km <= 25) return 40;
  return 50;
}

function walkMinutes(km) { return Math.max(1, Math.round(km * 12)); }

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

      // 1. Bus stops (local, instant)
      const qLow = q.toLowerCase();
      const stopMatches = stops.filter(s => {
        const text = (s.name + ' ' + s.id).toLowerCase();
        return text.includes(qLow);
      });
      // Deduplicate by name
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

      // 2. Nominatim places (Kathmandu valley)
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
      } catch(e) { /* nominatim unavailable */ }

      if (!html) html = `<div class="suggestion-item" style="color:#888;padding:12px">No results found</div>`;
      sugBox.innerHTML = html;
      sugBox.style.display = 'block';

      // Bind click events
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
searchBtn.onclick = () => {
  if (!startCoords) return alert('Please enter a start location');
  if (!destCoords)  return alert('Please enter a destination');

  const { stop: ss, dist: sdist } = nearestStop(startCoords[0], startCoords[1]);
  const { stop: ds, dist: ddist } = nearestStop(destCoords[0], destCoords[1]);

  if (!ss || !ds) return alert('No nearby bus stops found. Try a different location.');

  startStop = ss;
  destStop  = ds;

  routesFound = findRoutes(ss, ds, sdist, ddist);

  renderResults();
};

/* ======= ROUTE FINDER ======= */
function findRoutes(ss, ds, sdist, ddist) {
  const found = [];
  const seenKeys = new Set();

  // --- DIRECT ROUTES ---
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

    const busKm = calcBusKm(sl);
    found.push({
      type: 'direct',
      company: r.company,
      vehicle: r.vehicle || 'bus',
      segments: [{ stopList: sl, km: busKm, fare: getFare(busKm) }],
      walkStart: sdist, walkEnd: ddist,
      startStop: ss, destStop: ds,
      totalFare: getFare(busKm),
      totalStops: Math.abs(b - a)
    });
  });

  // Sort direct routes by fewest stops, then fewest km
  found.sort((a, b) => a.totalStops - b.totalStops || a.segments[0].km - b.segments[0].km);

  // If ANY direct route exists, return only direct routes (max 3) — no transfers shown
  if (found.length > 0) return found.slice(0, 3);

  // --- TRANSFER ROUTES (only reached if zero direct routes) ---
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

        let seg1 = si < ti
          ? r1.stops.slice(si, ti + 1)
          : [...r1.stops.slice(ti, si + 1)].reverse();
        let seg2 = t2 < di
          ? r2.stops.slice(t2, di + 1)
          : [...r2.stops.slice(di, t2 + 1)].reverse();

        const key = seg1.join('-') + '||' + seg2.join('-');
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        const km1 = calcBusKm(seg1), km2 = calcBusKm(seg2);
        const f1 = getFare(km1), f2 = getFare(km2);
        const totalKm = km1 + km2;
        const totalStops = seg1.length + seg2.length - 2;

        transferFound.push({
          type: 'transfer',
          company: r1.company + ' → ' + r2.company,
          vehicle: 'bus',
          transferStop: transferId,
          segments: [
            { stopList: seg1, km: km1, fare: f1, company: r1.company },
            { stopList: seg2, km: km2, fare: f2, company: r2.company }
          ],
          walkStart: sdist, walkEnd: ddist,
          startStop: ss, destStop: ds,
          totalFare: f1 + f2,
          totalStops,
          totalKm
        });
      });
    }
  });

  // Best transfer = fewest total stops, then fewest km, then cheapest fare
  transferFound.sort((a, b) =>
    a.totalStops - b.totalStops ||
    a.totalKm - b.totalKm ||
    a.totalFare - b.totalFare
  );
  return transferFound.slice(0, 3);
}

/* ======= RENDER RESULTS ======= */
function renderResults() {
  if (!routesFound.length) {
    resultsDiv.innerHTML = `<div class="no-routes">😕 No routes found between these locations.<br>Try selecting nearby bus stops.</div>`;
    return;
  }

  const walkStartMin = walkMinutes(routesFound[0].walkStart);
  const walkEndMin   = walkMinutes(routesFound[0].walkEnd);

  let html = `<div class="result-header">
    <strong>Found ${routesFound.length} route${routesFound.length>1?'s':''}</strong>
    <span>🚩 ${startStop.name} → 🏁 ${destStop.name}</span>
  </div>`;

  if (routesFound[0].walkStart > 0.05) {
    html += `<div class="walk-notice">🚶 Walk <strong>${(routesFound[0].walkStart*1000).toFixed(0)}m</strong> (~${walkStartMin} min) to <strong>${startStop.name}</strong></div>`;
  }

  routesFound.forEach((route, i) => {
    const badge = route.type === 'direct'
      ? `<span class="badge direct">⭐ Direct</span>`
      : `<span class="badge transfer">🔄 1 Transfer</span>`;

    const stopCount = route.totalStops;
    const totalKm   = route.segments.reduce((s, seg) => s + seg.km, 0);
    const walkTotalMin = walkStartMin + walkEndMin;

    html += `<div class="routeCard" onclick="openDetail(${i})">
      <div class="route-top">
        ${badge}
        <span class="route-company">${route.company}</span>
      </div>
      <div class="route-meta">
        <span>🚌 ${stopCount} stops</span>
        <span>📏 ${totalKm.toFixed(1)} km</span>
        ${walkTotalMin > 0 ? `<span>🚶 ~${walkTotalMin} min walk</span>` : ''}
      </div>
      <div class="route-fare">
        <span class="fare-amount">NPR ${route.totalFare}</span>
        <span class="fare-walk">+ 🚶 ${(route.walkStart + route.walkEnd).toFixed(2)} km walk</span>
      </div>
      <div class="route-stops-preview">${route.segments[0].stopList.slice(0,3).map(getStopName).join(' → ')}${route.segments[0].stopList.length > 3 ? ' → ...' : ''}</div>
    </div>`;
  });

  if (routesFound[0].walkEnd > 0.05) {
    html += `<div class="walk-notice">🚶 Walk <strong>${(routesFound[0].walkEnd*1000).toFixed(0)}m</strong> (~${walkEndMin} min) from <strong>${destStop.name}</strong> to your destination</div>`;
  }

  resultsDiv.innerHTML = html;

  // Auto-draw first route
  drawRouteLine(routesFound[0]);
}

/* ======= OPEN DETAIL ======= */
function openDetail(idx) {
  currentRouteIndex = idx;
  const route = routesFound[idx];

  let html = `<div class="detail-fare">Total Fare: <strong>NPR ${route.totalFare}</strong></div>`;

  // Walk to start stop
  const wsKm = route.walkStart;
  if (wsKm > 0.02) {
    html += `<div class="timeline-item" onclick="showWalkMap('start')">
      <div class="dot walk"></div>
      <div class="content">
        <strong>🚶 Walk to ${route.startStop.name}</strong><br>
        <small>${(wsKm*1000).toFixed(0)}m · ~${walkMinutes(wsKm)} min · Tap for map & navigation</small>
      </div>
    </div>`;
  } else {
    html += `<div class="timeline-item">
      <div class="dot walk"></div>
      <div class="content"><strong>📍 You are at / near ${route.startStop.name}</strong></div>
    </div>`;
  }

  // Bus segments
  route.segments.forEach((seg, i) => {
    const company = seg.company || route.company;
    const names = seg.stopList.map(getStopName);
    html += `<div class="timeline-item">
      <div class="dot ride"></div>
      <div class="content">
        <strong>🚌 Board bus at ${names[0]}</strong><br>
        <small>${company}</small><br>
        <div class="stop-list">${names.join(' <span class="arrow">›</span> ')}</div>
        <div class="seg-meta">
          <span>🛑 ${seg.stopList.length - 1} stops</span>
          <span>📏 ${seg.km.toFixed(1)} km</span>
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

  // Walk to destination
  const wdKm = route.walkEnd;
  if (wdKm > 0.02) {
    html += `<div class="timeline-item" onclick="showWalkMap('end')">
      <div class="dot walk"></div>
      <div class="content">
        <strong>🚶 Walk to your destination</strong><br>
        <small>${(wdKm*1000).toFixed(0)}m · ~${walkMinutes(wdKm)} min · Tap for map & navigation</small>
      </div>
    </div>`;
  } else {
    html += `<div class="timeline-item">
      <div class="dot walk"></div>
      <div class="content"><strong>🏁 You have arrived at your destination!</strong></div>
    </div>`;
  }

  html += `<div style="margin-top:16px;padding:12px;background:#fff3cd;border-radius:10px;font-size:13px;">
    ⏰ Buses run approx every <strong>15-20 minutes</strong><br>
    💡 Fare may vary slightly by operator
  </div>`;

  detailContent.innerHTML = html;
  detailPanel.style.display = 'block';
  drawRouteLine(route);
}

window.openDetail = openDetail;

/* ======= CLOSE DETAIL ======= */
window.closeDetail = function() {
  detailPanel.style.display = 'none';
};

/* ======= DRAW ROUTE ON MAP ======= */
async function drawRouteLine(route) {
  if (routeLayer) map.removeLayer(routeLayer);

  const coords = [];
  // Add user start if available
  if (startCoords) coords.push([startCoords[1], startCoords[0]]);

  route.segments.forEach(seg => {
    seg.stopList.forEach(id => {
      const s = stops.find(x => x.id === id);
      if (s && s.lat && s.lon) coords.push([s.lon, s.lat]);
    });
  });

  // Add user dest if available
  if (destCoords) coords.push([destCoords[1], destCoords[0]]);

  if (coords.length < 2) return;

  // Try ORS routing, fallback to straight line
  try {
    // Use up to 50 waypoints (ORS limit)
    const waypoints = coords.length > 50
      ? [coords[0], ...coords.slice(1, 49), coords[coords.length-1]]
      : coords;

    const res = await fetch('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
      method: 'POST',
      headers: { Authorization: ORS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: waypoints })
    });
    if (!res.ok) throw new Error('ORS error');
    const data = await res.json();
    const path = data.features[0].geometry.coordinates.map(c => [c[1], c[0]]);
    routeLayer = L.polyline(path, { color: '#2c7be5', weight: 5, opacity: 0.85 }).addTo(map);
  } catch {
    const path = coords.map(c => [c[1], c[0]]);
    routeLayer = L.polyline(path, { color: '#2c7be5', weight: 5, dashArray: '10,6', opacity: 0.8 }).addTo(map);
  }

  // Add stop markers on route
  route.segments.forEach(seg => {
    [seg.stopList[0], seg.stopList[seg.stopList.length-1]].forEach(id => {
      const s = stops.find(x => x.id === id);
      if (s) L.circleMarker([s.lat, s.lon], { radius: 6, color: '#2c7be5', fillColor: '#fff', fillOpacity: 1, weight: 2 })
        .addTo(map).bindPopup(`🚌 ${s.name}`);
    });
  });

  map.fitBounds(routeLayer.getBounds(), { padding: [30, 30] });
}

/* ======= WALK MAP ======= */
window.showWalkMap = function(type) {
  currentWalkType = type;
  const route = routesFound[currentRouteIndex];

  let fromCoords, toCoords, title;
  if (type === 'start') {
    fromCoords = startCoords;
    toCoords   = [route.startStop.lat, route.startStop.lon];
    title      = `🚶 Walk to ${route.startStop.name}`;
  } else {
    fromCoords = [route.destStop.lat, route.destStop.lon];
    toCoords   = destCoords;
    title      = `🚶 Walk to your destination`;
  }

  const km = haversine(fromCoords[0], fromCoords[1], toCoords[0], toCoords[1]);
  document.getElementById('wmTitle').textContent = title;
  walkMapContainer.style.display = 'flex';

  // Init walk map
  setTimeout(() => {
    if (!walkMapInst) {
      walkMapInst = L.map('walkMap').setView(fromCoords, 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(walkMapInst);
    } else {
      walkMapInst.invalidateSize();
    }

    if (fullPathLayer) walkMapInst.removeLayer(fullPathLayer);
    if (movingDot) walkMapInst.removeLayer(movingDot);
    if (animInterval) clearInterval(animInterval);

    // Straight-line path (always works)
    currentPath = [fromCoords, toCoords];

    // Try ORS walking route
    (async () => {
      try {
        const res = await fetch('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
          method: 'POST',
          headers: { Authorization: ORS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ coordinates: [[fromCoords[1], fromCoords[0]], [toCoords[1], toCoords[0]]] })
        });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const steps = data.features[0].properties.segments[0].steps;
        currentPath = data.features[0].geometry.coordinates.map(c => [c[1], c[0]]);
        fullPathLayer = L.polyline(currentPath, { color: '#10b981', weight: 5 }).addTo(walkMapInst);
        walkMapInst.fitBounds(fullPathLayer.getBounds(), { padding: [30, 30] });

        // Generate turn-by-turn
        let instrHtml = `<div class="walk-info-box">
          <div class="walk-stat">📏 ${(km*1000).toFixed(0)} m</div>
          <div class="walk-stat">⏱ ~${walkMinutes(km)} min</div>
        </div><h4>Turn-by-turn</h4>`;
        steps.forEach((step, i) => {
          const icons = { 0:'⬆️', 1:'↗️', 2:'➡️', 3:'↘️', 4:'⬇️', 5:'↙️', 6:'⬅️', 7:'↖️', 10:'🏁', 11:'🚩' };
          instrHtml += `<div class="turn-step">
            <span class="turn-num">${i+1}</span>
            <span>${icons[step.type] || '•'} ${step.instruction}</span>
            <small>${step.distance < 1000 ? step.distance.toFixed(0)+'m' : (step.distance/1000).toFixed(1)+'km'}</small>
          </div>`;
        });
        document.getElementById('walkInstructions').innerHTML = instrHtml;
      } catch {
        // Fallback straight line
        fullPathLayer = L.polyline(currentPath, { color: '#10b981', weight: 5, dashArray: '8,6' }).addTo(walkMapInst);
        walkMapInst.fitBounds(fullPathLayer.getBounds(), { padding: [30, 30] });
        document.getElementById('walkInstructions').innerHTML = `
          <div class="walk-info-box">
            <div class="walk-stat">📏 ~${(km*1000).toFixed(0)} m</div>
            <div class="walk-stat">⏱ ~${walkMinutes(km)} min</div>
          </div>
          <p>🗺️ Walk straight toward the destination marker on the map.</p>
          <p>Press <strong>▶ Simulate</strong> to see a walking animation.</p>`;
      }
    })();

    // Add markers
    L.marker(fromCoords, { icon: makeIcon('🚩') }).addTo(walkMapInst).bindPopup('Start walking from here');
    L.marker(toCoords,   { icon: makeIcon('🏁') }).addTo(walkMapInst).bindPopup(type === 'start' ? `Bus Stop: ${route.startStop.name}` : 'Your destination');
  }, 100);
};

/* ======= SIMULATION ======= */
window.startSimulation = function() {
  if (!currentPath || currentPath.length < 2) return;
  if (animInterval) clearInterval(animInterval);
  if (movingDot) walkMapInst.removeLayer(movingDot);

  movingDot = L.marker(currentPath[0], { icon: makeIcon('🚶‍♂️') }).addTo(walkMapInst);
  let progress = 0;
  const totalPts = currentPath.length;
  animInterval = setInterval(() => {
    progress += 0.4 / totalPts;
    if (progress >= 1) { clearInterval(animInterval); movingDot.setLatLng(currentPath[totalPts-1]); return; }
    const idx = Math.floor(progress * (totalPts - 1));
    const frac = (progress * (totalPts - 1)) % 1;
    const a = currentPath[idx];
    const b = currentPath[Math.min(idx+1, totalPts-1)];
    movingDot.setLatLng([a[0] + frac*(b[0]-a[0]), a[1] + frac*(b[1]-a[1])]);
  }, 40);
};

window.closeWalkMap = function() {
  walkMapContainer.style.display = 'none';
  if (animInterval) clearInterval(animInterval);
};