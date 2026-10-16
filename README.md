# Home Station Network

The Node server serves the website in `homestation/` and the weather API. PostgreSQL stores station registrations and the latest reading for each station.

## Run locally

Requires Node.js 20 or newer and PostgreSQL server tools (`initdb` and `pg_ctl`). The local database script adds the directory reported by `pg_config --bindir` to its own PATH, so you do not need to configure it in your shell.

```sh
npm install
npm run setup
npm run db:start
docker compose -f Docker-compose.yml up -d
npm start
```

Open http://localhost:3001. Read `CLASS_CODE` from `.env` to register a station. Save the returned station ID and API key; the browser remembers them only for the current tab/session.

`setup` generates a private `.env` with random credentials and does not overwrite existing settings. `db:start` starts a separate local PostgreSQL cluster on port **55432**, creates the database, and applies `schema.sql`. Data persists in the ignored `.local/postgres/` directory. Keep `.env` with that database: changing its password does not change the existing PostgreSQL user's password.

To stop the API, press Ctrl+C. To stop PostgreSQL:

```sh
npm run db:stop
```

For an existing PostgreSQL database, fill in its connection details in `.env` and run `npm run db:setup` instead. The database must already exist. The schema script creates missing tables; it does not migrate incompatible existing tables.

## Connect an ESP32 with MQTT

The Node server subscribes to a broker configured by `MQTT_URL` (default `mqtt://127.0.0.1:1883`). Set `MQTT_USERNAME` and `MQTT_PASSWORD` in `.env` if your broker requires authentication. Broker credentials are separate from each station's API key. MQTT.js reconnects and subscribes again automatically.

The included Compose file starts a local Mosquitto development broker. Requires Docker running. It binds port 1883 to localhost by default. For ESP32 access on a trusted LAN, set `MQTT_BIND_ADDRESS` in `.env` to your computer's LAN IP and set `MQTT_URL` to `mqtt://THAT_LAN_IP:1883`, then recreate the broker:

```sh
docker compose -f Docker-compose.yml up -d
```

1. Start the database and Node server. Open the website at `http://YOUR_LAN_IP:3001`.
2. Register a station, then open **Hoe verstuur ik data?**.
3. Enter the broker address reachable from the ESP32, such as `mqtt://192.168.1.10:1883`, and optional broker credentials. The broker can run on a different computer from the website.
4. Install the Arduino library **PubSubClient** by Nick O’Leary and generate your code.
5. Add the snippet to your existing sketch. Call `setupHomeStationMqtt()` in `setup()`, `loopHomeStationMqtt()` on every `loop()`, and periodically call `sendHomeStationData(temperature, humidity, windSpeed)`. Keep calling the MQTT loop between measurements to maintain the connection.

Each measurement has its own topic:

| Topic | Value |
| --- | --- |
| `homestation/<naam>/temperature` | Temperature in °C |
| `homestation/<naam>/humidity` | Humidity from 0 to 100 percent |
| `homestation/<naam>/windSpeed` | Wind speed in m/s, at least 0 |

Every message contains JSON, for example `{"apiKey":"YOUR_STATION_API_KEY","value":20.4}`. Values must be finite numbers. The server validates the station and API key before updating only that measurement. Missing measurements remain null until received; existing values and station registrations are preserved. `updated_at` indicates the most recent received measurement, not a synchronized set of three readings. Run `npm run db:setup` once when upgrading to allow independent measurements in an existing database.

Publish without retain. Retained messages replayed on subscription are ignored, so reconnecting does not make old data appear fresh. The generated ESP32 code publishes at QoS 0; a successful publish indicates transmission to the broker, not confirmation of database storage. Measurements sent while the subscriber is offline are not queued for later storage. The map still fetches data over HTTP every 15 seconds. Station registration remains an HTTP request; the HTTP `PUT /api/stations/:id/current` measurement endpoint has been removed.

The bundled anonymous broker is for local development on a trusted network: other clients with broker access can read payloads, including API keys. For a public deployment, configure broker authentication, topic ACLs, and TLS before exposing it. Station clients should only publish to their own three topics; the server account should subscribe to `homestation/+/temperature`, `homestation/+/humidity`, and `homestation/+/windSpeed`. Use `mqtts://broker.example.com:8883` in the ESP32 generator, supply the broker's root CA, and synchronize the ESP32 clock with NTP. For the Node subscriber, `mqtts://` uses the system trust store; a private CA can be provided through `NODE_EXTRA_CA_CERTS`.

## Public server

Install Node.js and PostgreSQL on the server, copy the project, install dependencies, and configure its `.env`. For the included Nginx reverse proxy, set `HOST=127.0.0.1` and `PORT=3001`. Keep the API running using your server's process manager.

The Nginx configuration in `deploy/nginx.conf.example` forwards the website and `/api` to Node on port 3001. Adjust its IP/domain, install it as your Nginx site, validate with `nginx -t`, and reload Nginx. Configure HTTPS before sending real API keys over the internet. The public IP in the example is the one from the original code; verify that it belongs to your server. Nothing in this repository deploys to that machine automatically.

### Keep the app running with systemd

The included systemd units are configured for `/home/msnijder/centrale_server` and user `msnijder`. If the project is in a different location or runs as another user, update both unit files first. Install and start them with:

```sh
sudo install -m 644 deploy/homestation-db.service /etc/systemd/system/homestation-db.service
sudo install -m 644 deploy/homestation.service /etc/systemd/system/homestation.service
sudo systemctl daemon-reload
sudo systemctl enable --now homestation-db.service homestation.service
```

The database unit starts the local PostgreSQL cluster; the app unit starts Node after the database and restarts Node if it exits unexpectedly. Check status and logs with `systemctl status homestation-db homestation` and `journalctl -u homestation -f`. To stop both services, run `sudo systemctl stop homestation homestation-db`.

## Checks

```sh
npm test
npm run db:start
npm run test:db
```

The database integration test creates and removes its own temporary schema. It checks simultaneous registrations, MQTT API-key validation, independent and concurrent measurement updates, database constraints, and the public map response without changing your station data. Other tests check static assets, input validation, database health, safe popup rendering, map refreshes, MQTT validation and reconnect handling, and ESP32 code generation. These tests do not require a running MQTT broker.

API routes:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Checks database connectivity |
| POST | `/api/register` | Registers a station with `name`, numeric `latitude` and `longitude`, and `classCode` |
| GET | `/api/stations` | Lists stations and their latest readings without API keys |

Registration responses include an API key once. Do not commit `.env` or `.local/`, or share your API key.
