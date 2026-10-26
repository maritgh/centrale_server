// Lees altijd de .env naast deze server, ook wanneer Node vanuit een andere map start.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });
const express = require("express");
const { Pool } = require("pg");
const crypto = require("crypto");
const { createAdminRouter } = require("./admin");
const { createAccountRouter } = require("./account");
const { createStationId } = require("./station-id");
const { startMqtt } = require("./mqtt");

// Accepteer alleen echte, eindige getallen binnen het opgegeven bereik.
function validNumber(value, min = -Infinity, max = Infinity) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
// HTTP verzorgt de website, registratie en het ophalen van stations.
// Nieuwe meetgegevens komen binnen via de MQTT-verbinding in mqtt.js.
function createApp({ pool, mqttClient, classCode, adminUsername = process.env.ADMIN_USERNAME, adminPassword = process.env.ADMIN_PASSWORD }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  // Controleer de database met een echte query; deze route controleert de broker niet.
  app.get("/api/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", mqtt: mqttClient?.getHomeStationStatus?.() ?? null });
    } catch {
      res.status(503).json({ status: "error", error: "Database niet bereikbaar" });
    }
  });
  // Alleen met de juiste klascode mag een nieuw station worden aangemaakt.
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
      // Ieder station krijgt een eigen geheime sleutel voor het insturen van metingen.
      const apiKey = crypto.randomBytes(32).toString("hex");
      const base = createStationId(name);
      // Laat PostgreSQL dubbele IDs afvangen, ook bij gelijktijdige registraties.
      // Bij een bezette naam proberen we opnieuw met een willekeurig achtervoegsel.
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
  // LEFT JOIN toont ook stations die nog geen meting hebben. API-keys blijven geheim.
  app.get("/api/stations", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT s.id, s.name, s.latitude, s.longitude,
                c.temperature, c.humidity, c.wind_speed, c.extra, c.updated_at,
                COALESCE((SELECT json_agg(json_build_object(
                  'slug', m.slug, 'name', m.name, 'unit', m.unit, 'value', r.value, 'updated_at', r.updated_at) ORDER BY m.name)
                  FROM custom_metrics m LEFT JOIN custom_readings r
                    ON r.station_id = m.station_id AND r.slug = m.slug
                  WHERE m.station_id = s.id), '[]'::json) AS custom_metrics
         FROM stations s LEFT JOIN current_readings c ON c.station_id = s.id ORDER BY s.name`
      );
      res.json(result.rows);
    } catch (error) { next(error); }
  });
  // Accountbeheer heeft eigen sessiecontrole voor profiel en meetgeschiedenis.
  app.use("/api/admin", createAdminRouter({ pool, username: adminUsername, password: adminPassword }));
  app.use("/api/account", createAccountRouter({ pool }));
  app.use("/api", (req, res) => res.status(404).json({ error: "API-route niet gevonden" }));
  app.use(express.static(path.join(__dirname, "..", "public")));
  // Vang fouten uit de routes op en stuur een bruikbare HTTP-status terug.
  app.use((error, req, res, next) => {
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Ongeldige JSON" });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "Request te groot" });
    console.error(error.message);
    res.status(500).json({ error: "Server error" });
  });
  return app;
}
// Start verbindingen alleen als dit bestand direct wordt uitgevoerd.
// Tests kunnen createApp importeren zonder een database of broker te starten.
if (require.main === module) {
  const missing = ["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "CLASS_CODE"].filter(key => !process.env[key]);
  if (missing.length) {
    console.error(`Missing settings: ${missing.join(", ")}. Run npm run setup first.`);
    process.exit(1);
  }
  // Hergebruik databaseverbindingen voor zowel HTTP-verzoeken als MQTT-berichten.
  const pool = new Pool({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000,
  });
  pool.on("error", error => console.error("Database connection error:", error.message));
  const mqttClient = startMqtt({ pool });
  const port = Number(process.env.PORT || 3001);
  const host = process.env.HOST || "127.0.0.1";
  const server = createApp({ pool, mqttClient, classCode: process.env.CLASS_CODE }).listen(port, host, () => {
    console.log(`Home Station: http://${host}:${port}`);
  });
  server.on("error", error => { console.error(error.message); process.exitCode = 1; mqttClient.end(true, {}, () => pool.end()); });
  // Stop bij Ctrl+C of een afsluitsignaal eerst de server en daarna de verbindingen.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close(() => mqttClient.end(false, {}, () => pool.end()));
    });
  }
}
module.exports = { createApp };
