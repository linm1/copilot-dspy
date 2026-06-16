/**
 * Persists the long-lived OAuth (`ghu_*`) token via an injected SecretStorage
 * implementation (Codex HIGH finding: never a flat file on disk). The
 * short-lived Copilot session token is NEVER persisted here -- it lives only
 * in CopilotTokenManager's in-memory field.
 *
 * Real callers inject `vscode.SecretStorage` (via context.secrets); unit
 * tests inject `InMemorySecretStorage` below. Neither this file nor its
 * tests import the `vscode` module directly.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** Minimal slice of vscode.SecretStorage this module depends on. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

/** In-memory fake for unit tests; mirrors vscode.SecretStorage's async contract. */
export class InMemorySecretStorage implements SecretStorageLike {
  private readonly data = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.data.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  /** Test helper: inspect what's stored without going through the async API. */
  has(key: string): boolean {
    return this.data.has(key);
  }
}

/** Stored token shape -- unchanged from the Python client's token-*.json. */
export interface StoredTokenData {
  access_token: string;
  refresh_token?: string | null;
  token_type?: string;
  /** ISO 8601 string. */
  expires_at?: string;
  /** ISO 8601 string. */
  acquired_at?: string;
}

/**
 * Build the stable secret key for a normalized domain:
 * `copilot-dspy.token.{safeDomain}-{sha256(domain)[:8]}`
 */
export function secretKeyForDomain(domain: string): string {
  const safeDomain = domain.replace(/[^A-Za-z0-9.\-]/g, "_");
  const hash = crypto.createHash("sha256").update(domain).digest("hex").slice(0, 8);
  return `copilot-dspy.token.${safeDomain}-${hash}`;
}

export class TokenStore {
  constructor(private readonly secrets: SecretStorageLike) {}

  async load(domain: string): Promise<StoredTokenData | undefined> {
    const raw = await this.secrets.get(secretKeyForDomain(domain));
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as StoredTokenData;
    } catch {
      return undefined;
    }
  }

  async save(domain: string, data: StoredTokenData): Promise<void> {
    await this.secrets.store(secretKeyForDomain(domain), JSON.stringify(data));
  }

  async clear(domain: string): Promise<void> {
    await this.secrets.delete(secretKeyForDomain(domain));
  }

  /**
   * One-time, best-effort migration of a legacy Python-client token file
   * (`~/.config/copilot-dspy/token-{safeDomain}-{hash}.json`) into
   * SecretStorage, then delete the file. No-ops if the file does not exist,
   * is unreadable, or SecretStorage already has a token for this domain.
   *
   * Mirrors CopilotTokenManager.token_file naming exactly so the same
   * domain resolves to the same legacy filename.
   */
  async migrateLegacyFile(domain: string, configDir: string): Promise<boolean> {
    const existing = await this.load(domain);
    if (existing) {
      return false; // already migrated / already signed in via the extension
    }

    const safeDomain = domain.replace(/[^A-Za-z0-9.\-]/g, "_");
    const hash = crypto.createHash("sha256").update(domain).digest("hex").slice(0, 8);
    const legacyPath = path.join(configDir, `token-${safeDomain}-${hash}.json`);

    let raw: string;
    try {
      raw = fs.readFileSync(legacyPath, "utf8");
    } catch {
      return false; // file doesn't exist or isn't readable
    }

    let parsed: StoredTokenData;
    try {
      parsed = JSON.parse(raw) as StoredTokenData;
    } catch {
      return false; // corrupt legacy file -- leave it alone, do not delete
    }

    if (!parsed.access_token) {
      return false;
    }

    await this.save(domain, parsed);

    try {
      fs.unlinkSync(legacyPath);
    } catch {
      // best-effort delete; migration into SecretStorage already succeeded
    }

    return true;
  }
}
