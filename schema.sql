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
  station_id TEXT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
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
