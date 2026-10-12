require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();

app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

function createStationId(name) {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  return base || "station";
}

// Simpele controle of de backend draait
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
  });
});

app.post("/api/register", async (req, res) => {
  const {
    name,
    latitude,
    longitude,
    classCode
  } = req.body;

  if (!name || latitude === undefined || longitude === undefined || !classCode) {
    return res.status(400).json({
      error: "name, latitude, longitude en classCode zijn verplicht"
    });
  }

  if (classCode !== process.env.CLASS_CODE) {
    return res.status(403).json({
      error: "Ongeldige klascode"
    });
  }

  const lat = Number(latitude);
  const lon = Number(longitude);

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return res.status(400).json({
      error: "Latitude moet tussen -90 en 90 liggen"
    });
  }

  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return res.status(400).json({
      error: "Longitude moet tussen -180 en 180 liggen"
    });
  }

  try {
    let stationId = createStationId(name);

    // Als de ID al bestaat, voegen we automatisch iets toe.
    const existing = await pool.query(
      "SELECT id FROM stations WHERE id = $1",
      [stationId]
    );

    if (existing.rowCount > 0) {
      stationId += "-" + crypto.randomBytes(2).toString("hex");
    }

    const apiKey = crypto.randomBytes(32).toString("hex");

    await pool.query(
      `
      INSERT INTO stations (
        id,
        name,
        latitude,
        longitude,
        api_key
      )
      VALUES ($1, $2, $3, $4, $5)
      `,
      [
        stationId,
        name.trim(),
        lat,
        lon,
        apiKey
      ]
    );

    res.status(201).json({
      success: true,
      stationId,
      apiKey,
      name: name.trim(),
      latitude: lat,
      longitude: lon
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Station kon niet worden aangemaakt"
    });
  }
});

// Alle stations + hun laatste waarden ophalen
app.get("/api/stations", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id,
        s.name,
        s.latitude,
        s.longitude,
        c.temperature,
        c.humidity,
        c.wind_speed,
        c.extra,
        c.updated_at
      FROM stations s
      LEFT JOIN current_readings c
        ON c.station_id = s.id
      ORDER BY s.name;
    `);

    res.json(result.rows);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

// Actuele waardes van één station bijwerken
app.put("/api/stations/:id/current", async (req, res) => {
  const stationId = req.params.id;
  const apiKey = req.header("x-api-key");

  const {
    temperature,
    humidity,
    windSpeed,
    extra = null,
  } = req.body;

  if (!apiKey) {
    return res.status(401).json({
      error: "API key ontbreekt",
    });
  }

  if (
    temperature === undefined ||
    humidity === undefined ||
    windSpeed === undefined
  ) {
    return res.status(400).json({
      error: "temperature, humidity en windSpeed zijn verplicht",
    });
  }

  try {
    // Controleren of station bestaat en API-key klopt
    const stationResult = await pool.query(
      `
      SELECT id
      FROM stations
      WHERE id = $1
        AND api_key = $2
      `,
      [stationId, apiKey]
    );

    if (stationResult.rowCount === 0) {
      return res.status(401).json({
        error: "Ongeldig station of API key",
      });
    }

    // UPSERT van de actuele meting
    const result = await pool.query(
      `
      INSERT INTO current_readings (
        station_id,
        temperature,
        humidity,
        wind_speed,
        extra,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())

      ON CONFLICT (station_id)

      DO UPDATE SET
        temperature = EXCLUDED.temperature,
        humidity = EXCLUDED.humidity,
        wind_speed = EXCLUDED.wind_speed,
        extra = EXCLUDED.extra,
        updated_at = NOW()

      RETURNING *;
      `,
      [
        stationId,
        temperature,
        humidity,
        windSpeed,
        extra,
      ]
    );

    res.json({
      success: true,
      reading: result.rows[0],
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Database error",
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Home Station API draait lokaal op poort ${PORT}`);
});

 