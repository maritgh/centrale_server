const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../src/node");

// Deze tests controleren de HTTP-grens zonder echte database of MQTT-broker.
async function withAccountServer(pool, callback, mqttClient) {
  const server = createApp({ pool, mqttClient, classCode: "test" }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("account rejects missing sessions and malformed login before database access", async () => {
  await withAccountServer({ query() { throw new Error("Database should not be used"); } }, async url => {
    for (const route of ["", "/history", "/metrics"]) {
      const response = await fetch(url + "/api/account" + route);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await fetch(url + "/api/account/metrics/luchtdruk", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}",
    })).status, 401);
    for (const body of [{}, { name: "Test", apiKey: "invalid" }, { name: 123, apiKey: "a".repeat(64) }]) {
      assert.equal((await fetch(url + "/api/account/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 401);
    }
    assert.equal((await fetch(url + "/api/account/login", { method: "POST", body: "name=Test" })).status, 415);
    assert.equal((await fetch(url + "/account.html")).status, 200);
    assert.equal((await fetch(url + "/js/account.js")).status, 200);
  });
});

test("actuator publishing requires a session, uses its station and waits for MQTT", async () => {
  const calls = [];
  let stationId = "eigen-station";
  const pool = { async query(sql) {
    assert.match(sql, /JOIN stations/);
    return { rowCount: 1, rows: [{ id: stationId }] };
  } };
  const mqttClient = { connected: true, publish(topic, payload, options, callback) {
    calls.push({ topic, payload, options });
    setImmediate(() => callback());
  } };
  await withAccountServer(pool, async url => {
    const endpoint = url + "/api/account/actuator";
    const headers = { "Content-Type": "application/json", Cookie: "homestation_session=" + "a".repeat(64) };
    const body = { led: true, settings: { brightness: 42 }, stationId: "ander-station", topic: "homestation/ander-station/actuator" };
    const post = (payload, requestHeaders = headers) => fetch(endpoint, { method: "POST", headers: requestHeaders, body: JSON.stringify(payload) });
    assert.equal((await post(body, { "Content-Type": "application/json" })).status, 401);
    assert.equal((await post(body, { ...headers, Cookie: "homestation_session=invalid" })).status, 401);
    assert.equal((await post(body, { ...headers, "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post([])).status, 400);
    assert.equal((await post({ value: "é".repeat(600) })).status, 413);
    assert.equal((await fetch(endpoint, { method: "POST", headers, body: "{" })).status, 400);
    assert.equal(calls.length, 0);
    let response = await post(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, topic: "homestation/eigen-station/actuator" });
    assert.deepEqual(calls[0], { topic: "homestation/eigen-station/actuator", payload: JSON.stringify(body), options: { qos: 0, retain: false } });
    stationId = "nieuwe-naam";
    response = await post({ led: false });
    assert.equal((await response.json()).topic, "homestation/nieuwe-naam/actuator");
    mqttClient.connected = false;
    assert.equal((await post(body)).status, 503);
    assert.equal(calls.length, 2);
    mqttClient.connected = true;
    mqttClient.publish = (topic, payload, options, callback) => callback(new Error("private broker details"));
    response = await post(body);
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes("private broker details"));
  }, mqttClient);
});

test("authenticated account validates profile and history filters before reading or changing data", async () => {
  const pool = { async query(sql) {
    assert.match(sql, /JOIN stations/);
    return { rowCount: 1, rows: [{ id: "test", name: "Test", latitude: 52, longitude: 5 }] };
  } };
  await withAccountServer(pool, async url => {
    const headers = { "Content-Type": "application/json", Cookie: "homestation_session=" + "a".repeat(64) };
    for (const change of [{ name: "" }, { name: "a".repeat(121) }, { latitude: null }, { latitude: "52" }, { latitude: 91 }, { longitude: -181 }]) {
      const response = await fetch(url + "/api/account", { method: "PATCH", headers, body: JSON.stringify({ name: "Test", latitude: 52, longitude: 5, ...change }) });
      assert.equal(response.status, 400);
    }
    // Een ongeldige grootheid wordt al vóór het schrijven naar de database afgewezen.
    for (const change of [{ slug: "Bad" }, { slug: "x/y" }, { slug: "a".repeat(41) }, { name: "" }, { unit: "" }, { unit: "a".repeat(21) }]) {
      assert.equal((await fetch(url + "/api/account/metrics", { method: "POST", headers,
        body: JSON.stringify({ slug: "luchtdruk", name: "Luchtdruk", unit: "hPa", ...change }) })).status, 400);
    }
    assert.equal((await fetch(url + "/api/account/metrics/Bad", { method: "DELETE", headers, body: "{}" })).status, 400);
    assert.equal((await fetch(url + "/api/account/metrics/temperature", { method: "DELETE", body: "{}" })).status, 415);
    for (const params of ["metric=invalid", "before=-1", "before=9223372036854775808", "before=x", "limit=0", "limit=101", "limit=1.2"]) {
      assert.equal((await fetch(url + "/api/account/history?" + params, { headers })).status, 400);
    }
  });
});
