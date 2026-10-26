const mqtt = require("mqtt");

// Koppel de topicnaam aan een vaste databasekolom en het toegestane bereik.
// Zo kan een afzender geen willekeurige kolomnaam in de SQL-query plaatsen.
const metrics = {
  temperature: { column: "temperature", min: -Infinity, max: Infinity },
  humidity: { column: "humidity", min: 0, max: 100 },
  windSpeed: { column: "wind_speed", min: 0, max: Infinity },
};

// Verwerk één bericht: { apiKey: "...", value: 20.4 }.
// Geef false terug bij ongeldige invoer of als station en API-key niet overeenkomen.
async function storeMqttReading(pool, topic, payload, packet = {}) {
  if (payload.length > 1024) return false;
  // Verwacht precies homestation/<station-id>/<meetwaarde>.
  const match = /^homestation\/([a-z0-9-]{1,100})\/(temperature|humidity|windSpeed|custom\/[a-z][a-z0-9-]{0,39})$/.exec(topic);
  if (!match) return false;
  // Controleer de inhoud voordat er een databasequery wordt uitgevoerd.
  let body;
  try { body = JSON.parse(payload.toString()); } catch { return false; }
  if (!body || typeof body.apiKey !== "string" || !/^[a-f0-9]{64}$/.test(body.apiKey)) return false;
  const metric = metrics[match[2]];
  const value = typeof body.value === "string" && /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(body.value)
    ? Number(body.value)
    : body.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (metric && (value < metric.min || value > metric.max)) return false;
  if (!metric) {
    // Alleen vooraf aangemaakte grootheden van dit station mogen data ontvangen.
    // Houd de definitie tijdens opslag vast: verwijderen wacht tot deze meting is afgerond.
    // Autorisatie, actuele waarde en geschiedenis vormen samen één databaseopdracht.
    const result = await pool.query(
      `WITH updated AS (
       INSERT INTO custom_readings (station_id, slug, value, updated_at)
       SELECT m.station_id, m.slug, $3, NOW() FROM custom_metrics m
       JOIN stations s ON s.id = m.station_id
       WHERE s.id = $1 AND s.api_key = $2 AND m.slug = $4
       FOR KEY SHARE OF m
       ON CONFLICT (station_id, slug) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
       ${packet.retain ? "WHERE custom_readings.value IS NULL" : ""}
       RETURNING station_id)
       INSERT INTO reading_history (station_id, metric, value)
       SELECT station_id, $5, $3 FROM updated RETURNING station_id`,
      [match[1], body.apiKey, value, match[2].slice(7), match[2]]
    );
    return result.rowCount > 0;
  }
  // Controleer de API-key en sla de meting op binnen dezelfde SQL-opdracht.
  // De CTE bewaart actuele waarde en geschiedenis samen: beide slagen of beide worden teruggedraaid.
  // INSERT maakt de eerste meting aan; ON CONFLICT werkt alleen deze kolom bij.
  // Waarden van de andere topics blijven daardoor behouden, ook bij gelijktijdige berichten.
  const result = await pool.query(
    `WITH updated AS (
     INSERT INTO current_readings (station_id, ${metric.column}, updated_at)
     SELECT id, $3, NOW() FROM stations WHERE id = $1 AND api_key = $2
     ON CONFLICT (station_id) DO UPDATE SET
       ${metric.column} = EXCLUDED.${metric.column}, updated_at = NOW()
     ${packet.retain ? `WHERE current_readings.${metric.column} IS NULL` : ""}
     RETURNING station_id)
     INSERT INTO reading_history (station_id, metric, value)
     SELECT station_id, $4, $3 FROM updated RETURNING station_id`,
    [match[1], body.apiKey, value, match[2]]
  );
  return result.rowCount > 0;
}

// Start de verbinding met de broker; MQTT.js probeert na uitval opnieuw te verbinden.
function startMqtt({ pool, url = process.env.MQTT_URL || "mqtt://127.0.0.1:8883", connect = mqtt.connect, logger = console }) {
  const brokerUrl = new URL(url);
  const broker = `${brokerUrl.hostname}:${brokerUrl.port || (brokerUrl.protocol === "mqtts:" ? 8883 : 1883)}`;
  const client = connect(url, {
    // Deze gegevens geven toegang tot de broker; de API-key hoort bij een station.
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
  });
  let connected = false;
  let subscribed = false;
  let lastMessageAt = null;
  let lastAcceptedAt = null;
  let lastRejectedAt = null;
  let lastDatabaseErrorAt = null;
  let lastConnectionError = null;
  client.getHomeStationStatus = () => ({
    broker,
    connected,
    subscribed,
    lastMessageAt,
    lastAcceptedAt,
    lastRejectedAt,
    lastDatabaseErrorAt,
    lastConnectionError,
  });
  // Dit gebeurt ook na opnieuw verbinden. De + staat voor ieder station-ID.
  client.on("connect", () => {
    connected = true;
    subscribed = false;
    lastConnectionError = null;
    client.subscribe([...Object.keys(metrics).map(metric => `homestation/+/${metric}`), "homestation/+/custom/+"], { qos: 1 }, (error, granted) => {
      if (error || granted?.some(topic => topic.qos === 128)) {
        lastConnectionError = error?.code || "MQTT_SUBSCRIPTION_FAILED";
        logger.error("MQTT subscription failed");
      }
      else {
        subscribed = true;
        logger.log("MQTT: subscribed to station readings");
      }
    });
  });
  for (const event of ["close", "offline", "end"]) {
    client.on(event, () => { connected = false; subscribed = false; });
  }
  // MQTT.js wacht op done() voordat het volgende bericht wordt verwerkt.
  // Wacht daarom eerst op de database, zodat berichten zich niet onbeperkt opstapelen.
  client.handleMessage = (packet, done) => {
    lastMessageAt = new Date().toISOString();
    storeMqttReading(pool, packet.topic, packet.payload, packet)
      .then(stored => {
        if (stored) lastAcceptedAt = lastMessageAt;
        else lastRejectedAt = lastMessageAt;
        if (!stored) {
          logger.warn?.(packet.retain
            ? "MQTT: retained reading rejected; check its topic, payload, station API key, value, and existing reading"
            : "MQTT: reading rejected; check topic, JSON, station API key, value, and custom metric");
        }
        done();
      }, () => {
        lastDatabaseErrorAt = lastMessageAt;
        logger.error("MQTT: database write failed");
        done();
      });
  };
  client.on("error", error => {
    lastConnectionError = error?.code || "MQTT_CONNECTION_ERROR";
    logger.error("MQTT connection error; check broker settings");
  });
  return client;
}
module.exports = { storeMqttReading, startMqtt };
