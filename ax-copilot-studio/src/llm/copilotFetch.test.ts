import { describe, expect, it, vi } from "vitest";
import { CopilotTokenManager } from "../auth/copilotTokenManager";
import { InMemorySecretStorage, TokenStore } from "../auth/tokenStore";
import { createCopilotFetch } from "./copilotFetch";

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function makeTokenManager(authFetch: typeof fetch, secrets = new InMemorySecretStorage()): CopilotTokenManager {
  return new CopilotTokenManager({
    secrets,
    fetchImpl: authFetch,
    sleep: vi.fn().mockResolvedValue(undefined),
  });
}

/** Pre-seed a valid (non-expired) OAuth token so getToken() skips device flow entirely. */
async function seedOAuthToken(secrets: InMemorySecretStorage, domain = "github.com"): Promise<void> {
  const store = new TokenStore(secrets);
  await store.save(domain, {
    access_token: "ghu_seeded",
    expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
  });
}

describe("createCopilotFetch", () => {
  it("injects Authorization + VS_CODE_HEADERS + Openai-Intent on every request", async () => {
    const deviceFlowFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ device_code: "dc", user_code: "X", verification_uri: "https://x", interval: 0 }),
      )
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghu_abc", expires_in: 28800 }));

    const authFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/login/")) return deviceFlowFetch(url, init);
      if (url.includes("/copilot_internal/v2/token")) {
        return jsonResponse({ token: "session-1", expires_at: Math.floor(Date.now() / 1000) + 1500 });
      }
      throw new Error(`unexpected ${url}`);
    });

    const tokenManager = makeTokenManager(authFetch as unknown as typeof fetch);
    const downstreamFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));

    const copilotFetch = createCopilotFetch({ tokenManager, fetchImpl: downstreamFetch as unknown as typeof fetch });
    await copilotFetch("https://api.githubcopilot.com/chat/completions", { method: "POST", body: "{}" });

    const [, init] = downstreamFetch.mock.calls[0];
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer session-1");
    expect(headers.get("Openai-Intent")).toBe("conversation-edits");
    expect(headers.get("Editor-Version")).toBe("vscode/1.99.3");
    expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
  });

  it("on a 401, forces a token refresh and retries exactly once", async () => {
    let sessionCalls = 0;
    const deviceFlowFetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ device_code: "dc", user_code: "X", verification_uri: "https://x", interval: 0 }),
      )
      .mockResolvedValueOnce(jsonResponse({ access_token: "ghu_abc", expires_in: 28800 }));

    const authFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/login/")) return deviceFlowFetch(url, init);
      if (url.includes("/copilot_internal/v2/token")) {
        sessionCalls += 1;
        return jsonResponse({ token: `session-${sessionCalls}`, expires_at: Math.floor(Date.now() / 1000) + 1500 });
      }
      throw new Error(`unexpected ${url}`);
    });

    const tokenManager = makeTokenManager(authFetch as unknown as typeof fetch);

    const downstreamFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));

    const copilotFetch = createCopilotFetch({ tokenManager, fetchImpl: downstreamFetch as unknown as typeof fetch });
    const response = await copilotFetch("https://api.githubcopilot.com/chat/completions", { method: "POST" });

    expect(response.status).toBe(200);
    expect(downstreamFetch).toHaveBeenCalledTimes(2);
    const firstAuth = (downstreamFetch.mock.calls[0][1].headers as Headers).get("Authorization");
    const secondAuth = (downstreamFetch.mock.calls[1][1].headers as Headers).get("Authorization");
    expect(firstAuth).toBe("Bearer session-1");
    expect(secondAuth).toBe("Bearer session-2");
    expect(sessionCalls).toBe(2); // initial + forced refresh
  });

  it("forwards the caller's AbortSignal to the underlying fetch", async () => {
    const secrets = new InMemorySecretStorage();
    await seedOAuthToken(secrets);

    const authFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ token: "session-1", expires_at: Math.floor(Date.now() / 1000) + 1500 }));
    const tokenManager = makeTokenManager(authFetch as unknown as typeof fetch, secrets);

    const downstreamFetch = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const controller = new AbortController();

    const copilotFetch = createCopilotFetch({ tokenManager, fetchImpl: downstreamFetch as unknown as typeof fetch });
    await copilotFetch("https://api.githubcopilot.com/chat/completions", { signal: controller.signal });

    const [, init] = downstreamFetch.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
  });
});
