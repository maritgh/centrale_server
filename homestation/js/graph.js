(() => {
    "use strict";

    // TODO login: verander dit in "/api/me/history" zodra de server
    // de ingelogde gebruiker en bijbehorend station veilig bepaalt.
    const HISTORY_URL = "/api/demo/history";
    const REFRESH_INTERVAL_MS = 30_000;

    const METRICS = {
        temperature: { label: "Temperatuur", unit: "°C", color: "#df7265", digits: 1 },
        humidity: { label: "Luchtvochtigheid", unit: "%", color: "#3886bb", digits: 0 },
        wind_speed: { label: "Windsnelheid", unit: "m/s", color: "#459e83", digits: 1 }
    };

    const container = document.querySelector("[data-history-graph]");
    if (!container) return;

    const canvas = document.getElementById("historyChart");
    const periodSelect = document.getElementById("graphPeriod");
    const latestValue = document.getElementById("graphLatest");
    const latestTime = document.getElementById("graphLatestTime");
    const status = document.getElementById("graphStatus");
    const empty = document.getElementById("graphEmpty");
    const heading = document.getElementById("graphTitle");
    const metricButtons = Array.from(container.querySelectorAll("[data-metric]"));

    let metric = "temperature";
    let readings = [];
    let chart = null;
    let requestNumber = 0;

    const numberFormat = (value, digits) => new Intl.NumberFormat("nl-NL", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    }).format(value);

    function dateTime(value) {
        return new Date(value).toLocaleString("nl-NL", {
            day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
        });
    }

    function showEmpty(message) {
        empty.textContent = message;
        empty.hidden = false;
        canvas.hidden = true;
        latestValue.textContent = "--";
        latestTime.textContent = "Geen metingen beschikbaar";
        if (chart) {
            chart.destroy();
            chart = null;
        }
    }

    // De grafiek kent alleen meetpunten; hij weet niets van gebruikers of stations.
    function updateGraph(rows) {
        const info = METRICS[metric];
        const points = rows.map(row => ({
            x: Date.parse(row.measured_at),
            y: Number(row[metric])
        })).filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));

        if (!points.length) {
            showEmpty("Er zijn nog geen meetpunten voor deze periode.");
            return;
        }

        if (typeof Chart === "undefined") {
            showEmpty("De grafiekbibliotheek kon niet worden geladen. Controleer je internetverbinding.");
            return;
        }

        empty.hidden = true;
        canvas.hidden = false;

        const latest = points[points.length - 1];
        latestValue.textContent = `${numberFormat(latest.y, info.digits)} ${info.unit}`;
        latestTime.textContent = `Gemeten op ${dateTime(latest.x)}`;

        const dataset = {
            label: info.label,
            data: points,
            parsing: false,
            borderColor: info.color,
            backgroundColor: `${info.color}18`,
            fill: true,
            tension: 0.18,
            borderWidth: 2,
            pointRadius: 0,
            pointHitRadius: 10
        };

        if (chart) {
            chart.data.datasets = [dataset];
            chart.options.scales.y.title.text = info.unit;
            chart.options.scales.y.beginAtZero = metric !== "temperature";
            chart.update("none");
            return;
        }

        chart = new Chart(canvas, {
            type: "line",
            data: { datasets: [dataset] },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: "nearest", intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title(items) { return items.length ? dateTime(items[0].parsed.x) : ""; },
                            label(item) {
                                const selected = METRICS[metric];
                                return `${selected.label}: ${numberFormat(item.parsed.y, selected.digits)} ${selected.unit}`;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: "linear",  // Tijdstempels, dus geen extra datumadapter nodig.
                        grid: { color: "#edf0f2" },
                        ticks: {
                            maxTicksLimit: 6,
                            callback(value) { return dateTime(Number(value)); }
                        }
                    },
                    y: {
                        beginAtZero: metric !== "temperature",
                        title: { display: true, text: info.unit },
                        grid: { color: "#edf0f2" }
                    }
                }
            }
        });
    }

    async function loadHistory() {
        const currentRequest = ++requestNumber;
        const hours = Number(periodSelect.value);
        status.classList.remove("error");
        status.textContent = "Meetgegevens laden...";

        try {
            const response = await fetch(`${HISTORY_URL}?hours=${hours}`, { cache: "no-store" });
            if (!response.ok) throw new Error(`API gaf status ${response.status}`);
            const data = await response.json();
            if (currentRequest !== requestNumber) return;

            heading.textContent = data.stationName || "Mijn Home Station";
            readings = Array.isArray(data.readings) ? data.readings : [];
            updateGraph(readings);
            status.textContent = `Bijgewerkt om ${new Date().toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" })} · ${readings.length} meetpunten`;
        } catch (error) {
            if (currentRequest !== requestNumber) return;
            showEmpty("De historische metingen konden niet worden opgehaald.");
            status.classList.add("error");
            status.textContent = `Fout bij ophalen: ${error.message}`;
        }
    }

    metricButtons.forEach(button => {
        button.addEventListener("click", () => {
            const nextMetric = button.dataset.metric;
            if (!METRICS[nextMetric]) return;
            metric = nextMetric;
            metricButtons.forEach(item => {
                const active = item === button;
                item.classList.toggle("active", active);
                item.setAttribute("aria-pressed", String(active));
            });
            updateGraph(readings);
        });
    });

    periodSelect.addEventListener("change", loadHistory);
    loadHistory();
    const timer = setInterval(loadHistory, REFRESH_INTERVAL_MS);
    window.addEventListener("pagehide", () => clearInterval(timer));
})();
