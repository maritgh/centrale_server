const map = L.map("map").setView([52.1, 5.3], 7);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);
// Bewaar bestaande markers per station-ID, zodat verversen geen dubbele markers maakt.
const markers = new Map();
const mapStatus = document.getElementById("mapStatus");
const stationList = document.getElementById("stationList");
const stationCards = new Map();

function displayValue(value, unit) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    return Number(value).toLocaleString("nl-NL", { maximumFractionDigits: 1 }) + " " + unit;
}

// Werk bestaande kaarten bij: verversen behoudt de toetsenbordfocus op de kaartknoppen.
function updateStationOverview(stations) {
    const count = document.getElementById("stationCount");
    const reporting = document.getElementById("reportingCount");
    if (count) count.textContent = String(stations.length);
    if (reporting) reporting.textContent = String(stations.filter(station =>
        [station.temperature, station.humidity, station.wind_speed, ...(station.custom_metrics || []).map(metric => metric.value)]
            .some(value => value != null)
    ).length);
    if (!stationList) return;
    stationList.querySelector(".empty-state")?.remove();
    const visible = new Set(stations.map(station => station.id));
    for (const [id, card] of stationCards) {
        if (!visible.has(id)) { card.element.remove(); stationCards.delete(id); }
    }
    for (const station of stations) {
        let card = stationCards.get(station.id);
        if (!card) {
            const element = document.createElement("article");
            element.className = "station-card";
            const title = document.createElement("h3");
            const updated = document.createElement("p");
            const values = document.createElement("dl");
            values.className = "station-values";
            const readings = [];
            for (const label of ["Temperatuur", "Vochtigheid", "Wind"]) {
                const group = document.createElement("div");
                const term = document.createElement("dt");
                term.textContent = label;
                const value = document.createElement("dd");
                group.appendChild(term);
                group.appendChild(value);
                values.appendChild(group);
                readings.push(value);
            }
            const button = document.createElement("button");
            button.type = "button";
            button.className = "text-link";
            button.textContent = "Bekijk op de kaart ↗";
            button.addEventListener("click", () => {
                const marker = markers.get(station.id);
                if (!marker) return;
                map.setView(marker.getLatLng(), 11);
                marker.openPopup();
                document.getElementById("map").scrollIntoView({ block: "center" });
            });
            for (const node of [title, updated, values, button]) element.appendChild(node);
            stationList.appendChild(element);
            card = { element, title, updated, readings };
            stationCards.set(station.id, card);
        }
        card.title.textContent = station.name;
        const dates = [station.updated_at, ...(station.custom_metrics || []).map(metric => metric.updated_at)]
            .filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
        card.updated.textContent = dates.length
            ? "Laatste meting: " + new Date(Math.max(...dates)).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
            : "Klaar voor de eerste meting";
        card.readings[0].textContent = displayValue(station.temperature, "°C");
        card.readings[1].textContent = displayValue(station.humidity, "%");
        card.readings[2].textContent = displayValue(station.wind_speed, "m/s");
    }
    if (!stations.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "Nog geen stations op de kaart. Meld jouw station aan en doe als eerste mee!";
        stationList.appendChild(empty);
    }
}

// Gebruik DOM-elementen en textContent: stationsnamen worden zo nooit als HTML uitgevoerd.
function stationPopup(station) {
    const popup = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = station.name;
    popup.appendChild(title);
    // MQTT-waarden komen los binnen; een ontbrekende waarde wordt als "Geen data" getoond.
    const lines = [
        `Temperatuur: ${station.temperature == null ? "Geen data" : station.temperature + " °C"}`,
        `Luchtvochtigheid: ${station.humidity == null ? "Geen data" : station.humidity + " %"}`,
        `Windsnelheid: ${station.wind_speed == null ? "Geen data" : station.wind_speed + " m/s"}`,
        `Laatste update: ${station.updated_at ? new Date(station.updated_at).toLocaleString("nl-NL") : "Nog geen meting"}`
    ];
    // Eigen grootheden hebben dezelfde veilige tekstweergave als de vaste metingen.
    for (const metric of station.custom_metrics || []) {
        lines.push(`${metric.name}: ${metric.value == null ? "Geen data" : metric.value + " " + metric.unit}`);
    }
    for (const text of lines) {
        const line = document.createElement("div");
        line.textContent = text;
        popup.appendChild(line);
    }
    return popup;
}
async function loadStations() {
    // Breek een vastgelopen verzoek na tien seconden af.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch("/api/stations", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Kon stations niet ophalen");
        const stations = await response.json();
        const visible = new Set();
        const mappedStations = [];
        for (const station of stations) {
            if (station.latitude == null || station.longitude == null) continue;
            const lat = Number(station.latitude);
            const lon = Number(station.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
            visible.add(station.id);
            mappedStations.push(station);
            const popup = stationPopup(station);
            if (markers.has(station.id)) {
                markers.get(station.id).setLatLng([lat, lon]).setPopupContent(popup);
            } else {
                markers.set(station.id, L.marker([lat, lon]).addTo(map).bindPopup(popup));
            }
        }
        // Verwijder markers van stations die niet meer in het antwoord staan.
        for (const [id, marker] of markers) {
            if (!visible.has(id)) { marker.remove(); markers.delete(id); }
        }
        updateStationOverview(mappedStations);
        mapStatus.textContent = `${visible.size} station(s). Laatste controle: ${new Date().toLocaleTimeString("nl-NL")}. Vernieuwt elke 15 seconden.`;
        mapStatus.classList.remove("error");
    } catch (error) {
        mapStatus.textContent = "Stations ophalen mislukt. Opnieuw proberen over 15 seconden.";
        mapStatus.classList.add("error");
        const empty = stationList?.querySelector(".empty-state");
        if (empty) empty.textContent = "Stations ophalen lukt even niet. We proberen het automatisch opnieuw.";
        console.error(error);
    } finally {
        clearTimeout(timeout);
        // Plan pas na afloop opnieuw, zodat trage verzoeken elkaar niet overlappen.
        setTimeout(loadStations, 15000);
    }
}
loadStations();
