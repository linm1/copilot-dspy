/**
 * Fetches the list of available Copilot models for the UI dropdown.
 *
 * Risk (per spec Component 2): the Python reference client never calls a
 * `/models` endpoint, so its exact response shape is unverified against a
 * live Copilot API in this offline build. We GET `{apiBase}/models` with the
 * same auth headers as chat completions and accept either a bare array or an
 * OpenAI-style `{ data: [...] }` envelope; on any failure (network, bad
 * shape, non-2xx) we fall back to a static list seeded with `gpt-5-mini`
 * (the app.py demo default) so the UI never shows an empty dropdown.
 */

import { CopilotTokenManager } from "../auth/copilotTokenManager";
import { VS_CODE_HEADERS } from "./headers";

export const FALLBACK_MODELS: readonly string[] = ["gpt-5-mini", "gpt-4o", "gpt-4o-mini"];

export interface ListModelsOptions {
  tokenManager: CopilotTokenManager;
  fetchImpl?: typeof fetch;
}

interface ModelsResponseEnvelope {
  data?: { id: string }[];
}

function parseModelIds(body: unknown): string[] | undefined {
  if (Array.isArray(body)) {
    const ids = body
      .map((entry) => (typeof entry === "string" ? entry : (entry as { id?: string })?.id))
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids.length > 0 ? ids : undefined;
  }
  const envelope = body as ModelsResponseEnvelope;
  if (Array.isArray(envelope?.data)) {
    const ids = envelope.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    return ids.length > 0 ? ids : undefined;
  }
  return undefined;
}

/** GET {apiBase}/models -> list of model ids, falling back to a static list on any failure. */
export async function listModels(options: ListModelsOptions): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const token = await options.tokenManager.getToken();
    const apiBase = await options.tokenManager.getApiBase();
    const response = await fetchImpl(`${apiBase}/models`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...VS_CODE_HEADERS,
      },
    });
    if (!response.ok) {
      return [...FALLBACK_MODELS];
    }
    const body = await response.json();
    const ids = parseModelIds(body);
    return ids ?? [...FALLBACK_MODELS];
  } catch {
    return [...FALLBACK_MODELS];
  }
}
