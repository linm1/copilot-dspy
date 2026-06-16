/**
 * Pure runId -> AbortController bookkeeping, extracted out of panel.ts so the
 * cancellation/stale-drop logic (Codex MEDIUM finding, see DESIGN spec
 * "Architecture" / Data flow) is unit-testable without any `vscode` import.
 *
 * Rules (spec):
 *  - Starting a new run (`register`) aborts and replaces any prior in-flight
 *    run -- there is at most one active runId at a time.
 *  - `run.cancel` aborts the controller for that runId but otherwise leaves
 *    bookkeeping alone (the run's own cleanup -- via `complete` -- clears it).
 *  - Events (`run.delta` / `run.done` / `run.error`) for a runId that is no
 *    longer the active run (superseded or already completed/cancelled) must
 *    be dropped by the receiver. `isActive(runId)` is the single source of
 *    truth for that check on the host side.
 */

export class RunRegistry {
  private activeRunId: string | undefined;
  private activeController: AbortController | undefined;

  /**
   * Register a new run, cancelling any previously in-flight run first.
   * Returns the AbortSignal to thread through fetch/streaming/tools.
   */
  register(runId: string): AbortSignal {
    this.cancelActive();
    const controller = new AbortController();
    this.activeRunId = runId;
    this.activeController = controller;
    return controller.signal;
  }

  /** True if `runId` is the currently active (non-superseded, non-completed) run. */
  isActive(runId: string): boolean {
    return this.activeRunId === runId;
  }

  /** Abort the run identified by `runId`, if it is the active one. No-op otherwise (stale cancel). */
  cancel(runId: string): void {
    if (this.activeRunId === runId) {
      this.activeController?.abort();
    }
  }

  /** Abort whatever run is currently active, if any (used when registering a new run). */
  cancelActive(): void {
    this.activeController?.abort();
  }

  /** Mark a run as finished (done/error/cancelled) and clear bookkeeping if it's still the active one. */
  complete(runId: string): void {
    if (this.activeRunId === runId) {
      this.activeRunId = undefined;
      this.activeController = undefined;
    }
  }

  /** Test/debug helper. */
  get currentRunId(): string | undefined {
    return this.activeRunId;
  }
}
