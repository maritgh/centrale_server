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
serverUrlInput.value = window.location.origin;
try {
    stationIdInput.value = sessionStorage.getItem("stationId") || "";
    apiKeyInput.value = sessionStorage.getItem("apiKey") || "";
} catch { /* Credentials can still be entered manually when storage is blocked. */ }

function generateCode() {
    connectError.textContent = "";
    codeSection.classList.add("hidden");
    const stationId = stationIdInput.value.trim();
    const apiKey = apiKeyInput.value.trim();
    if (!/^[a-z0-9-]+$/.test(stationId) || !/^[a-f0-9]{64}$/.test(apiKey)) {
        connectError.textContent = "Vul je Station ID en de API-key van 64 tekens in.";
        return;
    }
    let base;
    try {
        base = new URL(serverUrlInput.value.trim());
        if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error();
    } catch {
        connectError.textContent = "Gebruik een serveradres zoals http://192.168.1.10:3000, zonder pad.";
        return;
    }
    if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(base.hostname)) {
        connectError.textContent = "Een ESP32 kan localhost niet bereiken. Vul het LAN-IP van je computer of het publieke serveradres in.";
        return;
    }
    const serverUrl = `${base.origin}/api/stations/${encodeURIComponent(stationId)}/current`;
    const secure = base.protocol === "https:";
    endpointElement.textContent = `PUT ${serverUrl}`;
    headerExampleElement.textContent = `Content-Type: application/json\nx-api-key: ${apiKey}`;
    const tls = secure ? `
#include <WiFiClientSecure.h>

// Vervang dit door het PEM-rootcertificaat van jouw HTTPS-server.
const char* rootCACertificate = R"CERT(
PASTE_ROOT_CA_CERTIFICATE_HERE
)CERT";
` : "";
    arduinoCodeElement.textContent = `#include <WiFi.h>
#include <HTTPClient.h>
#include <math.h>
${tls}
const char* apiKey = ${JSON.stringify(apiKey)};
const char* serverUrl = ${JSON.stringify(serverUrl)};

void sendHomeStationData(float temperature, float humidity, float windSpeed) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Geen WiFi verbinding");
    return;
  }
  if (!isfinite(temperature) || !isfinite(humidity) || !isfinite(windSpeed) ||
      humidity < 0 || humidity > 100 || windSpeed < 0) {
    Serial.println("Ongeldige sensorwaarden");
    return;
  }
  ${secure ? "WiFiClientSecure" : "WiFiClient"} client;
  ${secure ? "client.setCACert(rootCACertificate);" : ""}
  HTTPClient http;
  if (!http.begin(client, serverUrl)) {
    Serial.println("HTTP verbinding starten mislukt");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", apiKey);
  String json =
    "{\\"temperature\\":" + String(temperature, 1) +
    ",\\"humidity\\":" + String(humidity, 1) +
    ",\\"windSpeed\\":" + String(windSpeed, 1) + "}";
  int responseCode = http.PUT(json);
  Serial.print("HTTP response: ");
  Serial.println(responseCode);
  if (responseCode > 0) Serial.println(http.getString());
  http.end();
}`;
    document.getElementById("httpsNotice").classList.toggle("hidden", !secure);
    codeSection.classList.remove("hidden");
}
generateButton.addEventListener("click", generateCode);
copyButton.addEventListener("click", async () => {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(arduinoCodeElement.textContent);
        } else {
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
if (stationIdInput.value && apiKeyInput.value) generateCode();
