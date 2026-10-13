# Home Station Network

The Node server serves the website in `homestation/` and the weather API. PostgreSQL stores station registrations and the latest reading for each station.

## Run locally

Requires Node.js 20 or newer and PostgreSQL server tools (`initdb` and `pg_ctl`). The local database script adds the directory reported by `pg_config --bindir` to its own PATH, so you do not need to configure it in your shell.

```sh
npm install
npm run setup
npm run db:start
npm start
```

Open http://localhost:3001. Read `CLASS_CODE` from `.env` to register a station. Save the returned station ID and API key; the browser remembers them only for the current tab/session.

`setup` generates a private `.env` with random credentials and does not overwrite existing settings. `db:start` starts a separate local PostgreSQL cluster on port **55432**, creates the database, and applies `schema.sql`. Data persists in the ignored `.local/postgres/` directory. Keep `.env` with that database: changing its password does not change the existing PostgreSQL user's password.

To stop the API, press Ctrl+C. To stop PostgreSQL:

```sh
npm run db:stop
```

For an existing PostgreSQL database, fill in its connection details in `.env` and run `npm run db:setup` instead. The database must already exist. The schema script creates missing tables; it does not migrate incompatible existing tables.

## Connect an ESP32

1. Keep the API running. The default `HOST=0.0.0.0` lets devices on your LAN reach it.
2. Find your computer's LAN IP in its network settings. Open the website at `http://YOUR_LAN_IP:3000` from the same network as the ESP32.
3. Register a station, then open **Hoe verstuur ik data?** The server address defaults to the website's origin. You can change it to another reachable server address.
4. Generate the Arduino code, add it to your ESP32 project, connect to WiFi, and call `sendHomeStationData(temperature, humidity, windSpeed)` with your sensor readings.

The function is a snippet for an existing Arduino project, rather than a complete sketch with `setup()` and `loop()`. Temperature uses °C, humidity uses percent (0–100), and wind speed uses m/s (at least 0). The server returns HTTP 200 for accepted readings. The map refreshes every 15 seconds.

For an HTTPS address, the generated code uses `WiFiClientSecure`: supply the server's PEM root CA certificate and synchronize the ESP32 clock via NTP before sending readings. The clipboard button also supports ordinary HTTP pages where the browser permits the fallback copy operation.

## Public server

Install Node.js and PostgreSQL on the server, copy the project, install dependencies, and configure its `.env`. For the included Nginx reverse proxy, set `HOST=127.0.0.1` and `PORT=3001`. Keep the API running using your server's process manager.

The Nginx configuration in `deploy/nginx.conf.example` forwards the website and `/api` to Node on port 3001. Adjust its IP/domain, install it as your Nginx site, validate with `nginx -t`, and reload Nginx. Configure HTTPS before sending real API keys over the internet. The public IP in the example is the one from the original code; verify that it belongs to your server. Nothing in this repository deploys to that machine automatically.

## Checks

```sh
npm test
npm run db:start
npm run test:db
```

The database integration test creates and removes its own temporary schema. It checks simultaneous registrations, authentication, updating existing readings, database constraints, and the public map response without changing your station data. Other tests check static assets, input validation, database health, safe popup rendering, map refreshes, and ESP32 code generation.

API routes:

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Checks database connectivity |
| POST | `/api/register` | Registers a station with `name`, numeric `latitude` and `longitude`, and `classCode` |
| GET | `/api/stations` | Lists stations and their latest readings without API keys |
| PUT | `/api/stations/:id/current` | Updates a reading with the station's `x-api-key` header |

Registration responses include an API key once. Do not commit `.env` or `.local/`, or share your API key.
