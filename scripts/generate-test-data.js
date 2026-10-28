
require("dotenv").config({ quiet: true });

const { Pool } = require("pg");
const crypto = require("crypto");

// Instellingen voor de testgegevens
const HOURS = 30;
const INTERVAL_MINUTES = 1;

// Onze twee teststations
const stations = [
    {
        id: "test-station-001",
        name: "Test Home Station",
        latitude: 51.92,
        longitude: 4.48,
        temperature: 19,
        humidity: 65,
        wind: 2.5
    },
    {
        id: "test-station-002",
        name: "Test Home Station 2",
        latitude: 52.17,
        longitude: 4.71,
        temperature: 16,
        humidity: 75,
        wind: 4.5
    }
];

const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

async function generateTestData() {
    // Veiligheid: alleen uitvoeren op een lokale database
    if (!["127.0.0.1", "localhost", "::1"].includes(process.env.DB_HOST)) {
        throw new Error("Testgegevens mogen alleen lokaal worden aangemaakt.");
    }

    const end = Math.floor(Date.now() / 60000) * 60000;

    for (const station of stations) {

        // Maak het teststation aan als het nog niet bestaat
        await pool.query(`
      INSERT INTO stations (id, name, latitude, longitude, api_key)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO NOTHING
    `, [
            station.id,
            station.name,
            station.latitude,
            station.longitude,
            crypto.randomBytes(24).toString("hex")
        ]);

        const values = [];
        const placeholders = [];

        for (let minute = HOURS * 60; minute > 0; minute -= INTERVAL_MINUTES) {
            const date = new Date(end - minute * 60000);
            const hour = date.getHours() + date.getMinutes() / 60;
            const tick = Math.floor(date.getTime() / 60000);

            // Dag- en nachtritme: warmste moment rond 14:00
            const dayCycle = Math.cos(2 * Math.PI * (hour - 14) / 24);

            // Kleine natuurlijke schommelingen
            const temperature = station.temperature
                + 4 * dayCycle
                + 0.3 * Math.sin(tick * 0.13);

            const humidity = station.humidity
                - 10 * dayCycle
                + 2 * Math.sin(tick * 0.08);

            const wind = Math.max(0,
                station.wind
                + 1.2 * Math.sin(tick * 0.035)
                + 0.4 * Math.sin(tick * 0.11)
            );

            const index = values.length + 1;

            placeholders.push(
                `($${index}, $${index + 1}, $${index + 2}, $${index + 3}, $${index + 4})`
            );

            values.push(
                station.id,
                Number(temperature.toFixed(1)),
                Number(humidity.toFixed(1)),
                Number(wind.toFixed(1)),
                date
            );
        }

        const result = await pool.query(`
      INSERT INTO readings_history (
        station_id,
        temperature,
        humidity,
        wind_speed,
        measured_at
      )
      VALUES ${placeholders.join(", ")}
      ON CONFLICT (station_id, measured_at) DO NOTHING
    `, values);

        console.log(
            `${station.name}: ${result.rowCount} nieuwe meetpunten toegevoegd`
        );
    }

    console.log("Testgegevens succesvol gegenereerd!");
}

generateTestData()
    .catch(error => {
        console.error("Fout:", error.message);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
