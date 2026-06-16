import { describe, expect, it } from "vitest";
import {
  buildDomainUrls,
  isTrustedApiHost,
  normalizeDomain,
  parseProxyEp,
  resolveApiBase,
  resolveDomain,
} from "./apiBase";

describe("normalizeDomain", () => {
  it("passes through a bare host unchanged", () => {
    expect(normalizeDomain("parexel.ghe.com")).toBe("parexel.ghe.com");
  });

  it("lowercases an uppercase host", () => {
    expect(normalizeDomain("GitHub.com")).toBe("github.com");
  });

  it("strips https:// and trailing slash", () => {
    expect(normalizeDomain("https://parexel.ghe.com/")).toBe("parexel.ghe.com");
  });

  it("strips https:// with no trailing slash", () => {
    expect(normalizeDomain("https://parexel.ghe.com")).toBe("parexel.ghe.com");
  });

  it("strips a schemeless double-slash prefix", () => {
    expect(normalizeDomain("//parexel.ghe.com")).toBe("parexel.ghe.com");
  });

  it("drops a :port suffix", () => {
    expect(normalizeDomain("parexel.ghe.com:443")).toBe("parexel.ghe.com");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeDomain("")).toBe("");
  });
});

describe("resolveDomain", () => {
  it("defaults to github.com when nothing is provided", () => {
    expect(resolveDomain(undefined, undefined)).toBe("github.com");
  });

  it("prefers the explicit enterprise domain over env", () => {
    expect(resolveDomain("explicit.ghe.com", "env.ghe.com")).toBe("explicit.ghe.com");
  });

  it("falls back to the env domain when no explicit override", () => {
    expect(resolveDomain(undefined, "env.ghe.com")).toBe("env.ghe.com");
  });

  it("treats a whitespace-only override as absent and falls back to github.com", () => {
    expect(resolveDomain("   ", undefined)).toBe("github.com");
  });
});

describe("buildDomainUrls", () => {
  it("builds the default github.com URLs", () => {
    const urls = buildDomainUrls("github.com");
    expect(urls.deviceCodeUrl).toBe("https://github.com/login/device/code");
    expect(urls.deviceAuthUrl).toBe("https://github.com/login/oauth/access_token");
    expect(urls.copilotTokenUrl).toBe("https://api.github.com/copilot_internal/v2/token");
  });

  it("builds enterprise URLs from a custom domain", () => {
    const urls = buildDomainUrls("parexel.ghe.com");
    expect(urls.deviceCodeUrl).toBe("https://parexel.ghe.com/login/device/code");
    expect(urls.deviceAuthUrl).toBe("https://parexel.ghe.com/login/oauth/access_token");
    expect(urls.copilotTokenUrl).toBe("https://api.parexel.ghe.com/copilot_internal/v2/token");
  });
});

describe("parseProxyEp", () => {
  it("extracts the proxy-ep value from a semicolon-delimited token", () => {
    const token = "tid=abc;exp=999;proxy-ep=proxy.parexel.ghe.com;cst=x";
    expect(parseProxyEp(token)).toBe("proxy.parexel.ghe.com");
  });

  it("returns undefined when proxy-ep is absent", () => {
    expect(parseProxyEp("tid=abc;exp=999")).toBeUndefined();
  });

  it("does not match a key that merely contains proxy-ep as a substring", () => {
    const token = "tid=abc;xproxy-ep=proxy.evil.com;exp=999";
    expect(parseProxyEp(token)).toBeUndefined();
  });
});

describe("isTrustedApiHost", () => {
  it("trusts the public githubcopilot.com domain", () => {
    expect(isTrustedApiHost("githubcopilot.com", "parexel.ghe.com")).toBe(true);
  });

  it("trusts a subdomain of githubcopilot.com", () => {
    expect(isTrustedApiHost("api.individual.githubcopilot.com", "parexel.ghe.com")).toBe(true);
  });

  it("trusts the configured enterprise domain itself", () => {
    expect(isTrustedApiHost("parexel.ghe.com", "parexel.ghe.com")).toBe(true);
  });

  it("trusts a subdomain of the configured enterprise domain", () => {
    expect(isTrustedApiHost("api.parexel.ghe.com", "parexel.ghe.com")).toBe(true);
  });

  it("rejects an unrelated host", () => {
    expect(isTrustedApiHost("evil.com", "parexel.ghe.com")).toBe(false);
  });

  it("rejects a lookalike suffix host without a dot boundary", () => {
    expect(isTrustedApiHost("api.evilparexel.ghe.com", "parexel.ghe.com")).toBe(false);
  });

  it("rejects on the default github.com domain (no enterprise trust granted)", () => {
    expect(isTrustedApiHost("parexel.ghe.com", "github.com")).toBe(false);
  });
});

describe("resolveApiBase", () => {
  it("returns the hardcoded public endpoint for github.com regardless of proxy-ep", () => {
    const token = "tid=abc;exp=999;proxy-ep=proxy.individual.githubcopilot.com;cst=x";
    expect(resolveApiBase("github.com", token)).toBe("https://api.githubcopilot.com");
  });

  it("returns the hardcoded public endpoint for github.com with no token", () => {
    expect(resolveApiBase("github.com", undefined)).toBe("https://api.githubcopilot.com");
  });

  it("swaps proxy. for api. on a trusted enterprise proxy-ep", () => {
    const token = "tid=abc;exp=999;proxy-ep=proxy.parexel.ghe.com;cst=x";
    expect(resolveApiBase("parexel.ghe.com", token)).toBe("https://api.parexel.ghe.com");
  });

  it("accepts an enterprise proxy-ep pointing at *.githubcopilot.com", () => {
    const token = "tid=abc;exp=999;proxy-ep=proxy.individual.githubcopilot.com;cst=x";
    expect(resolveApiBase("parexel.ghe.com", token)).toBe("https://api.individual.githubcopilot.com");
  });

  it("falls back to copilot-api.<domain> when proxy-ep is absent on enterprise", () => {
    const token = "tid=abc;exp=999";
    expect(resolveApiBase("parexel.ghe.com", token)).toBe("https://copilot-api.parexel.ghe.com");
  });

  it("falls back to copilot-api.<domain> when proxy-ep host is untrusted (SSRF guard)", () => {
    const token = "tid=abc;exp=999;proxy-ep=proxy.evil.com;cst=x";
    expect(resolveApiBase("parexel.ghe.com", token)).toBe("https://copilot-api.parexel.ghe.com");
  });

  it("falls back to copilot-api.<domain> when no session token is present", () => {
    expect(resolveApiBase("parexel.ghe.com", undefined)).toBe("https://copilot-api.parexel.ghe.com");
  });
});
