/* API */
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjY5YzJiOGFhYmQ3ZDA3MTk4MzM5MTYyZTMwMGNkMzdjNGYyZDFkZGY4NGVkOTFhNTA2ZmQzZDdkIiwiaCI6Im11cm11cjY0In0=";

/* ================= MAP ================= */
let map = L.map('map').setView([27.7172, 85.3240], 13);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

/* DOM ELEMENTS (fixed - this was the main bug) */
const startInput = document.getElementById('startInput');
const destInput = document.getElementById('destInput');
const suggestionsStart = document.getElementById('suggestionsStart');
const suggestionsDest = document.getElementById('suggestionsDest');
const searchBtn = document.getElementById('searchBtn');
const results = document.getElementById('results');
const detailPanel = document.getElementById('detailPanel');
const detailContent = document.getElementById('detailContent');

/* VARIABLES */
let startCoords = null, destCoords = null;
let startStop = null, destStop = null;
let routesFound = [];

let startMarker = null, destMarker = null;
let routeLayer = null;

/* WALK MAP */
const walkMapContainer = document.createElement("div");
walkMapContainer.id = "walkMapContainer";
walkMapContainer.style.cssText = `
    display:none; position:fixed; top:0; left:0; width:100%; height:100%; 
    background:white; z-index:10000; flex-direction:column;
`;
walkMapContainer.innerHTML = `
    <div style="padding:12px; background:#2c7be5; color:white; display:flex; justify-content:space-between; align-items:center;">
        <button onclick="closeWalkMap()" style="background:none; border:none; color:white; font-size:20px;">←</button>
        <strong>🚶 Walking Navigation</strong>
        <button onclick="startGoogleSimulation()" style="background:#4285f4; border:none; color:white; padding:8px 16px; border-radius:8px; font-weight:bold;">▶ Start Simulation</button>
    </div>
    <div style="flex:1; display:flex; overflow:hidden;">
        <div id="walkInstructions" style="width:340px; background:#f8f9fa; padding:15px; overflow:auto; border-right:1px solid #ddd;"></div>
        <div id="walkMap" style="flex:1;"></div>
    </div>
`;
document.body.appendChild(walkMapContainer);

let walkMapInstance = null;
let fullPathLayer = null;
let movingDot = null;
let animationInterval = null;
let currentPath = [];

/* ================= HELPERS ================= */
function getStopName(id) {
    const stop = stops.find(s => s.id === id);
    return stop ? (stop.name || stop.id) : id;
}

function distance(a, b, c, d) {
    const R = 6371;
    const dLat = (c - a) * Math.PI / 180;
    const dLon = (d - b) * Math.PI / 180;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * Math.PI / 180) * Math.cos(c * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function calcBusDistance(stopList) {
    let total = 0;
    for (let i = 1; i < stopList.length; i++) {
        const s1 = stops.find(s => s.id === stopList[i-1]);
        const s2 = stops.find(s => s.id === stopList[i]);
        if (s1 && s2 && s1.lat && s2.lat) {
            total += distance(s1.lat, s1.lon, s2.lat, s2.lon);
        }
    }
    return total;
}

function calculateFare(km) {
    if (km <= 5) return 20;
    if (km <= 10) return 25;
    if (km <= 15) return 30;
    if (km <= 20) return 35;
    return 40;
}

function nearestStop(lat, lon) {
    let min = 999, closest = null;
    stops.forEach(s => {
        if (!s.lat || !s.lon) return;
        let d = distance(lat, lon, s.lat, s.lon);
        if (d < min) { min = d; closest = s; }
    });
    return closest;
}

function walkTime(km) { return Math.round(km * 12); }

/* ORS Geocode for Kathmandu places (new feature) */
async function searchPlaces(query) {
    if (query.length < 3) return [];
    try {
        const res = await fetch(`https://api.openrouteservice.org/geocode/search?api_key=${ORS_API_KEY}&text=${encodeURIComponent(query)}&boundary.country=NP&size=6`);
        const data = await res.json();
        return data.features.map(f => ({
            name: f.properties.label,
            lat: f.geometry.coordinates[1],
            lon: f.geometry.coordinates[0],
        }));
    } catch(e) {
        return [];
    }
}

/* ================= AUTOCOMPLETE (now shows stops + real Kathmandu places) ================= */
function setupAutocomplete(input, suggestions, isStart) {
    let debounceTimer;
    input.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        const q = input.value.trim().toLowerCase();
        if (q.length < 2) {
            suggestions.style.display = "none";
            return;
        }

        debounceTimer = setTimeout(async () => {
            let html = "";

            // 1. Bus Stops
            const stopMatches = stops.filter(s => 
                (s.name + " " + s.id).toLowerCase().includes(q)
            ).slice(0, 8);

            if (stopMatches.length > 0) {
                html += `<div class="suggestion-title">🚌 Bus Stops</div>`;
                stopMatches.forEach(stop => {
                    const displayName = stop.name || stop.id;
                    html += `
                    <div class="suggestion-item" onclick="selectSuggestion(${stop.lat},${stop.lon},'${displayName.replace(/'/g, "\\'")}',${isStart})">
                        <div class="title">🚌 ${displayName}</div>
                        <div class="subtitle">Bus Stop</div>
                    </div>`;
                });
            }

            // 2. Real Places in Kathmandu (ORS Geocode)
            const places = await searchPlaces(q);
            if (places.length > 0) {
                html += `<div class="suggestion-title">📍 Places / Landmarks</div>`;
                places.forEach(place => {
                    html += `
                    <div class="suggestion-item" onclick="selectSuggestion(${place.lat},${place.lon},'${place.name.replace(/'/g, "\\'")}',${isStart})">
                        <div class="title">📍 ${place.name}</div>
                        <div class="subtitle">Area / Landmark</div>
                    </div>`;
                });
            }

            suggestions.innerHTML = html || `<div class="suggestion-item" style="padding:12px;color:#888;">No matching stops or places found</div>`;
            suggestions.style.display = "block";
        }, 250);
    });

    // Close suggestions when clicking outside
    document.addEventListener("click", (e) => {
        if (!input.contains(e.target) && !suggestions.contains(e.target)) {
            suggestions.style.display = "none";
        }
    });
}

setupAutocomplete(startInput, suggestionsStart, true);
setupAutocomplete(destInput, suggestionsDest, false);

/* SELECT LOCATION */
window.selectSuggestion = function(lat, lon, name, isStart) {
    const coords = [lat, lon];
    if (isStart) {
        startCoords = coords;
        startInput.value = name;
        if (startMarker) map.removeLayer(startMarker);
        startMarker = L.marker(coords, {icon: L.divIcon({className: 'moving-dot', html: '🚩', iconSize: [30,30]})}).addTo(map);
    } else {
        destCoords = coords;
        destInput.value = name;
        if (destMarker) map.removeLayer(destMarker);
        destMarker = L.marker(coords, {icon: L.divIcon({className: 'moving-dot', html: '🏁', iconSize: [30,30]})}).addTo(map);
    }
    map.setView(coords, 15);
    suggestionsStart.style.display = suggestionsDest.style.display = "none";
};

/* Current location */
document.getElementById("locBtn").onclick = () => {
    navigator.geolocation.getCurrentPosition(pos => {
        startCoords = [pos.coords.latitude, pos.coords.longitude];
        startInput.value = "📍 Current Location";
        if (startMarker) map.removeLayer(startMarker);
        startMarker = L.marker(startCoords, {icon: L.divIcon({className: 'moving-dot', html: '📍', iconSize: [30,30]})}).addTo(map);
        map.setView(startCoords, 15);
    }, () => alert("Could not get your location"));
};

/* ================= SEARCH LOGIC (fixed + exactly as you asked) ================= */
searchBtn.onclick = () => {
    if (!startCoords || !destCoords) return alert("Please select both start and destination");

    startStop = nearestStop(startCoords[0], startCoords[1]);
    destStop = nearestStop(destCoords[0], destCoords[1]);

    if (!startStop || !destStop) return alert("No nearby bus stops found");

    const walkStartDist = distance(startCoords[0], startCoords[1], startStop.lat, startStop.lon);
    const walkEndDist = distance(destCoords[0], destCoords[1], destStop.lat, destStop.lon);

    routesFound = [];
    const seen = new Set();

    // === 1. DIRECT ROUTES (max 3) ===
    routes.forEach(r => {
        let a = r.stops.indexOf(startStop.id);
        let b = r.stops.indexOf(destStop.id);
        if (a !== -1 && b !== -1 && a !== b) {
            const from = Math.min(a, b);
            const to = Math.max(a, b);
            let stopList = r.stops.slice(from, to + 1);
            if (a > b) stopList = stopList.reverse();

            const key = stopList.join('|');
            if (!seen.has(key)) {
                seen.add(key);
                routesFound.push({
                    type: "direct",
                    segments: [{ vehicle: "bus", stops: Math.abs(b - a), stopList }],
                    walkStartDist, walkEndDist, startStop, destStop
                });
            }
        }
    });

    if (routesFound.length > 0) {
        routesFound.sort((a, b) => a.segments[0].stops - b.segments[0].stops);
        routesFound = routesFound.slice(0, 3);   // ← exactly as you asked
    } 
    // === 2. TRANSFER ROUTES (max 5) ===
    else {
        routes.forEach(r1 => {
            let si = r1.stops.indexOf(startStop.id);
            if (si === -1) return;

            for (let i = 0; i < r1.stops.length; i++) {
                if (i === si) continue;
                let ts = r1.stops[i];

                routes.forEach(r2 => {
                    if (r1 === r2) return;
                    let t = r2.stops.indexOf(ts);
                    let d = r2.stops.indexOf(destStop.id);
                    if (t !== -1 && d !== -1 && t !== d) {
                        const key = `${r1.stops.join('|')}|${ts}|${r2.stops.join('|')}`;
                        if (!seen.has(key)) {
                            seen.add(key);

                            let seg1List = si < i ? r1.stops.slice(si, i + 1) : r1.stops.slice(i, si + 1).reverse();
                            let seg2List = t < d ? r2.stops.slice(t, d + 1) : r2.stops.slice(d, t + 1).reverse();

                            routesFound.push({
                                type: "transfer",
                                transfer: ts,
                                segments: [
                                    { vehicle: "bus", stops: Math.abs(i - si), stopList: seg1List },
                                    { vehicle: "bus", stops: Math.abs(d - t), stopList: seg2List }
                                ],
                                walkStartDist, walkEndDist, startStop, destStop
                            });
                        }
                    }
                });
            }
        });

        // Strong deduplication + limit 5
        const uniqueKeys = new Set();
        const unique = [];
        routesFound.forEach(route => {
            const seqKey = route.segments.map(seg => seg.stopList.join('|')).join('||');
            if (!uniqueKeys.has(seqKey)) {
                uniqueKeys.add(seqKey);
                unique.push(route);
            }
        });
        routesFound = unique.slice(0, 5);
    }

    // Build results UI
    let html = "";
    routesFound.forEach((route, i) => {
        let totalFare = 0;
        let totalBusStops = 0;

        route.segments.forEach(seg => {
            const segKm = calcBusDistance(seg.stopList);
            totalFare += calculateFare(segKm);
            totalBusStops += seg.stops;
        });

        const walkTotalKm = (route.walkStartDist + route.walkEndDist).toFixed(1);

        html += `
        <div class="routeCard" onclick="showDetail(${i}); drawRouteLine(routesFound[${i}])">
            ${route.type === "direct" ? "⭐ DIRECT ROUTE<br>" : "🔄 1 TRANSFER<br>"}
            🚌 Public Bus<br>
            🚶 Walk ${walkTotalKm} km<br>
            💰 NPR <strong>${totalFare}</strong>
            <small style="display:block; margin-top:6px; color:#555;">Every 15-20 min</small>
        </div>`;
    });

    results.innerHTML = html || "<p style='padding:20px;text-align:center;color:#666;'>No bus routes found between these locations.<br>Try different stops or places.</p>";
};

/* ================= DRAW BUS ROUTE ON MAP ================= */
async function drawRouteLine(route) {
    if (routeLayer) map.removeLayer(routeLayer);
    let coords = [];
    route.segments.forEach(seg => {
        seg.stopList.forEach(id => {
            let s = stops.find(x => x.id === id);
            if (s) coords.push([s.lon, s.lat]);
        });
    });

    if (coords.length < 2) return;

    try {
        const res = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
            method: "POST",
            headers: { Authorization: ORS_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ coordinates: coords })
        });
        const data = await res.json();
        const path = data.features[0].geometry.coordinates.map(c => [c[1], c[0]]);
        routeLayer = L.polyline(path, { color: "#2c7be5", weight: 7, opacity: 0.85 }).addTo(map);
        map.fitBounds(routeLayer.getBounds());
    } catch(e) {
        const path = coords.map(c => [c[1], c[0]]);
        routeLayer = L.polyline(path, { color: "#2c7be5", weight: 7, dashArray: "10,8" }).addTo(map);
        map.fitBounds(routeLayer.getBounds());
    }
}

/* ================= DETAIL PANEL (exactly as you asked) ================= */
function showDetail(index) {
    const route = routesFound[index];
    if (!route) return;

    let html = `
    <div class="timeline-item" onclick="showWalkOnFullMap('start')" style="cursor:pointer;">
        <div class="dot walk"></div>
        <div class="content">
            🚶 Walk to <strong>${getStopName(route.startStop.id)}</strong><br>
            <small>Tap for live walking map + simulation</small>
        </div>
    </div>`;

    let totalFare = 0;

    route.segments.forEach((seg, i) => {
        const stopNames = seg.stopList.map(id => getStopName(id));
        const segKm = calcBusDistance(seg.stopList);
        const segFare = calculateFare(segKm);
        totalFare += segFare;

        html += `
        <div class="timeline-item">
            <div class="dot ride"></div>
            <div class="content">
                🚌 Bus from <strong>${stopNames[0]}</strong> to <strong>${stopNames[stopNames.length-1]}</strong><br>
                <small>${seg.stops} stops • NPR ${segFare}</small><br>
                <small style="color:#555;">${stopNames.join(" → ")}</small>
            </div>
        </div>`;

        if (route.type === "transfer" && i === 0) {
            html += `<div class="timeline-item"><div class="dot transfer"></div><div class="content">🔁 Transfer at <strong>${getStopName(route.transfer)}</strong></div></div>`;
        }
    });

    html += `
    <div class="timeline-item" onclick="showWalkOnFullMap('end')" style="cursor:pointer;">
        <div class="dot walk"></div>
        <div class="content">
            🚶 Walk to final destination<br>
            <small>Tap for live walking map + simulation</small>
        </div>
    </div>`;

    html = `<p style="font-weight:bold; color:#2c7be5; margin:15px 0 10px 0; font-size:1.1em;">Total Fare: NPR ${totalFare}</p>` + html;

    detailContent.innerHTML = html;
    detailPanel.style.display = "block";
}

/* ================= WALKING SIMULATION ================= */
window.showWalkOnFullMap = async function(type) {
    walkMapContainer.style.display = "flex";

    let fromCoords, toCoords, titleText;
    if (type === "start") {
        fromCoords = startCoords;
        toCoords = [startStop.lat, startStop.lon];
        titleText = `Walking to ${getStopName(startStop.id)}`;
    } else {
        fromCoords = [destStop.lat, destStop.lon];
        toCoords = destCoords;
        titleText = `Walking to Destination`;
    }

    if (!walkMapInstance) {
        walkMapInstance = L.map("walkMap").setView(fromCoords, 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(walkMapInstance);
    }

    if (fullPathLayer) walkMapInstance.removeLayer(fullPathLayer);
    if (movingDot) walkMapInstance.removeLayer(movingDot);

    try {
        const res = await fetch("https://api.openrouteservice.org/v2/directions/foot-walking/geojson", {
            method: "POST",
            headers: { Authorization: ORS_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ coordinates: [[fromCoords[1], fromCoords[0]], [toCoords[1], toCoords[0]]] })
        });
        const data = await res.json();
        currentPath = data.features[0].geometry.coordinates.map(c => [c[1], c[0]]);

        fullPathLayer = L.polyline(currentPath, { color: "#10b981", weight: 6 }).addTo(walkMapInstance);
        walkMapInstance.fitBounds(fullPathLayer.getBounds());
    } catch (e) {
        currentPath = [fromCoords, toCoords];
        fullPathLayer = L.polyline(currentPath, { color: "#10b981", weight: 6 }).addTo(walkMapInstance);
    }

    document.getElementById("walkInstructions").innerHTML = `
        <h4>${titleText}</h4>
        <p><strong>Tap ▶ to start realistic walking simulation</strong></p>
        <small>Shows real Kathmandu streets</small>
    `;
};

window.startGoogleSimulation = function() {
    if (!currentPath || currentPath.length < 2) return alert("No path available");

    if (animationInterval) clearInterval(animationInterval);
    if (movingDot) walkMapInstance.removeLayer(movingDot);

    movingDot = L.marker(currentPath[0], {
        icon: L.divIcon({ className: 'moving-dot', html: '🚶‍♂️', iconSize: [30, 30] })
    }).addTo(walkMapInstance);

    let progress = 0;
    animationInterval = setInterval(() => {
        progress += 0.045;
        if (progress >= 1) {
            clearInterval(animationInterval);
            return;
        }
        const index = Math.floor(progress * (currentPath.length - 1));
        const fraction = (progress * (currentPath.length - 1)) % 1;
        const a = currentPath[index];
        const b = currentPath[Math.min(index + 1, currentPath.length - 1)];

        movingDot.setLatLng([
            a[0] + fraction * (b[0] - a[0]),
            a[1] + fraction * (b[1] - a[1])
        ]);
    }, 35);
};

function closeDetail() {
    detailPanel.style.display = "none";
}

window.closeWalkMap = function() {
    walkMapContainer.style.display = "none";
    if (animationInterval) clearInterval(animationInterval);
};