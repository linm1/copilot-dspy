import { describe, expect, it } from "vitest";
import { RunRegistry } from "./runRegistry";

describe("RunRegistry", () => {
  it("registers a run and reports it as active", () => {
    const registry = new RunRegistry();
    const signal = registry.register("run-1");
    expect(registry.isActive("run-1")).toBe(true);
    expect(signal.aborted).toBe(false);
  });

  it("cancelling the active run aborts its signal", () => {
    const registry = new RunRegistry();
    const signal = registry.register("run-1");
    registry.cancel("run-1");
    expect(signal.aborted).toBe(true);
  });

  it("cancelling a stale/unknown runId is a no-op and does not throw", () => {
    const registry = new RunRegistry();
    const signal = registry.register("run-1");
    registry.cancel("some-other-run");
    expect(signal.aborted).toBe(false);
  });

  it("starting a new run aborts and supersedes the prior in-flight run", () => {
    const registry = new RunRegistry();
    const firstSignal = registry.register("run-1");
    const secondSignal = registry.register("run-2");

    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    expect(registry.isActive("run-1")).toBe(false);
    expect(registry.isActive("run-2")).toBe(true);
  });

  it("isActive returns false for a runId that was never registered", () => {
    const registry = new RunRegistry();
    registry.register("run-1");
    expect(registry.isActive("never-registered")).toBe(false);
  });

  it("complete() clears the active run so later events for it are dropped", () => {
    const registry = new RunRegistry();
    registry.register("run-1");
    registry.complete("run-1");
    expect(registry.isActive("run-1")).toBe(false);
    expect(registry.currentRunId).toBeUndefined();
  });

  it("complete() for a stale runId does not clear a newer active run", () => {
    const registry = new RunRegistry();
    registry.register("run-1");
    registry.register("run-2");
    registry.complete("run-1"); // stale completion racing in after supersession
    expect(registry.isActive("run-2")).toBe(true);
    expect(registry.currentRunId).toBe("run-2");
  });

  it("cancelActive() aborts whatever is active without needing the runId", () => {
    const registry = new RunRegistry();
    const signal = registry.register("run-1");
    registry.cancelActive();
    expect(signal.aborted).toBe(true);
  });

  it("after cancellation, a fresh register() with the same runId produces a non-aborted signal", () => {
    const registry = new RunRegistry();
    registry.register("run-1");
    registry.cancel("run-1");
    registry.complete("run-1");

    const signal = registry.register("run-1");
    expect(signal.aborted).toBe(false);
    expect(registry.isActive("run-1")).toBe(true);
  });
});
