const express = require("express");
const crypto = require("crypto");
const { adminConfigError } = require("./admin-config");

const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const equalSecret = (left, right) => crypto.timingSafeEqual(Buffer.from(digest(left), "hex"), Buffer.from(digest(right), "hex"));

// Beheer heeft eigen inloggegevens en eigen sessies, geheel los van stationsaccounts.
function createAdminRouter({ pool, username, password }) {
  const router = express.Router();
  const configError = adminConfigError(username, password);
  const configured = !configError;
  // Een wijziging van admininloggegevens maakt bestaande beheersessies meteen ongeldig.
  const version = configured ? digest(JSON.stringify([username, password])) : "";
  const cookieName = "homestation_admin";
  const attempts = new Map();
  const cookieOptions = req => ({ httpOnly: true, sameSite: "strict", secure: req.secure || process.env.COOKIE_SECURE === "true", path: "/api/admin" });
  function tokenFrom(req) {
    const value = (req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(value || "") ? value : null;
  }
  router.use((req, res, next) => {
    // API-keys en beheergegevens mogen niet worden gecachet.
    res.set("Cache-Control", "no-store");
    if (!configured) return res.status(503).json({ error: `Beheerlogin niet beschikbaar: ${configError} Controleer .env, voer npm run admin:setup uit en herstart de server.` });
    if (["POST", "DELETE"].includes(req.method) && !req.is("application/json")) return res.status(415).json({ error: "Gebruik application/json" });
    next();
  });

  router.post("/login", async (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = req.ip;
    const count = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (count.count >= 10 || (!attempts.has(key) && attempts.size >= 10000)) {
      res.set("Retry-After", String(Math.max(1, Math.ceil((count.until - now) / 1000))));
      return res.status(429).json({ error: "Te veel inlogpogingen. Probeer over 15 minuten opnieuw." });
    }
    count.count++;
    attempts.set(key, count);
    const body = req.body || {};
    const validName = typeof body.username === "string" && body.username.length <= 120 && equalSecret(body.username, username);
    const validPassword = typeof body.password === "string" && body.password.length <= 1024 && equalSecret(body.password, password);
    if (!validName || !validPassword) return res.status(401).json({ error: "Ongeldige beheerinloggegevens" });
    try {
      await pool.query("DELETE FROM admin_sessions WHERE expires_at <= NOW() OR credential_version <> $1", [version]);
      const token = crypto.randomBytes(32).toString("hex");
      await pool.query(
        "INSERT INTO admin_sessions (token_hash, credential_version, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')",
        [digest(token), version]
      );
      const previous = tokenFrom(req);
      if (previous) await pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [digest(previous)]);
      attempts.delete(key);
      res.cookie(cookieName, token, { ...cookieOptions(req), maxAge: 60 * 60 * 1000 });
      res.json({ success: true });
    } catch (error) { next(error); }
  });
  router.post("/logout", async (req, res, next) => {
    try {
      const token = tokenFrom(req);
      if (token) await pool.query("DELETE FROM admin_sessions WHERE token_hash = $1", [digest(token)]);
      res.clearCookie(cookieName, cookieOptions(req));
      res.json({ success: true });
    } catch (error) { next(error); }
  });

  // Een stationscookie of API-key geeft nooit toegang tot onderstaande routes.
  router.use(async (req, res, next) => {
    const token = tokenFrom(req);
    if (!token) return res.status(401).json({ error: "Log eerst in als beheerder" });
    try {
      const session = await pool.query(
        "SELECT 1 FROM admin_sessions WHERE token_hash = $1 AND credential_version = $2 AND expires_at > NOW()",
        [digest(token), version]
      );
      if (!session.rowCount) return res.status(401).json({ error: "Beheersessie verlopen. Log opnieuw in." });
      next();
    } catch (error) { next(error); }
  });
  router.get("/session", (req, res) => res.json({ username }));
  router.get("/stations", async (req, res, next) => {
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (search.length > 120 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) return res.status(400).json({ error: "Ongeldige zoekopdracht of pagina" });
    try {
      // Laad begrensde pagina's; sleutels worden pas apart op verzoek opgehaald.
      const result = await pool.query(
        `SELECT id, name, latitude, longitude FROM stations
         WHERE strpos(lower(name), lower($1)) > 0 OR strpos(lower(id), lower($1)) > 0
         ORDER BY name, id LIMIT 51 OFFSET $2`, [search, offset]
      );
      res.json({ stations: result.rows.slice(0, 50), nextOffset: result.rows.length > 50 ? offset + 50 : null });
    } catch (error) { next(error); }
  });
  router.get("/stations/:id/key", async (req, res, next) => {
    try {
      const result = await pool.query("SELECT api_key FROM stations WHERE id = $1", [req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: "Station niet gevonden" });
      res.json({ apiKey: result.rows[0].api_key });
    } catch (error) { next(error); }
  });
  router.delete("/stations/:id", async (req, res, next) => {
    // De bevestiging moet exact het bedoelde station bevatten, ook bij een directe API-aanroep.
    if (req.body?.confirmStationId !== req.params.id) return res.status(400).json({ error: "Bevestig het station-ID om te verwijderen" });
    try {
      // Foreign keys verwijderen ook sessies, grootheden, actuele waarden en geschiedenis.
      const result = await pool.query("DELETE FROM stations WHERE id = $1 RETURNING id", [req.params.id]);
      if (!result.rowCount) return res.status(404).json({ error: "Station niet gevonden" });
      res.json({ success: true });
    } catch (error) { next(error); }
  });
  return router;
}
module.exports = { createAdminRouter };
