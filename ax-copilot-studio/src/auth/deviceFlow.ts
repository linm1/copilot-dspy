/**
 * GitHub OAuth device flow: request a device code, then poll for the user
 * to authorize it. Faithful port of
 * CopilotTokenManager._device_flow_auth / _refresh_token from
 * copilot_dspy_client.py.
 */

export const FALLBACK_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const DEVICE_SCOPE = "read:user";
const MAX_POLL_ATTEMPTS = 120;

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval?: number;
}

export interface AccessTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface PreparedTokenData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_at: string;
  acquired_at: string;
}

/** Injectable fetch + sleep + clock so the polling loop is unit-testable without real timers/network. */
export interface DeviceFlowDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now?: () => Date;
  clientId?: string;
  onDeviceCode?: (response: DeviceCodeResponse) => void;
}

export async function requestDeviceCode(deviceCodeUrl: string, deps: DeviceFlowDeps): Promise<DeviceCodeResponse> {
  const clientId = deps.clientId ?? FALLBACK_CLIENT_ID;
  const response = await deps.fetch(deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: clientId, scope: DEVICE_SCOPE }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Device code request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as DeviceCodeResponse;
}

function buildPreparedTokenData(auth: AccessTokenResponse, now: Date): PreparedTokenData {
  const expiresIn = auth.expires_in ?? 28800;
  return {
    access_token: auth.access_token as string,
    refresh_token: auth.refresh_token,
    token_type: auth.token_type ?? "Bearer",
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    acquired_at: now.toISOString(),
  };
}

/**
 * Poll-state outcome for a single iteration -- exposed for the state-machine
 * unit tests so the polling decision logic (continue / slow_down / done /
 * fail) can be exercised without real sleeps.
 */
export type PollOutcome =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "success"; token: PreparedTokenData }
  | { kind: "failed"; message: string };

export function interpretPollResponse(auth: AccessTokenResponse, now: Date): PollOutcome {
  if (auth.access_token) {
    return { kind: "success", token: buildPreparedTokenData(auth, now) };
  }
  if (auth.error === "authorization_pending") {
    return { kind: "pending" };
  }
  if (auth.error === "slow_down") {
    return { kind: "slow_down" };
  }
  return { kind: "failed", message: auth.error_description ?? auth.error ?? "unknown error" };
}

/** Run the full device flow: request a code, show it, then poll until authorized. */
export async function runDeviceFlowAuth(
  deviceCodeUrl: string,
  deviceAuthUrl: string,
  deps: DeviceFlowDeps,
): Promise<PreparedTokenData> {
  const clientId = deps.clientId ?? FALLBACK_CLIENT_ID;
  const deviceResponse = await requestDeviceCode(deviceCodeUrl, deps);
  deps.onDeviceCode?.(deviceResponse);

  let interval = deviceResponse.interval ?? 5;

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await deps.sleep(interval * 1000);

    const resp = await deps.fetch(deviceAuthUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceResponse.device_code,
        grant_type: GRANT_TYPE,
      }).toString(),
    });
    if (!resp.ok) {
      throw new Error(`Device auth poll failed: HTTP ${resp.status}`);
    }
    const auth = (await resp.json()) as AccessTokenResponse;
    const outcome = interpretPollResponse(auth, deps.now ? deps.now() : new Date());

    if (outcome.kind === "success") {
      return outcome.token;
    }
    if (outcome.kind === "pending") {
      continue;
    }
    if (outcome.kind === "slow_down") {
      interval += 5;
      continue;
    }
    throw new Error(`Authentication failed: ${outcome.message}`);
  }

  throw new Error("Device flow authentication timed out after 10 minutes");
}

/** Attempt to renew the OAuth token using a stored refresh_token. */
export async function refreshOAuthToken(
  deviceAuthUrl: string,
  refreshToken: string,
  deps: DeviceFlowDeps,
): Promise<PreparedTokenData> {
  const clientId = deps.clientId ?? FALLBACK_CLIENT_ID;
  const resp = await deps.fetch(deviceAuthUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!resp.ok) {
    throw new Error(`Token refresh failed: HTTP ${resp.status}`);
  }
  const auth = (await resp.json()) as AccessTokenResponse;
  if (auth.access_token) {
    return buildPreparedTokenData(auth, deps.now ? deps.now() : new Date());
  }
  throw new Error(`Token refresh failed: ${auth.error_description ?? "unknown error"}`);
}
