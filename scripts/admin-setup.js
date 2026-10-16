const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { adminConfigError } = require("../admin-config");

// Bewaar bestaande inloggegevens. Meld pas succes als de server ze ook zal accepteren.
function setupAdmin(file = path.join(__dirname, "..", ".env")) {
  if (!fs.existsSync(file)) throw new Error("Voer eerst npm run setup uit.");
  let content = fs.readFileSync(file, "utf8");
  const settings = dotenv.parse(content);
  const username = settings.ADMIN_USERNAME || "admin";
  const password = settings.ADMIN_PASSWORD || crypto.randomBytes(24).toString("hex");
  const error = adminConfigError(username, password);
  if (error) throw new Error(error + " Pas dit aan in .env en voer admin:setup opnieuw uit.");
  for (const [key, value] of [["ADMIN_USERNAME", username], ["ADMIN_PASSWORD", password]]) {
    if (settings[key]) continue;
    // Vervang ook regels met spaties of export, zodat een lege waarde niet achterblijft.
    const line = new RegExp("^(?:export\\s+)?" + key + "\\s*=.*$", "gm");
    content = line.test(content) ? content.replace(line, () => key + "=" + value) : content.trimEnd() + "\n" + key + "=" + value + "\n";
  }
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
if (require.main === module) {
  try {
    setupAdmin();
    console.log("Beheerlogin gecontroleerd en opgeslagen in .env. Bestaande inloggegevens zijn behouden.");
    console.log("Herstart een draaiende server om de instellingen toe te passen. Of start met npm run admin:start.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { setupAdmin };
