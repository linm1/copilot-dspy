import { describe, expect, it, vi, afterEach } from "vitest";
import { AxFunction, AxGen } from "@ax-llm/ax";
import { buildModuleProgram, isAbortError, runModule } from "./moduleRunner";

const SIMPLE_SIGNATURE = "userQuestion:string -> assistantAnswer:string";

describe("buildModuleProgram", () => {
  it("Predict leaves the signature unchanged (no internal reasoning field, no functions)", () => {
    const program = buildModuleProgram("Predict", SIMPLE_SIGNATURE, undefined);
    const sig = program.getSignature();
    const outputNames = sig.getOutputFields().map((f) => f.name);
    expect(outputNames).toEqual(["assistantAnswer"]);
  });

  it("ChainOfThought injects an internal reasoning output field ahead of declared outputs", () => {
    const program = buildModuleProgram("ChainOfThought", SIMPLE_SIGNATURE, undefined);
    const sig = program.getSignature();
    const outputs = sig.getOutputFields();
    const reasoningField = outputs.find((f) => f.name === "reasoning");

    expect(reasoningField).toBeDefined();
    expect(reasoningField?.isInternal).toBe(true);
    expect(outputs.map((f) => f.name)).toContain("assistantAnswer");
  });

  it("ChainOfThought places reasoning FIRST in the output field list, before the declared outputs", () => {
    const program = buildModuleProgram(
      "ChainOfThought",
      "userQuestion:string -> assistantAnswer:string, confidence:number",
      undefined,
    );
    const sig = program.getSignature();
    const outputNames = sig.getOutputFields().map((f) => f.name);

    expect(outputNames).toEqual(["reasoning", "assistantAnswer", "confidence"]);
  });

  it("Predict has no reasoning field at all", () => {
    const program = buildModuleProgram("Predict", SIMPLE_SIGNATURE, undefined);
    const sig = program.getSignature();
    expect(sig.getOutputFields().some((f) => f.name === "reasoning")).toBe(false);
  });

  it("ReAct's output field order is unchanged (no reasoning field injected)", () => {
    const program = buildModuleProgram(
      "ReAct",
      "userQuestion:string -> assistantAnswer:string, confidence:number",
      [],
    );
    const sig = program.getSignature();
    expect(sig.getOutputFields().map((f) => f.name)).toEqual(["assistantAnswer", "confidence"]);
  });

  it("ChainOfThought does not duplicate an already-present reasoning field", () => {
    const program = buildModuleProgram(
      "ChainOfThought",
      "userQuestion:string -> reasoning!:string, assistantAnswer:string",
      undefined,
    );
    const sig = program.getSignature();
    const reasoningFields = sig.getOutputFields().filter((f) => f.name === "reasoning");
    expect(reasoningFields).toHaveLength(1);
  });

  it("ReAct constructs successfully with enabled tool functions", () => {
    const enabledFn: AxFunction = {
      name: "readFile",
      description: "read a file",
      func: async () => "contents",
    };
    const program = buildModuleProgram("ReAct", SIMPLE_SIGNATURE, [enabledFn]);
    const sig = program.getSignature();
    // The signature itself is untouched by the ReAct transform (no injected
    // reasoning field) -- functions are passed as AxGen constructor options,
    // not signature fields.
    expect(sig.getOutputFields().map((f) => f.name)).toEqual(["assistantAnswer"]);
  });

  it("ReAct with no functions still constructs (empty tool set)", () => {
    expect(() => buildModuleProgram("ReAct", SIMPLE_SIGNATURE, undefined)).not.toThrow();
  });
});

describe("isAbortError", () => {
  it("returns true when the signal is already aborted, regardless of error shape", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(new Error("anything"), controller.signal)).toBe(true);
  });

  it("returns true for a DOMException-style AbortError even without a signal", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isAbortError(err, undefined)).toBe(true);
  });

  it("returns false for an unrelated error with a non-aborted signal", () => {
    const controller = new AbortController();
    expect(isAbortError(new Error("boom"), controller.signal)).toBe(false);
  });
});

describe("runModule cancellation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns cancelled:true without throwing when the signal aborts mid-stream", async () => {
    const controller = new AbortController();

    async function* fakeStream() {
      yield { version: 1, index: 0, delta: { assistantAnswer: "partial" } };
      controller.abort();
      yield { version: 1, index: 0, delta: { assistantAnswer: " more" } };
    }

    vi.spyOn(AxGen.prototype, "streamingForward").mockReturnValue(
      fakeStream() as ReturnType<AxGen["streamingForward"]>,
    );

    const onDelta = vi.fn();
    const fakeAi = {} as Parameters<typeof runModule>[0]["ai"];

    const result = await runModule({
      ai: fakeAi,
      signatureString: SIMPLE_SIGNATURE,
      module: "Predict",
      inputs: { userQuestion: "hi" },
      signal: controller.signal,
      onDelta,
    });

    expect(result.cancelled).toBe(true);
    expect(onDelta).toHaveBeenCalledTimes(1);
  });

  it("propagates a genuine (non-abort) error", async () => {
    async function* fakeStream(): AsyncGenerator<{ version: number; index: number; delta: Record<string, unknown> }> {
      throw new Error("upstream failure");
    }

    vi.spyOn(AxGen.prototype, "streamingForward").mockReturnValue(
      fakeStream() as ReturnType<AxGen["streamingForward"]>,
    );

    const fakeAi = {} as Parameters<typeof runModule>[0]["ai"];
    await expect(
      runModule({
        ai: fakeAi,
        signatureString: SIMPLE_SIGNATURE,
        module: "Predict",
        inputs: { userQuestion: "hi" },
      }),
    ).rejects.toThrow("upstream failure");
  });

  it("returns cancelled:false and the accumulated output on normal completion", async () => {
    async function* fakeStream() {
      yield { version: 1, index: 0, delta: { assistantAnswer: "Hello" } };
      yield { version: 1, index: 0, delta: { assistantAnswer: " world" } };
    }

    vi.spyOn(AxGen.prototype, "streamingForward").mockReturnValue(
      fakeStream() as ReturnType<AxGen["streamingForward"]>,
    );

    const fakeAi = {} as Parameters<typeof runModule>[0]["ai"];
    const result = await runModule({
      ai: fakeAi,
      signatureString: SIMPLE_SIGNATURE,
      module: "Predict",
      inputs: { userQuestion: "hi" },
    });

    expect(result.cancelled).toBe(false);
    expect(result.output).toEqual({ assistantAnswer: "Hello world" });
  });

  it("accumulates string deltas across many chunks into the full final value (not just the last fragment)", async () => {
    async function* fakeStream() {
      yield { version: 1, index: 0, delta: { assistantAnswer: "Hello" } };
      yield { version: 1, index: 0, delta: { assistantAnswer: " world" } };
      yield { version: 1, index: 0, delta: { assistantAnswer: "!" } };
    }

    vi.spyOn(AxGen.prototype, "streamingForward").mockReturnValue(
      fakeStream() as ReturnType<AxGen["streamingForward"]>,
    );

    const fakeAi = {} as Parameters<typeof runModule>[0]["ai"];
    const result = await runModule({
      ai: fakeAi,
      signatureString: SIMPLE_SIGNATURE,
      module: "Predict",
      inputs: { userQuestion: "hi" },
    });

    expect(result.output).toEqual({ assistantAnswer: "Hello world!" });
  });

  it("accumulates array-field deltas by concatenation across chunks", async () => {
    async function* fakeStream() {
      yield { version: 1, index: 0, delta: { items: ["a", "b"] } };
      yield { version: 1, index: 0, delta: { items: ["c"] } };
    }

    vi.spyOn(AxGen.prototype, "streamingForward").mockReturnValue(
      fakeStream() as ReturnType<AxGen["streamingForward"]>,
    );

    const fakeAi = {} as Parameters<typeof runModule>[0]["ai"];
    const result = await runModule({
      ai: fakeAi,
      signatureString: SIMPLE_SIGNATURE,
      module: "Predict",
      inputs: { userQuestion: "hi" },
    });

    expect(result.output).toEqual({ items: ["a", "b", "c"] });
  });
});
