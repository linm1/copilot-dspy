/**
 * Extension host entry point.
 *
 * Wave 2: constructs the real `CopilotTokenManager` (backed by
 * `context.secrets`), the `SavedConfigsStore` (backed by
 * `context.globalState`), and registers the real `StudioViewProvider`
 * (src/webview/panel.ts) in place of the Wave 1 stub.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CopilotTokenManager } from "./auth/copilotTokenManager";
import { SavedConfigsStore } from "./state/savedConfigs";
import { StudioViewProvider } from "./webview/panel";

const STUDIO_VIEW_ID = "axCopilot.studioView";

function getWorkspaceRoots(): readonly string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

function getEnterpriseDomainSetting(): string | undefined {
  return vscode.workspace.getConfiguration("axCopilot").get<string>("enterpriseDomain") || undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  const tokenManager = new CopilotTokenManager({
    secrets: context.secrets,
    enterpriseDomain: getEnterpriseDomainSetting(),
    envDomain: process.env.COPILOT_ENTERPRISE_DOMAIN,
    legacyConfigDir: path.join(os.homedir(), ".config", "copilot-dspy"),
    onDeviceCode: (response) => {
      void vscode.env.clipboard.writeText(response.user_code);
      void vscode.env.openExternal(vscode.Uri.parse(response.verification_uri));
      void vscode.window.showInformationMessage(
        `Ax Copilot Studio: enter code ${response.user_code} at ${response.verification_uri} (copied to clipboard)`,
      );
    },
  });

  const savedConfigs = new SavedConfigsStore(context.globalState);

  const provider = new StudioViewProvider({
    tokenManager,
    savedConfigs,
    getWorkspaceRoots,
    extensionUri: context.extensionUri,
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(STUDIO_VIEW_ID, provider),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("axCopilot.openStudio", async () => {
      await vscode.commands.executeCommand(`${STUDIO_VIEW_ID}.focus`);
    }),
  );
}

export function deactivate(): void {
  // No explicit teardown needed: in-flight runs are owned by per-run
  // AbortControllers inside StudioViewProvider's RunRegistry, and
  // CopilotTokenManager holds no resources beyond in-memory state + the
  // injected SecretStorage.
}
