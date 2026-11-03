// Deze pagina bouwt Arduino-code op uit de ingevulde station- en brokergegevens.
const stationIdInput = document.getElementById("stationIdInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const serverUrlInput = document.getElementById("serverUrlInput");
const generateButton = document.getElementById("generateButton");
const copyButton = document.getElementById("copyButton");
const codeSection = document.getElementById("codeSection");
const endpointElement = document.getElementById("endpoint");
const headerExampleElement = document.getElementById("headerExample");
const arduinoCodeElement = document.getElementById("arduinoCode");
const connectError = document.getElementById("connectError");
const codeStatus = document.getElementById("codeStatus");
// Neem dezelfde computer als de website als uitgangspunt; een HTTPS-site gebruikt de TLS-broker.
const pageUrl = new URL(window.location.origin);
serverUrlInput.value = pageUrl.protocol === "https:"
    ? `mqtts://${pageUrl.hostname}:8883`
    : `mqtt://${pageUrl.hostname}:8883`;
// Vul gegevens uit een registratie in dezelfde browsersessie automatisch in.
try {
    stationIdInput.value = sessionStorage.getItem("stationId") || "";
    apiKeyInput.value = sessionStorage.getItem("apiKey") || "";
} catch { /* Handmatig invullen blijft mogelijk als de browser opslag blokkeert. */ }

// Valideer de invoer voordat we nieuwe code tonen of laten kopiëren.
function generateCode() {
    connectError.textContent = "";
    codeSection.classList.add("hidden");
    const stationId = stationIdInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    if (!/^[a-z0-9-]+$/.test(stationId) || !/^[a-f0-9]{64}$/.test(apiKey)) {
        connectError.textContent = "Vul je Station ID en de API-key van 64 tekens in.";
        return;
    }
    // Eigen grootheden gebruiken hun vaste, vooraf aangemaakte topicsleutels.
    const customSlugs = [...new Set(document.getElementById("customMetricInput").value.split(",").map(value => value.trim()).filter(Boolean))];
    if (customSlugs.length > 50 || customSlugs.some(slug => !/^[a-z][a-z0-9-]{0,39}$/.test(slug))) {
        connectError.textContent = "Gebruik maximaal 50 eigen topicsleutels van 1–40 kleine letters, cijfers of streepjes; begin met een letter.";
        return;
    }
    // Het brokeradres bevat alleen protocol, host en eventueel poort.
    // Gebruikersnaam wordt aan het station-ID gekoppeld voor de Mosquitto topic-ACL.
    let base;
    try {
        base = new URL(serverUrlInput.value.trim());
        if (!["mqtt:", "mqtts:"].includes(base.protocol) || base.username || base.password || (base.pathname && base.pathname !== "/") || base.search || base.hash || !base.hostname) throw new Error();
        if (base.port && (Number(base.port) < 1 || Number(base.port) > 65535)) throw new Error();
    } catch {
        connectError.textContent = "Gebruik een brokeradres zoals mqtt://145.24.237.237:8883, zonder pad of inloggegevens.";
        return;
    }
    if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(base.hostname)) {
        connectError.textContent = "Een ESP32 kan localhost niet bereiken. Vul het LAN-IP van je broker of het publieke brokeradres in.";
        return;
    }
    renderCode({ stationId, apiKey, base, customSlugs });
    return true;
}

// Gebruik dezelfde generator voor het invulvoorbeeld en de persoonlijke code.
function renderCode({ stationId, apiKey, base, customSlugs, example = false }) {
    // mqtts gebruikt TLS; zonder expliciete poort kiezen we de gebruikelijke standaard.
    const secure = base.protocol === "mqtts:";
    const port = Number(base.port || 8883);
    const topicBase = `homestation/${stationId}/`;
    endpointElement.textContent = ["temperature", "humidity", "windSpeed", ...customSlugs.map(slug => "custom/" + slug)].map(metric => topicBase + metric).join("\n");
    document.getElementById("actuatorEndpoint").textContent = topicBase + "actuator";
    headerExampleElement.textContent = JSON.stringify({ apiKey, value: 20.4 }, null, 2);
    const tls = secure ? `#include <WiFiClientSecure.h>
// Vul het PEM-rootcertificaat van de broker in en synchroniseer de klok via NTP.
const char* rootCACertificate = R"CERT(
PASTE_ROOT_CA_CERTIFICATE_HERE
)CERT";
` : "";
    // Dit tekstblok is de gegenereerde C++-code. JSON.stringify maakt van
    // de ingevulde tekst een stringliteral met ge-escapete aanhalingstekens.
    arduinoCodeElement.textContent = `#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <math.h>
#include <string.h>
${tls}
// De API-key identificeert het station; de brokergegevens regelen de MQTT-toegang.
const char* stationId = ${JSON.stringify(stationId)};
const char* apiKey = ${JSON.stringify(apiKey)};
const char* mqttHost = ${JSON.stringify(base.hostname.replace(/^\[|\]$/g, ""))};
const int mqttPort = ${port};
// Kies de GPIO van een gewone digitale led. -1 verwerkt opdrachten alleen in de seriële monitor.
// Een adresseerbare RGB-led vraagt om eigen aanstuurcode in handleHomeStationActuator().
const int actuatorLedPin = -1;
const bool actuatorLedActiveLow = false;
const unsigned int maxActuatorPayload = 1024;
String actuatorTopic = String("homestation/") + stationId + "/actuator";

${secure ? "WiFiClientSecure" : "WiFiClient"} mqttNetwork;
PubSubClient mqttClient(mqttNetwork);
unsigned long lastMqttAttempt = 0;
bool mqttAttempted = false;
bool mqttBufferReady = false;

// Pas deze functie aan voor jouw actuator. Voorbeeld vanuit Mijn station: {"led":true}.
void handleHomeStationActuator(JsonObjectConst command) {
  // Alleen echte JSON-booleans accepteren: false schakelt uit, true schakelt in.
  if (!command["led"].is<bool>()) {
    Serial.println("Actuator: gebruik een boolean, bijvoorbeeld {\\"led\\":true}");
    return;
  }
  bool enabled = command["led"].as<bool>();
  if (actuatorLedPin < 0) {
    Serial.println(enabled ? "LED aan gevraagd; stel actuatorLedPin in" : "LED uit gevraagd; stel actuatorLedPin in");
    return;
  }
  digitalWrite(actuatorLedPin, (enabled != actuatorLedActiveLow) ? HIGH : LOW);
  Serial.println(enabled ? "LED ingeschakeld" : "LED uitgeschakeld");
}

void onHomeStationMqttMessage(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, actuatorTopic.c_str()) != 0) return;
  if (length == 0 || length > maxActuatorPayload) {
    Serial.println("Actuator: bericht moet 1 tot 1024 bytes bevatten");
    return;
  }
  JsonDocument command;
  // MQTT-payloads eindigen niet altijd op een nulbyte; lees alleen de opgegeven lengte.
  DeserializationError error = deserializeJson(command, reinterpret_cast<const char*>(payload), length);
  if (error || !command.is<JsonObject>()) {
    Serial.println("Actuator: ongeldig JSON-object");
    return;
  }
  handleHomeStationActuator(command.as<JsonObjectConst>());
}

// Roep dit eenmalig aan in setup(), na je WiFi-instellingen.
void setupHomeStationMqtt() {
  ${secure ? "mqttNetwork.setCACert(rootCACertificate);" : ""}
  mqttClient.setServer(mqttHost, mqttPort);
  mqttClient.setCallback(onHomeStationMqttMessage);
  // 1024 bytes JSON plus de topicnaam en MQTT-headers moeten in de buffer passen.
  mqttBufferReady = mqttClient.setBufferSize(1280);
  if (!mqttBufferReady) Serial.println("MQTT: onvoldoende geheugen voor de berichtbuffer");
  if (actuatorLedPin >= 0) {
    pinMode(actuatorLedPin, OUTPUT);
    digitalWrite(actuatorLedPin, actuatorLedActiveLow ? HIGH : LOW);
  }
}

// Roep dit bij elke loop() aan, ook tussen metingen door.
void loopHomeStationMqtt() {
  if (!mqttBufferReady || WiFi.status() != WL_CONNECTED) return;
  if (!mqttClient.connected()) {
    // Probeer maximaal eenmaal per vijf seconden opnieuw te verbinden.
    if (mqttAttempted && millis() - lastMqttAttempt < 5000) return;
    mqttAttempted = true;
    lastMqttAttempt = millis();
    // Een client-ID per apparaat voorkomt dat ESP32's elkaar van de broker afmelden.
    String clientId = String("hs-") + WiFi.macAddress();
    bool connected = mqttClient.connect(clientId.c_str());
    if (!connected) {
      Serial.print("MQTT verbinden mislukt: ");
      Serial.println(mqttClient.state());
      return;
    }
    // Abonneer opnieuw na iedere herverbinding, uitsluitend op het eigen station.
    if (!mqttClient.subscribe(actuatorTopic.c_str(), 0)) {
      Serial.println("MQTT: abonneren op actuator-topic mislukt");
      mqttClient.disconnect();
      return;
    }
  }
  // Ontvang actuatoropdrachten en houd de verbinding met de broker actief.
  mqttClient.loop();
}

// Verstuur één waarde naar het eigen topic, samen met de stationssleutel.
bool publishHomeStationValue(const char* metric, float value) {
  String topic = String("homestation/") + stationId + "/" + metric;
  String payload = String("{\\"apiKey\\":\\"") + apiKey + "\\",\\"value\\":" + String(value, 2) + "}";
  // false schakelt retain uit: nieuwe abonnees krijgen deze meting niet opnieuw.
  return mqttClient.publish(topic.c_str(), payload.c_str(), false);
}

// Geef een echte sensorwaarde in de bijbehorende eenheid door. De server controleert de topicsleutel.
void sendHomeStationCustomData(const char* slug, float value) {
  if (!isfinite(value)) return;
  loopHomeStationMqtt();
  if (!mqttClient.connected()) return;
  String metric = String("custom/") + slug;
  if (!publishHomeStationValue(metric.c_str(), value)) Serial.println("Eigen meting verzenden mislukt");
}
${customSlugs.map(slug => `// Voorbeeld: sendHomeStationCustomData(${JSON.stringify(slug)}, customValue_${slug.replace(/-/g, "_")});`).join("\n")}

// Roep deze functie periodiek aan met temperatuur in °C, vochtigheid in % en wind in m/s.
void sendHomeStationData(float temperature, float humidity, float windSpeed) {
  if (!isfinite(temperature) || !isfinite(humidity) || !isfinite(windSpeed) ||
      humidity < 0 || humidity > 100 || windSpeed < 0) {
    Serial.println("Ongeldige sensorwaarden");
    return;
  }
  loopHomeStationMqtt();
  if (!mqttClient.connected()) return;
  // Losse aanroepen zorgen dat alle drie de topics worden geprobeerd.
  bool temperatureSent = publishHomeStationValue("temperature", temperature);
  bool humiditySent = publishHomeStationValue("humidity", humidity);
  bool windSent = publishHomeStationValue("windSpeed", windSpeed);
  // Dit bevestigt verzending naar de broker, niet de opslag in PostgreSQL.
  Serial.println(temperatureSent && humiditySent && windSent
    ? "Drie MQTT-berichten verzonden" : "MQTT verzenden mislukt");
}`;
    document.getElementById("httpsNotice").classList.toggle("hidden", !secure);
    codeStatus.textContent = example
        ? "Voorbeeldcode: vervang jouw-station-id en JOUW_API_KEY door je eigen gegevens. Controleer ook het brokeradres."
        : "Deze code gebruikt de gegevens die je hierboven hebt ingevuld.";
    codeSection.classList.remove("hidden");
}

function showExampleCode() {
    const base = new URL(serverUrlInput.value);
    // Een lokaal websiteadres is geen bruikbaar brokeradres voor de ESP32.
    if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(base.hostname)) base.hostname = "jouw-broker.example";
    const customSlugs = [...new Set(document.getElementById("customMetricInput").value.split(",")
        .map(value => value.trim()).filter(slug => /^[a-z][a-z0-9-]{0,39}$/.test(slug)))].slice(0, 50);
    renderCode({ stationId: "jouw-station-id", apiKey: "JOUW_API_KEY", base, customSlugs, example: true });
}
generateButton.addEventListener("click", generateCode);
copyButton.addEventListener("click", async () => {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(arduinoCodeElement.textContent);
        } else {
            // Op gewone HTTP-pagina's is de moderne klembord-API vaak niet beschikbaar.
            const textarea = document.createElement("textarea");
            textarea.value = arduinoCodeElement.textContent;
            document.body.appendChild(textarea);
            textarea.select();
            try {
                if (!document.execCommand("copy")) throw new Error("Copy unavailable");
            } finally { textarea.remove(); }
        }
        copyButton.textContent = "Gekopieerd!";
        setTimeout(() => { copyButton.textContent = "Kopieer code"; }, 2000);
    } catch {
        connectError.textContent = "Automatisch kopiëren is niet gelukt. Selecteer en kopieer de code hieronder.";
    }
});
// Het account kan alleen de topicsleutels doorgeven via een link; nooit de API-key.
const requestedParams = new URL(window.location.href || window.location.origin).searchParams;
const requestedStationId = requestedParams.get("station");
if (requestedStationId && /^[a-z0-9-]{1,100}$/.test(requestedStationId)) stationIdInput.value = requestedStationId;
const requestedCustomSlugs = requestedParams.get("custom");
if (requestedCustomSlugs) document.getElementById("customMetricInput").value = requestedCustomSlugs;
// Toon ook zonder registratie of browseropslag direct een kopieerbaar voorbeeld.
if (!stationIdInput.value || !apiKeyInput.value || !generateCode()) showExampleCode();
