const map = L.map("map").setView([52.1, 5.3], 7);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);
// Bewaar bestaande markers per station-ID, zodat verversen geen dubbele markers maakt.
const markers = new Map();
const mapStatus = document.getElementById("mapStatus");

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
        for (const station of stations) {
            if (station.latitude == null || station.longitude == null) continue;
            const lat = Number(station.latitude);
            const lon = Number(station.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
            visible.add(station.id);
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
        mapStatus.textContent = `${visible.size} station(s). Laatste controle: ${new Date().toLocaleTimeString("nl-NL")}. Vernieuwt elke 15 seconden.`;
        mapStatus.classList.remove("error");
    } catch (error) {
        mapStatus.textContent = "Stations ophalen mislukt. Opnieuw proberen over 15 seconden.";
        mapStatus.classList.add("error");
        console.error(error);
    } finally {
        clearTimeout(timeout);
        // Plan pas na afloop opnieuw, zodat trage verzoeken elkaar niet overlappen.
        setTimeout(loadStations, 15000);
    }
}
loadStations();
