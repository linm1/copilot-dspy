/**
 * Builds and runs an `AxGen` program for the three supported module kinds:
 *
 *  - Predict          -- the signature is used as-is.
 *  - ChainOfThought    -- an internal `reasoning!:string` field is injected
 *                         as an output so the model emits a hidden
 *                         scratchpad before the real outputs (mirrors DSPy's
 *                         ChainOfThought, which wraps a signature the same
 *                         way: prepend a reasoning field marked internal).
 *  - ReAct             -- the enabled tool functions are passed via
 *                         `{ functions }`; AxGen drives the tool-call loop
 *                         itself (see AxProgramForwardOptions.functions).
 *
 * Streaming runs via `streamingForward()`; deltas are surfaced through the
 * caller-supplied `onDelta` callback so the extension host can forward
 * `RunDeltaMessage`s to the webview as they arrive. Cancellation is plumbed
 * through `AxAIServiceOptions.abortSignal` -- an aborted run resolves the
 * async generator's iteration with the signal's abort reason rather than
 * throwing an uncaught rejection, so `runModule` treats `AbortError`/
 * `signal.aborted` as a clean cancel rather than a run failure.
 */

import { AxAI, AxFieldValue, AxFunction, AxGen, AxGenIn, AxGenOut, AxSignature } from "@ax-llm/ax";
import { AxModuleKind, RunInputs } from "../types";
import { buildSignatureFromString } from "./signatureBuilder";

const REASONING_FIELD_NAME = "reasoning";

export interface RunModuleOptions {
  ai: AxAI;
  signatureString: string;
  module: AxModuleKind;
  inputs: RunInputs;
  /** Tool functions to pass when `module === "ReAct"`. Ignored otherwise. */
  functions?: AxFunction[];
  /** Called once per streamed delta chunk. */
  onDelta?: (delta: Partial<AxGenOut>) => void;
  signal?: AbortSignal;
}

export interface RunModuleResult {
  output: AxGenOut;
  /** True if the run was cancelled via `signal` before completion. */
  cancelled: boolean;
}

/**
 * Returns true if `error` represents a clean cancellation rather than a
 * genuine run failure -- either the DOMException `AbortError` thrown by
 * fetch/streaming consumers, or any error raised after the signal was
 * already aborted (covers Ax wrapping the abort in a different error type).
 */
export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return true;
  }
  return false;
}

/**
 * Merges one streamed delta value into the corresponding accumulated value
 * for a field: strings concatenate (so `"Hello"` then `" world"` yields
 * `"Hello world"`), arrays concatenate, and any new field is set as-is.
 * Mixed/unknown-type pairs fall back to last-wins rather than throwing --
 * streamed chunks are AxGenOut-shaped but not exhaustively validated here.
 */
function mergeDeltaValue(previous: AxFieldValue | undefined, next: AxFieldValue): AxFieldValue {
  if (previous === undefined) {
    return next;
  }
  if (typeof previous === "string" && typeof next === "string") {
    return previous + next;
  }
  if (Array.isArray(previous)) {
    return previous.concat(next as string | string[]);
  }
  return next;
}

/**
 * Accumulates a streamed `delta` chunk into `acc`, field by field, using
 * `mergeDeltaValue` so the returned object reflects the FULL value per
 * field rather than just the most recent fragment. Returns a new object;
 * `acc` is not mutated.
 */
function accumulateOutput(acc: AxGenOut, delta: Partial<AxGenOut>): AxGenOut {
  const next: AxGenOut = { ...acc };
  for (const [key, value] of Object.entries(delta)) {
    next[key] = mergeDeltaValue(next[key], value);
  }
  return next;
}

/**
 * Inject a hidden `reasoning!:string` output field ahead of the declared
 * outputs, DSPy-CoT style. `addOutputField` only appends, so the reasoning
 * field is prepended by rebuilding the full output field list via
 * `setOutputFields` -- otherwise the model would be asked to produce the
 * final answer before reasoning, defeating chain-of-thought.
 */
function injectReasoningField(signature: AxSignature): AxSignature {
  const existing = signature.getOutputFields();
  const alreadyPresent = existing.some((field) => field.name === REASONING_FIELD_NAME);
  if (alreadyPresent) {
    return signature;
  }

  const next = new AxSignature(signature);
  next.setOutputFields([
    {
      name: REASONING_FIELD_NAME,
      description: "Step-by-step reasoning before producing the final outputs.",
      isInternal: true,
      type: { name: "string" },
    },
    ...existing,
  ]);
  return next;
}

/** Build the `AxGen` program for the given module kind, applying the per-kind signature/options transform. */
export function buildModuleProgram(
  module: AxModuleKind,
  signatureString: string,
  functions: AxFunction[] | undefined,
): AxGen {
  const baseSignature = buildSignatureFromString(signatureString);

  if (module === "ChainOfThought") {
    return new AxGen(injectReasoningField(baseSignature));
  }

  if (module === "ReAct") {
    return new AxGen(baseSignature, { functions: functions ?? [] });
  }

  // Predict: signature unchanged, no functions.
  return new AxGen(baseSignature);
}

/**
 * Run a module to completion, streaming deltas through `onDelta` as they
 * arrive. Resolves with `{ output, cancelled: true }` (no error thrown) if
 * `signal` is aborted mid-stream.
 */
export async function runModule(options: RunModuleOptions): Promise<RunModuleResult> {
  const program = buildModuleProgram(
    options.module,
    options.signatureString,
    options.module === "ReAct" ? options.functions : undefined,
  );

  let lastOutput: AxGenOut = {};

  try {
    // RunInputs (Record<string, unknown>) is the wire-protocol shape coming
    // from the webview (src/types.ts); AxGenIn requires AxFieldValue-typed
    // values. We don't re-validate the shape here -- the signature itself
    // (built from options.signatureString) is what enforces field
    // names/types at the Ax layer, and a mismatch surfaces as an Ax
    // validation error inside streamingForward rather than a silent bug.
    const stream = program.streamingForward(options.ai, options.inputs as AxGenIn, {
      abortSignal: options.signal,
    });

    for await (const chunk of stream) {
      if (options.signal?.aborted) {
        return { output: lastOutput, cancelled: true };
      }
      lastOutput = accumulateOutput(lastOutput, chunk.delta);
      options.onDelta?.(chunk.delta);
    }

    return { output: lastOutput, cancelled: false };
  } catch (error) {
    if (isAbortError(error, options.signal)) {
      return { output: lastOutput, cancelled: true };
    }
    throw error;
  }
}
