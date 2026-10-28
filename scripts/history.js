
const HISTORY_INTERVAL_SECONDS = 60;

function startHistory(pool) {
    let timer;
    let stopped = false;

    async function saveHistory() {
        const result = await pool.query(`
      INSERT INTO readings_history (
        station_id,
        temperature,
        humidity,
        wind_speed,
        extra,
        measured_at
      )
      SELECT
        cr.station_id,
        cr.temperature,
        cr.humidity,
        cr.wind_speed,
        cr.extra,
        cr.updated_at
      FROM current_readings cr
      WHERE NOT EXISTS (
        SELECT 1 FROM readings_history rh
        WHERE rh.station_id = cr.station_id
          AND rh.measured_at >= cr.updated_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM readings_history rh
        WHERE rh.station_id = cr.station_id
          AND rh.saved_at > NOW() - ($1::int * INTERVAL '1 second')
      )
      ON CONFLICT (station_id, measured_at) DO NOTHING
    `, [HISTORY_INTERVAL_SECONDS]);

        console.log(
            `[History] ${result.rowCount} meetpunt(en) opgeslagen`
        );
    }

    async function tick() {
        try {
            await saveHistory();
        } catch (error) {
            console.error("[History] Fout:", error.message);
        } finally {
            if (!stopped) {
                timer = setTimeout(tick, HISTORY_INTERVAL_SECONDS * 1000);
            }
        }
    }

    console.log(
        `[History] Automatische opslag gestart: elke ${HISTORY_INTERVAL_SECONDS} seconden`
    );

    tick();

    // Functie om de opslag netjes te stoppen
    return function stopHistory() {
        stopped = true;
        clearTimeout(timer);
    };
}

module.exports = { startHistory };
