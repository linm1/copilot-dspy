/**
 * Identity headers required by the Copilot API gateway on every request.
 * These identify this client as VS Code -- the only client type GitHub
 * currently authorises for third-party Copilot API access.
 *
 * Values copied byte-for-byte from copilot_dspy_client.py's VS_CODE_HEADERS.
 */
export const VS_CODE_HEADERS: Record<string, string> = {
  "Editor-Version": "vscode/1.99.3",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "Copilot-Integration-Id": "vscode-chat",
  "User-Agent": "GitHubCopilotChat/0.26.7",
};

const GPT5_RE = /^gpt-5(?:[.\-o]|$)/;

/** GPT-5 family rejects `max_tokens`; needs `max_completion_tokens`.
 *
 * Note (Wave 1 deviation): Ax's OpenAI provider builds the request body
 * internally from AxModelConfig.maxTokens; it does not currently expose a
 * hook for swapping the field name per-model the way the Python client's
 * `_build_request` does. This predicate is kept (and tested) for parity
 * with the Python oracle and for future use if Ax exposes a chatReqUpdater
 * hook we wire up, but Wave 1 does not yet rewrite the Ax request body.
 */
export function usesMaxCompletionTokens(model: string): boolean {
  return GPT5_RE.test(model);
}
