/**
 * Manages the three-step GitHub Copilot token lifecycle:
 *
 * 1. OAuth device flow -> long-lived `ghu_*` token (stored via SecretStorage).
 * 2. `/copilot_internal/v2/token` exchange -> short-lived session token (~25 min).
 * 3. Automatic re-exchange when the session token nears expiry.
 *
 * Faithful TypeScript port of CopilotTokenManager (copilot_dspy_client.py).
 * The VS Code GitHub App client ID (`Iv1.b507a08c87ecfe98`) is the only
 * client ID GitHub authorises for third-party Copilot access.
 */

import { buildDomainUrls, resolveApiBase, resolveDomain } from "./apiBase";
import {
  DeviceFlowDeps,
  PreparedTokenData,
  refreshOAuthToken,
  runDeviceFlowAuth,
} from "./deviceFlow";
import { SecretStorageLike, StoredTokenData, TokenStore } from "./tokenStore";
import { VS_CODE_HEADERS } from "../llm/headers";

const SESSION_EXPIRY_BUFFER_MS = 60_000; // refresh when within 60s of expiry
const TOKEN_VALID_BUFFER_MS = 5 * 60_000; // stored OAuth token must have >5min left

export interface CopilotTokenManagerOptions {
  secrets: SecretStorageLike;
  enterpriseDomain?: string | null;
  envDomain?: string | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  onDeviceCode?: (response: { user_code: string; verification_uri: string }) => void;
  /** Legacy Python-client config dir for one-time token-file migration. */
  legacyConfigDir?: string;
}

export class CopilotTokenManager {
  readonly domain: string;
  readonly deviceCodeUrl: string;
  readonly deviceAuthUrl: string;
  readonly copilotTokenUrl: string;

  private readonly tokenStore: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly onDeviceCode?: (response: { user_code: string; verification_uri: string }) => void;
  private readonly legacyConfigDir?: string;

  private sessionToken: string | undefined;
  private sessionTokenExpiresAtMs = 0;
  private migrated = false;
  /** Serializes get_token() calls so concurrent callers don't trigger duplicate device flows. */
  private pendingGetToken: Promise<string> | undefined;

  constructor(options: CopilotTokenManagerOptions) {
    this.domain = resolveDomain(options.enterpriseDomain, options.envDomain);
    const urls = buildDomainUrls(this.domain);
    this.deviceCodeUrl = urls.deviceCodeUrl;
    this.deviceAuthUrl = urls.deviceAuthUrl;
    this.copilotTokenUrl = urls.copilotTokenUrl;

    this.tokenStore = new TokenStore(options.secrets);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.onDeviceCode = options.onDeviceCode;
    this.legacyConfigDir = options.legacyConfigDir;
  }

  /** Expose the session token already in memory, if any (used by getApiBase()). */
  get currentSessionToken(): string | undefined {
    return this.sessionToken;
  }

  /**
   * Return a valid short-lived Copilot session token, refreshing as needed.
   * Concurrent calls share a single in-flight refresh (mirrors the Python
   * client's threading.Lock).
   */
  async getToken(forceRefresh = false): Promise<string> {
    if (this.pendingGetToken) {
      return this.pendingGetToken;
    }
    this.pendingGetToken = this.getTokenInner(forceRefresh).finally(() => {
      this.pendingGetToken = undefined;
    });
    return this.pendingGetToken;
  }

  private async getTokenInner(forceRefresh: boolean): Promise<string> {
    if (!forceRefresh && this.sessionToken && this.now().getTime() < this.sessionTokenExpiresAtMs - SESSION_EXPIRY_BUFFER_MS) {
      return this.sessionToken;
    }

    await this.migrateLegacyTokenIfNeeded();

    // forceRefresh (used after a 401) only forces the session-token
    // exchange to re-run -- it must NOT force a fresh OAuth device flow.
    // The long-lived ghu_* OAuth token is still good for hours/days; only
    // the short-lived session token expires on the ~25min cadence that
    // forceRefresh exists to handle. Re-running device flow on every 401
    // would pop a browser auth prompt for what is usually just an expired
    // session token.
    const stored = await this.tokenStore.load(this.domain);
    const oauthToken = stored && this.isTokenValid(stored) ? stored.access_token : await this.acquireOrRefreshToken(stored);

    const { token, expiresAtMs } = await this.exchangeForSessionToken(oauthToken);
    this.sessionToken = token;
    this.sessionTokenExpiresAtMs = expiresAtMs;
    return token;
  }

  private async migrateLegacyTokenIfNeeded(): Promise<void> {
    if (this.migrated || !this.legacyConfigDir) {
      return;
    }
    this.migrated = true;
    try {
      await this.tokenStore.migrateLegacyFile(this.domain, this.legacyConfigDir);
    } catch {
      // best-effort; never block auth on migration failure
    }
  }

  private isTokenValid(tokenData: StoredTokenData): boolean {
    const raw = tokenData.expires_at;
    if (!raw) {
      return true; // no expiry set -- treat as valid; 401 will force refresh
    }
    const expiresAt = new Date(raw);
    if (Number.isNaN(expiresAt.getTime())) {
      return true; // unparseable -- treat as valid
    }
    return this.now().getTime() < expiresAt.getTime() - TOKEN_VALID_BUFFER_MS;
  }

  private async acquireOrRefreshToken(stored: StoredTokenData | undefined): Promise<string> {
    const refreshToken = stored?.refresh_token;
    if (refreshToken) {
      try {
        const refreshed = await refreshOAuthToken(this.deviceAuthUrl, refreshToken, this.deviceFlowDeps());
        await this.tokenStore.save(this.domain, refreshed);
        return refreshed.access_token;
      } catch {
        // fall through to device flow
      }
    }
    const fresh = await runDeviceFlowAuth(this.deviceCodeUrl, this.deviceAuthUrl, this.deviceFlowDeps());
    await this.tokenStore.save(this.domain, fresh);
    return fresh.access_token;
  }

  private deviceFlowDeps(): DeviceFlowDeps {
    return {
      fetch: this.fetchImpl,
      sleep: this.sleep,
      now: this.now,
      onDeviceCode: (response) => {
        this.onDeviceCode?.({
          user_code: response.user_code,
          verification_uri: response.verification_uri,
        });
      },
    };
  }

  private async exchangeForSessionToken(oauthToken: string): Promise<{ token: string; expiresAtMs: number }> {
    const response = await this.fetchImpl(this.copilotTokenUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oauthToken}`,
        ...VS_CODE_HEADERS,
      },
    });
    if (!response.ok) {
      throw new Error(`Session token exchange failed: HTTP ${response.status}`);
    }
    const data = (await response.json()) as { token: string; expires_at?: number };
    const expiresAtMs = data.expires_at !== undefined ? data.expires_at * 1000 : this.now().getTime() + 1_500_000;
    return { token: data.token, expiresAtMs };
  }

  /**
   * Return the Copilot chat API base URL for this domain. Ensures a session
   * token is available first (enterprise domains parse proxy-ep from it).
   */
  async getApiBase(): Promise<string> {
    if (this.domain === "github.com") {
      return resolveApiBase(this.domain, undefined);
    }
    await this.getToken();
    return resolveApiBase(this.domain, this.sessionToken);
  }

  /** Used by tests/tools that already hold a session token and want a pure resolve. */
  getApiBaseSync(): string {
    return resolveApiBase(this.domain, this.sessionToken);
  }
}

export type { PreparedTokenData };
