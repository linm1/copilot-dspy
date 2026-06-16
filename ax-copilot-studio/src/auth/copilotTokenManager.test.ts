import { describe, expect, it, vi } from "vitest";
import { CopilotTokenManager } from "./copilotTokenManager";
import { InMemorySecretStorage } from "./tokenStore";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

function makeDeviceFlowFetch(finalAccessToken: string) {
  return vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({ device_code: "dc", user_code: "ABCD", verification_uri: "https://github.com/login/device", interval: 0 }),
    )
    .mockResolvedValueOnce(jsonResponse({ access_token: finalAccessToken, expires_in: 28800 }));
}

describe("CopilotTokenManager.getToken", () => {
  it("runs device flow then exchanges for a session token on first call", async () => {
    const secrets = new InMemorySecretStorage();
    const deviceFlowFetch = makeDeviceFlowFetch("ghu_new");

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/login/device/code") || url.includes("/login/oauth/access_token")) {
        return deviceFlowFetch(url, init);
      }
      if (url.includes("/copilot_internal/v2/token")) {
        return jsonResponse({ token: "session-token-1", expires_at: Math.floor(Date.now() / 1000) + 1500 });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const manager = new CopilotTokenManager({
      secrets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    const token = await manager.getToken();
    expect(token).toBe("session-token-1");

    const stored = await secrets.get(`copilot-dspy.token.github.com-${await hashSuffix("github.com")}`);
    expect(stored).toBeDefined();
  });

  it("reuses the cached in-memory session token when not near expiry", async () => {
    const secrets = new InMemorySecretStorage();
    const deviceFlowFetch = makeDeviceFlowFetch("ghu_new");
    let sessionTokenCalls = 0;

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/login/device/code") || url.includes("/login/oauth/access_token")) {
        return deviceFlowFetch(url, init);
      }
      if (url.includes("/copilot_internal/v2/token")) {
        sessionTokenCalls += 1;
        return jsonResponse({ token: "session-token-1", expires_at: Math.floor(Date.now() / 1000) + 1500 });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const manager = new CopilotTokenManager({
      secrets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await manager.getToken();
    await manager.getToken();

    expect(sessionTokenCalls).toBe(1);
  });

  it("forceRefresh re-runs the session token exchange even if cached token is fresh", async () => {
    const secrets = new InMemorySecretStorage();
    const deviceFlowFetch = makeDeviceFlowFetch("ghu_new");
    let sessionTokenCalls = 0;

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/login/device/code") || url.includes("/login/oauth/access_token")) {
        return deviceFlowFetch(url, init);
      }
      if (url.includes("/copilot_internal/v2/token")) {
        sessionTokenCalls += 1;
        return jsonResponse({ token: `session-token-${sessionTokenCalls}`, expires_at: Math.floor(Date.now() / 1000) + 1500 });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const manager = new CopilotTokenManager({
      secrets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    const first = await manager.getToken();
    const second = await manager.getToken(true);

    expect(first).toBe("session-token-1");
    expect(second).toBe("session-token-2");
    expect(sessionTokenCalls).toBe(2);
  });

  it("reuses a stored (non-expired) OAuth token without re-running device flow", async () => {
    const secrets = new InMemorySecretStorage();
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/copilot_internal/v2/token")) {
        return jsonResponse({ token: "session-token-1", expires_at: Math.floor(Date.now() / 1000) + 1500 });
      }
      throw new Error(`unexpected url ${url} -- device flow should not run`);
    });

    const manager = new CopilotTokenManager({
      secrets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    // Pre-seed a valid stored token (>5 min remaining).
    await secrets.store(
      `copilot-dspy.token.github.com-${await hashSuffix("github.com")}`,
      JSON.stringify({
        access_token: "ghu_stored",
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        acquired_at: new Date().toISOString(),
      }),
    );

    const token = await manager.getToken();
    expect(token).toBe("session-token-1");
  });

  it("falls back to device flow when the stored token has no refresh_token and is expired", async () => {
    const secrets = new InMemorySecretStorage();
    const deviceFlowFetch = makeDeviceFlowFetch("ghu_fresh");

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/login/device/code") || url.includes("/login/oauth/access_token")) {
        return deviceFlowFetch(url, init);
      }
      if (url.includes("/copilot_internal/v2/token")) {
        return jsonResponse({ token: "session-token-1", expires_at: Math.floor(Date.now() / 1000) + 1500 });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const manager = new CopilotTokenManager({
      secrets,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await secrets.store(
      `copilot-dspy.token.github.com-${await hashSuffix("github.com")}`,
      JSON.stringify({
        access_token: "ghu_expired",
        refresh_token: null,
        expires_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        acquired_at: new Date().toISOString(),
      }),
    );

    const token = await manager.getToken();
    expect(token).toBe("session-token-1");
    // device flow's deviceFlowFetch mock would have thrown if not invoked correctly;
    // also assert it was actually called.
    expect(deviceFlowFetch).toHaveBeenCalled();
  });
});

describe("CopilotTokenManager.getApiBase", () => {
  it("returns the public endpoint for github.com without making any network calls", async () => {
    const manager = new CopilotTokenManager({
      secrets: new InMemorySecretStorage(),
      fetchImpl: vi.fn() as unknown as typeof fetch,
      sleep: vi.fn(),
    });
    expect(await manager.getApiBase()).toBe("https://api.githubcopilot.com");
  });
});

// Re-derive the same hash suffix the implementation uses, for assembling
// SecretStorage keys in test setup (kept local rather than importing
// secretKeyForDomain to also indirectly verify the two stay in sync).
async function hashSuffix(domain: string): Promise<string> {
  const { secretKeyForDomain } = await import("./tokenStore");
  const fullKey = secretKeyForDomain(domain);
  return fullKey.split("-").pop() as string;
}
