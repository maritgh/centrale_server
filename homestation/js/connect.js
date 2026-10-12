const stationIdInput = document.getElementById("stationIdInput");
const apiKeyInput = document.getElementById("apiKeyInput");

const generateButton = document.getElementById("generateButton");
const copyButton = document.getElementById("copyButton");

const codeSection = document.getElementById("codeSection");

const endpointElement = document.getElementById("endpoint");
const headerExampleElement = document.getElementById("headerExample");
const arduinoCodeElement = document.getElementById("arduinoCode");


// Gegevens ophalen als iemand net geregistreerd heeft
const storedStationId = sessionStorage.getItem("stationId");
const storedApiKey = sessionStorage.getItem("apiKey");

if (storedStationId) {
    stationIdInput.value = storedStationId;
}

if (storedApiKey) {
    apiKeyInput.value = storedApiKey;
}


function generateCode() {
    const stationId = stationIdInput.value.trim();
    const apiKey = apiKeyInput.value.trim();

    if (!stationId || !apiKey) {
        alert("Vul je Station ID en API-key in.");
        return;
    }

    const serverUrl =
        `http://145.24.237.237/api/stations/${stationId}/current`;


    // Laten zien welke PUT-request wordt gebruikt
    endpointElement.textContent =
        `PUT ${serverUrl}`;


    // Laten zien welke headers nodig zijn
    headerExampleElement.textContent =
`Content-Type: application/json
x-api-key: ${apiKey}`;


    // Persoonlijke ESP32-code genereren
    const code =
`#include <WiFi.h>
#include <HTTPClient.h>

const char* apiKey = "${apiKey}";

const char* serverUrl =
  "${serverUrl}";

void sendHomeStationData(
  float temperature,
  float humidity,
  float windSpeed
) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Geen WiFi verbinding");
    return;
  }

  HTTPClient http;

  http.begin(serverUrl);

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  http.addHeader(
    "x-api-key",
    apiKey
  );

  String json =
    "{\\"temperature\\":" + String(temperature, 1) +
    ",\\"humidity\\":" + String(humidity, 1) +
    ",\\"windSpeed\\":" + String(windSpeed, 1) +
    "}";

  int responseCode = http.PUT(json);

  Serial.print("HTTP response: ");
  Serial.println(responseCode);

  if (responseCode > 0) {
    Serial.println(http.getString());
  }

  http.end();
}`;

    arduinoCodeElement.textContent = code;

    codeSection.classList.remove("hidden");
}


// Code maken als op de knop wordt gedrukt
generateButton.addEventListener("click", generateCode);


// Arduino-code kopiëren
copyButton.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(
            arduinoCodeElement.textContent
        );

        copyButton.textContent = "Gekopieerd!";

        setTimeout(() => {
            copyButton.textContent = "Kopieer code";
        }, 2000);

    } catch (error) {
        alert("Kopiëren is niet gelukt.");
    }
});


// Net geregistreerd?
// Dan meteen automatisch de persoonlijke code tonen.
if (storedStationId && storedApiKey) {
    generateCode();
}
