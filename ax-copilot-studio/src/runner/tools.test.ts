import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertFetchUrlAllowed,
  createFetchUrlTool,
  createListFilesTool,
  createReadFileTool,
  FetchUrlBlockedError,
  PathConfinementError,
  resolveWithinWorkspace,
} from "./tools";

let tmpRoot: string;
let workspaceA: string;
let workspaceB: string;
let outsideDir: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ax-copilot-tools-test-"));
  workspaceA = path.join(tmpRoot, "workspaceA");
  workspaceB = path.join(tmpRoot, "workspaceB");
  outsideDir = path.join(tmpRoot, "outside");

  await fs.mkdir(workspaceA, { recursive: true });
  await fs.mkdir(workspaceB, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });

  await fs.writeFile(path.join(workspaceA, "inside.txt"), "hello from A");
  await fs.writeFile(path.join(workspaceB, "inside-b.txt"), "hello from B");
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "should not be readable");
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("resolveWithinWorkspace", () => {
  it("resolves a relative path inside the (single) workspace root", async () => {
    const resolved = await resolveWithinWorkspace("inside.txt", () => [workspaceA]);
    expect(path.basename(resolved)).toBe("inside.txt");
  });

  it("rejects a relative path that escapes via ..", async () => {
    await expect(resolveWithinWorkspace("../outside/secret.txt", () => [workspaceA])).rejects.toThrow(
      PathConfinementError,
    );
  });

  it("rejects an absolute path outside any workspace root", async () => {
    const absoluteOutside = path.join(outsideDir, "secret.txt");
    await expect(resolveWithinWorkspace(absoluteOutside, () => [workspaceA])).rejects.toThrow(
      PathConfinementError,
    );
  });

  it("accepts an absolute path that happens to be inside a workspace root", async () => {
    const absoluteInside = path.join(workspaceA, "inside.txt");
    const resolved = await resolveWithinWorkspace(absoluteInside, () => [workspaceA]);
    expect(path.basename(resolved)).toBe("inside.txt");
  });

  it("throws when no workspace folder is open", async () => {
    await expect(resolveWithinWorkspace("inside.txt", () => [])).rejects.toThrow(PathConfinementError);
  });

  it("multi-root: resolves a path under the second root when not found under the first", async () => {
    const resolved = await resolveWithinWorkspace("inside-b.txt", () => [workspaceA, workspaceB]);
    expect(path.basename(resolved)).toBe("inside-b.txt");
    expect(path.dirname(resolved).toLowerCase()).toBe((await fs.realpath(workspaceB)).toLowerCase());
  });

  it("rejects a path that does not exist (realpath fails) even if textually inside the root", async () => {
    await expect(resolveWithinWorkspace("does-not-exist.txt", () => [workspaceA])).rejects.toThrow(
      PathConfinementError,
    );
  });

  it("rejects a junction inside the workspace that points outside it", async () => {
    const junctionPath = path.join(workspaceA, "escape-link");
    try {
      await fs.symlink(outsideDir, junctionPath, "junction");
    } catch {
      // Junction creation can fail in restricted CI sandboxes; skip rather
      // than fail the suite on an environment limitation unrelated to the
      // code under test.
      return;
    }

    await expect(resolveWithinWorkspace("escape-link/secret.txt", () => [workspaceA])).rejects.toThrow(
      PathConfinementError,
    );
  });
});

describe("createReadFileTool", () => {
  it("reads a confined file's contents", async () => {
    const tool = createReadFileTool({ getWorkspaceRoots: () => [workspaceA] });
    const result = await tool.func({ path: "inside.txt" });
    expect(result).toBe("hello from A");
  });

  it("rejects reading a path outside the workspace", async () => {
    const tool = createReadFileTool({ getWorkspaceRoots: () => [workspaceA] });
    await expect(tool.func({ path: "../outside/secret.txt" })).rejects.toThrow(PathConfinementError);
  });
});

describe("createListFilesTool", () => {
  it("lists files within a confined directory", async () => {
    const tool = createListFilesTool({ getWorkspaceRoots: () => [workspaceA] });
    const result = (await tool.func({ dir: "." })) as { name: string; type: string }[];
    expect(result.some((entry) => entry.name === "inside.txt" && entry.type === "file")).toBe(true);
  });

  it("rejects listing a directory outside the workspace", async () => {
    const tool = createListFilesTool({ getWorkspaceRoots: () => [workspaceA] });
    await expect(tool.func({ dir: "../outside" })).rejects.toThrow(PathConfinementError);
  });
});

describe("createFetchUrlTool", () => {
  it("fetches and returns text content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: undefined,
      text: async () => "page contents",
    });

    const tool = createFetchUrlTool({ getWorkspaceRoots: () => [workspaceA], fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await tool.func({ url: "https://example.com" });
    expect(result).toBe("page contents");
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, body: undefined, text: async () => "" });
    const tool = createFetchUrlTool({ getWorkspaceRoots: () => [workspaceA], fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(tool.func({ url: "https://example.com" })).rejects.toThrow(/HTTP 500/);
  });

  it("aborts the underlying fetch when the caller's AbortSignal fires", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const tool = createFetchUrlTool({
      getWorkspaceRoots: () => [workspaceA],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });

    const pending = tool.func({ url: "https://example.com/slow" });
    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it("throws without calling fetchImpl when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn();

    const tool = createFetchUrlTool({
      getWorkspaceRoots: () => [workspaceA],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });

    await expect(tool.func({ url: "https://example.com" })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a blocked URL without calling fetchImpl", async () => {
    const fetchImpl = vi.fn();
    const tool = createFetchUrlTool({ getWorkspaceRoots: () => [workspaceA], fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(tool.func({ url: "http://127.0.0.1/" })).rejects.toThrow(FetchUrlBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws and does not return the body when a redirect points at a blocked host", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: new Headers({ location: "http://127.0.0.1/admin" }),
      body: undefined,
      text: async () => "secret internal content",
    });

    const tool = createFetchUrlTool({ getWorkspaceRoots: () => [workspaceA], fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(tool.func({ url: "https://example.com/redirect-to-internal" })).rejects.toThrow(FetchUrlBlockedError);
    // Only the initial (public) hop should have been requested -- the blocked
    // redirect target must never be fetched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to a public URL and returns the final body", async () => {
    const fetchImpl = vi.fn();
    fetchImpl
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: "https://example.com/final" }),
        body: undefined,
        text: async () => "",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: undefined,
        text: async () => "final page contents",
      });

    const tool = createFetchUrlTool({ getWorkspaceRoots: () => [workspaceA], fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await tool.func({ url: "https://example.com/start" });
    expect(result).toBe("final page contents");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("throws once the redirect chain exceeds the max-redirect cap", async () => {
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      const next = url === "https://example.com/0" ? "https://example.com/1" : `https://example.com/${Number(url.split("/").pop()) + 1}`;
      return Promise.resolve({
        ok: false,
        status: 302,
        headers: new Headers({ location: next }),
        body: undefined,
        text: async () => "",
      });
    });

    const tool = createFetchUrlTool({ getWorkspaceRoots: () => [workspaceA], fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(tool.func({ url: "https://example.com/0" })).rejects.toThrow(/redirects/i);
  });
});

describe("assertFetchUrlAllowed", () => {
  it("allows normal public http/https URLs", () => {
    expect(assertFetchUrlAllowed("https://example.com/page").toString()).toBe("https://example.com/page");
    expect(assertFetchUrlAllowed("http://example.com").href).toContain("example.com");
  });

  it.each([
    ["http://localhost/"],
    ["http://localhost:8080/"],
    ["http://127.0.0.1/"],
    ["http://127.0.0.1:9000/admin"],
    ["http://10.0.0.5/"],
    ["http://10.255.255.255/"],
    ["http://172.16.0.1/"],
    ["http://172.31.255.255/"],
    ["http://192.168.1.1/"],
    ["http://169.254.169.254/latest/meta-data/"],
    ["http://0.0.0.0/"],
    ["http://[::1]/"],
    ["http://[fe80::1]/"],
    ["http://[fc00::1]/"],
    ["http://[fd12:3456:789a::1]/"],
    // IPv4-mapped/translated/compatible IPv6 literals embedding a
    // private/loopback/link-local IPv4 address must be blocked the same
    // way the plain IPv4 literal would be.
    ["http://[::ffff:127.0.0.1]/"],
    ["http://[::ffff:7f00:1]/"],
    ["http://[::ffff:10.0.0.1]/"],
    ["http://[::ffff:192.168.1.1]/"],
    ["http://[::ffff:169.254.169.254]/"],
    ["http://[::127.0.0.1]/"],
  ])("rejects loopback/private/link-local host %s", (url) => {
    expect(() => assertFetchUrlAllowed(url)).toThrow(FetchUrlBlockedError);
  });

  it("treats an IPv4-mapped PUBLIC address consistently with the plain IPv4 address (both allowed)", () => {
    expect(() => assertFetchUrlAllowed("http://8.8.8.8/")).not.toThrow();
    expect(() => assertFetchUrlAllowed("http://[::ffff:8.8.8.8]/")).not.toThrow();
  });

  it.each([["file:///etc/passwd"], ["data:text/plain;base64,aGk="], ["ftp://example.com/file"]])(
    "rejects non-http(s) scheme %s",
    (url) => {
      expect(() => assertFetchUrlAllowed(url)).toThrow(FetchUrlBlockedError);
    },
  );

  it("does not block ordinary 172.x addresses outside the 172.16-31 private range", () => {
    expect(() => assertFetchUrlAllowed("http://172.15.0.1/")).not.toThrow();
    expect(() => assertFetchUrlAllowed("http://172.32.0.1/")).not.toThrow();
  });

  it.each([["http://localhost./"], ["http://LOCALHOST/"], ["http://LOCALHOST./"]])(
    "rejects trailing-dot / mixed-case localhost variant %s (SSRF guard bypass)",
    (url) => {
      expect(() => assertFetchUrlAllowed(url)).toThrow(FetchUrlBlockedError);
    },
  );

  it("still allows a normal public host with no trailing dot", () => {
    expect(() => assertFetchUrlAllowed("https://example.com/page")).not.toThrow();
  });
});
