const form = document.getElementById("registerForm");

const result = document.getElementById("result");
const errorMessage = document.getElementById("errorMessage");

const stationIdElement = document.getElementById("stationId");
const apiKeyElement = document.getElementById("apiKey");

form.addEventListener("submit", async (event) => {
    event.preventDefault();

    errorMessage.textContent = "";
    result.classList.add("hidden");

    const data = {
        name: document.getElementById("name").value,
        latitude: Number(
            document.getElementById("latitude").value
        ),
        longitude: Number(
            document.getElementById("longitude").value
        ),
        classCode: document.getElementById("classCode").value
    };

    try {
        const response = await fetch("/api/register", {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify(data)
        });

        const responseData = await response.json();

        if (!response.ok) {
            throw new Error(
                responseData.error || "Registreren mislukt"
            );
        }

        const stationId = responseData.stationId;
        const apiKey = responseData.apiKey;

        // Tonen op deze pagina
        stationIdElement.textContent = stationId;
        apiKeyElement.textContent = apiKey;

        // Tijdelijk bewaren zodat connect.html
        // deze gegevens automatisch kan invullen
        sessionStorage.setItem("stationId", stationId);
        sessionStorage.setItem("apiKey", apiKey);

        result.classList.remove("hidden");

        // Formulier verbergen na succesvolle registratie
        form.style.display = "none";

    } catch (error) {
        errorMessage.textContent = error.message;
    }
});
