const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");
const { setupAdmin } = require("../scripts/admin-setup");

// Gebruik tijdelijke configuraties: tests wijzigen nooit de echte .env of inloggegevens.
function environment(t, content) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "homestation-admin-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".env");
  fs.writeFileSync(file, content);
  return file;
}
test("admin setup preserves an existing nine-character password over repeated runs", t => {
  const content = 'DB_PASSWORD=keep-this\nADMIN_USERNAME=owner\nADMIN_PASSWORD="example-9"\n';
  const file = environment(t, content);
  setupAdmin(file);
  setupAdmin(file);
  assert.equal(fs.readFileSync(file, "utf8"), content);
});
test("admin setup reports invalid credentials without modifying the file", t => {
  const content = 'ADMIN_USERNAME=owner\nADMIN_PASSWORD=short\n';
  const file = environment(t, content);
  assert.throws(() => setupAdmin(file), /8–1024/);
  assert.equal(fs.readFileSync(file, "utf8"), content);
});
test("admin setup fills empty credentials and keeps generated secrets stable", t => {
  const file = environment(t, 'DB_PASSWORD=unchanged\nADMIN_USERNAME =\nexport ADMIN_PASSWORD =\n');
  setupAdmin(file);
  const initial = fs.readFileSync(file, "utf8");
  const settings = dotenv.parse(initial);
  assert.equal(settings.ADMIN_USERNAME, "admin");
  assert.match(settings.ADMIN_PASSWORD, /^[a-f0-9]{48}$/);
  assert.equal(settings.DB_PASSWORD, "unchanged");
  setupAdmin(file);
  assert.equal(fs.readFileSync(file, "utf8"), initial);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
