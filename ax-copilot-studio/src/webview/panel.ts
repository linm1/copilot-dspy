/**
 * Host side of the webview panel: a `vscode.WebviewViewProvider` that serves
 * the HTML shell (CSP + nonce) and speaks the postMessage protocol defined in
 * src/types.ts.
 *
 * Responsibilities (spec Component 7 + Architecture/"Cancellation model"):
 *  - auth.start            -> kick off device flow via CopilotTokenManager,
 *                             forward auth.deviceCode / auth.ready
 *  - models.list           -> listModels() -> models.result
 *  - config.save / load    -> SavedConfigsStore -> configs.list
 *  - run.start / run.cancel -> RunRegistry-backed runId/AbortController
 *                              bookkeeping; builds the Ax provider + runs the
 *                              module; streams run.delta, then run.done /
 *                              run.error, each stamped with runId. Late
 *                              events for a stale/cancelled runId are
 *                              dropped via `RunRegistry.isActive()`.
 *
 * This module DOES import `vscode` (it's a real WebviewViewProvider), so it
 * is exercised manually (F5) rather than under vitest. The cancellation/
 * stale-drop core it depends on (`RunRegistry`) is extracted into
 * src/webview/runRegistry.ts and unit-tested there without any vscode import.
 */

import * as vscode from "vscode";
import { CopilotTokenManager } from "../auth/copilotTokenManager";
import { createCopilotProvider } from "../llm/copilotProvider";
import { listModels } from "../llm/models";
import { createBuiltinTools, WorkspaceRootsProvider } from "../runner/tools";
import { isAbortError, runModule } from "../runner/moduleRunner";
import { SavedConfigsStore } from "../state/savedConfigs";
import {
  BuiltinToolName,
  HostToWebviewMessage,
  RunStartMessage,
  WebviewToHostMessage,
} from "../types";
import { STUDIO_FORM_MARKUP } from "./formMarkup";
import { RunRegistry } from "./runRegistry";

export interface StudioViewProviderOptions {
  tokenManager: CopilotTokenManager;
  savedConfigs: SavedConfigsStore;
  getWorkspaceRoots: WorkspaceRootsProvider;
  /** Resolves the dist asset URIs for the webview UI bundle (CSS/JS). */
  extensionUri: vscode.Uri;
}

function nonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class StudioViewProvider implements vscode.WebviewViewProvider {
  private readonly runs = new RunRegistry();
  private webview: vscode.Webview | undefined;

  constructor(private readonly options: StudioViewProviderOptions) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webview = webviewView.webview;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.options.extensionUri, "dist")],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      void this.handleMessage(message);
    });

    this.post({ type: "configs.list", configs: this.options.savedConfigs.list() });
  }

  private post(message: HostToWebviewMessage): void {
    void this.webview?.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const csp = nonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "dist", "webview", "styles.css"),
    );

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${csp}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Ax Copilot Studio</title>
  </head>
  <body>
    ${STUDIO_FORM_MARKUP}
    <script nonce="${csp}" src="${scriptUri}"></script>
  </body>
</html>`;
  }

  private async handleMessage(message: WebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case "auth.start":
        await this.handleAuthStart();
        return;
      case "models.list":
        await this.handleModelsList();
        return;
      case "config.save":
        await this.options.savedConfigs.save(message.config);
        this.post({ type: "configs.list", configs: this.options.savedConfigs.list() });
        return;
      case "config.load":
        // The webview already holds the full SavedRunConfig client-side
        // (populated from the last configs.list); "load" here just confirms
        // the canonical list is current.
        this.post({ type: "configs.list", configs: this.options.savedConfigs.list() });
        return;
      case "config.delete":
        await this.options.savedConfigs.delete(message.name);
        this.post({ type: "configs.list", configs: this.options.savedConfigs.list() });
        return;
      case "run.start":
        await this.handleRunStart(message);
        return;
      case "run.cancel":
        this.runs.cancel(message.runId);
        return;
      default:
        return;
    }
  }

  private async handleAuthStart(): Promise<void> {
    try {
      await this.options.tokenManager.getToken();
      this.post({ type: "auth.ready", domain: this.options.tokenManager.domain });
    } catch (error) {
      this.post({
        type: "run.error",
        runId: "auth",
        message: error instanceof Error ? error.message : "Sign-in failed",
      });
    }
  }

  private async handleModelsList(): Promise<void> {
    const models = await listModels({ tokenManager: this.options.tokenManager });
    this.post({ type: "models.result", models });
  }

  private async handleRunStart(message: RunStartMessage): Promise<void> {
    const { runId } = message;
    const signal = this.runs.register(runId);

    try {
      const ai = await createCopilotProvider({
        tokenManager: this.options.tokenManager,
        model: message.model,
      });

      const functions =
        message.module === "ReAct" ? this.buildEnabledTools(message.enabledTools, signal) : undefined;

      const result = await runModule({
        ai,
        signatureString: message.signatureString,
        module: message.module,
        inputs: message.inputs,
        functions,
        signal,
        onDelta: (delta) => {
          if (!this.runs.isActive(runId)) {
            return; // stale/superseded run -- drop per cancellation model
          }
          this.post({ type: "run.delta", runId, delta: delta as Record<string, unknown> });
        },
      });

      if (!this.runs.isActive(runId)) {
        return; // superseded while awaiting completion -- drop, no run.done
      }

      if (result.cancelled) {
        // Clean cancel: no further events for this runId.
        this.runs.complete(runId);
        return;
      }

      this.post({ type: "run.done", runId, output: result.output as Record<string, unknown> });
    } catch (error) {
      if (this.runs.isActive(runId) && !isAbortError(error, signal)) {
        this.post({
          type: "run.error",
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.runs.complete(runId);
    }
  }

  private buildEnabledTools(enabledTools: BuiltinToolName[], signal: AbortSignal) {
    const all = createBuiltinTools({ getWorkspaceRoots: this.options.getWorkspaceRoots, signal });
    return enabledTools.map((name) => all[name]);
  }
}
