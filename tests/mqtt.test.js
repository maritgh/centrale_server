const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { storeMqttReading, startMqtt } = require("../src/mqtt");
// Vaste testgegevens; dit is geen sleutel van een echt station.
const apiKey = "a".repeat(64);
const payload = value => Buffer.from(JSON.stringify({ apiKey, value }));

test("MQTT rejects malformed, oversized, retained and out-of-range readings before database access", async () => {
  // Een ongeldige meting mag de database nooit bereiken.
  const pool = { query() { throw new Error("Invalid message reached database"); } };
  for (const [topic, body, packet] of [
    ["other/test/temperature", payload(20)],
    ["homestation/test/unknown", payload(20)],
    ["homestation/test/custom/Bad", payload(20)],
    ["homestation/test/custom/lucht/druk", payload(20)],
    ["homestation/test/custom/luchtdruk", payload("1013")],
    ["homestation/test/temperature/extra", payload(20)],
    ["homestation/test/temperature", Buffer.from("{")],
    ["homestation/test/temperature", Buffer.from("null")],
    ["homestation/test/temperature", Buffer.from('{}')],
    ["homestation/test/temperature", Buffer.from(JSON.stringify({ apiKey: "wrong", value: 20 }))],
    ["homestation/test/temperature", payload("20")],
    ["homestation/test/temperature", payload(null)],
    ["homestation/test/temperature", Buffer.from(`{"apiKey":"${apiKey}","value":1e999}`)],
    ["homestation/test/humidity", payload(-1)],
    ["homestation/test/humidity", payload(101)],
    ["homestation/test/windSpeed", payload(-0.1)],
    ["homestation/test/temperature", Buffer.alloc(1025)],
    ["homestation/test/temperature", payload(20), { retain: true }],
  ]) assert.equal(await storeMqttReading(pool, topic, body, packet), false);
});

test("MQTT accepts zero and boundary values and rejects unknown credentials", async () => {
  // Leg queryparameters vast om te controleren welke station-ID, sleutel en waarde worden gebruikt.
  const calls = [];
  const pool = { async query(sql, args) { calls.push(args); return { rowCount: 1 }; } };
  for (const [metric, value] of [["temperature", -20], ["humidity", 0], ["humidity", 100], ["windSpeed", 0]]) {
    assert.equal(await storeMqttReading(pool, `homestation/test/${metric}`, payload(value)), true);
    assert.deepEqual(calls.at(-1), ["test", apiKey, value, metric]);
  }
  assert.equal(await storeMqttReading({ query: async () => ({ rowCount: 0 }) }, "homestation/test/temperature", payload(20)), false);
});

test("MQTT subscribes on reconnect and completes messages after database processing", async () => {
  // Boots brokergebeurtenissen na; deze test opent geen netwerkverbinding.
  const client = new EventEmitter();
  const subscriptions = [];
  const errors = [];
  client.subscribe = (topics, options, callback) => { subscriptions.push(topics); callback(null, topics.map(topic => ({ topic, qos: 1 }))); };
  // Houd de databasequery tijdelijk tegen om te testen dat done() daarop wacht.
  let release;
  const pool = { query: () => new Promise(resolve => { release = resolve; }) };
  const subscriber = startMqtt({ pool, connect(url) { assert.match(url, /^mqtt:/); return client; }, logger: { log() {}, error(message) { errors.push(message); } } });
  assert.equal(subscriber, client);
  // De tweede connect-gebeurtenis stelt een herstelde verbinding voor.
  client.emit("connect");
  client.emit("connect");
  assert.deepEqual(subscriptions, Array(2).fill(["homestation/+/temperature", "homestation/+/humidity", "homestation/+/windSpeed", "homestation/+/custom/+"]));
  let completed = false;
  client.handleMessage({ topic: "homestation/test/temperature", payload: payload(20) }, () => { completed = true; });
  assert.equal(completed, false);
  release({ rowCount: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, true);
  // Verwerking moet na een schrijffout doorgaan, zonder geheimen naar de logs te kopiëren.
  pool.query = async () => { throw new Error(`private information ${apiKey}`); };
  await new Promise(resolve => client.handleMessage({ topic: "homestation/test/temperature", payload: payload(20) }, resolve));
  client.emit("error", new Error(`private ${apiKey}`));
  assert.equal(errors.length, 2);
  assert.ok(errors.every(message => !message.includes(apiKey)));
});
