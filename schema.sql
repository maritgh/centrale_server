CREATE TABLE IF NOT EXISTS stations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  api_key TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS current_readings (
  station_id TEXT PRIMARY KEY REFERENCES stations(id) ON DELETE CASCADE,
  temperature DOUBLE PRECISION NOT NULL,
  humidity DOUBLE PRECISION NOT NULL CHECK (humidity BETWEEN 0 AND 100),
  wind_speed DOUBLE PRECISION NOT NULL CHECK (wind_speed >= 0),
  extra JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


CREATE TABLE IF NOT EXISTS readings_history (
                                                id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                                                station_id TEXT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,

    temperature DOUBLE PRECISION NOT NULL,
    humidity DOUBLE PRECISION NOT NULL CHECK (humidity BETWEEN 0 AND 100),
    wind_speed DOUBLE PRECISION NOT NULL CHECK (wind_speed >= 0),
    extra JSONB,

    measured_at TIMESTAMPTZ NOT NULL,
    saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (station_id, measured_at)
    );

CREATE INDEX IF NOT EXISTS idx_history_station_time
    ON readings_history (station_id, measured_at DESC);
