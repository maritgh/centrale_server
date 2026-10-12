const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { createApp } = require("../node");

test("PostgreSQL: concurrent registration, authenticated upsert, and public map data", { skip: process.env.RUN_DB_TESTS !== "1" }, async () => {
  const connection = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD };
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
    const stations = await Promise.all(Array.from({ length: 5 }, register));
    assert.equal(new Set(stations.map(station => station.stationId)).size, 5);
    const station = stations[0];
    const endpoint = `${url}/api/stations/${station.stationId}/current`;
    const body = { temperature: 20.4, humidity: 58, windSpeed: 2.7, extra: ["one", "two"] };
    const put = (apiKey, data = body) => fetch(endpoint, { method: "PUT", headers: { ...headers, "x-api-key": apiKey }, body: JSON.stringify(data) });
    assert.equal((await put("wrong-key")).status, 401);
    assert.equal((await put(station.apiKey)).status, 200);
    const updated = await put(station.apiKey, { ...body, temperature: 21.5 });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).reading.temperature, 21.5);
    const current = await pool.query("SELECT * FROM current_readings");
    assert.equal(current.rowCount, 1);
    assert.deepEqual(current.rows[0].extra, ["one", "two"]);
    const publicData = await (await fetch(url + "/api/stations")).json();
    assert.equal(publicData.length, 5);
    assert.equal(publicData.find(row => row.id === station.stationId).wind_speed, 2.7);
    assert.ok(publicData.every(row => !("api_key" in row)));
    await assert.rejects(pool.query("UPDATE current_readings SET humidity = 101"));
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
