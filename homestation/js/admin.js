// Beheer gebruikt een HttpOnly-sessiecookie; wachtwoord en API-keys worden nergens opgeslagen.
const adminElement = id => document.getElementById(id);
let adminVersion = 0;
let listVersion = 0;
let nextAdminOffset = null;
let loadingAdminList = false;

function clearAdmin() {
    adminVersion++;
    listVersion++;
    nextAdminOffset = null;
    loadingAdminList = false;
    adminElement("adminRows").replaceChildren();
    adminElement("adminPanel").classList.add("hidden");
    adminElement("adminLogout").classList.add("hidden");
    adminElement("adminLoginSection").classList.remove("hidden");
    adminElement("adminPassword").value = "";
    adminElement("adminStatus").textContent = "Log in als beheerder.";
    adminElement("adminListStatus").textContent = "";
}
async function adminRequest(path, options = {}) {
    const version = adminVersion;
    const response = await fetch("/api/admin" + path, {
        ...options, credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" },
    });
    const data = await response.json();
    if (!response.ok) {
        if ([401, 503].includes(response.status) && version === adminVersion) {
            clearAdmin();
            adminElement("adminError").textContent = data.error;
        }
        throw new Error(data.error || "Beheerverzoek mislukt");
    }
    return data;
}
function showAdmin() {
    adminVersion++;
    adminElement("adminLoginSection").classList.add("hidden");
    adminElement("adminPanel").classList.remove("hidden");
    adminElement("adminLogout").classList.remove("hidden");
    adminElement("adminStatus").textContent = "Je bent ingelogd als beheerder.";
}

// Iedere rij krijgt eigen acties. textContent voorkomt dat namen of IDs als HTML werken.
function adminRow(station, version) {
    const row = document.createElement("tr");
    for (const text of [station.name, station.id, `${station.latitude}, ${station.longitude}`]) {
        const cell = document.createElement("td");
        cell.textContent = text;
        row.appendChild(cell);
    }
    const actions = document.createElement("td");
    const keyButton = document.createElement("button");
    keyButton.type = "button";
    keyButton.className = "button secondary";
    keyButton.textContent = "Toon API-key";
    const keyOutput = document.createElement("code");
    keyOutput.className = "admin-key";
    keyButton.addEventListener("click", async () => {
        if (keyOutput.textContent) {
            keyOutput.textContent = "";
            keyButton.textContent = "Toon API-key";
            return;
        }
        if (keyButton.disabled) return;
        keyButton.disabled = true;
        adminElement("adminError").textContent = "";
        try {
            const data = await adminRequest("/stations/" + encodeURIComponent(station.id) + "/key");
            if (version !== adminVersion) return;
            keyOutput.textContent = data.apiKey;
            keyButton.textContent = "Verberg API-key";
        } catch (error) { adminElement("adminError").textContent = error.message; }
        finally { keyButton.disabled = false; }
    });
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "button danger";
    deleteButton.textContent = "Station verwijderen";
    deleteButton.addEventListener("click", async () => {
        // De beheerder typt het ID, zodat een verkeerde klik geen account verwijdert.
        const confirmation = window.prompt(`Verwijder “${station.name}” en alle bijbehorende metingen, grootheden en sessies? Dit kan niet ongedaan worden gemaakt. Typ het station-ID ter bevestiging: ${station.id}`);
        if (confirmation === null) return;
        if (confirmation !== station.id) {
            adminElement("adminError").textContent = "Station-ID komt niet overeen. Er is niets verwijderd.";
            return;
        }
        if (deleteButton.disabled) return;
        deleteButton.disabled = true;
        adminElement("adminError").textContent = "";
        try {
            await adminRequest("/stations/" + encodeURIComponent(station.id), { method: "DELETE", body: JSON.stringify({ confirmStationId: confirmation }) });
            if (version !== adminVersion) return;
            await loadAdminStations();
            if (version === adminVersion) adminElement("adminStatus").textContent = `${station.name} is verwijderd.`;
        } catch (error) { adminElement("adminError").textContent = error.message; }
        finally { deleteButton.disabled = false; }
    });
    actions.appendChild(keyButton);
    actions.appendChild(deleteButton);
    actions.appendChild(keyOutput);
    row.appendChild(actions);
    return row;
}
async function loadAdminStations(reset = true) {
    if (!reset && loadingAdminList) return;
    const version = adminVersion;
    const requestVersion = reset ? ++listVersion : listVersion;
    loadingAdminList = true;
    if (reset) {
        nextAdminOffset = null;
        adminElement("adminRows").replaceChildren();
        adminElement("adminMore").classList.add("hidden");
    }
    adminElement("adminMore").disabled = true;
    adminElement("adminError").textContent = "";
    adminElement("adminListStatus").textContent = "Stations laden…";
    const params = new URLSearchParams({ search: adminElement("adminSearch").value.trim(), offset: String(nextAdminOffset || 0) });
    try {
        const data = await adminRequest("/stations?" + params);
        if (version !== adminVersion || requestVersion !== listVersion) return;
        for (const station of data.stations) adminElement("adminRows").appendChild(adminRow(station, version));
        nextAdminOffset = data.nextOffset;
        adminElement("adminMore").classList.toggle("hidden", nextAdminOffset === null);
        const count = adminElement("adminRows").children.length;
        adminElement("adminListStatus").textContent = count ? `${count} stations getoond.` : "Geen stations gevonden.";
    } catch (error) {
        if (version === adminVersion && requestVersion === listVersion) {
            adminElement("adminError").textContent = error.message;
            adminElement("adminListStatus").textContent = "Stations ophalen mislukt.";
        }
    } finally {
        if (version === adminVersion && requestVersion === listVersion) {
            loadingAdminList = false;
            adminElement("adminMore").disabled = false;
        }
    }
}
adminElement("adminLoginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    if (button.disabled) return;
    button.disabled = true;
    adminElement("adminError").textContent = "";
    try {
        await adminRequest("/login", { method: "POST", body: JSON.stringify({ username: adminElement("adminUsername").value, password: adminElement("adminPassword").value }) });
        adminElement("adminPassword").value = "";
        showAdmin();
        await loadAdminStations();
    } catch (error) { adminElement("adminError").textContent = error.message; }
    finally { button.disabled = false; }
});
adminElement("adminLogout").addEventListener("click", async () => {
    const button = adminElement("adminLogout");
    if (button.disabled) return;
    button.disabled = true;
    try {
        await adminRequest("/logout", { method: "POST", body: "{}" });
        clearAdmin();
        adminElement("adminUsername").value = "";
        adminElement("adminError").textContent = "";
        adminElement("adminStatus").textContent = "Je bent uitgelogd.";
    } catch (error) { adminElement("adminError").textContent = error.message; }
    finally { button.disabled = false; }
});
adminElement("adminSearchForm").addEventListener("submit", event => { event.preventDefault(); return loadAdminStations(); });
adminElement("adminMore").addEventListener("click", () => loadAdminStations(false));
// Haal bestaande beheersessies terug zonder het wachtwoord opnieuw op te slaan.
async function restoreAdmin() {
    try { await adminRequest("/session"); showAdmin(); await loadAdminStations(); }
    catch (error) { clearAdmin(); adminElement("adminError").textContent = error.message === "Log eerst in als beheerder" ? "" : error.message; }
}
restoreAdmin();
