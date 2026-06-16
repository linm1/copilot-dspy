/**
 * Single source of truth for the webview's form DOM (the contents of
 * `#root`). `panel.ts` (host) injects this into the served HTML; the
 * element IDs/classes here MUST stay in sync with what
 * `src/webview/ui/main.ts` queries via `byId(...)`.
 *
 * `src/webview/ui/index.html` is a static reference copy for manual
 * preview of styles.css only -- it is never read by the extension at
 * runtime. Keep it in sync with this constant if you change either.
 */
export const STUDIO_FORM_MARKUP = `<div id="root">
      <section class="section">
        <h2>Copilot Auth</h2>
        <div class="status-bar">
          <span id="auth-status" class="status-badge signed-out">Signed Out</span>
          <button id="sign-in-btn">Sign In To Copilot</button>
        </div>
        <div id="device-code-box" class="device-code-box">
          <span class="label">Go to <span id="device-verification-uri"></span> and enter:</span>
          <span id="device-user-code" class="device-code"></span>
        </div>
      </section>

      <section class="section">
        <h2>Model</h2>
        <select id="model-select"></select>
      </section>

      <section class="section">
        <h2>Signature</h2>
        <label class="label" for="signature-string">Ax Signature String</label>
        <textarea id="signature-string" rows="2"></textarea>
        <div id="signature-error" class="error-banner"></div>

        <div class="label">Inputs</div>
        <div id="input-rows"></div>
        <button id="add-input-row">+ Add Input</button>

        <div class="label">Outputs</div>
        <div id="output-rows"></div>
        <button id="add-output-row">+ Add Output</button>
      </section>

      <section class="section">
        <h2>Module</h2>
        <div class="segmented" id="module-segmented">
          <button data-module="Predict" class="active">Predict</button>
          <button data-module="ChainOfThought">ChainOfThought</button>
          <button data-module="ReAct">ReAct</button>
        </div>
        <div id="tool-checkboxes" class="tool-checkboxes">
          <label class="checkbox-row"><input type="checkbox" value="readFile" /> readFile</label>
          <label class="checkbox-row"><input type="checkbox" value="listFiles" /> listFiles</label>
          <label class="checkbox-row"><input type="checkbox" value="fetchUrl" /> fetchUrl</label>
        </div>
      </section>

      <section class="section">
        <h2>Run Inputs</h2>
        <div id="run-input-fields"></div>
      </section>

      <section class="section">
        <h2>Saved Configs</h2>
        <div class="row">
          <input type="text" id="config-name" placeholder="Config name" />
          <button id="save-config-btn">Save</button>
        </div>
        <div id="saved-configs-list" class="saved-configs-list"></div>
      </section>

      <section class="section">
        <div class="row">
          <button id="run-btn" class="primary">Run</button>
          <button id="cancel-btn" class="danger" disabled>Cancel</button>
        </div>
        <details class="reasoning" id="reasoning-box" style="display: none">
          <summary>Reasoning</summary>
          <div id="reasoning-content"></div>
        </details>
        <div id="tool-trace"></div>
        <div id="results"></div>
        <div id="usage-summary" class="usage-summary"></div>
      </section>
    </div>`;
