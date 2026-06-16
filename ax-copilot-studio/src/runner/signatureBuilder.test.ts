import { describe, expect, it } from "vitest";
import { SignatureFieldRow } from "../types";
import {
  buildSignatureFromRows,
  buildSignatureFromString,
  parseSignatureStringToRows,
  rowsToSignatureString,
} from "./signatureBuilder";

describe("signatureBuilder", () => {
  it("round-trips a simple string signature through rows and back", () => {
    const original = "questionText:string -> answerText:string";
    const sig = buildSignatureFromString(original);
    expect(sig.getInputFields()).toHaveLength(1);
    expect(sig.getOutputFields()).toHaveLength(1);

    const rows = parseSignatureStringToRows(original);
    expect(rows.inputs).toEqual([{ name: "questionText", type: "string", description: undefined, classOptions: undefined, isOptional: undefined, isArray: false, isInternal: undefined }]);
    expect(rows.outputs[0].name).toBe("answerText");

    const rebuilt = rowsToSignatureString(rows.inputs, rows.outputs);
    expect(rebuilt).toContain("questionText");
    expect(rebuilt).toContain("answerText");
  });

  it("builds an AxField with type.name per row type (string keyed, not nested)", () => {
    const inputs: SignatureFieldRow[] = [{ name: "userQuery", type: "string", description: "the query" }];
    const outputs: SignatureFieldRow[] = [{ name: "score", type: "number" }];

    const sig = buildSignatureFromRows(inputs, outputs);
    const [inputField] = sig.getInputFields();
    const [outputField] = sig.getOutputFields();

    expect(inputField.name).toBe("userQuery");
    expect((inputField as unknown as { type?: { name: string } }).type?.name).toBe("string");
    expect((outputField as unknown as { type?: { name: string } }).type?.name).toBe("number");
  });

  it("preserves classOptions for a class-typed field", () => {
    const outputs: SignatureFieldRow[] = [
      { name: "category", type: "class", classOptions: ["tech", "business", "health"] },
    ];
    const sig = buildSignatureFromRows([], outputs);
    const [field] = sig.getOutputFields();
    expect((field as unknown as { type?: { options?: string[] } }).type?.options).toEqual([
      "tech",
      "business",
      "health",
    ]);
  });

  it("marks isOptional and isInternal on the built AxField", () => {
    const outputs: SignatureFieldRow[] = [
      { name: "reasoning", type: "string", isInternal: true },
      { name: "extra", type: "string", isOptional: true },
    ];
    const sig = buildSignatureFromRows([], outputs);
    const fields = sig.getOutputFields();
    expect(fields[0].isInternal).toBe(true);
    expect(fields[1].isOptional).toBe(true);
  });

  it("marks isArray on the built AxField type", () => {
    const outputs: SignatureFieldRow[] = [{ name: "keywords", type: "string", isArray: true }];
    const sig = buildSignatureFromRows([], outputs);
    const [field] = sig.getOutputFields();
    expect((field as unknown as { type?: { isArray?: boolean } }).type?.isArray).toBe(true);
  });

  it("round-trips multi-field signatures with descriptions", () => {
    // Ax rejects overly generic field names (e.g. bare "text") with
    // AxSignatureValidationError, so use descriptive names throughout.
    const inputs: SignatureFieldRow[] = [
      { name: "articleText", type: "string", description: "input text" },
      { name: "articleContext", type: "string", description: "extra context" },
    ];
    const outputs: SignatureFieldRow[] = [
      { name: "summary", type: "string" },
      { name: "keywords", type: "string", isArray: true },
    ];

    const signatureString = rowsToSignatureString(inputs, outputs);
    const parsed = parseSignatureStringToRows(signatureString);

    expect(parsed.inputs.map((r) => r.name)).toEqual(["articleText", "articleContext"]);
    expect(parsed.outputs.map((r) => r.name)).toEqual(["summary", "keywords"]);
    expect(parsed.outputs[1].isArray).toBe(true);
  });

  it("throws when parsing an invalid signature string", () => {
    expect(() => parseSignatureStringToRows("not a valid signature !!!")).toThrow();
  });
});
