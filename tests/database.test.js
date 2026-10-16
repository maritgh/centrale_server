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
    server = createApp({ pool, classCode: "test-code" }).listen(0, "127.0.0.1");
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
  } finally {
    // Ruim verbindingen en het tijdelijke schema ook na een mislukte test op.
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
