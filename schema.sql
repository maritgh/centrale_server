-- Stationsregistraties: locatie voor de kaart en een unieke sleutel voor MQTT-metingen.
CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  api_key TEXT NOT NULL UNIQUE
);

-- Bewaar per station alleen de laatste waarde van ieder meettype, geen meetgeschiedenis.
-- ON DELETE CASCADE verwijdert de metingen wanneer het bijbehorende station wordt verwijderd.
CREATE TABLE IF NOT EXISTS current_readings (
  station_id TEXT PRIMARY KEY REFERENCES stations(id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- NULL betekent dat er voor dit topic nog geen meetwaarde ontvangen is.
  temperature DOUBLE PRECISION,
  humidity DOUBLE PRECISION CHECK (humidity BETWEEN 0 AND 100),
  wind_speed DOUBLE PRECISION CHECK (wind_speed >= 0),
  extra JSONB,
  -- Ontvangsttijd van de laatste opgeslagen meting, ongeacht welk topic die leverde.
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pas ook bestaande tabellen aan zodat de MQTT-topics onafhankelijk kunnen binnenkomen.
-- Dit verwijdert alleen de verplichting om alle drie de waarden tegelijk op te slaan.
ALTER TABLE current_readings
  ALTER COLUMN temperature DROP NOT NULL,
  ALTER COLUMN humidity DROP NOT NULL,
  ALTER COLUMN wind_speed DROP NOT NULL;

-- Iedere ontvangen meetwaarde blijft bewaard, los van de actuele waarde op de kaart.
CREATE TABLE IF NOT EXISTS reading_history (
  id BIGSERIAL PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON UPDATE CASCADE ON DELETE CASCADE,
  metric TEXT NOT NULL CHECK (metric IN ('temperature', 'humidity', 'windSpeed')),
  value DOUBLE PRECISION NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (metric <> 'humidity' OR value BETWEEN 0 AND 100),
  CHECK (metric <> 'windSpeed' OR value >= 0)
);
-- Ondersteun het ophalen van de nieuwste metingen van één station, eventueel per meettype.
CREATE INDEX IF NOT EXISTS reading_history_station_id_idx ON reading_history (station_id, id DESC);
CREATE INDEX IF NOT EXISTS reading_history_station_metric_idx ON reading_history (station_id, metric, id DESC);

-- Browseraccounts gebruiken tijdelijke sessies; de oorspronkelijke API-key blijft ongewijzigd.
CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  station_id TEXT NOT NULL REFERENCES stations(id) ON UPDATE CASCADE ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS account_sessions_expires_idx ON account_sessions (expires_at);

-- Eigen grootheden horen bij één station. De topicsleutel blijft vast na aanmaken.
CREATE TABLE IF NOT EXISTS custom_metrics (
  station_id TEXT NOT NULL REFERENCES stations(id) ON UPDATE CASCADE ON DELETE CASCADE,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z][a-z0-9-]{0,39}$'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  unit TEXT NOT NULL CHECK (length(trim(unit)) BETWEEN 1 AND 20),
  PRIMARY KEY (station_id, slug)
);
CREATE TABLE IF NOT EXISTS custom_readings (
  station_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (station_id, slug),
  FOREIGN KEY (station_id, slug) REFERENCES custom_metrics(station_id, slug) ON UPDATE CASCADE ON DELETE CASCADE
);
-- Verruim de bestaande controle zonder eerdere meetgeschiedenis te verwijderen.
ALTER TABLE reading_history DROP CONSTRAINT IF EXISTS reading_history_metric_check;
ALTER TABLE reading_history ADD CONSTRAINT reading_history_metric_check
  CHECK (metric IN ('temperature', 'humidity', 'windSpeed') OR metric ~ '^custom/[a-z][a-z0-9-]{0,39}$');

-- Beheersessies staan los van stations; alleen een hash van het cookiegeheim wordt opgeslagen.
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  credential_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions (expires_at);

-- Neem een gewijzigd station-ID ook over in bestaande tabellen, zonder gegevens te verwijderen.
-- Nieuwe tabellen hebben deze regels al; bestaande installaties krijgen dezelfde relaties.
ALTER TABLE current_readings DROP CONSTRAINT IF EXISTS current_readings_station_id_fkey;
ALTER TABLE current_readings ADD CONSTRAINT current_readings_station_id_fkey
  FOREIGN KEY (station_id) REFERENCES stations(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE reading_history DROP CONSTRAINT IF EXISTS reading_history_station_id_fkey;
ALTER TABLE reading_history ADD CONSTRAINT reading_history_station_id_fkey
  FOREIGN KEY (station_id) REFERENCES stations(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE account_sessions DROP CONSTRAINT IF EXISTS account_sessions_station_id_fkey;
ALTER TABLE account_sessions ADD CONSTRAINT account_sessions_station_id_fkey
  FOREIGN KEY (station_id) REFERENCES stations(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE custom_metrics DROP CONSTRAINT IF EXISTS custom_metrics_station_id_fkey;
ALTER TABLE custom_metrics ADD CONSTRAINT custom_metrics_station_id_fkey
  FOREIGN KEY (station_id) REFERENCES stations(id) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE custom_readings DROP CONSTRAINT IF EXISTS custom_readings_station_id_slug_fkey;
ALTER TABLE custom_readings ADD CONSTRAINT custom_readings_station_id_slug_fkey
  FOREIGN KEY (station_id, slug) REFERENCES custom_metrics(station_id, slug) ON UPDATE CASCADE ON DELETE CASCADE;
