/**
 * A `fetch`-compatible wrapper that injects a fresh Copilot session token +
 * VS_CODE_HEADERS + Openai-Intent on every request, and on HTTP 401 forces a
 * token refresh and retries exactly once. This is the function passed as
 * `options.fetch` to Ax's AxAI("openai", ...) instance -- ALL Copilot auth
 * lives here so the rest of the Ax bridge stays provider-agnostic.
 *
 * Mirrors CopilotLM._make_request's 401 -> refresh -> retry behaviour from
 * copilot_dspy_client.py (the 3-attempt exponential-backoff retry loop there
 * also covers timeouts/5xx; this wrapper covers the 401 refresh case, which
 * is the auth-specific piece in scope for the LLM bridge -- general
 * transient-error retry is handled by Ax/the underlying HTTP stack).
 */

import { CopilotTokenManager } from "../auth/copilotTokenManager";
import { VS_CODE_HEADERS } from "./headers";

export interface CopilotFetchOptions {
  tokenManager: CopilotTokenManager;
  fetchImpl?: typeof fetch;
}

/** Build a fetch function bound to a token manager, suitable for Ax's `options.fetch`. */
export function createCopilotFetch(options: CopilotFetchOptions): typeof fetch {
  const baseFetch = options.fetchImpl ?? fetch;
  const tokenManager = options.tokenManager;

  return async function copilotFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const token = await tokenManager.getToken();
    const response = await sendWithToken(baseFetch, input, init, token);

    if (response.status !== 401) {
      return response;
    }

    // 401 -> force a session-token refresh and retry exactly once.
    const refreshedToken = await tokenManager.getToken(true);
    return sendWithToken(baseFetch, input, init, refreshedToken);
  };
}

async function sendWithToken(
  baseFetch: typeof fetch,
  input: string | URL | Request,
  init: RequestInit | undefined,
  token: string,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Openai-Intent", "conversation-edits");
  for (const [key, value] of Object.entries(VS_CODE_HEADERS)) {
    headers.set(key, value);
  }

  return baseFetch(input, {
    ...init,
    headers,
    // Forward the caller's AbortSignal (if any) so a cancelled run aborts
    // the in-flight HTTP request rather than streaming to completion.
    signal: init?.signal,
  });
}
