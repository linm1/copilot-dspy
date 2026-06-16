/**
 * Shared types for the extension host <-> webview message protocol, and for
 * config/run state used by both src/runner and (in Wave 2) src/webview.
 *
 * Kept dependency-free (no `vscode` import) so it can be used from unit
 * tests and from the webview UI bundle without pulling in Node/VS Code APIs.
 */

/** The three DSPy-style modules this extension supports in v1. */
export type AxModuleKind = "Predict" | "ChainOfThought" | "ReAct";

/** Identifiers for the built-in ReAct starter tools (src/runner/tools.ts). */
export type BuiltinToolName = "readFile" | "listFiles" | "fetchUrl";

/** A single structured input/output row in the signature builder UI. */
export interface SignatureFieldRow {
  name: string;
  /** Ax field type keyword, e.g. "string" | "number" | "class" | ... */
  type: "string" | "number" | "boolean" | "json" | "image" | "audio" | "date" | "datetime" | "class" | "code";
  description?: string;
  /** Required for type === "class". */
  classOptions?: string[];
  /** Required for type === "code". */
  codeLanguage?: string;
  isOptional?: boolean;
  isArray?: boolean;
  isInternal?: boolean;
}

/** A named, persisted run configuration (src/state/savedConfigs.ts, Wave 2). */
export interface SavedRunConfig {
  name: string;
  signatureString: string;
  module: AxModuleKind;
  model: string;
  enabledTools: BuiltinToolName[];
}

/** Inputs keyed by signature input-field name; values are user-entered strings. */
export type RunInputs = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Webview -> host messages
// ---------------------------------------------------------------------------

export interface AuthStartMessage {
  type: "auth.start";
}

export interface ModelsListMessage {
  type: "models.list";
}

export interface ConfigSaveMessage {
  type: "config.save";
  config: SavedRunConfig;
}

export interface ConfigLoadMessage {
  type: "config.load";
  name: string;
}

export interface ConfigDeleteMessage {
  type: "config.delete";
  name: string;
}

export interface RunStartMessage {
  type: "run.start";
  runId: string;
  signatureString: string;
  module: AxModuleKind;
  model: string;
  inputs: RunInputs;
  enabledTools: BuiltinToolName[];
}

export interface RunCancelMessage {
  type: "run.cancel";
  runId: string;
}

export type WebviewToHostMessage =
  | AuthStartMessage
  | ModelsListMessage
  | ConfigSaveMessage
  | ConfigLoadMessage
  | ConfigDeleteMessage
  | RunStartMessage
  | RunCancelMessage;

// ---------------------------------------------------------------------------
// Host -> webview messages
// ---------------------------------------------------------------------------

export interface AuthDeviceCodeMessage {
  type: "auth.deviceCode";
  userCode: string;
  verificationUri: string;
}

export interface AuthReadyMessage {
  type: "auth.ready";
  domain: string;
}

export interface ModelsResultMessage {
  type: "models.result";
  models: string[];
}

/** Stamped with the runId so stale/cancelled runs can be dropped by the receiver. */
export interface RunDeltaMessage {
  type: "run.delta";
  runId: string;
  delta: Record<string, unknown>;
}

export interface RunDoneMessage {
  type: "run.done";
  runId: string;
  output: Record<string, unknown>;
  usage?: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface RunErrorMessage {
  type: "run.error";
  runId: string;
  message: string;
}

export interface ConfigsListMessage {
  type: "configs.list";
  configs: SavedRunConfig[];
}

export type HostToWebviewMessage =
  | AuthDeviceCodeMessage
  | AuthReadyMessage
  | ModelsResultMessage
  | RunDeltaMessage
  | RunDoneMessage
  | RunErrorMessage
  | ConfigsListMessage;
