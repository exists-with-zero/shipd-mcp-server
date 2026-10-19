// Settings for where the server runs. On Railway it must listen publicly, accept
// only its own domains (plus Railway's health checker), and refuse to start
// pointed at localhost.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig, RAILWAY_HEALTHCHECK_HOST } from "../src/config.js";

test("locally: listens on localhost only, no host list, local Shipd", () => {
  const c = loadConfig({});
  assert.equal(c.host, "127.0.0.1");
  assert.deepEqual(c.allowedHosts, []);
  assert.equal(c.apiUrl, "http://localhost:8000");
  assert.equal(c.port, 8787);
});

test("on Railway: public, and only its own domain, a custom one and the health checker", () => {
  const c = loadConfig({
    RAILWAY_ENVIRONMENT_NAME: "production",
    RAILWAY_PUBLIC_DOMAIN: "shipd-mcp-production.up.railway.app",
    MCP_ALLOWED_HOSTS: "mcp.theshipd.com, ",
    SHIPD_API_URL: "https://api.example.test/",
    SHIPD_APP_URL: "https://theshipd.com",
    PORT: "8080",
  });
  assert.equal(c.host, "0.0.0.0");
  assert.equal(c.port, 8080);
  assert.equal(c.apiUrl, "https://api.example.test");
  assert.deepEqual(c.allowedHosts.sort(), [
    "mcp.theshipd.com",
    "shipd-mcp-production.up.railway.app",
    RAILWAY_HEALTHCHECK_HOST,
  ].sort());
});

test("on Railway before a domain exists: only the health checker gets in", () => {
  const c = loadConfig({
    RAILWAY_SERVICE_ID: "svc",
    SHIPD_API_URL: "https://api.example.test",
    SHIPD_APP_URL: "https://theshipd.com",
  });
  assert.deepEqual(c.allowedHosts, [RAILWAY_HEALTHCHECK_HOST]);
});

test("on Railway without the Shipd URLs: refuses to start", () => {
  assert.throws(
    () => loadConfig({ RAILWAY_ENVIRONMENT_NAME: "production", SHIPD_APP_URL: "https://theshipd.com" }),
    /SHIPD_API_URL and SHIPD_APP_URL/,
  );
});

test("MCP_HOST still wins", () => {
  const c = loadConfig({
    RAILWAY_ENVIRONMENT_NAME: "production",
    MCP_HOST: "::",
    SHIPD_API_URL: "https://api.example.test",
    SHIPD_APP_URL: "https://theshipd.com",
  });
  assert.equal(c.host, "::");
});

test("a token-carrying Shipd URL must be https, except on this machine or Railway's private network", () => {
  const base = { RAILWAY_ENVIRONMENT_NAME: "production", SHIPD_APP_URL: "https://theshipd.com" };
  assert.throws(() => loadConfig({ ...base, SHIPD_API_URL: "http://api.example.test" }), /must be https/);
  assert.doesNotThrow(() => loadConfig({ ...base, SHIPD_API_URL: "http://backend.railway.internal:8080" }));
  assert.doesNotThrow(() => loadConfig({ SHIPD_API_URL: "http://localhost:8000" }));
  assert.throws(() => loadConfig({ ...base, SHIPD_API_URL: "not a url" }), /not a URL/);
});

test("listening publicly with no host list refuses to start", () => {
  assert.throws(() => loadConfig({ MCP_HOST: "0.0.0.0" }), /needs MCP_ALLOWED_HOSTS/);
  assert.doesNotThrow(() => loadConfig({ MCP_HOST: "0.0.0.0", MCP_ALLOWED_HOSTS: "mcp.theshipd.com" }));
});

test("the request limit per address comes from MCP_RATE_PER_MIN", () => {
  assert.equal(loadConfig({}).ratePerMin, 120);
  assert.equal(loadConfig({ MCP_RATE_PER_MIN: "30" }).ratePerMin, 30);
});

test("the browser may call it from Shipd's own web app, plus MCP_CORS_ORIGINS", () => {
  const c = loadConfig({
    SHIPD_APP_URL: "https://theshipd.com/",
    MCP_CORS_ORIGINS: "http://localhost:3000, not a url, null, file:///tmp/x, chrome-extension://abc",
  });
  assert.deepEqual(c.corsOrigins, ["https://theshipd.com", "http://localhost:3000"]);
});

test("sign in with Shipd: off unless SHIPD_OAUTH_ISSUER is set; https only; names its own public URL", () => {
  assert.equal(loadConfig({}).oauthIssuer, undefined);
  const railway = {
    RAILWAY_ENVIRONMENT_NAME: "production",
    RAILWAY_PUBLIC_DOMAIN: "pretty-spirit.up.railway.app",
    SHIPD_API_URL: "https://api.example.test",
    SHIPD_APP_URL: "https://theshipd.com",
  };
  const c = loadConfig({ ...railway, SHIPD_OAUTH_ISSUER: "https://api.example.test/" });
  assert.equal(c.oauthIssuer, "https://api.example.test");
  assert.equal(c.publicUrl, "https://pretty-spirit.up.railway.app");
  assert.equal(
    loadConfig({ ...railway, SHIPD_OAUTH_ISSUER: "https://api.example.test", MCP_PUBLIC_URL: "https://mcp.theshipd.com/" }).publicUrl,
    "https://mcp.theshipd.com",
  );
  assert.throws(() => loadConfig({ ...railway, SHIPD_OAUTH_ISSUER: "http://api.example.test" }), /https/);
});
