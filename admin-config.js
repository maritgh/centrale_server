// Gebruik dezelfde regels bij instellen en starten, zodat een opgeslagen login ook bruikbaar is.
function adminConfigError(username, password) {
  if (typeof username !== "string" || !username.trim() || username.length > 120) {
    return "ADMIN_USERNAME moet 1–120 tekens bevatten.";
  }
  if (typeof password !== "string" || !password.trim() || password.length < 8 || password.length > 1024) {
    return "ADMIN_PASSWORD moet 8–1024 tekens bevatten. Kies bij voorkeur een lang, uniek wachtwoord.";
  }
  return null;
}
module.exports = { adminConfigError };
