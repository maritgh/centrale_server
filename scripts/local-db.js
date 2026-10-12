require("dotenv").config({ quiet: true });
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { setupDatabase } = require("./database");
const root = path.join(__dirname, "..", ".local");
const data = path.join(root, "postgres");
function run(command, args, allowFailure = false) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw new Error(`${command} is unavailable. Install PostgreSQL and add its bin directory to PATH.`);
  if (result.status !== 0 && !allowFailure) throw new Error(result.stderr || result.stdout || `${command} failed`);
  return result;
}
async function main() {
  if (process.argv[2] === "stop") {
    run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
    console.log("Local database stopped.");
    return;
  }
  if (process.argv[2] !== "start") throw new Error("Use db:start or db:stop");
  if (process.env.DB_HOST !== "127.0.0.1") throw new Error("db:start is for DB_HOST=127.0.0.1; use db:setup for an existing database.");
  if (!process.env.DB_USER || !process.env.DB_PASSWORD || !/^\d+$/.test(process.env.DB_PORT || "")) {
    throw new Error("Run npm run setup and check your database settings first.");
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(data, "PG_VERSION"))) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "homestation-password-"));
    try {
      const passwordFile = path.join(temporary, "password");
      fs.writeFileSync(passwordFile, process.env.DB_PASSWORD + "\n", { mode: 0o600 });
      run("initdb", ["-D", data, "-U", process.env.DB_USER, "--pwfile", passwordFile, "--auth=scram-sha-256", "--encoding=UTF8"]);
      fs.appendFileSync(path.join(data, "postgresql.conf"), `\nlisten_addresses = '127.0.0.1'\nport = ${Number(process.env.DB_PORT)}\nunix_socket_directories = '${root.replace(/'/g, "''")}'\n`);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  if (run("pg_ctl", ["-D", data, "status"], true).status !== 0) {
    run("pg_ctl", ["-D", data, "-l", path.join(root, "postgres.log"), "-w", "start"]);
  }
  await setupDatabase({ create: true });
  console.log("Local database is running.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
