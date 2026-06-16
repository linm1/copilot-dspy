# Ax Copilot Studio

A VS Code extension that ports the GitHub Copilot OAuth device-flow client from
the sibling Python project (`copilot-dspy`) to TypeScript, and routes requests
through [Ax](https://github.com/ax-llm/ax) (the TypeScript DSPy port). Define a
signature, pick a module (Predict / ChainOfThought / ReAct), and run it against
your Copilot subscription from a webview panel.

## Status

**Wave 1** (this build): project scaffold + dependency-free spine — auth
(device flow, token storage via `vscode.SecretStorage`), the Ax/Copilot fetch
bridge, the module runner, and built-in ReAct tools. No webview UI yet (see
`src/extension.ts` and `src/webview/panel.ts` for the Wave 2 TODO).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build        # esbuild bundle -> dist/extension.js
```

Press `F5` in VS Code to launch an Extension Development Host and run the
**Ax Copilot: Open Studio** command.

## Auth

Sign-in uses the GitHub OAuth device flow (client ID `Iv1.b507a08c87ecfe98`,
scope `read:user`) — identical to the Python reference client. Tokens are
stored in `vscode.SecretStorage`, never on disk. A legacy
`~/.config/copilot-dspy/token-*.json` file (from the Python client) is
imported once on first run, then deleted.

## Enterprise (GHE.com)

Set the `axCopilot.enterpriseDomain` setting (or `COPILOT_ENTERPRISE_DOMAIN`
env var) to route through a GitHub Enterprise Copilot proxy. See
`src/auth/apiBase.ts` for the trust-list / SSRF-guard logic.
