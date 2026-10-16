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

## Station account and history

Open **Mijn account** (`/account.html`) and log in with your current station name and API key. Names are matched without case sensitivity; the API key distinguishes stations with the same name. You can update your name, latitude and longitude. Changing the name also changes the station ID to a lowercase topic key derived from the new name. A conflicting ID is rejected without changing the account. Updating only the location preserves the ID. The API key, sessions, measurements and history are preserved. After renaming, update the ESP32 station ID and any broker ACLs to the new MQTT topics; old topics no longer accept data for this station. The account page shows the new ID and passes it to the code generator. Use the new name for subsequent logins.

The browser receives an HttpOnly, SameSite=Strict session cookie valid for eight hours. Only a hash of the session token is stored in PostgreSQL. Logout invalidates the session on the server. In production behind an HTTPS proxy, set `COOKIE_SECURE=true` in `.env` so the browser only transmits the cookie over HTTPS.

Each accepted MQTT measurement is now stored in `reading_history` in the same database statement as the current value. History starts with new messages after applying the schema; previously overwritten readings cannot be recovered. On the account page, filter by measurement type, refresh, and load older readings in pages of 50. Timestamps show receipt at the server, not measurement time on the ESP32. The history endpoint is restricted to the station in your session. History is retained until its station is removed; plan database storage for long-running stations.

Run `npm run db:setup` and restart Node after upgrading. The schema adds history and sessions without changing existing stations or keys.

## Custom measurements

In **Mijn account**, add a quantity with a display name, unit and fixed topic key, for example **Luchtdruk**, **hPa**, **luchtdruk**. Keys contain 1–40 lowercase letters, digits or hyphens and start with a letter. Each station owns its definitions; different stations can use the same key with different labels and units.

Publish to `homestation/<stationId>/custom/luchtdruk` with the usual JSON payload:

```json
{"apiKey":"YOUR_STATION_API_KEY","value":1013.2}
```

Only finite numbers for an existing quantity belonging to the authenticated station are stored. The latest value appears on your account page and the public map. Each accepted message also appears in your private history, where the quantity is available as a filter. Unknown quantities and incorrect station keys do not create data.

On **Hoe verstuur ik data?**, enter your custom topic keys separated by commas to generate matching topic examples. The generated helper `sendHomeStationCustomData("luchtdruk", gemetenLuchtdruk)` publishes one sensor value, in addition to the existing helper for temperature, humidity and wind. Connect a suitable physical sensor and obtain the measured value in your Arduino sketch; adding a quantity does not configure sensor hardware automatically.

Broker ACLs must allow station clients to publish to their own `homestation/<stationId>/custom/+` topics and the server account to subscribe to `homestation/+/custom/+`. Apply `npm run db:setup` and restart Node when upgrading; existing readings and history are preserved.

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

Account API routes (session cookie required except login and logout):

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/account/login` | Log in with `{name, apiKey}` |
| POST | `/api/account/logout` | Invalidate the browser session |
| GET | `/api/account` | Read your station profile |
| PATCH | `/api/account` | Save `{name, latitude, longitude}` |
| GET | `/api/account/history` | Read your history with optional `metric`, `before`, and `limit` (1–100) |

Custom quantity API (session required):

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/account/metrics` | List your quantities and their latest values |
| POST | `/api/account/metrics` | Create a quantity with `{slug, name, unit}` |

Filter custom history with `metric=custom/luchtdruk` on `/api/account/history`.

To remove a custom quantity, use **Verwijderen** next to it in **Mijn account** and confirm. This permanently removes that station's definition, current value and history for the quantity. Standard temperature, humidity and wind measurements cannot be removed this way. Other stations are unaffected. New messages on the removed topic are ignored until the quantity is created again; stop publishing that topic on the ESP32 as well.

`DELETE /api/account/metrics/:slug` removes a quantity for the station in the current session. Send `Content-Type: application/json`; missing or other stations' quantities return 404. Deletion and concurrent MQTT ingestion lock the quantity definition to prevent leftover readings.

## Owner administration

Open **Beheer** from the account page, or visit `/admin.html`. It uses a single owner login, separate from all station accounts. On an existing installation, run:

```sh
npm run admin:setup
npm run db:setup
```

Read `ADMIN_USERNAME` and `ADMIN_PASSWORD` locally in the private `.env`, then restart Node. The setup command generates a random password, preserves existing credentials and never prints the password. New installations also receive random admin credentials through `npm run setup`. Keep these credentials private; anyone who knows them can use the admin account. There is no admin registration through the website. Leave `ADMIN_PASSWORD` empty to disable administration. It must contain 8–1024 characters when enabled; the default generated password is 48 random hexadecimal characters.

The administration page searches stations by name or ID and loads pages of 50. **Toon API-key** retrieves a station's original API key on demand; **Verberg API-key** removes it from the page. The public map and station accounts cannot access other stations' keys. **Station verwijderen** requires typing the exact station ID and permanently deletes that station, current readings, history, custom quantities and account sessions. Other stations remain intact. A deleted station's API key stops working.

Admin sessions use a separate HttpOnly, SameSite=Strict cookie that expires after one hour. Only token hashes are stored. Logging out invalidates the session, and changing admin credentials invalidates previous sessions after restarting Node. Repeated incorrect login attempts are limited per client IP. In production use HTTPS and `COOKIE_SECURE=true`, including when HTTPS terminates at a reverse proxy.

| Method | Admin API route | Purpose |
| --- | --- | --- |
| POST | `/api/admin/login` | Log in with `{username, password}` |
| POST | `/api/admin/logout` | Invalidate the admin session |
| GET | `/api/admin/session` | Check the admin session |
| GET | `/api/admin/stations` | List stations with optional `search` and `offset` |
| GET | `/api/admin/stations/:id/key` | Retrieve a station's API key |
| DELETE | `/api/admin/stations/:id` | Delete a station with `{confirmStationId: "the-exact-id"}` |

If administration says it is not configured, run `npm run admin:setup`. It validates the saved values and preserves existing credentials. Invalid values produce an error instead of a success message. A running Node process must be restarted after changing `.env`: stop it with Ctrl+C, then run `npm run admin:start` to validate the settings and start the server. For the systemd deployment, run `sudo systemctl restart homestation` instead. `admin:start` does not restart an already running process. The server reads the `.env` alongside `node.js`, regardless of its working directory.
