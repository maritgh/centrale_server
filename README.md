# Home Station

De centrale server bestaat uit drie services: de webapp en API (Node.js), PostgreSQL en een MQTT-broker (Mosquitto). Docker Compose start en beheert ze samen. De database en broker bewaren hun gegevens in Docker-volumes.

## Vereisten

- Docker met Docker Compose v2
- Node.js 20 of hoger, alleen voor het eenmalig genereren van `.env`

## Starten

Voer vanuit deze projectmap uit:

```sh
npm run setup
docker compose up --build -d
```

`npm run setup` maakt een `.env` met willekeurige database-, registratie- en beheerwachtwoorden. Bewaar de klascode en beheerlogin uit dat bestand op een veilige plek. De `.env` staat in `.gitignore` en hoort niet in Git of in gedeelde projectbestanden.

Open daarna <http://localhost:3001>. Gebruik de waarde van `CLASS_CODE` uit `.env` om een weerstation te registreren. De registratie geeft een station-ID en API-sleutel terug; bewaar die veilig.

Handige opdrachten:

```sh
docker compose logs -f                 # logs volgen
docker compose ps                      # status bekijken
docker compose down                    # services stoppen; data behouden
docker compose down -v                 # services stoppen en alle database-/brokerdata verwijderen
docker compose exec app npm run db:setup  # schema bijwerken na een code-update
docker compose run --rm app npm test   # tests uitvoeren
```

De database is alleen bereikbaar binnen het Docker-netwerk. De webapp luistert standaard op poort 3001. Pas `APP_PORT` in `.env` aan als die poort al bezet is. Voor HTTPS zet je een reverse proxy vóór de app en stel je `COOKIE_SECURE=true` in `.env` in.

## ESP32 en MQTT

De server verbindt intern met Mosquitto via `mqtt://mosquitto:1883`. De brokerpoort is standaard alleen op deze computer bereikbaar op `127.0.0.1:8883`. De broker staat voor lokaal gebruik open zonder account. Stel `MQTT_BIND_ADDRESS` in `.env` in op het LAN-IP van deze computer als een ESP32 op hetzelfde vertrouwde netwerk moet verbinden. Gebruik voor de ESP32 het adres `mqtt://<LAN-IP>:8883`.

Deze ontwikkelbroker versleutelt het verkeer niet en gebruikt geen brokerwachtwoord. Stel poort 1883 daarom niet rechtstreeks bloot aan het internet. De API-sleutel van een station staat in de MQTT-berichten. Gebruik voor publiek gebruik een broker met TLS en accounts, en een HTTPS-verbinding voor de website.

De ESP32 kan de waarden `temperature`, `humidity` en `windSpeed` publiceren op `homestation/<station-id>/<waarde>`. Een bericht heeft bijvoorbeeld deze vorm:

```json
{"apiKey":"<station-api-sleutel>","value":20.4}
```

Aangepaste meetwaarden gebruiken het topic `homestation/<station-id>/custom/<sleutel>`. Maak de meetwaarde eerst aan op **Mijn account**. De server controleert de station-ID en API-sleutel voordat een meting wordt opgeslagen.

## Mappenstructuur

```text
src/          Node-server, API-routes en MQTT-verwerking
public/       Websitebestanden
database/     PostgreSQL-schema
infra/        Configuratie van Mosquitto
scripts/      Installatie- en databasescripts
tests/        Testbestanden
compose.yaml  Services en volumes voor Docker Compose
Dockerfile    Image voor de Node-app
```

## Database en updates

Bij de eerste start voert PostgreSQL `database/schema.sql` automatisch uit. Na een update die het schema wijzigt, voer je `docker compose exec app npm run db:setup` uit. De database bewaart data in het volume `postgres_data`; de broker gebruikt `mosquitto_data`.

De integratietests voor PostgreSQL kun je uitvoeren met `docker compose run --rm app npm run test:db` terwijl de Compose-database draait. Dit maakt een eigen testschema aan en verwijdert dat na afloop.
