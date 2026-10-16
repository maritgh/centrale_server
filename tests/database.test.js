const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { createApp } = require("../node");
const { storeMqttReading } = require("../mqtt");

// Deze integratietest gebruikt echt PostgreSQL en draait alleen met RUN_DB_TESTS=1.
// De MQTT-opslagfunctie wordt direct aangeroepen; er is geen broker nodig.
test("PostgreSQL: concurrent registration, authenticated MQTT partial updates, and public map data", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD };
  // Een eigen schema isoleert testtabellen van de bestaande stations en metingen.
  const schema = `test_${crypto.randomBytes(8).toString("hex")}`;
  const admin = new Pool(connection);
  let pool;
  let server;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ ...connection, options: `-c search_path=${schema}` });
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    server = createApp({ pool, classCode: "test-code", adminUsername: "owner", adminPassword: "test-admin-" + "x".repeat(40) }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url + "/api/health")).status, 200);
    const headers = { "Content-Type": "application/json" };
    const register = async () => {
      const response = await fetch(url + "/api/register", { method: "POST", headers, body: JSON.stringify({ name: "Same name", latitude: 52, longitude: 5, classCode: "test-code" }) });
      assert.equal(response.status, 201);
      return response.json();
    };
    // Gelijktijdig registreren met dezelfde naam moet unieke station-IDs opleveren.
    const stations = await Promise.all(Array.from({ length: 5 }, register));
    assert.equal(new Set(stations.map(station => station.stationId)).size, 5);
    const station = stations[0];
    // Bouw hetzelfde topic en JSON-bericht op als een ESP32 zou versturen.
    const send = (metric, value, apiKey = station.apiKey, id = station.stationId) =>
      storeMqttReading(pool, `homestation/${id}/${metric}`, Buffer.from(JSON.stringify({ apiKey, value })));
    assert.equal(await send("temperature", 99, "b".repeat(64)), false);
    assert.equal(await send("temperature", 99, station.apiKey, "missing"), false);
    assert.equal(await send("temperature", 20.4), true);
    // Een eerste temperatuurmeting mag al bestaan zonder vochtigheid of windsnelheid.
    const partial = (await pool.query("SELECT * FROM current_readings")).rows[0];
    assert.equal(partial.temperature, 20.4);
    assert.equal(partial.humidity, null);
    assert.equal(partial.wind_speed, null);
    // Losse topics mogen elkaar bij gelijktijdige verwerking niet overschrijven.
    await Promise.all([send("temperature", 21.5), send("humidity", 58), send("windSpeed", 2.7)]);
    assert.equal(await send("humidity", 101), false);
    const current = await pool.query("SELECT * FROM current_readings");
    assert.equal(current.rowCount, 1);
    assert.equal(current.rows[0].temperature, 21.5);
    assert.equal(current.rows[0].humidity, 58);
    assert.equal(current.rows[0].wind_speed, 2.7);
    // De kaart krijgt de laatste metingen, maar nooit de geheime API-keys.
    const publicData = await (await fetch(url + "/api/stations")).json();
    assert.equal(publicData.length, 5);
    assert.equal(publicData.find(row => row.id === station.stationId).wind_speed, 2.7);
    assert.ok(publicData.every(row => !("api_key" in row)));
    await assert.rejects(pool.query("UPDATE current_readings SET humidity = 101"));

    // Een afgewezen MQTT-bericht mag ook geen historisch record achterlaten.
    assert.equal((await pool.query("SELECT * FROM reading_history")).rowCount, 4);
    const accountCall = (path = "", options = {}, cookie = "") => fetch(url + "/api/account" + path, {
      ...options, headers: { "Content-Type": "application/json", Cookie: cookie },
    });
    assert.equal((await accountCall("/history")).status, 401);
    assert.equal((await accountCall("/login", { method: "POST", body: JSON.stringify({ name: station.name, apiKey: "b".repeat(64) }) })).status, 401);
    const login = await accountCall("/login", { method: "POST", body: JSON.stringify({ name: station.name.toLowerCase(), apiKey: station.apiKey }) });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie");
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";")[0];
    const profile = await (await accountCall("", {}, cookie)).json();
    assert.equal(profile.station.id, station.stationId);
    assert.ok(!("api_key" in profile.station));
    // Controleer dat het ruwe cookiegeheim niet in de database staat.
    assert.notEqual((await pool.query("SELECT token_hash FROM account_sessions")).rows[0].token_hash, cookie.split("=")[1]);

    const firstPage = await (await accountCall("/history?limit=2", {}, cookie)).json();
    assert.equal(firstPage.readings.length, 2);
    assert.ok(firstPage.nextCursor);
    const nextPage = await (await accountCall("/history?limit=2&before=" + firstPage.nextCursor, {}, cookie)).json();
    assert.equal(nextPage.readings.length, 2);
    assert.equal(nextPage.nextCursor, null);
    assert.equal(new Set([...firstPage.readings, ...nextPage.readings].map(row => row.id)).size, 4);
    const humidityHistory = await (await accountCall("/history?metric=humidity", {}, cookie)).json();
    assert.equal(humidityHistory.readings.length, 1);
    assert.equal(humidityHistory.readings[0].value, 58);

    // Een andere naam met een eigen sleutel geeft toegang tot uitsluitend dat eigen station.
    const otherLogin = await accountCall("/login", { method: "POST", body: JSON.stringify({ name: stations[1].name, apiKey: stations[1].apiKey }) });
    const otherCookie = otherLogin.headers.get("set-cookie").split(";")[0];
    assert.equal((await (await accountCall("/history", {}, otherCookie)).json()).readings.length, 0);

    // Eigen grootheden en hun metingen zijn afgeschermd per station, ook bij gelijke sleutels.
    const sendCustom = (value, key = station.apiKey, stationId = station.stationId) =>
      storeMqttReading(pool, `homestation/${stationId}/custom/luchtdruk`, Buffer.from(JSON.stringify({ apiKey: key, value })));
    assert.equal(await sendCustom(1013.2), false);
    const definition = { slug: "luchtdruk", name: "Luchtdruk", unit: "hPa" };
    const createMetric = (data, session) => accountCall("/metrics", { method: "POST", body: JSON.stringify(data) }, session);
    assert.equal((await createMetric(definition, "")).status, 401);
    assert.equal((await createMetric(definition, cookie)).status, 201);
    assert.equal((await createMetric(definition, cookie)).status, 409);
    assert.equal(await sendCustom(1013.2, "b".repeat(64)), false);
    assert.equal(await sendCustom(1013.2, stations[1].apiKey, stations[1].stationId), false);
    assert.equal(await sendCustom(1013.2), true);
    assert.equal((await createMetric({ ...definition, name: "Andere luchtdruk", unit: "Pa" }, otherCookie)).status, 201);
    assert.equal(await sendCustom(101320, stations[1].apiKey, stations[1].stationId), true);
    const ownMetrics = await (await accountCall("/metrics", {}, cookie)).json();
    assert.equal(ownMetrics.metrics[0].value, 1013.2);
    assert.equal(ownMetrics.metrics[0].unit, "hPa");
    const ownHistory = await (await accountCall("/history?metric=custom%2Fluchtdruk", {}, cookie)).json();
    assert.equal(ownHistory.readings.length, 1);
    assert.equal(ownHistory.readings[0].value, 1013.2);
    assert.equal(ownHistory.readings[0].metric_name, "Luchtdruk");
    assert.equal(ownHistory.readings[0].unit, "hPa");
    const previousStationId = station.stationId;
    const changed = await accountCall("", { method: "PATCH", body: JSON.stringify({ name: "Nieuwe naam", latitude: 51.9, longitude: 4.5, id: stations[1].stationId }) }, cookie);
    assert.equal(changed.status, 200);
    const renamed = (await changed.json()).station;
    assert.equal(renamed.id, "nieuwe-naam");
    assert.notEqual(renamed.id, previousStationId);
    station.stationId = renamed.id;
    // De bestaande cookie blijft werken en alle gekoppelde data verhuist naar het nieuwe ID.
    assert.equal((await (await accountCall("", {}, cookie)).json()).station.id, renamed.id);
    for (const table of ["current_readings", "reading_history", "account_sessions", "custom_metrics", "custom_readings"]) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE station_id = $1`, [previousStationId])).rowCount, 0);
      assert.ok((await pool.query(`SELECT 1 FROM ${table} WHERE station_id = $1`, [renamed.id])).rowCount > 0);
    }
    assert.equal(await send("temperature", 99, station.apiKey, previousStationId), false);
    assert.equal((await (await accountCall("/history?metric=custom%2Fluchtdruk", {}, cookie)).json()).readings[0].value, 1013.2);
    // Een bezet ID weigert de complete wijziging; het profiel blijft ongewijzigd.
    const occupied = await fetch(url + "/api/register", { method: "POST", headers, body: JSON.stringify({ name: "Bezet", latitude: 52, longitude: 5, classCode: "test-code" }) });
    assert.equal(occupied.status, 201);
    assert.equal((await accountCall("", { method: "PATCH", body: JSON.stringify({ name: "Bezet", latitude: 0, longitude: 0 }) }, cookie)).status, 409);
    const afterConflict = (await (await accountCall("", {}, cookie)).json()).station;
    assert.equal(afterConflict.name, "Nieuwe naam");
    assert.equal(afterConflict.latitude, 51.9);
    // Alleen de locatie wijzigen behoudt het ID.
    assert.equal((await (await accountCall("", { method: "PATCH", body: JSON.stringify({ name: "Nieuwe naam", latitude: 51.9, longitude: 4.5 }) }, cookie)).json()).station.id, renamed.id);
    const unchanged = (await pool.query("SELECT name FROM stations WHERE id = $1", [stations[1].stationId])).rows[0];
    assert.equal(unchanged.name, stations[1].name);
    const mapStation = (await (await fetch(url + "/api/stations")).json()).find(row => row.id === station.stationId);
    assert.equal(mapStation.name, "Nieuwe naam");
    assert.equal(mapStation.latitude, 51.9);
    assert.equal(mapStation.custom_metrics[0].value, 1013.2);
    assert.equal(mapStation.custom_metrics[0].name, "Luchtdruk");
    // Het nieuwe MQTT-topic werkt met dezelfde sleutel en behoudt de meetgeschiedenis.
    assert.equal(await send("temperature", 22), true);
    // Verwijderen is beperkt tot eigen definities, ook als een ander station dezelfde sleutel gebruikt.
    const deleteMetric = slug => accountCall("/metrics/" + slug, { method: "DELETE", body: "{}" }, cookie);
    assert.equal((await createMetric({ slug: "other-only", name: "Alleen ander station", unit: "lux" }, otherCookie)).status, 201);
    assert.equal((await deleteMetric("other-only")).status, 404);
    for (const session of [cookie, otherCookie]) {
      assert.equal((await createMetric({ slug: "licht", name: "Licht", unit: "lux" }, session)).status, 201);
    }
    const lightPayload = Buffer.from(JSON.stringify({ apiKey: station.apiKey, value: 300 }));
    const lightTopic = `homestation/${station.stationId}/custom/licht`;
    assert.equal(await storeMqttReading(pool, lightTopic, lightPayload), true);
    // Een gelijktijdige meting mag na verwijderen geen actuele waarde of geschiedenis achterlaten.
    const [, removed] = await Promise.all([storeMqttReading(pool, lightTopic, lightPayload), deleteMetric("licht")]);
    assert.equal(removed.status, 200);
    assert.equal((await deleteMetric("licht")).status, 404);
    assert.equal(await storeMqttReading(pool, lightTopic, lightPayload), false);
    assert.equal((await pool.query("SELECT 1 FROM custom_readings WHERE station_id = $1 AND slug = 'licht'", [station.stationId])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM reading_history WHERE station_id = $1 AND metric = 'custom/licht'", [station.stationId])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM custom_metrics WHERE station_id = $1 AND slug = 'licht'", [stations[1].stationId])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM custom_readings WHERE station_id = $1 AND slug = 'luchtdruk'", [station.stationId])).rowCount, 1);
    const newLogin = await accountCall("/login", { method: "POST", body: JSON.stringify({ name: "Nieuwe naam", apiKey: station.apiKey }) });
    assert.equal(newLogin.status, 200);
    const newCookie = newLogin.headers.get("set-cookie").split(";")[0];
    assert.equal((await accountCall("/logout", { method: "POST", body: "{}" }, newCookie)).status, 200);
    assert.equal((await accountCall("", {}, newCookie)).status, 401);
    await pool.query("UPDATE account_sessions SET expires_at = NOW() - INTERVAL '1 second'");
    assert.equal((await accountCall("", {}, cookie)).status, 401);

    // Als de geschiedenis niet opgeslagen kan worden, moet ook de actuele waarde teruggedraaid worden.
    await pool.query(`CREATE FUNCTION reject_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test history failure'; END $$`);
    await pool.query("CREATE TRIGGER reject_history BEFORE INSERT ON reading_history FOR EACH ROW EXECUTE FUNCTION reject_history()");
    await assert.rejects(send("temperature", 99));
    assert.equal((await pool.query("SELECT temperature FROM current_readings")).rows[0].temperature, 22);
    await assert.rejects(sendCustom(9999));
    assert.equal((await pool.query("SELECT value FROM custom_readings WHERE station_id = $1", [station.stationId])).rows[0].value, 1013.2);

    // Beheerlogin gebruikt een ander cookie en mag vergeten sleutels ophalen.
    const adminCall = (path, options = {}, adminCookie = "") => fetch(url + "/api/admin" + path, {
      ...options, headers: { "Content-Type": "application/json", Cookie: adminCookie },
    });
    assert.equal((await adminCall("/stations", {}, cookie)).status, 401);
    assert.equal((await adminCall("/login", { method: "POST", body: JSON.stringify({ username: "owner", password: station.apiKey }) })).status, 401);
    const adminLogin = await adminCall("/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "test-admin-" + "x".repeat(40) }) });
    assert.equal(adminLogin.status, 200);
    assert.match(adminLogin.headers.get("set-cookie"), /HttpOnly/);
    assert.match(adminLogin.headers.get("set-cookie"), /SameSite=Strict/);
    assert.match(adminLogin.headers.get("set-cookie"), /Path=\/api\/admin/);
    const adminCookie = adminLogin.headers.get("set-cookie").split(";")[0];
    assert.equal((await accountCall("", {}, adminCookie)).status, 401);
    const listResponse = await adminCall("/stations?search=Nieuwe", {}, adminCookie);
    const adminList = await listResponse.json();
    assert.equal(listResponse.headers.get("cache-control"), "no-store");
    assert.equal(adminList.stations.length, 1);
    assert.equal(adminList.stations[0].id, station.stationId);
    assert.ok(!("api_key" in adminList.stations[0]));
    assert.equal((await (await adminCall(`/stations/${station.stationId}/key`, {}, adminCookie)).json()).apiKey, station.apiKey);
    assert.equal((await adminCall("/stations/missing/key", {}, adminCookie)).status, 404);
    assert.equal((await adminCall(`/stations/${station.stationId}`, { method: "DELETE", body: "{}" }, adminCookie)).status, 400);
    const rawToken = adminCookie.split("=")[1];
    assert.notEqual((await pool.query("SELECT token_hash FROM admin_sessions")).rows[0].token_hash, rawToken);
    // Verwijderen wist alle gekoppelde gegevens en maakt oude stationssleutels onbruikbaar.
    assert.equal((await adminCall(`/stations/${station.stationId}`, { method: "DELETE", body: JSON.stringify({ confirmStationId: station.stationId }) }, adminCookie)).status, 200);
    for (const table of ["current_readings", "reading_history", "custom_metrics", "custom_readings", "account_sessions"]) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE station_id = $1`, [station.stationId])).rowCount, 0);
    }
    assert.equal((await pool.query("SELECT 1 FROM stations WHERE id = $1", [stations[1].stationId])).rowCount, 1);
    assert.equal(await send("temperature", 25), false);
    assert.equal((await adminCall(`/stations/${station.stationId}/key`, {}, adminCookie)).status, 404);
    // Een veranderd wachtwoord maakt een bestaande beheersessie ook zonder logout ongeldig.
    const changedAdmin = createApp({ pool, classCode: "test-code", adminUsername: "owner", adminPassword: "changed-" + "y".repeat(40) }).listen(0, "127.0.0.1");
    await once(changedAdmin, "listening");
    try {
      assert.equal((await fetch(`http://127.0.0.1:${changedAdmin.address().port}/api/admin/session`, { headers: { Cookie: adminCookie } })).status, 401);
    } finally { await new Promise(resolve => changedAdmin.close(resolve)); }
    assert.equal((await adminCall("/logout", { method: "POST", body: "{}" }, adminCookie)).status, 200);
    assert.equal((await adminCall("/session", {}, adminCookie)).status, 401);

  } finally {
    // Ruim verbindingen en het tijdelijke schema ook na een mislukte test op.
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
