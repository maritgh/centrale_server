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
  const station = { id: "test", name: '<img src=x onerror="alert(1)">', latitude: 52, longitude: 5, temperature: 20, custom_metrics: [{ name: "Luchtdruk <test>", unit: "hPa", value: 1013.2 }] };
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
  assert.ok(popup.children.some(child => child.textContent === "Luchtdruk <test>: 1013.2 hPa"));
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
  elements.customMetricInput.value = "luchtdruk, lichtsterkte";
  vm.runInContext("generateCode()", context);
  assert.ok(elements.endpoint.textContent.includes("homestation/test/custom/luchtdruk"));
  assert.ok(elements.arduinoCode.textContent.includes('sendHomeStationCustomData("luchtdruk", customValue_luchtdruk)'));
  elements.customMetricInput.value = "luchtdruk/extra";
  vm.runInContext("generateCode()", context);
  assert.match(elements.connectError.textContent, /topicsleutels/);
  elements.customMetricInput.value = "";
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

// Controleer de accountbediening met dezelfde browsercode, zonder netwerk of echte API-key.
test("account UI logs in, edits profile, pages history and clears private data on logout", async () => {
  const elements = {};
  function accountNode() {
    const classes = new Set();
    const node = { value: "", textContent: "", children: [], listeners: {}, disabled: false,
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
        toggle(name, hide) { if (hide) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
      setAttribute() {}, appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
      addEventListener(type, callback) { this.listeners[type] = callback; }, querySelector() { return this.button ||= { disabled: false }; },
    };
    return node;
  }
  let confirmRemoval = false;
  const storedCredentials = new Map([["stationId", "test"], ["apiKey", "a".repeat(64)]]);
  const customMetrics = [];
  let loggedIn = false;
  let station = { id: "test", name: '<img src=x onerror="alert(1)">', latitude: 52, longitude: 5 };
  const calls = [];
  const context = vm.createContext({
    document: { getElementById(id) { return elements[id] ||= accountNode(); }, createElement: accountNode },
    sessionStorage: { removeItem(key) { storedCredentials.delete(key); }, getItem(key) { return storedCredentials.get(key); }, setItem(key, value) { storedCredentials.set(key, value); } },
    URLSearchParams, Date, window: { confirm() { return confirmRemoval; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const body = options.body ? JSON.parse(options.body) : null;
      let data;
      let status = 200;
      if (url.endsWith("/login")) { loggedIn = true; data = { station }; }
      else if (url.endsWith("/logout")) { loggedIn = false; data = { success: true }; }
      else if (!loggedIn) { status = 401; data = { error: "Log eerst in" }; }
      else if (url.includes("/metrics/") && options.method === "DELETE") { customMetrics.splice(0); data = { success: true }; }
      else if (url.endsWith("/metrics") && options.method === "POST") { customMetrics.push(body); data = { metric: body }; }
      else if (url.endsWith("/metrics")) { data = { metrics: customMetrics }; }
      else if (options.method === "PATCH") { station = { ...station, ...body, id: body.name !== station.name ? "nieuwe-naam" : station.id }; data = { station }; }
      else if (url.includes("/history?")) {
        const older = url.includes("before=2");
        data = { readings: [{ id: older ? "1" : "2", metric: "temperature", value: older ? 19 : 20, received_at: "2026-10-16T09:00:00Z" }], nextCursor: older ? null : "2" };
        if (url.includes("metric=custom%2Fluchtdruk")) data = { readings: [{ id: "3", metric: "custom/luchtdruk", metric_name: "Luchtdruk", unit: "hPa", value: 1013.2, received_at: "2026-10-16T09:00:00Z" }], nextCursor: null };
      } else data = { station };
      return { ok: status === 200, status, json: async () => data };
    },
  });
  vm.runInContext(source("account.js"), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.loginSection.classList.contains("hidden"), false);
  elements.loginName ||= accountNode();
  elements.loginApiKey ||= accountNode();
  elements.historyMetric ||= accountNode();
  elements.loginName.value = "Test";
  elements.loginApiKey.value = "a".repeat(64);
  const submit = async id => elements[id].listeners.submit({ preventDefault() {}, currentTarget: elements[id] });
  await submit("loginForm");
  assert.equal(elements.loginApiKey.value, "");
  assert.equal(elements.accountTitle.textContent, station.name);
  assert.equal(elements.accountSection.classList.contains("hidden"), false);
  assert.equal(elements.logoutButton.classList.contains("hidden"), false);
  assert.equal(elements.historyRows.children.length, 1);
  await elements.moreHistory.listeners.click();
  assert.equal(elements.historyRows.children.length, 2);
  assert.equal(elements.moreHistory.classList.contains("hidden"), true);
  elements.profileName.value = "Nieuwe naam";
  elements.profileLatitude.value = "51.9";
  elements.profileLongitude.value = "4.5";
  await submit("profileForm");
  assert.equal(station.name, "Nieuwe naam");
  assert.equal(station.latitude, 51.9);
  assert.equal(station.id, "nieuwe-naam");
  assert.equal(elements.accountStationId.textContent, "nieuwe-naam");
  assert.equal(storedCredentials.get("stationId"), "nieuwe-naam");
  for (const id of ["metricName", "metricUnit", "metricSlug"]) elements[id] ||= accountNode();
  elements.metricName.value = "Luchtdruk";
  elements.metricUnit.value = "hPa";
  elements.metricSlug.value = "luchtdruk";
  await submit("metricForm");
  assert.equal(elements.customMetricsList.children.length, 1);
  assert.equal(elements.customMetricsList.children[0].children[1].textContent, "homestation/nieuwe-naam/custom/luchtdruk");
  assert.ok(elements.historyMetric.children.some(option => option.value === "custom/luchtdruk"));
  assert.ok(elements.customCodeLink.href.includes("custom=luchtdruk"));
  assert.ok(elements.customCodeLink.href.includes("station=nieuwe-naam"));
  elements.historyMetric.value = "custom/luchtdruk";
  await elements.historyMetric.listeners.change();
  assert.equal(elements.historyRows.children[0].children[1].textContent, "Luchtdruk");
  assert.equal(elements.historyRows.children[0].children[2].textContent, "1013.2 hPa");
  elements.historyMetric.value = "temperature";
  await elements.historyMetric.listeners.change();
  assert.equal(elements.historyRows.children.length, 1);
  assert.ok(calls.at(-1).url.includes("metric=temperature"));
  const removeButton = elements.customMetricsList.children[0].children[2];
  await removeButton.listeners.click();
  assert.equal(customMetrics.length, 1); // Annuleren mag geen gegevens verwijderen.
  confirmRemoval = true;
  await removeButton.listeners.click();
  assert.equal(customMetrics.length, 0);
  assert.equal(elements.customMetricsList.children.length, 0);
  assert.ok(!elements.historyMetric.children.some(option => option.value === "custom/luchtdruk"));
  assert.ok(calls.some(call => call.url.endsWith("/metrics/luchtdruk") && call.options.method === "DELETE"));
  await elements.logoutButton.listeners.click();
  assert.equal(elements.accountSection.classList.contains("hidden"), true);
  assert.equal(elements.logoutButton.classList.contains("hidden"), true);
  assert.equal(storedCredentials.size, 0);
  assert.equal(elements.loginName.value, "");
  assert.equal(elements.historyRows.children.length, 0);
  assert.equal(elements.profileName.value, "");
  assert.equal(elements.customMetricsList.children.length, 0);
  assert.ok(calls.every(call => !call.url.includes("apiKey")));
});

// Test beheerbediening met namaakantwoorden; er worden geen echte stations verwijderd.
test("admin UI reveals keys on demand, clears them on logout and requires deletion confirmation", async () => {
  const elements = {};
  function node() {
    const classes = new Set();
    return { value: "", textContent: "", children: [], listeners: {}, disabled: false,
      classList: { add(name) { classes.add(name); }, remove(name) { classes.delete(name); }, toggle(name, hide) { if (hide) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
      appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
      addEventListener(type, callback) { this.listeners[type] = callback; }, querySelector() { return this.button ||= { disabled: false }; },
    };
  }
  let loggedIn = false;
  let removed = false;
  let confirmation = null;
  const apiKey = "a".repeat(64);
  const calls = [];
  const station = { id: "test", name: '<img src=x onerror="alert(1)">', latitude: 52, longitude: 5 };
  const context = vm.createContext({
    document: { getElementById(id) { return elements[id] ||= node(); }, createElement: node },
    URLSearchParams, window: { prompt() { return confirmation; } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      let data;
      let status = 200;
      if (url.endsWith("/login")) { loggedIn = true; data = { success: true }; }
      else if (url.endsWith("/logout")) { loggedIn = false; data = { success: true }; }
      else if (!loggedIn) { status = 401; data = { error: "Log eerst in als beheerder" }; }
      else if (url.endsWith("/key")) data = { apiKey };
      else if (options.method === "DELETE") { removed = true; data = { success: true }; }
      else if (url.includes("/stations?")) data = { stations: removed ? [] : [station], nextOffset: null };
      else data = { username: "owner" };
      return { ok: status === 200, status, json: async () => data };
    },
  });
  vm.runInContext(source("admin.js"), context);
  await new Promise(resolve => setImmediate(resolve));
  elements.adminUsername ||= node();
  elements.adminSearch ||= node();
  elements.adminUsername.value = "owner";
  elements.adminPassword.value = "test-owner-password";
  const login = () => elements.adminLoginForm.listeners.submit({ preventDefault() {}, currentTarget: elements.adminLoginForm });
  await login();
  assert.equal(elements.adminPassword.value, "");
  assert.equal(elements.adminLogout.classList.contains("hidden"), false);
  assert.equal(elements.adminRows.children[0].children[0].textContent, station.name);
  assert.ok(!calls.some(call => call.url.endsWith("/key")));
  let actions = elements.adminRows.children[0].children[3];
  await actions.children[0].listeners.click();
  assert.equal(actions.children[2].textContent, apiKey);
  await actions.children[0].listeners.click();
  assert.equal(actions.children[2].textContent, "");
  await actions.children[0].listeners.click();
  await elements.adminLogout.listeners.click();
  assert.equal(elements.adminRows.children.length, 0);
  assert.equal(elements.adminPanel.classList.contains("hidden"), true);
  assert.equal(elements.adminLogout.classList.contains("hidden"), true);
  await login();
  actions = elements.adminRows.children[0].children[3];
  await actions.children[1].listeners.click();
  assert.equal(removed, false);
  confirmation = "wrong";
  await actions.children[1].listeners.click();
  assert.equal(removed, false);
  confirmation = "test";
  await actions.children[1].listeners.click();
  assert.equal(removed, true);
  assert.equal(elements.adminRows.children.length, 0);
  const deletion = calls.find(call => call.options.method === "DELETE");
  assert.equal(JSON.parse(deletion.options.body).confirmStationId, "test");
  assert.ok(calls.every(call => !call.url.includes(apiKey) && !call.url.includes("password")));
});
