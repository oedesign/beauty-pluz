import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

const source = await readFile(
  new URL("../js/backend-config.js", import.meta.url),
  "utf8",
);

function executeConfig(hostname) {
  const window = { location: { hostname } };
  runInContext(source, createContext({ window }));
  return window.BEAUTY_PLUZ_BACKEND_CONFIG;
}

function configFor(hostname) {
  return JSON.parse(JSON.stringify(executeConfig(hostname)));
}

test("SumUp branch Preview selects the testing Supabase project", () => {
  const config = configFor(
    "beauty-pluz-git-sumup-payment-oe-designs-projects.vercel.app",
  );
  assert.equal(
    config?.supabaseUrl === "https://nchoghcxcisxzflyrqcy.supabase.co",
    true,
  );
  assert.equal(
    config?.supabaseAnonKey ===
      "sb_publishable_DTHEyuc2bulp_5I7mBj_-Q_E9NMHOOA",
    true,
  );
});

test("only approved production hostnames select production Supabase", () => {
  for (const hostname of [
    "www.beautypluzskincare.co.uk",
    "beauty-pluz.vercel.app",
  ]) {
    const config = configFor(hostname);
    assert.equal(
      config?.supabaseUrl === "https://kdudirbzyiedelpdrgic.supabase.co",
      true,
    );
    assert.equal(
      config?.supabaseAnonKey ===
        "sb_publishable_i7SXukT0COvoQZ5f7a4Sxw_zjTlbAGd",
      true,
    );
  }
});

test("unique Vercel deployments do not select either configured project", () => {
  for (const hostname of [
    "beauty-pluz-abc123-oe-designs-projects.vercel.app",
    "beauty-pluz-git-feature-oe-designs-projects.vercel.app",
  ]) {
    assert.deepEqual(configFor(hostname), {});
  }
});

test("unapproved Preview URLs, suffixes, and lookalikes return empty config", () => {
  for (const hostname of [
    "beauty-pluz-git-sumup-payment-oe-designs-projects.vercel.app.attacker.example",
    "attackerbeauty-pluz-git-sumup-payment-oe-designs-projects.vercel.app",
    "beauty-pluz-git-sumup-payment-oe-designs-projects.vercel.app.evil",
    "beauty-pluz-git-other-oe-designs-projects.vercel.app",
    "beautypluzskincare.co.uk",
    "www.beautypluzskincare.co.uk.attacker.example",
    "beauty-pluz.vercel.app.attacker.example",
  ]) {
    assert.deepEqual(configFor(hostname), {});
  }
});

test("localhost, loopback, and IPv6 loopback return empty config", () => {
  for (const hostname of [
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]",
    "localhost.localdomain",
  ]) {
    assert.deepEqual(configFor(hostname), {});
  }
});

test("backend configuration contains no server-side credentials", () => {
  assert.doesNotMatch(
    source,
    /SUPABASE_SERVICE_ROLE_KEY|SUMUP_SANDBOX_API_KEY|service_role|client_secret/i,
  );
  assert.equal(
    Object.isFrozen(executeConfig("www.beautypluzskincare.co.uk")),
    true,
  );
});
