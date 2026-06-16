/**
 * Domain normalization + Copilot API base URL resolution.
 *
 * Faithful port of CopilotTokenManager._normalize_domain / get_api_base /
 * _parse_proxy_ep / _is_trusted_api_host from copilot_dspy_client.py.
 * See test_enterprise_auth.py for the behavioral oracle this file mirrors.
 */

/**
 * Normalise a user-supplied domain or URL to a bare, lowercased host.
 *
 * Handles inputs like:
 *   - "github.com" -> "github.com"
 *   - "GitHub.com" -> "github.com" (lowercased)
 *   - "https://parexel.ghe.com/" -> "parexel.ghe.com"
 *   - "//parexel.ghe.com" -> "parexel.ghe.com"
 *   - "parexel.ghe.com:443" -> "parexel.ghe.com" (port dropped)
 */
export function normalizeDomain(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }

  // Use the URL parser with a synthetic scheme for scheme-less inputs so
  // .hostname strips any port uniformly across both URL and bare forms.
  const candidate = trimmed.includes("://") ? trimmed : `//${trimmed.replace(/^\/+/, "")}`;

  try {
    // WHATWG URL requires a base when the input is protocol-relative ("//host").
    const url = new URL(candidate.startsWith("//") ? `http:${candidate}` : candidate);
    if (url.hostname) {
      return url.hostname.toLowerCase();
    }
  } catch {
    // fall through to the manual fallback below
  }

  // Fallback: strip leading slashes / trailing slash, then lowercase.
  const stripped = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  return stripped.toLowerCase();
}

/** Resolve the configured GitHub domain from explicit override -> env var -> default. */
export function resolveDomain(enterpriseDomain?: string | null, envDomain?: string | null): string {
  const candidates = [enterpriseDomain, envDomain, "github.com"];
  for (const candidate of candidates) {
    if (candidate && candidate.trim()) {
      return normalizeDomain(candidate.trim()) || "github.com";
    }
  }
  return "github.com";
}

export interface DomainUrls {
  domain: string;
  deviceCodeUrl: string;
  deviceAuthUrl: string;
  copilotTokenUrl: string;
}

export function buildDomainUrls(domain: string): DomainUrls {
  return {
    domain,
    deviceCodeUrl: `https://${domain}/login/device/code`,
    deviceAuthUrl: `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${domain}/copilot_internal/v2/token`,
  };
}

/**
 * Extract the `proxy-ep` host from a session token, or undefined.
 *
 * The token is a `;`-delimited list of `key=value` pairs. We split on those
 * exact separators (rather than a loose regex that could match a substring
 * elsewhere in the token) and return the value for the `proxy-ep` key only.
 */
export function parseProxyEp(sessionToken: string): string | undefined {
  for (const pair of sessionToken.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key === "proxy-ep") {
      return value;
    }
  }
  return undefined;
}

/**
 * Return true only for hosts we are willing to route chat traffic to.
 *
 * Guards against an attacker-controlled token redirecting requests to an
 * arbitrary HTTPS host (SSRF). Accept the host only if it belongs to the
 * public Copilot domain or to the configured enterprise domain.
 */
export function isTrustedApiHost(host: string, domain: string): boolean {
  if (!host) {
    return false;
  }
  if (host === "githubcopilot.com" || host.endsWith(".githubcopilot.com")) {
    return true;
  }
  if (domain !== "github.com" && (host === domain || host.endsWith(`.${domain}`))) {
    return true;
  }
  return false;
}

/**
 * Resolve the Copilot chat API base URL for a domain.
 *
 * Resolution order:
 * 1. For the default `github.com` domain, always return the hardcoded public
 *    endpoint -- `proxy-ep` is intentionally NOT consulted so the
 *    byte-for-byte default URL is preserved for backward compatibility.
 * 2. For an enterprise domain, parse `proxy-ep` from the session token, swap
 *    a leading `proxy.` for `api.`, and use it ONLY if the host passes trust
 *    validation (prevents SSRF via a hostile token).
 * 3. Otherwise (no/invalid proxy-ep) fall back to `https://copilot-api.<domain>`.
 */
export function resolveApiBase(domain: string, sessionToken: string | undefined): string {
  if (domain === "github.com") {
    return "https://api.githubcopilot.com";
  }

  if (sessionToken) {
    const proxyHost = parseProxyEp(sessionToken);
    if (proxyHost) {
      const apiHost = proxyHost.replace(/^proxy\./, "api.");
      if (isTrustedApiHost(apiHost, domain)) {
        return `https://${apiHost}`;
      }
    }
  }

  return `https://copilot-api.${domain}`;
}
