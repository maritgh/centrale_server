const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createApp } = require("../src/node");
const adminPassword = "test-admin-password-" + "x".repeat(32);

// Controleer de toegang zonder database: afgewezen verzoeken mogen geen gegevens ophalen.
async function withAdmin(options, callback) {
  const pool = { query() { throw new Error("No database access expected"); } };
  const server = createApp({ pool, classCode: "test", adminUsername: "owner", adminPassword, ...options }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test("admin stays disabled without configured owner credentials", async () => {
  await withAdmin({ adminPassword: "" }, async url => {
    const response = await fetch(url + "/api/admin/stations");
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});
test("admin rejects anonymous users and station cookies, including direct delete and key requests", async () => {
  await withAdmin({}, async url => {
    for (const path of ["/session", "/stations", "/stations/test/key"]) {
      const response = await fetch(url + "/api/admin" + path, { headers: { Cookie: "homestation_session=" + "a".repeat(64) } });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal((await fetch(url + "/api/admin/stations/test", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmStationId: "test" }) })).status, 401);
    assert.equal((await fetch(url + "/api/admin/login", { method: "POST", body: "username=owner" })).status, 415);
    assert.equal((await fetch(url + "/admin.html")).status, 200);
  });
});
test("admin limits repeated incorrect logins", async () => {
  await withAdmin({}, async url => {
    for (let attempt = 0; attempt < 11; attempt++) {
      const response = await fetch(url + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "wrong" }) });
      assert.equal(response.status, attempt < 10 ? 401 : 429);
      if (attempt === 10) assert.ok(Number(response.headers.get("retry-after")) > 0);
    }
  });
});

// Regressie: een geldig opgeslagen wachtwoord van negen tekens mag beheer niet uitschakelen.
test("admin login accepts saved passwords from eight characters and rejects shorter configuration", async () => {
  await withAdmin({ adminPassword: "example-9", pool: { query: async () => ({ rowCount: 1, rows: [] }) } }, async url => {
    const response = await fetch(url + "/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "example-9" }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /homestation_admin=/);
  });
  await withAdmin({ adminPassword: "short" }, async url => {
    const response = await fetch(url + "/api/admin/session");
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /8–1024/);
  });
});
