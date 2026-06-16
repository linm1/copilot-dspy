import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemorySecretStorage, secretKeyForDomain, TokenStore } from "./tokenStore";

describe("secretKeyForDomain", () => {
  it("produces a stable, deterministic key for the same domain", () => {
    expect(secretKeyForDomain("github.com")).toBe(secretKeyForDomain("github.com"));
  });

  it("produces distinct keys for distinct domains", () => {
    expect(secretKeyForDomain("github.com")).not.toBe(secretKeyForDomain("parexel.ghe.com"));
  });

  it("sanitizes non-alphanumeric characters in the human-readable segment", () => {
    const key = secretKeyForDomain("a:b.com");
    expect(key).toMatch(/^copilot-dspy\.token\.a_b\.com-[0-9a-f]{8}$/);
  });
});

describe("TokenStore save/load round-trip", () => {
  it("round-trips a stored token through SecretStorage", async () => {
    const secrets = new InMemorySecretStorage();
    const store = new TokenStore(secrets);
    const data = {
      access_token: "ghu_abc",
      refresh_token: "r_abc",
      token_type: "Bearer",
      expires_at: new Date().toISOString(),
      acquired_at: new Date().toISOString(),
    };

    await store.save("github.com", data);
    const loaded = await store.load("github.com");

    expect(loaded).toEqual(data);
  });

  it("returns undefined when nothing has been stored", async () => {
    const store = new TokenStore(new InMemorySecretStorage());
    expect(await store.load("github.com")).toBeUndefined();
  });

  it("clear() removes the stored token", async () => {
    const secrets = new InMemorySecretStorage();
    const store = new TokenStore(secrets);
    await store.save("github.com", { access_token: "ghu_abc" });
    await store.clear("github.com");
    expect(await store.load("github.com")).toBeUndefined();
  });

  it("keeps tokens for different domains independent", async () => {
    const secrets = new InMemorySecretStorage();
    const store = new TokenStore(secrets);
    await store.save("github.com", { access_token: "ghu_default" });
    await store.save("parexel.ghe.com", { access_token: "ghu_enterprise" });

    expect((await store.load("github.com"))?.access_token).toBe("ghu_default");
    expect((await store.load("parexel.ghe.com"))?.access_token).toBe("ghu_enterprise");
  });

  it("the session token is never written to SecretStorage by TokenStore", async () => {
    // TokenStore's API surface only ever persists StoredTokenData (the OAuth
    // blob); it has no method that accepts a bare session-token string, so
    // this is a structural guarantee rather than a runtime check. Assert the
    // stored fields contain only the OAuth blob shape.
    const secrets = new InMemorySecretStorage();
    const store = new TokenStore(secrets);
    await store.save("github.com", { access_token: "ghu_abc" });
    const raw = await secrets.get(secretKeyForDomain("github.com"));
    expect(raw).toBeDefined();
    const parsed = JSON.parse(raw as string);
    expect(parsed).not.toHaveProperty("session_token");
  });
});

describe("TokenStore.migrateLegacyFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ax-copilot-studio-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function legacyFilePath(domain: string, configDir: string): string {
    const safeDomain = domain.replace(/[^A-Za-z0-9.\-]/g, "_");
    const hash = crypto.createHash("sha256").update(domain).digest("hex").slice(0, 8);
    return path.join(configDir, `token-${safeDomain}-${hash}.json`);
  }

  it("imports a legacy token file into SecretStorage and deletes the file", async () => {
    const domain = "github.com";
    const legacyPath = legacyFilePath(domain, tmpDir);
    const legacyData = {
      access_token: "ghu_legacy",
      refresh_token: "r_legacy",
      token_type: "Bearer",
      expires_at: new Date().toISOString(),
      acquired_at: new Date().toISOString(),
    };
    fs.writeFileSync(legacyPath, JSON.stringify(legacyData));

    const store = new TokenStore(new InMemorySecretStorage());
    const migrated = await store.migrateLegacyFile(domain, tmpDir);

    expect(migrated).toBe(true);
    expect(fs.existsSync(legacyPath)).toBe(false);
    const loaded = await store.load(domain);
    expect(loaded?.access_token).toBe("ghu_legacy");
  });

  it("is a no-op when no legacy file exists", async () => {
    const store = new TokenStore(new InMemorySecretStorage());
    const migrated = await store.migrateLegacyFile("github.com", tmpDir);
    expect(migrated).toBe(false);
  });

  it("does not overwrite an already-migrated / already-present SecretStorage token", async () => {
    const domain = "github.com";
    const legacyPath = legacyFilePath(domain, tmpDir);
    fs.writeFileSync(legacyPath, JSON.stringify({ access_token: "ghu_legacy" }));

    const secrets = new InMemorySecretStorage();
    const store = new TokenStore(secrets);
    await store.save(domain, { access_token: "ghu_already_signed_in" });

    const migrated = await store.migrateLegacyFile(domain, tmpDir);

    expect(migrated).toBe(false);
    expect((await store.load(domain))?.access_token).toBe("ghu_already_signed_in");
    // legacy file is left untouched when migration is skipped
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("leaves a corrupt legacy file in place and does not throw", async () => {
    const domain = "github.com";
    const legacyPath = legacyFilePath(domain, tmpDir);
    fs.writeFileSync(legacyPath, "{not json");

    const store = new TokenStore(new InMemorySecretStorage());
    const migrated = await store.migrateLegacyFile(domain, tmpDir);

    expect(migrated).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true);
  });
});
