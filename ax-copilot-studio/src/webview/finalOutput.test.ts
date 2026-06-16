import { describe, expect, it } from "vitest";
import { shouldRenderFinalOutput } from "./finalOutput";

describe("shouldRenderFinalOutput", () => {
  it("returns false when deltas were already streamed (avoid double-render)", () => {
    expect(shouldRenderFinalOutput(true)).toBe(false);
  });

  it("returns true when no deltas were streamed (non-streamed fallback must still render once)", () => {
    expect(shouldRenderFinalOutput(false)).toBe(true);
  });
});
