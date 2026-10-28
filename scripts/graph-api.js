// Tijdelijke API met uitsluitend fictieve data uit het eerste teststation.
// TODO login: vervang deze demonstratieroute door /api/me/history,
// waarbij het station server-side uit de geauthenticeerde gebruiker volgt.
function registerGraphApi(app, pool) {
    app.get("/api/demo/history", async (req, res, next) => {
        const hours = Number(req.query.hours ?? 24);
        if (![1, 6, 24, 48].includes(hours)) {
            return res.status(400).json({ error: "Kies 1, 6, 24 of 48 uur" });
        }

        const stationId = "test-station-001"; // Alleen voor de ontwikkelfase

        try {
            const station = await pool.query(
                "SELECT id, name FROM stations WHERE id = $1",
                [stationId]
            );
            if (station.rowCount === 0) {
                return res.status(404).json({ error: "Teststation niet gevonden" });
            }

            const history = await pool.query(`
                SELECT measured_at, temperature, humidity, wind_speed, extra
                FROM readings_history
                WHERE station_id = $1
                  AND measured_at >= NOW() - ($2::integer * INTERVAL '1 hour')
                  AND measured_at <= NOW()
                ORDER BY measured_at ASC
                LIMIT 3000
            `, [stationId, hours]);

            res.set("Cache-Control", "no-store");
            return res.json({
                stationId,
                stationName: station.rows[0].name,
                readings: history.rows
            });
        } catch (error) {
            next(error);
        }
    });
}

module.exports = { registerGraphApi };
