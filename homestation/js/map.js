const map = L.map("map").setView([52.1, 5.3], 7);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);
const markers = new Map();
const mapStatus = document.getElementById("mapStatus");

function stationPopup(station) {
    const popup = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = station.name;
    popup.appendChild(title);
    const lines = [
        `Temperatuur: ${station.temperature == null ? "Geen data" : station.temperature + " °C"}`,
        `Luchtvochtigheid: ${station.humidity == null ? "Geen data" : station.humidity + " %"}`,
        `Windsnelheid: ${station.wind_speed == null ? "Geen data" : station.wind_speed + " m/s"}`,
        `Laatste update: ${station.updated_at ? new Date(station.updated_at).toLocaleString("nl-NL") : "Nog geen meting"}`
    ];
    for (const text of lines) {
        const line = document.createElement("div");
        line.textContent = text;
        popup.appendChild(line);
    }
    return popup;
}
async function loadStations() {
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
        setTimeout(loadStations, 15000);
    }
}
loadStations();
