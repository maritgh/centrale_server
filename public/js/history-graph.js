// Alleen de grafiekweergave. account.js beheert de sessie en de meetgeschiedenistabel.
(() => {
    const metricSelect = document.getElementById("graphMetric");
    const periodSelect = document.getElementById("graphPeriod");
    const status = document.getElementById("graphStatus");
    const canvas = document.getElementById("historyGraph");
    const AUTO_REFRESH_MS = 30000;

    let chart = null;
    let version = 0;
    let activeRequests = 0;
    let refreshTimer = null;
    let chartMetric = null;
    let chartPeriod = null;
    let chartDataSignature = null;

    const labels = {
        temperature: ["Temperatuur", "°C"],
        humidity: ["Luchtvochtigheid", "%"],
        windSpeed: ["Windsnelheid", "m/s"],
    };
    const timeLabel = timestamp => new Intl.DateTimeFormat("nl-NL", {
        timeZone: "Europe/Amsterdam", day: "2-digit", month: "2-digit",
        hour: "2-digit", minute: "2-digit",
    }).format(new Date(timestamp));
    const axisTimeLabel = (timestamp, period) => new Intl.DateTimeFormat("nl-NL", {
        timeZone: "Europe/Amsterdam",
        ...(period === "today" || period === "yesterday"
            ? { hour: "2-digit", minute: "2-digit" }
            : { day: "2-digit", month: "2-digit" }),
    }).format(new Date(timestamp));
    const bucketLabels = { today: "5 minuten", yesterday: "5 minuten", "7d": "30 minuten", "30d": "2 uur" };

    function addOption(value, label) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        metricSelect.appendChild(option);
    }

    function setMetrics(customMetrics = []) {
        const selected = metricSelect.value;
        metricSelect.replaceChildren();
        for (const [value, [label]] of Object.entries(labels)) {
            if (!value.startsWith("custom/")) addOption(value, label);
        }
        for (const metric of customMetrics) {
            const key = "custom/" + metric.slug;
            labels[key] = [metric.name, metric.unit];
            addOption(key, metric.name);
        }
        metricSelect.value = [...metricSelect.options].some(option => option.value === selected) ? selected : "temperature";
    }

    function clear() {
        version++; // Negeer nog lopende verzoeken na uitloggen of wisselen van station.
        status.textContent = "";
        if (chart) chart.destroy();
        chart = null;
        chartMetric = null;
        chartPeriod = null;
        chartDataSignature = null;
    }

    function destroyChart() {
        if (chart) chart.destroy();
        chart = null;
        chartMetric = null;
        chartPeriod = null;
        chartDataSignature = null;
    }

    function graphStatusText(points, period) {
        const totalSamples = points.reduce((total, point) => total + point.samples, 0);
        const summary = points.length
            ? `${totalSamples.toLocaleString("nl-NL")} metingen weergegeven als ${points.length.toLocaleString("nl-NL")} gemiddelden per ${bucketLabels[period]}.`
            : "Nog geen metingen voor deze meetwaarde en periode.";
        return `${summary} Wordt automatisch elke 30 seconden ververst.`;
    }

    function buildChart(points, metric, period) {
        const [metricLabel, unit] = labels[metric] || [metric, ""];
        return new Chart(canvas.getContext("2d"), {
            type: "line",
            data: { datasets: [{
                label: metricLabel, data: points, parsing: false,
                borderColor: "#1f2933",
                pointRadius: points.length > 40 ? 0 : 2,
                pointHoverRadius: 4, pointHitRadius: 8,
                borderWidth: 2, fill: false, tension: 0,
            }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                interaction: { intersect: false, mode: "nearest", axis: "x" },
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: {
                        title: items => items.length ? timeLabel(items[0].parsed.x) : "",
                        label: item => `${metricLabel}: ${Number(item.parsed.y).toLocaleString("nl-NL", { maximumFractionDigits: 2 })} ${unit}`,
                        afterLabel: item => item.raw.samples > 1 ? `Gemiddelde van ${item.raw.samples} metingen` : "1 meting",
                    } },
                },
                scales: {
                    x: { type: "linear", border: { display: false },
                        // Meer tijdlabels dan voorheen (5), maar op mobiel automatisch minder.
                        ticks: { color: "#667085", maxTicksLimit: 10, autoSkip: true, maxRotation: 0,
                            callback: value => axisTimeLabel(value, period) },
                        grid: { display: false } },
                    y: { border: { display: false },
                        title: { display: true, text: unit || metricLabel, color: "#667085" },
                        ticks: { color: "#667085", callback: value => Number(value).toLocaleString("nl-NL") },
                        grid: { color: "#e5e7eb" } },
                },
            },
        });
    }

    async function refresh({ silent = false } = {}) {
        // Een automatische update wacht een nog lopende aanvraag af.
        if (silent && activeRequests > 0) return;
        const thisVersion = ++version;
        if (typeof Chart === "undefined" || !canvas.getContext) {
            status.textContent = "De grafiekbibliotheek kon niet laden. Controleer je internetverbinding.";
            return;
        }
        const metric = metricSelect.value;
        const period = periodSelect.value;
        if (!silent && (!chart || chartMetric !== metric || chartPeriod !== period)) {
            status.textContent = "Grafiek laden…";
        }
        activeRequests++;
        try {
            const params = new URLSearchParams({ metric, period });
            const response = await fetch("/api/account/history/graph?" + params, {
                credentials: "same-origin", cache: "no-store",
            });
            const payload = await response.json();
            if (!response.ok) {
                if (response.status === 401 && thisVersion === version) {
                    stopAutoRefresh();
                    clear();
                    status.textContent = "Je sessie is verlopen. Log opnieuw in om je grafiek te bekijken.";
                    return;
                }
                throw new Error(payload.error || "Grafiek laden mislukt");
            }
            if (thisVersion !== version) return; // Filters of loginstatus zijn inmiddels veranderd.

            const points = payload.readings.map(r => ({
                x: Date.parse(r.received_at),
                y: Number(r.value),
                samples: Number(r.samples) > 0 ? Number(r.samples) : 1,
            }))
                .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
                .sort((a, b) => a.x - b.x);
            const signature = JSON.stringify(points);
            status.textContent = graphStatusText(points, period);

            if (!points.length) {
                destroyChart();
                return;
            }
            if (chart && chartMetric === metric && chartPeriod === period) {
                if (signature !== chartDataSignature) {
                    // Werk alleen de data bij: geen nieuw canvas, geen knipperen of animatie.
                    chart.data.datasets[0].data = points;
                    chart.data.datasets[0].pointRadius = points.length > 40 ? 0 : 2;
                    chart.update("none");
                    chartDataSignature = signature;
                }
                return;
            }
            destroyChart();
            chart = buildChart(points, metric, period);
            chartMetric = metric;
            chartPeriod = period;
            chartDataSignature = signature;
        } catch (error) {
            if (thisVersion === version) {
                status.textContent = chart
                    ? `Automatisch bijwerken mislukt: ${error.message}. De laatste grafiek blijft zichtbaar.`
                    : error.message;
            }
        } finally {
            activeRequests--;
        }
    }

    function startAutoRefresh() {
        if (refreshTimer !== null) return; // Nooit meerdere timers na opnieuw inloggen.
        refreshTimer = setInterval(() => {
            if (document.visibilityState !== "hidden") return refresh({ silent: true });
        }, AUTO_REFRESH_MS);
    }

    function stopAutoRefresh() {
        if (refreshTimer === null) return;
        clearInterval(refreshTimer);
        refreshTimer = null;
    }

    // Na terugkomst op dit tabblad meteen de meest recente waarden ophalen.
    document.addEventListener("visibilitychange", () => {
        if (refreshTimer !== null && document.visibilityState === "visible") return refresh({ silent: true });
    });
    metricSelect.addEventListener("change", () => refresh());
    periodSelect.addEventListener("change", () => refresh());
    window.historyGraph = { setMetrics, refresh, clear, startAutoRefresh, stopAutoRefresh };
})();
