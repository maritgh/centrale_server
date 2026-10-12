const map = L.map("map").setView([52.1, 5.3], 7);

L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        attribution: "&copy; OpenStreetMap contributors"
    }
).addTo(map);

async function loadStations() {
    try {
        const response = await fetch("/api/stations");

        if (!response.ok) {
            throw new Error("Kon stations niet ophalen");
        }

        const stations = await response.json();

        stations.forEach(station => {
            if (
                station.latitude === null ||
                station.longitude === null
            ) {
                return;
            }

            const marker = L.marker([
                station.latitude,
                station.longitude
            ]).addTo(map);

            const temperature =
                station.temperature ?? "Geen data";

            const humidity =
                station.humidity ?? "Geen data";

            const windSpeed =
                station.wind_speed ?? "Geen data";

            let updated = "Nog geen meting";

            if (station.updated_at) {
                updated = new Date(
                    station.updated_at
                ).toLocaleString("nl-NL");
            }

            marker.bindPopup(`
                <strong>${station.name}</strong>
                <br><br>

                Temperature: ${temperature} °C
                <br>

                Humidity: ${humidity} %
                <br>

                Windspeed: ${windSpeed} m/s
                <br><br>

                <small>
                    Laatste update: ${updated}
                </small>
            `);
        });

    } catch (error) {
        console.error(error);
    }
}

loadStations();
