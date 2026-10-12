const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../node");

async function withServer(pool, callback) {
  const server = createApp({ pool, classCode: "test-code" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("website and assets are served by the same server as the API", async () => {
  await withServer({ query: async () => ({ rows: [], rowCount: 0 }) }, async url => {
    for (const asset of ["/", "/register.html", "/connect.html", "/js/map.js", "/css/style.css"]) {
      assert.equal((await fetch(url + asset)).status, 200, asset);
    }
    assert.equal((await fetch(url + "/api/stations")).status, 200);
    const missing = await fetch(url + "/api/missing");
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type"), /json/);
  });
});

test("invalid registrations and readings never reach the database", async () => {
  const pool = { query() { throw new Error("Validation should run before querying"); } };
  await withServer(pool, async url => {
    const valid = { name: "Test", latitude: 52, longitude: 5, classCode: "test-code" };
    for (const change of [{ name: "   " }, { name: 123 }, { name: "a".repeat(121) }, { latitude: null }, { latitude: "52" }, { latitude: 91 }, { longitude: -181 }]) {
      const response = await fetch(url + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...valid, ...change }) });
      assert.equal(response.status, 400);
    }
    assert.equal((await fetch(url + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...valid, classCode: "wrong" }) })).status, 403);
    for (const change of [{ temperature: null }, { humidity: 150 }, { humidity: -1 }, { windSpeed: -1 }, { temperature: "warm" }]) {
      const response = await fetch(url + "/api/stations/test/current", { method: "PUT", headers: { "Content-Type": "application/json", "x-api-key": "test" }, body: JSON.stringify({ temperature: 20, humidity: 50, windSpeed: 0, ...change }) });
      assert.equal(response.status, 400);
    }
    assert.equal((await fetch(url + "/api/stations/test/current", { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    const malformed = await fetch(url + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    assert.equal(malformed.status, 400);
    const oversized = await fetch(url + "/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a".repeat(20000) }) });
    assert.equal(oversized.status, 413);
  });
});

test("database outage is reflected in health status", async () => {
  await withServer({ query: async () => { throw new Error("offline"); } }, async url => {
    assert.equal((await fetch(url + "/api/health")).status, 503);
  });
});

module.exports = { withServer };
