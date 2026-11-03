const express = require("express");
const crypto = require("crypto");
const { createStationId } = require("./station-id");

const cookieName = "homestation_session";
const sessionHours = 8;
const hashToken = token => crypto.createHash("sha256").update(token).digest("hex");

// Accounts horen bij bestaande stations. De API-key blijft de sleutel voor MQTT;
// de browser krijgt na inloggen een aparte, tijdelijke sessiecookie.
function createAccountRouter({ pool }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    // Formulieren van andere websites kunnen zo geen accountwijziging uitvoeren.
    if (["POST", "PATCH", "DELETE"].includes(req.method) && !req.is("application/json")) {
      return res.status(415).json({ error: "Gebruik application/json" });
    }
    next();
  });

  function cookieOptions(req) {
    return { httpOnly: true, sameSite: "strict", secure: req.secure || process.env.COOKIE_SECURE === "true", path: "/" };
  }
  function sessionToken(req) {
    const cookie = (req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(cookieName + "="));
    const token = cookie?.slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(token || "") ? token : null;
  }

  router.post("/login", async (req, res, next) => {
    const { name, apiKey } = req.body || {};
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120 || typeof apiKey !== "string" || !/^[a-f0-9]{64}$/.test(apiKey)) {
      return res.status(401).json({ error: "Ongeldige naam of API-key" });
    }
    try {
      const result = await pool.query(
        "SELECT id, name, latitude, longitude FROM stations WHERE lower(name) = lower($1) AND api_key = $2",
        [name.trim(), apiKey]
      );
      if (!result.rowCount) return res.status(401).json({ error: "Ongeldige naam of API-key" });
      // Ruim verlopen sessies op bij nieuwe logins, zonder actieve sessies aan te raken.
      await pool.query("DELETE FROM account_sessions WHERE expires_at <= NOW()");
      const token = crypto.randomBytes(32).toString("hex");
      // Bewaar alleen de hash van het sessiegeheim, met een vaste vervaltijd.
      await pool.query(
        `INSERT INTO account_sessions (token_hash, station_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '8 hours')`,
        [hashToken(token), result.rows[0].id]
      );
      const previous = sessionToken(req);
      if (previous) await pool.query("DELETE FROM account_sessions WHERE token_hash = $1", [hashToken(previous)]);
      res.cookie(cookieName, token, { ...cookieOptions(req), maxAge: sessionHours * 60 * 60 * 1000 });
      res.json({ station: result.rows[0] });
    } catch (error) { next(error); }
  });

  router.post("/logout", async (req, res, next) => {
    try {
      const token = sessionToken(req);
      if (token) await pool.query("DELETE FROM account_sessions WHERE token_hash = $1", [hashToken(token)]);
      res.clearCookie(cookieName, cookieOptions(req));
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  // Iedere volgende route haalt het station uit de sessie, nooit uit een opgegeven station-ID.
  router.use(async (req, res, next) => {
    const token = sessionToken(req);
    if (!token) return res.status(401).json({ error: "Log eerst in" });
    try {
      const result = await pool.query(
        `SELECT s.id, s.name, s.latitude, s.longitude FROM account_sessions a
         JOIN stations s ON s.id = a.station_id WHERE a.token_hash = $1 AND a.expires_at > NOW()`,
        [hashToken(token)]
      );
      if (!result.rowCount) return res.status(401).json({ error: "Je sessie is verlopen. Log opnieuw in." });
      req.station = result.rows[0];
      next();
    } catch (error) { next(error); }
  });

  router.get("/", (req, res) => res.json({ station: req.station }));
  router.patch("/", async (req, res, next) => {
    const { name, latitude, longitude } = req.body || {};
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120) {
      return res.status(400).json({ error: "Naam moet tussen 1 en 120 tekens bevatten" });
    }
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
        typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
      return res.status(400).json({ error: "Vul geldige coördinaten in: latitude −90 tot 90, longitude −180 tot 180" });
    }
    try {
      // Alleen een naamswijziging leidt tot een nieuw ID; een locatie-update behoudt het ID.
      // De foreign keys nemen alle metingen, grootheden en sessies atomair mee.
      const newId = name.trim() === req.station.name ? req.station.id : createStationId(name);
      const result = await pool.query(
        "UPDATE stations SET name = $1, latitude = $2, longitude = $3, id = $5 WHERE id = $4 RETURNING id, name, latitude, longitude",
        [name.trim(), latitude, longitude, req.station.id, newId]
      );
      if (!result.rowCount) return res.status(404).json({ error: "Station bestaat niet meer" });
      res.json({ station: result.rows[0] });
    } catch (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Deze naam levert een station-ID op dat al in gebruik is. Kies een andere naam." });
      next(error);
    }
  });

  // Laat alleen de eigenaar grootheden aanmaken en hun laatst ontvangen waarden bekijken.
  router.get("/metrics", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT m.slug, m.name, m.unit, r.value, r.updated_at FROM custom_metrics m
         LEFT JOIN custom_readings r ON r.station_id = m.station_id AND r.slug = m.slug
         WHERE m.station_id = $1 ORDER BY m.name`, [req.station.id]
      );
      res.json({ metrics: result.rows });
    } catch (error) { next(error); }
  });
  router.post("/metrics", async (req, res, next) => {
    const { slug, name, unit } = req.body || {};
    if (typeof slug !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(slug) ||
        typeof name !== "string" || !name.trim() || name.trim().length > 80 ||
        typeof unit !== "string" || !unit.trim() || unit.trim().length > 20) {
      return res.status(400).json({ error: "Vul een naam (max. 80 tekens), eenheid (max. 20) en topicsleutel met 1–40 kleine letters, cijfers of streepjes in. Begin de sleutel met een letter." });
    }
    try {
      const result = await pool.query(
        `INSERT INTO custom_metrics (station_id, slug, name, unit) VALUES ($1, $2, $3, $4)
         ON CONFLICT (station_id, slug) DO NOTHING RETURNING slug, name, unit`,
        [req.station.id, slug, name.trim(), unit.trim()]
      );
      if (!result.rowCount) return res.status(409).json({ error: "Deze topicsleutel bestaat al voor jouw station" });
      res.status(201).json({ metric: result.rows[0] });
    } catch (error) { next(error); }
  });

  // Verwijder uitsluitend een eigen grootheid, inclusief actuele waarde en geschiedenis.
  router.delete("/metrics/:slug", async (req, res, next) => {
    const { slug } = req.params;
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(slug)) {
      return res.status(400).json({ error: "Ongeldige topicsleutel" });
    }
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      // Deze rijvergrendeling wacht op lopende MQTT-metingen en blokkeert nieuwe.
      // Zo kan er tijdens verwijderen geen losse geschiedenis achterblijven.
      const metric = await client.query(
        "SELECT slug FROM custom_metrics WHERE station_id = $1 AND slug = $2 FOR UPDATE",
        [req.station.id, slug]
      );
      if (!metric.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Grootheid niet gevonden" });
      }
      await client.query("DELETE FROM reading_history WHERE station_id = $1 AND metric = $2", [req.station.id, "custom/" + slug]);
      // De gekoppelde actuele waarde verdwijnt via ON DELETE CASCADE.
      await client.query("DELETE FROM custom_metrics WHERE station_id = $1 AND slug = $2", [req.station.id, slug]);
      await client.query("COMMIT");
      res.json({ success: true });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally { if (client) client.release(); }
  });

  // Grafiekdata voor het eigen station. Lange periodes worden per tijdblok gemiddeld,
  // zodat de grafiek ook bij veel metingen snel en overzichtelijk blijft.
  router.get("/history/graph", async (req, res, next) => {
    const metric = req.query.metric === undefined ? "temperature" : req.query.metric;
    const period = req.query.period === undefined ? "7d" : req.query.period;
    if (typeof metric !== "string" || !/^(temperature|humidity|windSpeed|custom\/[a-z][a-z0-9-]{0,39})$/.test(metric) ||
        typeof period !== "string" || !["today", "yesterday", "7d", "30d"].includes(period)) {
      return res.status(400).json({ error: "Ongeldige meetwaarde of periode" });
    }
    try {
      // Daggrenzen volgen de Nederlandse tijd, ook bij overgang naar zomer-/wintertijd.
      const result = await pool.query(
        `WITH bounds AS (
           SELECT
             CASE $2::text
               WHEN 'today' THEN date_trunc('day', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam'
               WHEN 'yesterday' THEN (date_trunc('day', NOW() AT TIME ZONE 'Europe/Amsterdam') - INTERVAL '1 day') AT TIME ZONE 'Europe/Amsterdam'
               WHEN '7d' THEN NOW() - INTERVAL '7 days'
               ELSE NOW() - INTERVAL '30 days'
             END AS start_at,
             CASE WHEN $2::text = 'yesterday'
               THEN date_trunc('day', NOW() AT TIME ZONE 'Europe/Amsterdam') AT TIME ZONE 'Europe/Amsterdam'
               ELSE NOW() END AS end_at,
             CASE $2::text
               WHEN 'today' THEN INTERVAL '5 minutes'
               WHEN 'yesterday' THEN INTERVAL '5 minutes'
               WHEN '7d' THEN INTERVAL '30 minutes'
               ELSE INTERVAL '2 hours'
             END AS bucket_size
         )
         SELECT date_bin(b.bucket_size, h.received_at, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS received_at,
                AVG(h.value)::double precision AS value, COUNT(*)::integer AS samples
         FROM reading_history h CROSS JOIN bounds b
         WHERE h.station_id = $1 AND h.metric = $3
           AND h.received_at >= b.start_at AND h.received_at < b.end_at
         GROUP BY 1 ORDER BY 1 ASC`,
        [req.station.id, period, metric]
      );
      res.json({ metric, period, readings: result.rows });
    } catch (error) { next(error); }
  });

  router.get("/history", async (req, res, next) => {
    const { metric, before } = req.query;
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if ((metric !== undefined && (typeof metric !== "string" || !/^(temperature|humidity|windSpeed|custom\/[a-z][a-z0-9-]{0,39})$/.test(metric))) ||
        (before !== undefined && (typeof before !== "string" || !/^[1-9]\d{0,18}$/.test(before) || BigInt(before) > 9223372036854775807n)) ||
        !Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: "Ongeldig filter of paginanummer" });
    }
    try {
      // Sorteer op meetdatum, niet op de volgorde waarin data werd ingevoerd.
      // De bestaande ID-cursor blijft werken; de bijbehorende datum bepaalt de
      // paginagrens. Bij gelijke tijdstippen beslist de ID over de volgorde.
      const result = await pool.query(
        `SELECT h.id, h.metric, h.value, h.received_at, m.name AS metric_name, m.unit
         FROM reading_history h LEFT JOIN custom_metrics m
           ON m.station_id = h.station_id AND h.metric = 'custom/' || m.slug
         LEFT JOIN reading_history page_cursor ON page_cursor.id = $3::bigint AND page_cursor.station_id = $1
         WHERE h.station_id = $1 AND ($2::text IS NULL OR h.metric = $2)
           AND ($3::bigint IS NULL OR (h.received_at, h.id) < (page_cursor.received_at, page_cursor.id))
         ORDER BY h.received_at DESC, h.id DESC LIMIT $4`,
        [req.station.id, metric || null, before || null, limit + 1]
      );
      const readings = result.rows.slice(0, limit);
      res.json({ readings, nextCursor: result.rows.length > limit ? readings.at(-1).id : null });
    } catch (error) { next(error); }
  });
  return router;
}
module.exports = { createAccountRouter };
