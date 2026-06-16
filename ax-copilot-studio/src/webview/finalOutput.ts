/**
 * Pure helper deciding whether `run.done`'s `output` should be rendered,
 * extracted out of main.ts so the "don't double-render streamed output"
 * rule (Codex P2 finding) is unit-testable without any DOM/vscode import.
 *
 * Rule: if the run already streamed `run.delta` events, the deltas are the
 * authoritative rendering of the output and `run.done.output` must NOT be
 * appended again (it would duplicate already-shown text, e.g.
 * "Hello world" + "world" -> "Hello world world"). If no deltas were
 * streamed (non-streaming runs), `run.done.output` is the only rendering
 * of the result and must be shown exactly once.
 */
export function shouldRenderFinalOutput(hasStreamedDelta: boolean): boolean {
  return !hasStreamedDelta;
}
