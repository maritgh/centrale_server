// Gebruik bij registratie en hernoemen dezelfde omzetting naar een geldige MQTT-topicsleutel.
function createStationId(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "station";
}
module.exports = { createStationId };
