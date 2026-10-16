// De sessie zit in een HttpOnly-cookie: JavaScript bewaart de API-key niet na inloggen.
const accountElement = id => document.getElementById(id);
const statusElement = accountElement("accountStatus");
const errorElement = accountElement("accountError");
let nextHistoryCursor = null;
let historyLoading = false;
// Een nieuwe login, filterkeuze of logout maakt eerdere netwerkantwoorden ongeldig.
let historyVersion = 0;
let accountVersion = 0;
const metricLabels = {
    temperature: ["Temperatuur", "°C"],
    humidity: ["Luchtvochtigheid", "%"],
    windSpeed: ["Windsnelheid", "m/s"],
};

function showLoggedOut() {
    accountVersion++;
    statusElement.textContent = "Log in om je station te beheren.";
    historyVersion++;
    historyLoading = false;
    nextHistoryCursor = null;
    accountElement("loginSection").classList.remove("hidden");
    accountElement("accountSection").classList.add("hidden");
    accountElement("logoutButton").classList.add("hidden");
    accountElement("historyRows").replaceChildren();
    accountElement("customMetricsList").replaceChildren();
    accountElement("metricsStatus").textContent = "";
    accountElement("customCodeLink").href = "/connect.html";
    for (const id of ["profileName", "profileLatitude", "profileLongitude"]) accountElement(id).value = "";
    accountElement("accountTitle").textContent = "Mijn station";
    accountElement("accountStationId").textContent = "";
}

// Verstuur geen geheimen in URL's en toon sessieverloop als een nieuwe login.
async function accountRequest(path = "", options = {}) {
    const version = accountVersion;
    const response = await fetch("/api/account" + path, {
        ...options, credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/json", ...options.headers },
    });
    const data = await response.json();
    if (!response.ok) {
        if (response.status === 401 && version === accountVersion) {
            showLoggedOut();
            errorElement.textContent = data.error;
        }
        throw new Error(data.error || "Verzoek mislukt. Probeer opnieuw.");
    }
    return data;
}

function showStation(station) {
    accountVersion++;
    accountElement("loginSection").classList.add("hidden");
    accountElement("accountSection").classList.remove("hidden");
    accountElement("logoutButton").classList.remove("hidden");
    accountElement("accountTitle").textContent = station.name;
    accountElement("accountStationId").textContent = station.id;
    accountElement("profileName").value = station.name;
    accountElement("profileLatitude").value = station.latitude;
    accountElement("profileLongitude").value = station.longitude;
}

// Haal de eigen definities en actuele waarden op en bouw het geschiedenisfilter veilig op.
async function loadMetrics() {
    const version = accountVersion;
    const data = await accountRequest("/metrics");
    if (version !== accountVersion) return;
    const filter = accountElement("historyMetric");
    const selected = filter.value;
    filter.replaceChildren();
    const addOption = (value, label) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        filter.appendChild(option);
    };
    addOption("", "Alle meetwaarden");
    for (const [key, [label]] of Object.entries(metricLabels)) addOption(key, label);
    const list = accountElement("customMetricsList");
    list.replaceChildren();
    for (const metric of data.metrics) {
        addOption("custom/" + metric.slug, metric.name);
        const item = document.createElement("li");
        const label = document.createElement("p");
        label.textContent = `${metric.name} (${metric.unit}): ${metric.value == null ? "Nog geen meting" : metric.value + " " + metric.unit}`;
        const topic = document.createElement("code");
        topic.textContent = `homestation/${accountElement("accountStationId").textContent}/custom/${metric.slug}`;
        item.appendChild(label);
        item.appendChild(topic);
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "button secondary metric-delete";
        removeButton.textContent = "Verwijderen";
        removeButton.setAttribute("aria-label", `${metric.name} verwijderen`);
        removeButton.addEventListener("click", async () => {
            // Pas na expliciete bevestiging verdwijnen ook de opgeslagen metingen.
            if (!window.confirm(`Wil je “${metric.name}” verwijderen? De actuele waarde en alle meetgeschiedenis van deze grootheid worden definitief verwijderd.`)) return;
            if (removeButton.disabled) return;
            removeButton.disabled = true;
            errorElement.textContent = "";
            const currentVersion = accountVersion;
            try {
                await accountRequest("/metrics/" + encodeURIComponent(metric.slug), { method: "DELETE", body: "{}" });
                if (currentVersion !== accountVersion) return;
                await loadDashboard();
                if (currentVersion === accountVersion) statusElement.textContent = `${metric.name} en de bijbehorende metingen zijn verwijderd. Stop ook het versturen van dit topic op je ESP32.`;
            } catch (error) { errorElement.textContent = error.message; }
            finally { removeButton.disabled = false; }
        });
        item.appendChild(removeButton);
        list.appendChild(item);
    }
    filter.value = selected && !Object.hasOwn(metricLabels, selected) && !data.metrics.some(metric => "custom/" + metric.slug === selected) ? "" : selected;
    // De link neemt alleen niet-geheime topicsleutels mee naar de codegenerator.
    accountElement("customCodeLink").href = "/connect.html?" + new URLSearchParams({ station: accountElement("accountStationId").textContent, custom: data.metrics.map(metric => metric.slug).join(",") });
    accountElement("metricsStatus").textContent = data.metrics.length ? `${data.metrics.length} eigen grootheden.` : "Je hebt nog geen eigen grootheden toegevoegd.";
}

// Ververs actuele eigen waarden en geschiedenis samen. Nieuwe filters blijven behouden.
async function loadDashboard() {
    try {
        const version = accountVersion;
        await loadMetrics();
        if (version === accountVersion) await loadHistory();
    } catch (error) { errorElement.textContent = error.message; }
}

async function loadHistory(reset = true) {
    // Een nieuwe filterkeuze mag een nog lopend verzoek vervangen.
    if (!reset && historyLoading) return;
    const version = reset ? ++historyVersion : historyVersion;
    historyLoading = true;
    errorElement.textContent = "";
    const historyStatus = accountElement("historyStatus");
    if (reset) {
        nextHistoryCursor = null;
        accountElement("historyRows").replaceChildren();
        accountElement("moreHistory").classList.add("hidden");
    }
    historyStatus.textContent = "Metingen laden…";
    accountElement("moreHistory").disabled = true;
    const params = new URLSearchParams({ limit: "50" });
    const metric = accountElement("historyMetric").value;
    if (metric) params.set("metric", metric);
    if (nextHistoryCursor) params.set("before", nextHistoryCursor);
    try {
        const data = await accountRequest("/history?" + params);
        if (version !== historyVersion) return;
        // textContent voorkomt dat opgeslagen waarden of namen als HTML worden uitgevoerd.
        for (const reading of data.readings) {
            const row = document.createElement("tr");
            const [label, unit] = metricLabels[reading.metric] || [reading.metric_name || reading.metric, reading.unit || ""];
            for (const value of [new Date(reading.received_at).toLocaleString("nl-NL"), label, `${reading.value} ${unit}`]) {
                const cell = document.createElement("td");
                cell.textContent = value;
                row.appendChild(cell);
            }
            accountElement("historyRows").appendChild(row);
        }
        nextHistoryCursor = data.nextCursor;
        accountElement("moreHistory").classList.toggle("hidden", !nextHistoryCursor);
        historyStatus.textContent = accountElement("historyRows").children.length
            ? `${accountElement("historyRows").children.length} metingen getoond.` : "Nog geen metingen ontvangen voor deze selectie.";
    } catch (error) {
        if (version === historyVersion) {
            errorElement.textContent = error.message;
            historyStatus.textContent = "Metingen ophalen mislukt. Klik op Verversen om opnieuw te proberen.";
        }
    } finally {
        if (version === historyVersion) {
            historyLoading = false;
            accountElement("moreHistory").disabled = false;
        }
    }
}

accountElement("loginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    if (button.disabled) return;
    button.disabled = true;
    errorElement.textContent = "";
    try {
        const data = await accountRequest("/login", { method: "POST", body: JSON.stringify({
            name: accountElement("loginName").value.trim(), apiKey: accountElement("loginApiKey").value.trim(),
        }) });
        accountElement("loginApiKey").value = "";
        showStation(data.station);
        statusElement.textContent = "Je bent ingelogd.";
        await loadDashboard();
    } catch (error) { errorElement.textContent = error.message; }
    finally { button.disabled = false; }
});

accountElement("profileForm").addEventListener("submit", async event => {
    event.preventDefault();
    const version = accountVersion;
    const previousId = accountElement("accountStationId").textContent;
    const button = event.currentTarget.querySelector("button");
    if (button.disabled) return;
    button.disabled = true;
    errorElement.textContent = "";
    try {
        const data = await accountRequest("", { method: "PATCH", body: JSON.stringify({
            name: accountElement("profileName").value.trim(),
            latitude: Number(accountElement("profileLatitude").value),
            longitude: Number(accountElement("profileLongitude").value),
        }) });
        // Negeer een laat antwoord als de gebruiker ondertussen is uitgelogd.
        if (version !== accountVersion) return;
        showStation(data.station);
        // Werk ook het automatisch ingevulde ID voor de codegenerator bij.
        try {
            if (sessionStorage.getItem("stationId") === previousId) sessionStorage.setItem("stationId", data.station.id);
        } catch { /* De gebruiker kan het nieuwe ID ook handmatig overnemen. */ }
        await loadDashboard();
        if (previousId !== data.station.id) {
            statusElement.textContent = `Opgeslagen. Je nieuwe station-ID is ${data.station.id}. Pas je ESP32 aan naar de nieuwe MQTT-topics; de API-key blijft gelijk.`;
        } else statusElement.textContent = "Naam en locatie opgeslagen.";
    } catch (error) { errorElement.textContent = error.message; }
    finally { button.disabled = false; }
});

// Maak alleen de definitie aan; de sensor publiceert daarna numerieke waarden op het eigen topic.
accountElement("metricForm").addEventListener("submit", async event => {
    event.preventDefault();
    const version = accountVersion;
    const button = event.currentTarget.querySelector("button");
    if (button.disabled) return;
    button.disabled = true;
    errorElement.textContent = "";
    try {
        const data = await accountRequest("/metrics", { method: "POST", body: JSON.stringify({
            name: accountElement("metricName").value.trim(), unit: accountElement("metricUnit").value.trim(),
            slug: accountElement("metricSlug").value.trim(),
        }) });
        if (version !== accountVersion) return;
        for (const id of ["metricName", "metricUnit", "metricSlug"]) accountElement(id).value = "";
        await loadDashboard();
        if (version === accountVersion) statusElement.textContent = `${data.metric.name} toegevoegd. Je kunt nu metingen versturen via het getoonde MQTT-topic.`;
    } catch (error) { errorElement.textContent = error.message; }
    finally { button.disabled = false; }
});

accountElement("logoutButton").addEventListener("click", async () => {
    const button = accountElement("logoutButton");
    if (button.disabled) return;
    button.disabled = true;
    errorElement.textContent = "";
    try {
        await accountRequest("/logout", { method: "POST", body: "{}" });
        // Verwijder ook de registratiegegevens die de ESP32-generator automatisch invult.
        try {
            sessionStorage.removeItem("stationId");
            sessionStorage.removeItem("apiKey");
        } catch { /* Uitloggen blijft werken wanneer browseropslag geblokkeerd is. */ }
        accountElement("loginName").value = "";
        accountElement("loginApiKey").value = "";
        showLoggedOut();
        statusElement.textContent = "Je bent uitgelogd.";
    } catch (error) { errorElement.textContent = error.message; }
    finally { button.disabled = false; }
});
accountElement("historyMetric").addEventListener("change", () => loadHistory());
accountElement("refreshHistory").addEventListener("click", () => loadDashboard());
accountElement("moreHistory").addEventListener("click", () => loadHistory(false));

// Herstel een bestaande sessie bij herladen; stuur de API-key niet opnieuw mee.
async function restoreAccount() {
    try {
        const data = await accountRequest();
        showStation(data.station);
        statusElement.textContent = "Je bent ingelogd.";
        await loadDashboard();
    } catch (error) {
        showLoggedOut();
        statusElement.textContent = "Log in om je station te beheren.";
        errorElement.textContent = error.message === "Log eerst in" ? "" : error.message;
    }
}
restoreAccount();
