const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

// Kleine vervanger voor een DOM-element, met alleen de browserfuncties die we gebruiken.
function element() {
  return { value: "", textContent: "", children: [], classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) { this.children.push(child); }, addEventListener() {} };
}
// Lees het echte browserscript, zodat de test dezelfde code uitvoert als de website.
function source(name) { return fs.readFileSync(path.join(__dirname, "..", "homestation", "js", name), "utf8"); }

test("map treats station names as text and updates existing markers on refresh", async () => {
  const elements = { mapStatus: element() };
  let popup;
  let created = 0;
  let updated = 0;
  const timers = [];
  // Deze naam lijkt op HTML; de popup moet hem uitsluitend als tekst behandelen.
  const station = { id: "test", name: '<img src=x onerror="alert(1)">', latitude: 52, longitude: 5, temperature: 20 };
  // Boots browser, kaartbibliotheek en netwerk na, zonder een echte browser te openen.
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
  // Een verversing hoort de bestaande marker bij te werken in plaats van er een toe te voegen.
  station.temperature = 25;
  await vm.runInContext("loadStations()", context);
  assert.equal(created, 1);
  assert.equal(updated, 1);
  assert.ok(popup.children.some(child => child.textContent.includes("25 °C")));
});

// Controleer de gegenereerde MQTT-code en de invoervalidatie van het brokeradres.
test("ESP32 code publishes three authenticated MQTT topics and validates broker addresses", () => {
  const elements = {};
  const context = vm.createContext({
    document: { getElementById(id) { return elements[id] ||= element(); } },
    window: { location: { origin: "http://192.168.1.10:3001" } },
    sessionStorage: { getItem(key) { return key === "stationId" ? "test" : "a".repeat(64); } },
    URL, navigator: {}, setTimeout() {},
  });
  vm.runInContext(source("connect.js"), context);
  assert.equal(elements.serverUrlInput.value, "mqtt://192.168.1.10:1883");
  assert.equal(elements.endpoint.textContent, "homestation/test/temperature\nhomestation/test/humidity\nhomestation/test/windSpeed");
  const code = elements.arduinoCode.textContent;
  assert.ok(code.includes('String("{\\"apiKey\\":\\"")'));
  assert.ok(code.includes('publishHomeStationValue("temperature", temperature)'));
  assert.ok(code.includes('publishHomeStationValue("humidity", humidity)'));
  assert.ok(code.includes('publishHomeStationValue("windSpeed", windSpeed)'));
  assert.ok(code.includes('mqttClient.publish(topic.c_str(), payload.c_str(), false)'));
  assert.ok(!code.includes("HTTPClient"));
  // Weiger HTTP-adressen, topicpaden, ongeldige poorten en inloggegevens in het adres.
  for (const address of ["http://192.168.1.10", "mqtt://broker/topic", "mqtt://broker:99999", "mqtt://user:password@broker"]) {
    elements.serverUrlInput.value = address;
    vm.runInContext("generateCode()", context);
    assert.match(elements.connectError.textContent, /brokeradres/);
  }
  elements.serverUrlInput.value = "mqtt://localhost:1883";
  vm.runInContext("generateCode()", context);
  assert.match(elements.connectError.textContent, /LAN-IP/);
  // Bij TLS moet certificaatcontrole actief blijven en poort 8883 de standaard zijn.
  elements.serverUrlInput.value = "mqtts://weather.example.com";
  vm.runInContext("generateCode()", context);
  assert.ok(elements.arduinoCode.textContent.includes("mqttNetwork.setCACert(rootCACertificate)"));
  assert.ok(elements.arduinoCode.textContent.includes("mqttPort = 8883"));
  assert.ok(!elements.arduinoCode.textContent.includes("setInsecure"));
});
