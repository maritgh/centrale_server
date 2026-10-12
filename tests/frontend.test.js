const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

function element() {
  return { value: "", textContent: "", children: [], classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); }, addEventListener() {} };
}
function source(name) { return fs.readFileSync(path.join(__dirname, "..", "homestation", "js", name), "utf8"); }

test("map treats station names as text and updates existing markers on refresh", async () => {
  const elements = { mapStatus: element() };
  let popup;
  let created = 0;
  let updated = 0;
  const timers = [];
  const station = { id: "test", name: '<img src=x onerror="alert(1)">', latitude: 52, longitude: 5, temperature: 20 };
  const context = vm.createContext({
    document: { getElementById(id) { return elements[id]; }, createElement: element },
    L: { map() { return { setView() { return {}; } }; }, tileLayer() { return { addTo() {} }; }, marker() {
      created++;
      return { addTo() { return this; }, bindPopup(value) { popup = value; return this; }, setLatLng() { return this; }, setPopupContent(value) { popup = value; updated++; }, remove() {} };
    } },
    fetch: async () => ({ ok: true, json: async () => [station] }),
    setTimeout(callback, delay) { timers.push({ callback, delay }); }, clearTimeout() {}, AbortController, console, Date,
  });
  vm.runInContext(source("map.js"), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(popup.children[0].textContent, station.name);
  assert.equal(created, 1);
  assert.ok(timers.some(timer => timer.delay === 15000));
  station.temperature = 25;
  await vm.runInContext("loadStations()", context);
  assert.equal(created, 1);
  assert.equal(updated, 1);
  assert.ok(popup.children.some(child => child.textContent.includes("25 °C")));
});

test("ESP32 code uses the configured origin, escapes JSON, and validates addresses", () => {
  const elements = {};
  const context = vm.createContext({
    document: { getElementById(id) { return elements[id] ||= element(); } },
    window: { location: { origin: "http://192.168.1.10:3000" } },
    sessionStorage: { getItem(key) { return key === "stationId" ? "test" : "a".repeat(64); } },
    URL, navigator: {}, setTimeout() {},
  });
  vm.runInContext(source("connect.js"), context);
  assert.equal(elements.endpoint.textContent, "PUT http://192.168.1.10:3000/api/stations/test/current");
  assert.ok(elements.arduinoCode.textContent.includes('"{\\"temperature\\":"'));
  assert.ok(elements.arduinoCode.textContent.includes("http.begin(client, serverUrl)"));
  elements.serverUrlInput.value = "http://localhost:3000";
  vm.runInContext("generateCode()", context);
  assert.match(elements.connectError.textContent, /LAN-IP/);
  elements.serverUrlInput.value = "https://weather.example.com";
  vm.runInContext("generateCode()", context);
  assert.ok(elements.arduinoCode.textContent.includes("client.setCACert(rootCACertificate)"));
  assert.ok(!elements.arduinoCode.textContent.includes("setInsecure"));
});
