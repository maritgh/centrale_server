require("dotenv").config({ quiet: true });
const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const path = require("path");
const { startHistory } = require("./scripts/history");
const { registerGraphApi } = require("./scripts/graph-api");

function validNumber(value, min = -Infinity, max = Infinity) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function createStationId(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "station";
}
function createApp({ pool, classCode }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.get("/api/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "error", error: "Database niet bereikbaar" });
    }
  });
  app.post("/api/register", async (req, res, next) => {
    const { name, latitude, longitude, classCode: suppliedCode } = req.body || {};
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ error: "Naam moet tussen 1 en 120 tekens bevatten" });
    }
    if (!validNumber(latitude, -90, 90) || !validNumber(longitude, -180, 180)) {
      return res.status(400).json({ error: "Latitude en longitude moeten getallen zijn tussen -90/90 en -180/180" });
    }
    if (!classCode || suppliedCode !== classCode) {
      return res.status(403).json({ error: "Ongeldige klascode" });
    }
    try {
      const apiKey = crypto.randomBytes(32).toString("hex");
      const base = createStationId(name);
      // INSERT handles uniqueness atomically, even during simultaneous registrations.
      for (let attempt = 0; attempt < 5; attempt++) {
        const stationId = attempt === 0 ? base : `${base}-${crypto.randomBytes(6).toString("hex")}`;
        const result = await pool.query(
          `INSERT INTO stations (id, name, latitude, longitude, api_key)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING id`,
          [stationId, name.trim(), latitude, longitude, apiKey]
        );
        if (result.rowCount > 0) {
          return res.status(201).json({ success: true, stationId, apiKey, name: name.trim(), latitude, longitude });
        }
      }
      throw new Error("Could not generate a unique station ID");
    } catch (error) { next(error); }
  });
  app.get("/api/stations", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT s.id, s.name, s.latitude, s.longitude,
                c.temperature, c.humidity, c.wind_speed, c.extra, c.updated_at
         FROM stations s LEFT JOIN current_readings c ON c.station_id = s.id ORDER BY s.name`
      );
      res.json(result.rows);
    } catch (error) { next(error); }
  });
  app.put("/api/stations/:id/current", async (req, res, next) => {
    const apiKey = req.header("x-api-key");
    if (!apiKey) return res.status(401).json({ error: "API key ontbreekt" });
    const { temperature, humidity, windSpeed, extra = null } = req.body || {};
    if (!validNumber(temperature) || !validNumber(humidity, 0, 100) || !validNumber(windSpeed, 0)) {
      return res.status(400).json({ error: "Temperatuur moet een getal zijn, luchtvochtigheid 0–100 en windsnelheid minstens 0" });
    }
    try {
      const station = await pool.query("SELECT id FROM stations WHERE id = $1 AND api_key = $2", [req.params.id, apiKey]);
      if (station.rowCount === 0) return res.status(401).json({ error: "Ongeldig station of API key" });
      const result = await pool.query(
        `INSERT INTO current_readings (station_id, temperature, humidity, wind_speed, extra, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (station_id) DO UPDATE SET
           temperature = EXCLUDED.temperature, humidity = EXCLUDED.humidity,
           wind_speed = EXCLUDED.wind_speed, extra = EXCLUDED.extra, updated_at = NOW()
         RETURNING *`,
        [req.params.id, temperature, humidity, windSpeed, extra === null ? null : JSON.stringify(extra)]
      );
      res.json({ success: true, reading: result.rows[0] });
    } catch (error) { next(error); }
  });
  registerGraphApi(app, pool);
  app.use("/api", (req, res) => res.status(404).json({ error: "API-route niet gevonden" }));
  app.use(express.static(path.join(__dirname, "homestation")));
  app.use((error, req, res, next) => {
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Ongeldige JSON" });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Request te groot" });
    console.error(error.message);
    res.status(500).json({ error: "Server error" });
  });
  return app;
}
if (require.main === module) {
  const missing = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "CLASS_CODE"].filter(key => !process.env[key]);
  if (missing.length) {
    console.error(`Missing settings: ${missing.join(", ")}. Run npm run setup first.`);
    process.exit(1);
  }
  const pool = new Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000,
  });
  pool.on("error", error => console.error("Database connection error:", error.message));
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  let stopHistory = () => {};
  const server = createApp({ pool, classCode: process.env.CLASS_CODE }).listen(port, host, () => {
    console.log(`Home Station: http://${host}:${port}`);
    // Start automatisch de historische opslag
    stopHistory = startHistory(pool);
  });
  server.on("error", error => { console.error(error.message); stopHistory(); process.exitCode = 1; pool.end().catch(console.error); });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => { stopHistory(); server.close(() => pool.end())});
  }
}
module.exports = { createApp };
