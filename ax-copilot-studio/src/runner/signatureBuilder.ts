/**
 * Converts between the user-facing signature string (Ax's
 * `"input:type -> output:type"` syntax) and the structured input/output rows
 * used by the webview's signature builder UI (Wave 2). Both representations
 * are kept in sync per the spec: editing rows regenerates the string;
 * editing the string re-parses into rows (best-effort).
 */

import { AxSignature } from "@ax-llm/ax";
import { SignatureFieldRow } from "../types";

type AxFieldTypeKeyword = SignatureFieldRow["type"];

/**
 * Build an `AxSignature` from structured input/output rows.
 *
 * Deviation note: `AxField.type` is `{ name, isArray?, options? }` (keyed by
 * `name`, not `type`), and `description`/`isOptional`/`isInternal` live on
 * the field itself rather than nested under `type`. We build this shape
 * directly from each row rather than going through the `f()` fluent
 * builder, whose `AxFieldType` return shape (`{ type, isArray?, isOptional?,
 * isInternal?, options?, description? }`) does not match `AxField` and
 * would need the same field-by-field translation anyway.
 */
export function buildSignatureFromRows(inputs: readonly SignatureFieldRow[], outputs: readonly SignatureFieldRow[]): AxSignature {
  const sig = new AxSignature();
  for (const row of inputs) {
    sig.addInputField(toAxField(row));
  }
  for (const row of outputs) {
    sig.addOutputField(toAxField(row));
  }
  return sig;
}

function toAxField(row: SignatureFieldRow): {
  name: string;
  description?: string;
  isOptional?: boolean;
  isInternal?: boolean;
  type: { name: AxFieldTypeKeyword; isArray?: boolean; options?: string[] };
} {
  return {
    name: row.name,
    description: row.description,
    isOptional: row.isOptional,
    isInternal: row.isInternal,
    type: {
      name: row.type,
      isArray: row.isArray,
      options: row.classOptions,
    },
  };
}

/** Build an `AxSignature` directly from the user's Ax signature string. */
export function buildSignatureFromString(signatureString: string): AxSignature {
  return new AxSignature(signatureString);
}

export interface ParsedSignatureRows {
  inputs: SignatureFieldRow[];
  outputs: SignatureFieldRow[];
}

interface AxFieldLike {
  name: string;
  description?: string;
  type?: { name: AxFieldTypeKeyword; isArray?: boolean; options?: string[] };
  isOptional?: boolean;
  isInternal?: boolean;
}

function toRow(field: AxFieldLike): SignatureFieldRow {
  return {
    name: field.name,
    type: field.type?.name ?? "string",
    description: field.description,
    classOptions: field.type?.options ? [...field.type.options] : undefined,
    isOptional: field.isOptional,
    isArray: field.type?.isArray,
    isInternal: field.isInternal,
  };
}

/**
 * Parse a signature string into structured rows (best-effort). Throws if the
 * string fails to parse as a valid Ax signature -- callers should catch this
 * and flag the rows as stale rather than crash the run, per spec Component 3.
 */
export function parseSignatureStringToRows(signatureString: string): ParsedSignatureRows {
  const sig = new AxSignature(signatureString);
  return {
    inputs: sig.getInputFields().map((field) => toRow(field as unknown as AxFieldLike)),
    outputs: sig.getOutputFields().map((field) => toRow(field as unknown as AxFieldLike)),
  };
}

/** Render structured rows back into an Ax signature string (round-trips via AxSignature.toString()). */
export function rowsToSignatureString(inputs: readonly SignatureFieldRow[], outputs: readonly SignatureFieldRow[]): string {
  return buildSignatureFromRows(inputs, outputs).toString();
}
