/**
 * Built-in ReAct starter tools: readFile, listFiles, fetchUrl. No `runShell`
 * in v1 (Codex HIGH -- deferred to roadmap, see DESIGN.md Component 5).
 *
 * Every file tool is routed through `resolveWithinWorkspace()`, which
 * canonicalizes both the requested path and each workspace-folder root via
 * `fs.realpath` before checking containment -- a plain `..`/absolute-path
 * reject is insufficient because a symlink or junction inside the workspace
 * can point outside it (Codex MEDIUM).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AxFunction } from "@ax-llm/ax";

const MAX_FETCH_BYTES = 1_000_000; // 1 MB cap
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

export class PathConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathConfinementError";
  }
}

export class FetchUrlBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchUrlBlockedError";
  }
}

/**
 * Returns true if `hostname` is a loopback, private, link-local, or
 * otherwise internal-network address that `fetchUrl` must never reach --
 * this is the SSRF guard for the model-controlled `url` argument.
 *
 * Covers literal IPv4/IPv6 hosts and the common loopback hostname. DNS
 * rebinding (a public hostname that resolves to a private IP at request
 * time) is intentionally out of scope for this surgical fix; this only
 * blocks hosts that are *literally* private/loopback in the URL itself.
 */
function isBlockedHost(hostname: string): boolean {
  // Normalize before any comparison: lowercase, and strip a single trailing
  // "." -- a trailing dot denotes an absolute FQDN (RFC 1034) and resolves
  // identically to the dot-free form, so "localhost." still resolves to
  // loopback. Without this normalization "http://localhost./" bypassed the
  // exact-string check below.
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (host === "localhost" || host === "") {
    return true;
  }

  // IPv4 literal (including the unspecified address 0.0.0.0).
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    return isBlockedIpv4Octets(ipv4Match.slice(1).map(Number));
  }

  // IPv6 literal -- hostname is bracket-stripped by the URL parser already.
  if (host.includes(":")) {
    if (host === "::" || host === "::1") return true; // unspecified / loopback
    if (host.startsWith("fe80:") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")) {
      return true; // fe80::/10 link-local
    }
    if (/^f[cd][0-9a-f]{2}:/.test(host)) {
      return true; // fc00::/7 unique-local
    }

    // IPv4-mapped (::ffff:a.b.c.d or its compressed-hex form ::ffff:7f00:1),
    // IPv4-translated (::ffff:0:a.b.c.d / 64:ff9b::a.b.c.d), and the
    // deprecated IPv4-compatible (::a.b.c.d) forms all embed a real IPv4
    // address in the low 32 bits. `new URL()` normalizes the bracketed
    // literal to lowercase hex (e.g. "::ffff:127.0.0.1" becomes
    // "::ffff:7f00:1"), so extract the embedded IPv4 from either the
    // dotted-quad tail or the last 32 bits of hex and re-run it through the
    // existing IPv4 rules rather than duplicating them. DNS rebinding (a
    // public hostname resolving to a private IP at request time) remains
    // out of scope -- this only catches literal embedded addresses.
    const embeddedIpv4 = extractEmbeddedIpv4(host);
    if (embeddedIpv4) {
      return isBlockedIpv4Octets(embeddedIpv4);
    }

    return false;
  }

  return false;
}

/** Shared IPv4 octet rules, reused for plain IPv4 literals and IPv4 embedded inside IPv6 literals. */
function isBlockedIpv4Octets(octets: number[]): boolean {
  if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) {
    return true; // Not a valid IPv4 literal; treat as blocked rather than risk a bypass.
  }
  const [a, b] = octets;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 0) return true; // 0.0.0.0/8 unspecified/reserved
  return false;
}

/**
 * Extracts the embedded IPv4 address (as four octets) from an IPv6 literal
 * that is IPv4-mapped (`::ffff:a.b.c.d`, or its hex-compressed normalized
 * form `::ffff:7f00:1`), IPv4-translated (`::ffff:0:a.b.c.d` /
 * `64:ff9b::a.b.c.d`), or IPv4-compatible (`::a.b.c.d`, deprecated). Returns
 * `null` if `host` does not match one of these forms.
 */
function extractEmbeddedIpv4(host: string): number[] | null {
  // Dotted-quad tail, e.g. "::ffff:127.0.0.1" or "::a.b.c.d" -- not produced
  // by `new URL()`'s normalization (it always emits hex groups), but kept
  // as defense-in-depth in case a caller passes an already-parsed hostname.
  const dottedMatch = host.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dottedMatch && (host.startsWith("::ffff:") || host.startsWith("::"))) {
    return dottedMatch.slice(1).map(Number);
  }

  // Hex-compressed IPv4-mapped, e.g. "::ffff:7f00:1" (== ::ffff:127.0.0.1).
  const mappedHexMatch = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHexMatch) {
    return hexGroupsToIpv4(mappedHexMatch[1], mappedHexMatch[2]);
  }

  // IPv4-translated (NAT64 well-known prefix), e.g. "64:ff9b::7f00:1".
  const translatedMatch = host.match(/^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (translatedMatch) {
    return hexGroupsToIpv4(translatedMatch[1], translatedMatch[2]);
  }

  // IPv4-compatible (deprecated), e.g. "::7f00:1" (== ::127.0.0.1). Must be
  // checked after the more specific "::ffff:" prefix above so mapped
  // addresses aren't double-matched here.
  const compatibleMatch = host.match(/^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (compatibleMatch) {
    return hexGroupsToIpv4(compatibleMatch[1], compatibleMatch[2]);
  }

  return null;
}

/** Combines two 16-bit hex groups (the low 32 bits of a v6 address) into four IPv4 octets. */
function hexGroupsToIpv4(highHex: string, lowHex: string): number[] {
  const high = parseInt(highHex, 16);
  const low = parseInt(lowHex, 16);
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

/**
 * Parses and validates `rawUrl` for the `fetchUrl` tool, throwing
 * `FetchUrlBlockedError` instead of returning a `URL` whenever the target
 * could be used for SSRF against the user's machine or local network.
 *
 * `args.url` for this tool is model-controlled (ReAct tool args can be
 * steered via prompt injection from user input, fetched content, or
 * workspace files), so it must be validated the same way file-tool paths
 * are confined via `resolveWithinWorkspace` -- defense belongs in the tool,
 * not the caller.
 */
export function assertFetchUrlAllowed(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new FetchUrlBlockedError(`fetchUrl: "${rawUrl}" is not a valid URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new FetchUrlBlockedError(`fetchUrl: scheme "${parsed.protocol}" is not allowed; only http/https are permitted.`);
  }

  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (isBlockedHost(hostname)) {
    throw new FetchUrlBlockedError(`fetchUrl: "${hostname}" is a loopback/private/link-local address and is not allowed.`);
  }

  return parsed;
}

/** Abstraction over `vscode.workspace.workspaceFolders` so this module never imports `vscode`. */
export type WorkspaceRootsProvider = () => readonly string[];

/**
 * Resolve `requestedPath` (interpreted relative to each workspace root in
 * turn, or absolute) to a canonical, confined absolute path.
 *
 * Resolves BOTH the requested path and each workspace-folder root to their
 * real (canonical) path via `fs.realpath` before checking containment, so a
 * symlink/junction inside the workspace that points outside it is rejected
 * rather than silently followed. Multi-root workspaces are supported: the
 * target is accepted if it resolves under ANY configured root.
 *
 * Throws `PathConfinementError` if the path cannot be confined to any root,
 * does not exist (realpath requires the target to exist), or escapes via
 * `..`/absolute path/symlink.
 */
export async function resolveWithinWorkspace(
  requestedPath: string,
  getWorkspaceRoots: WorkspaceRootsProvider,
): Promise<string> {
  const roots = getWorkspaceRoots();
  if (roots.length === 0) {
    throw new PathConfinementError("No workspace folder is open; cannot resolve a confined path.");
  }

  const candidates = path.isAbsolute(requestedPath)
    ? [requestedPath]
    : roots.map((root) => path.join(root, requestedPath));

  let lastError: unknown;
  for (const candidate of candidates) {
    for (const root of roots) {
      try {
        const realRoot = await fs.realpath(root);
        const realCandidate = await fs.realpath(candidate);
        const relative = path.relative(realRoot, realCandidate);
        const isInside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        if (isInside) {
          return realCandidate;
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw new PathConfinementError(
    `Path "${requestedPath}" is not confined to any open workspace folder${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`,
  );
}

export interface ToolDeps {
  getWorkspaceRoots: WorkspaceRootsProvider;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** `readFile(path)` -- workspace-relative reads only, canonical-path confined. */
export function createReadFileTool(deps: ToolDeps): AxFunction {
  return {
    name: "readFile",
    description: "Read the contents of a text file within the open workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative (or absolute, if inside the workspace) file path." },
      },
      required: ["path"],
    },
    func: async (args: { path: string }) => {
      const confined = await resolveWithinWorkspace(args.path, deps.getWorkspaceRoots);
      deps.signal?.throwIfAborted();
      return await fs.readFile(confined, "utf8");
    },
  };
}

/** `listFiles(dir)` -- workspace-relative directory listing, same confinement. */
export function createListFilesTool(deps: ToolDeps): AxFunction {
  return {
    name: "listFiles",
    description: "List files and directories within a directory in the open workspace.",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Workspace-relative (or absolute, if inside the workspace) directory path." },
      },
      required: ["dir"],
    },
    func: async (args: { dir: string }) => {
      const confined = await resolveWithinWorkspace(args.dir, deps.getWorkspaceRoots);
      deps.signal?.throwIfAborted();
      const entries = await fs.readdir(confined, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));
    },
  };
}

/**
 * Performs the GET request with `redirect: "manual"` and follows any 30x
 * redirect chain itself, re-validating each hop's `Location` against
 * `assertFetchUrlAllowed` before re-fetching -- this closes the SSRF bypass
 * where a public URL redirects to a loopback/private/link-local target.
 * Node's `fetch` follows redirects by default, which would reach the
 * blocked host before this tool ever sees the response, so the guard at the
 * top of `func` (validating only the initial URL) is not enough on its own.
 *
 * Throws `FetchUrlBlockedError` (via `assertFetchUrlAllowed`) if any hop in
 * the chain resolves to a blocked host, and a plain `Error` if the chain
 * exceeds `MAX_FETCH_REDIRECTS` hops. Returns the final non-redirect
 * response, still wired to `signal` so the caller's timeout/abort applies
 * across the whole chain, not just the first hop.
 */
async function followAndValidateRedirects(
  initialUrl: URL,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_FETCH_REDIRECTS; hop++) {
    signal.throwIfAborted();
    const response = await fetchImpl(currentUrl.toString(), { signal, redirect: "manual" });

    if (!REDIRECT_STATUS_CODES.has(response.status)) {
      return response;
    }

    if (hop === MAX_FETCH_REDIRECTS) {
      throw new Error(`fetchUrl: exceeded maximum of ${MAX_FETCH_REDIRECTS} redirects.`);
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`fetchUrl: received HTTP ${response.status} redirect with no Location header.`);
    }

    const nextUrl = new URL(location, currentUrl);
    currentUrl = assertFetchUrlAllowed(nextUrl.toString());
  }

  // Unreachable: the loop always returns or throws within MAX_FETCH_REDIRECTS + 1 iterations.
  throw new Error("fetchUrl: redirect handling fell through unexpectedly.");
}

/** `fetchUrl(url)` -- HTTP GET, size + timeout capped, honors the run's AbortSignal. */
export function createFetchUrlTool(deps: ToolDeps): AxFunction {
  return {
    name: "fetchUrl",
    description: "Fetch the text content of a URL via HTTP GET (size and time capped).",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The absolute http(s) URL to fetch." },
      },
      required: ["url"],
    },
    func: async (args: { url: string }) => {
      const validatedUrl = assertFetchUrlAllowed(args.url);
      deps.signal?.throwIfAborted();

      const fetchImpl = deps.fetchImpl ?? fetch;
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);

      const onCallerAbort = () => timeoutController.abort();
      deps.signal?.addEventListener("abort", onCallerAbort);

      try {
        const response = await followAndValidateRedirects(validatedUrl, fetchImpl, timeoutController.signal);
        if (!response.ok) {
          throw new Error(`fetchUrl failed: HTTP ${response.status}`);
        }
        const reader = response.body?.getReader();
        if (!reader) {
          const text = await response.text();
          return text.slice(0, MAX_FETCH_BYTES);
        }

        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            chunks.push(value);
            if (total >= MAX_FETCH_BYTES) {
              await reader.cancel();
              break;
            }
          }
        }
        const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
        return buffer.subarray(0, MAX_FETCH_BYTES).toString("utf8");
      } finally {
        clearTimeout(timeout);
        deps.signal?.removeEventListener("abort", onCallerAbort);
      }
    },
  };
}

export function createBuiltinTools(deps: ToolDeps): Record<"readFile" | "listFiles" | "fetchUrl", AxFunction> {
  return {
    readFile: createReadFileTool(deps),
    listFiles: createListFilesTool(deps),
    fetchUrl: createFetchUrlTool(deps),
  };
}
