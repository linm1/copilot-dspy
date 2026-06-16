/**
 * Builds the Ax AI service backed by the Copilot chat API.
 *
 * Deviation from the spec (verified against the installed @ax-llm/ax types,
 * see Wave 1 report): there is no lowercase `ai()` factory function in this
 * version of Ax; the equivalent is the `AxAI` class, constructed with
 * `{ name: "openai", apiKey, config: { model }, apiURL, options: { fetch } }`.
 * The base URL is a top-level constructor arg (`apiURL`), not
 * `config.baseURL` -- `AxAIOpenAIConfig` has no `baseURL` field.
 *
 * Second deviation: when `name: "openai"`, Ax types `config.model` as the
 * closed `AxAIOpenAIModel` enum, which only lists models up to gpt-4o/o4 --
 * it predates Copilot/gpt-5-mini support and has no "arbitrary string"
 * escape hatch for this provider variant. Since Copilot's available models
 * are fetched dynamically from `{apiBase}/models` (src/llm/models.ts) and
 * are not knowable at the type level, we cast through `as AxAIOpenAIModel`
 * at this single boundary rather than widening the enum or forking the
 * provider. Runtime behavior is unaffected -- Ax forwards `config.model` to
 * the request body as a plain string.
 */

import { AxAI, AxAIOpenAIModel } from "@ax-llm/ax";
import { CopilotTokenManager } from "../auth/copilotTokenManager";
import { createCopilotFetch } from "./copilotFetch";

export interface CopilotProviderOptions {
  tokenManager: CopilotTokenManager;
  model: string;
  fetchImpl?: typeof fetch;
}

/**
 * Construct an Ax AI service that routes chat completions through the
 * Copilot API. The returned `AxAI` instance can be passed directly as the
 * `ai` argument to any `AxGen.forward()` / `streamingForward()` call.
 */
export async function createCopilotProvider(options: CopilotProviderOptions): Promise<AxAI> {
  const apiBase = await options.tokenManager.getApiBase();
  const copilotFetch = createCopilotFetch({
    tokenManager: options.tokenManager,
    fetchImpl: options.fetchImpl,
  });

  return new AxAI({
    name: "openai",
    // Placeholder: real auth is injected per-request inside copilotFetch via
    // the Authorization header; Ax's OpenAI provider requires a non-empty
    // apiKey string at construction time even though it is unused here.
    apiKey: "copilot",
    config: {
      // See deviation note above: Copilot model ids (e.g. "gpt-5-mini") are
      // not members of Ax's AxAIOpenAIModel enum, so we cast at this boundary.
      model: options.model as AxAIOpenAIModel,
    },
    apiURL: `${apiBase}`,
    options: {
      fetch: copilotFetch,
    },
  });
}
