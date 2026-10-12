require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

function connection(database = process.env.DB_NAME) {
  return { host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, connectionTimeoutMillis: 5000 };
}
async function setupDatabase({ create = false } = {}) {
  if (create) {
    const admin = new Pool(connection("postgres"));
    try {
      const name = process.env.DB_NAME;
      if (!name) throw new Error("DB_NAME is required");
      const result = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
      if (!result.rowCount) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    } finally { await admin.end(); }
  }
  const pool = new Pool(connection());
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8"));
    console.log("Database tables are ready.");
  } finally { await pool.end(); }
}
if (require.main === module) setupDatabase().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { setupDatabase };
