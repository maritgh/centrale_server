const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const root = path.join(__dirname, "..");
try {
  const content = fs.readFileSync(path.join(root, ".env.example"), "utf8")
    .replace("DB_PASSWORD=replace_me", `DB_PASSWORD=${crypto.randomBytes(24).toString("hex")}`)
    .replace("CLASS_CODE=replace_me", `CLASS_CODE=${crypto.randomBytes(8).toString("hex")}`);
  fs.writeFileSync(path.join(root, ".env"), content, { flag: "wx", mode: 0o600 });
  console.log("Created .env. Your registration class code is in that file.");
} catch (error) {
  if (error.code === "EEXIST") console.log(".env already exists; kept your settings.");
  else throw error;
}
