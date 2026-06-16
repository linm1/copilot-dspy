import { describe, expect, it, vi } from "vitest";
import {
  AccessTokenResponse,
  interpretPollResponse,
  refreshOAuthToken,
  requestDeviceCode,
  runDeviceFlowAuth,
} from "./deviceFlow";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe("interpretPollResponse (polling state machine)", () => {
  const now = new Date("2024-01-01T00:00:00Z");

  it("returns success with prepared token data when access_token is present", () => {
    const auth: AccessTokenResponse = { access_token: "ghu_abc", expires_in: 100 };
    const outcome = interpretPollResponse(auth, now);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.token.access_token).toBe("ghu_abc");
      expect(outcome.token.expires_at).toBe(new Date(now.getTime() + 100_000).toISOString());
    }
  });

  it("returns pending for authorization_pending", () => {
    expect(interpretPollResponse({ error: "authorization_pending" }, now).kind).toBe("pending");
  });

  it("returns slow_down for slow_down", () => {
    expect(interpretPollResponse({ error: "slow_down" }, now).kind).toBe("slow_down");
  });

  it("returns failed for any other error", () => {
    const outcome = interpretPollResponse({ error: "access_denied", error_description: "denied" }, now);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.message).toBe("denied");
    }
  });
});

describe("requestDeviceCode", () => {
  it("posts client_id + scope and returns the parsed device code response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        device_code: "dc123",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
      }),
    );

    const result = await requestDeviceCode("https://github.com/login/device/code", {
      fetch: fetchMock,
      sleep: vi.fn(),
    });

    expect(result.user_code).toBe("ABCD-1234");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://github.com/login/device/code");
    expect(init.method).toBe("POST");
    expect(init.body).toContain("client_id=Iv1.b507a08c87ecfe98");
    expect(init.body).toContain("scope=read%3Auser");
  });

  it("throws on a non-ok response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    await expect(
      requestDeviceCode("https://github.com/login/device/code", { fetch: fetchMock, sleep: vi.fn() }),
    ).rejects.toThrow(/500/);
  });
});

describe("runDeviceFlowAuth", () => {
  it("continues polling through authorization_pending and slow_down, then succeeds", async () => {
    const deviceCodeResp = jsonResponse({
      device_code: "dc123",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval: 1,
    });

    const pollResponses = [
      jsonResponse({ error: "authorization_pending" }),
      jsonResponse({ error: "slow_down" }),
      jsonResponse({ access_token: "ghu_final", expires_in: 28800 }),
    ];

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(deviceCodeResp)
      .mockResolvedValueOnce(pollResponses[0])
      .mockResolvedValueOnce(pollResponses[1])
      .mockResolvedValueOnce(pollResponses[2]);

    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const onDeviceCode = vi.fn();

    const token = await runDeviceFlowAuth(
      "https://github.com/login/device/code",
      "https://github.com/login/oauth/access_token",
      { fetch: fetchMock, sleep: sleepMock, onDeviceCode },
    );

    expect(token.access_token).toBe("ghu_final");
    expect(onDeviceCode).toHaveBeenCalledWith(
      expect.objectContaining({ user_code: "ABCD-1234" }),
    );
    // 3 polls total: pending, slow_down, success
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // sleep intervals: 1s (initial), 1s (after pending), 6s (after slow_down bumped interval by 5)
    expect(sleepMock.mock.calls.map((c) => c[0])).toEqual([1000, 1000, 6000]);
  });

  it("throws when the server reports a terminal error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ device_code: "dc", user_code: "X", verification_uri: "https://x", interval: 1 }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: "access_denied", error_description: "User denied" }));

    await expect(
      runDeviceFlowAuth("https://github.com/login/device/code", "https://github.com/login/oauth/access_token", {
        fetch: fetchMock,
        sleep: vi.fn().mockResolvedValue(undefined),
      }),
    ).rejects.toThrow(/User denied/);
  });
});

describe("refreshOAuthToken", () => {
  it("returns prepared token data on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: "ghu_new", expires_in: 100 }));
    const token = await refreshOAuthToken("https://github.com/login/oauth/access_token", "refresh123", {
      fetch: fetchMock,
      sleep: vi.fn(),
    });
    expect(token.access_token).toBe("ghu_new");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toContain("grant_type=refresh_token");
    expect(init.body).toContain("refresh_token=refresh123");
  });

  it("throws when the response has no access_token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error_description: "invalid_grant" }));
    await expect(
      refreshOAuthToken("https://github.com/login/oauth/access_token", "bad", { fetch: fetchMock, sleep: vi.fn() }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
