/**
 * Webview front-end: form logic, message passing, streaming render.
 * Runs inside the VS Code webview's sandboxed browser context -- no `vscode`
 * Node API, only `acquireVsCodeApi()` + DOM. Bundled separately from the
 * extension host by esbuild (browser/esm target), per esbuild.js.
 */

import {
  AxModuleKind,
  BuiltinToolName,
  HostToWebviewMessage,
  RunInputs,
  SavedRunConfig,
  SignatureFieldRow,
  WebviewToHostMessage,
} from "../../types";
import { shouldRenderFinalOutput } from "../finalOutput";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

function post(message: WebviewToHostMessage): void {
  vscode.postMessage(message);
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing #${id} in webview DOM`);
  }
  return el as T;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface UiState {
  module: AxModuleKind;
  model: string;
  signatureString: string;
  inputRows: SignatureFieldRow[];
  outputRows: SignatureFieldRow[];
  enabledTools: Set<BuiltinToolName>;
  savedConfigs: SavedRunConfig[];
  activeRunId: string | undefined;
}

const state: UiState = {
  module: "Predict",
  model: "gpt-5-mini",
  signatureString: "documentText:string -> summary:string, keyPoints:string",
  inputRows: [{ name: "documentText", type: "string" }],
  outputRows: [
    { name: "summary", type: "string" },
    { name: "keyPoints", type: "string" },
  ],
  enabledTools: new Set(),
  savedConfigs: [],
  activeRunId: undefined,
};

function genRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Signature string <-> rows sync (best-effort; host re-validates on run.start)
// ---------------------------------------------------------------------------

function rowsToString(inputs: SignatureFieldRow[], outputs: SignatureFieldRow[]): string {
  const renderRow = (row: SignatureFieldRow): string => {
    let out = row.name;
    if (row.isOptional) out += "?";
    if (row.isInternal) out += "!";
    if (row.type === "class") {
      out += `:class "${(row.classOptions ?? []).join(" | ")}"`;
    } else {
      out += `:${row.type}`;
      if (row.isArray) out += "[]";
    }
    if (row.description) out += ` "${row.description}"`;
    return out;
  };
  return `${inputs.map(renderRow).join(", ")} -> ${outputs.map(renderRow).join(", ")}`;
}

function syncStringFromRows(): void {
  state.signatureString = rowsToString(state.inputRows, state.outputRows);
  byId<HTMLTextAreaElement>("signature-string").value = state.signatureString;
  renderRunInputFields();
  // Rows are built from structured fields, so the regenerated string is
  // always well-formed -- clear any stale error/disabled-Run state left
  // over from a previous invalid textarea edit (Codex P2: editing rows
  // after a bad signature string never re-enabled Run).
  showSignatureError(undefined);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderFieldRows(containerId: string, rows: SignatureFieldRow[], onChange: () => void): void {
  const container = byId<HTMLDivElement>(containerId);
  container.innerHTML = "";
  rows.forEach((row, index) => {
    const rowEl = document.createElement("div");
    rowEl.className = "field-row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = row.name;
    nameInput.placeholder = "fieldName";
    nameInput.addEventListener("input", () => {
      rows[index] = { ...rows[index], name: nameInput.value };
      onChange();
    });

    const typeSelect = document.createElement("select");
    ["string", "number", "boolean", "json", "image", "audio", "date", "datetime", "class", "code"].forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      if (t === row.type) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener("change", () => {
      rows[index] = { ...rows[index], type: typeSelect.value as SignatureFieldRow["type"] };
      onChange();
    });

    const descInput = document.createElement("input");
    descInput.type = "text";
    descInput.value = row.description ?? "";
    descInput.placeholder = "description (optional)";
    descInput.addEventListener("input", () => {
      rows[index] = { ...rows[index], description: descInput.value || undefined };
      onChange();
    });

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      rows.splice(index, 1);
      onChange();
      rerenderSignatureRows();
    });

    rowEl.append(nameInput, typeSelect, descInput, removeBtn);
    container.appendChild(rowEl);
  });
}

function rerenderSignatureRows(): void {
  renderFieldRows("input-rows", state.inputRows, syncStringFromRows);
  renderFieldRows("output-rows", state.outputRows, syncStringFromRows);
  syncStringFromRows();
}

function renderRunInputFields(): void {
  const container = byId<HTMLDivElement>("run-input-fields");
  container.innerHTML = "";
  for (const row of state.inputRows) {
    if (!row.name) continue;
    const wrapper = document.createElement("div");
    const label = document.createElement("label");
    label.className = "label";
    label.textContent = row.name;
    const input = document.createElement(row.type === "json" ? "textarea" : "input");
    input.id = `run-input-${row.name}`;
    if (input instanceof HTMLInputElement) {
      input.type = row.type === "number" ? "number" : "text";
    }
    wrapper.append(label, input);
    container.appendChild(wrapper);
  }
}

function collectRunInputs(): RunInputs {
  const inputs: RunInputs = {};
  for (const row of state.inputRows) {
    if (!row.name) continue;
    const el = document.getElementById(`run-input-${row.name}`) as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    if (!el) continue;
    if (row.type === "number") {
      inputs[row.name] = Number(el.value);
    } else if (row.type === "json") {
      try {
        inputs[row.name] = JSON.parse(el.value);
      } catch {
        inputs[row.name] = el.value;
      }
    } else {
      inputs[row.name] = el.value;
    }
  }
  return inputs;
}

function renderSavedConfigs(): void {
  const container = byId<HTMLDivElement>("saved-configs-list");
  container.innerHTML = "";
  for (const config of state.savedConfigs) {
    const row = document.createElement("div");
    row.className = "saved-config-row";

    const name = document.createElement("span");
    name.textContent = config.name;

    const actions = document.createElement("div");
    actions.className = "row";

    const loadBtn = document.createElement("button");
    loadBtn.textContent = "Load";
    loadBtn.addEventListener("click", () => {
      applyConfig(config);
      post({ type: "config.load", name: config.name });
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "danger";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", () => {
      post({ type: "config.delete", name: config.name });
    });

    actions.append(loadBtn, deleteBtn);
    row.append(name, actions);
    container.appendChild(row);
  }
}

function applyConfig(config: SavedRunConfig): void {
  state.signatureString = config.signatureString;
  state.module = config.module;
  state.model = config.model;
  state.enabledTools = new Set(config.enabledTools);

  byId<HTMLTextAreaElement>("signature-string").value = config.signatureString;
  byId<HTMLSelectElement>("model-select").value = config.model;
  setActiveModule(config.module);

  try {
    const parsed = parseStringToRowsBestEffort(config.signatureString);
    state.inputRows = parsed.inputs;
    state.outputRows = parsed.outputs;
    renderFieldRows("input-rows", state.inputRows, syncStringFromRows);
    renderFieldRows("output-rows", state.outputRows, syncStringFromRows);
    renderRunInputFields();
  } catch {
    // Leave rows stale; string field remains source of truth (Component 3).
  }

  document.querySelectorAll<HTMLInputElement>("#tool-checkboxes input[type=checkbox]").forEach((cb) => {
    cb.checked = state.enabledTools.has(cb.value as BuiltinToolName);
  });
}

/**
 * Minimal best-effort string->rows parser for the webview side (the
 * authoritative parser is Ax's AxSignature on the host; this one is only
 * used to pre-populate rows when loading a saved config, and silently
 * degrades to "keep rows as-is" on any parse failure).
 */
function parseStringToRowsBestEffort(signatureString: string): { inputs: SignatureFieldRow[]; outputs: SignatureFieldRow[] } {
  const [inputsPart, outputsPart] = signatureString.split("->");
  if (!inputsPart || !outputsPart) {
    throw new Error("not a valid signature string");
  }
  const parseSide = (side: string): SignatureFieldRow[] =>
    side
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((field) => {
        const [namePart, typePart] = field.split(":");
        const isOptional = namePart.includes("?");
        const isInternal = namePart.includes("!");
        const name = namePart.replace(/[?!]/g, "").trim();
        const type = (typePart?.trim().split(" ")[0].replace("[]", "") || "string") as SignatureFieldRow["type"];
        const isArray = Boolean(typePart?.includes("[]"));
        return { name, type, isOptional, isInternal, isArray };
      });
  return { inputs: parseSide(inputsPart), outputs: parseSide(outputsPart) };
}

function setActiveModule(module: AxModuleKind): void {
  state.module = module;
  document.querySelectorAll<HTMLButtonElement>("#module-segmented button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.module === module);
  });
  byId<HTMLDivElement>("tool-checkboxes").classList.toggle("visible", module === "ReAct");
}

function setAuthStatus(signedIn: boolean, domain?: string): void {
  const badge = byId<HTMLSpanElement>("auth-status");
  badge.classList.toggle("signed-in", signedIn);
  badge.classList.toggle("signed-out", !signedIn);
  badge.textContent = signedIn ? `Signed In (${domain ?? "github.com"})` : "Signed Out";
  if (signedIn) {
    byId<HTMLDivElement>("device-code-box").classList.remove("visible");
  }
}

function showSignatureError(message: string | undefined): void {
  const banner = byId<HTMLDivElement>("signature-error");
  banner.textContent = message ?? "";
  banner.classList.toggle("visible", Boolean(message));
  byId<HTMLButtonElement>("run-btn").disabled = Boolean(message);
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

let reasoningBuffer = "";
const toolTraceEntries: string[] = [];
let hasStreamedDelta = false;

function resetResultsArea(): void {
  byId<HTMLDivElement>("results").textContent = "";
  byId<HTMLDivElement>("usage-summary").textContent = "";
  byId<HTMLDivElement>("tool-trace").innerHTML = "";
  byId<HTMLDivElement>("reasoning-content").textContent = "";
  (byId<HTMLDetailsElement>("reasoning-box") as HTMLElement).style.display = "none";
  reasoningBuffer = "";
  toolTraceEntries.length = 0;
  hasStreamedDelta = false;
}

function appendDelta(delta: Record<string, unknown>): void {
  const resultsEl = byId<HTMLDivElement>("results");
  for (const [key, value] of Object.entries(delta)) {
    if (key === "reasoning") {
      reasoningBuffer += String(value ?? "");
      const box = byId<HTMLElement>("reasoning-box");
      box.style.display = "block";
      byId<HTMLDivElement>("reasoning-content").textContent = reasoningBuffer;
      continue;
    }
    resultsEl.textContent += `${typeof value === "string" ? value : JSON.stringify(value)}`;
  }
}

function startRun(): void {
  const runId = genRunId();
  state.activeRunId = runId;
  resetResultsArea();
  byId<HTMLButtonElement>("run-btn").disabled = true;
  byId<HTMLButtonElement>("cancel-btn").disabled = false;

  post({
    type: "run.start",
    runId,
    signatureString: state.signatureString,
    module: state.module,
    model: state.model,
    inputs: collectRunInputs(),
    enabledTools: Array.from(state.enabledTools),
  });
}

function cancelRun(): void {
  if (!state.activeRunId) return;
  post({ type: "run.cancel", runId: state.activeRunId });
  endRunUi();
}

function endRunUi(): void {
  byId<HTMLButtonElement>("run-btn").disabled = false;
  byId<HTMLButtonElement>("cancel-btn").disabled = true;
}

// ---------------------------------------------------------------------------
// Host -> webview message handling
// ---------------------------------------------------------------------------

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "auth.deviceCode": {
      const box = byId<HTMLDivElement>("device-code-box");
      box.classList.add("visible");
      byId<HTMLSpanElement>("device-user-code").textContent = message.userCode;
      byId<HTMLSpanElement>("device-verification-uri").textContent = message.verificationUri;
      return;
    }
    case "auth.ready":
      setAuthStatus(true, message.domain);
      post({ type: "models.list" });
      return;
    case "models.result": {
      const select = byId<HTMLSelectElement>("model-select");
      select.innerHTML = "";
      for (const model of message.models) {
        const opt = document.createElement("option");
        opt.value = model;
        opt.textContent = model;
        if (model === state.model) opt.selected = true;
        select.appendChild(opt);
      }
      return;
    }
    case "run.delta":
      if (message.runId !== state.activeRunId) return; // stale/superseded -- drop
      hasStreamedDelta = true;
      appendDelta(message.delta);
      return;
    case "run.done":
      if (message.runId !== state.activeRunId) return;
      // Deltas already rendered the output incrementally; re-appending
      // `output` here would duplicate it (e.g. "Hello world world").
      // Only render it when this run never streamed any deltas.
      if (shouldRenderFinalOutput(hasStreamedDelta)) {
        appendDelta(message.output);
      }
      if (message.usage) {
        byId<HTMLDivElement>("usage-summary").textContent = `tokens: ${message.usage.totalTokens} (in ${message.usage.inputTokens} / out ${message.usage.outputTokens}), requests: ${message.usage.requests}`;
      }
      endRunUi();
      return;
    case "run.error":
      if (message.runId !== state.activeRunId && message.runId !== "auth") return;
      byId<HTMLDivElement>("results").textContent += `\n[ERROR] ${message.message}`;
      endRunUi();
      return;
    case "configs.list":
      state.savedConfigs = message.configs;
      renderSavedConfigs();
      return;
    default:
      return;
  }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function init(): void {
  byId<HTMLButtonElement>("sign-in-btn").addEventListener("click", () => post({ type: "auth.start" }));

  byId<HTMLTextAreaElement>("signature-string").addEventListener("change", (e) => {
    state.signatureString = (e.target as HTMLTextAreaElement).value;
    try {
      const parsed = parseStringToRowsBestEffort(state.signatureString);
      state.inputRows = parsed.inputs;
      state.outputRows = parsed.outputs;
      renderFieldRows("input-rows", state.inputRows, syncStringFromRows);
      renderFieldRows("output-rows", state.outputRows, syncStringFromRows);
      renderRunInputFields();
      showSignatureError(undefined);
    } catch {
      showSignatureError("Could not parse signature string into rows; string remains source of truth.");
    }
  });

  byId<HTMLButtonElement>("add-input-row").addEventListener("click", () => {
    state.inputRows.push({ name: "", type: "string" });
    rerenderSignatureRows();
  });
  byId<HTMLButtonElement>("add-output-row").addEventListener("click", () => {
    state.outputRows.push({ name: "", type: "string" });
    rerenderSignatureRows();
  });

  document.querySelectorAll<HTMLButtonElement>("#module-segmented button").forEach((btn) => {
    btn.addEventListener("click", () => setActiveModule(btn.dataset.module as AxModuleKind));
  });

  document.querySelectorAll<HTMLInputElement>("#tool-checkboxes input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const tool = cb.value as BuiltinToolName;
      if (cb.checked) state.enabledTools.add(tool);
      else state.enabledTools.delete(tool);
    });
  });

  byId<HTMLSelectElement>("model-select").addEventListener("change", (e) => {
    state.model = (e.target as HTMLSelectElement).value;
  });

  byId<HTMLButtonElement>("save-config-btn").addEventListener("click", () => {
    const name = byId<HTMLInputElement>("config-name").value.trim();
    if (!name) return;
    post({
      type: "config.save",
      config: {
        name,
        signatureString: state.signatureString,
        module: state.module,
        model: state.model,
        enabledTools: Array.from(state.enabledTools),
      },
    });
  });

  byId<HTMLButtonElement>("run-btn").addEventListener("click", startRun);
  byId<HTMLButtonElement>("cancel-btn").addEventListener("click", cancelRun);

  rerenderSignatureRows();
  // Do NOT request models here: this runs on view open, before the user has
  // signed in, and models.list on the host triggers tokenManager.getToken(),
  // which can kick off the device-flow browser prompt merely by opening the
  // view (Codex P2 finding). Models are fetched once signed-in via the
  // "auth.ready" handler above instead.
}

init();
