"""Tests for enterprise (GHE.com) authentication URL building and token routing.

All tests are purely unit tests — no network calls are made. The
CopilotTokenManager is constructed with a temp config_dir, and
_session_token / get_token() are patched where needed so the device
flow is never triggered.
"""

import pytest
from pathlib import Path
from unittest.mock import patch

from copilot_dspy_client import CopilotTokenManager


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_manager(tmp_path: Path, enterprise_domain=None, env_domain=None):
    """Construct a CopilotTokenManager with isolated config_dir.

    Patches COPILOT_ENTERPRISE_DOMAIN env var when *env_domain* is provided
    (empty string clears the var).
    """
    env = {}
    if env_domain is not None:
        env["COPILOT_ENTERPRISE_DOMAIN"] = env_domain

    with patch.dict("os.environ", env, clear=False):
        # Also unset the env var when not requested, so tests are isolated.
        if env_domain is None:
            import os
            os.environ.pop("COPILOT_ENTERPRISE_DOMAIN", None)
            return CopilotTokenManager(
                config_dir=str(tmp_path),
                enterprise_domain=enterprise_domain,
            )
        return CopilotTokenManager(
            config_dir=str(tmp_path),
            enterprise_domain=enterprise_domain,
        )


# ---------------------------------------------------------------------------
# 1. Default (github.com) — regression guard
# ---------------------------------------------------------------------------

class TestDefaultDomain:
    def test_device_code_url(self, tmp_path):
        mgr = make_manager(tmp_path)
        assert mgr.device_code_url == "https://github.com/login/device/code"

    def test_device_auth_url(self, tmp_path):
        mgr = make_manager(tmp_path)
        assert mgr.device_auth_url == "https://github.com/login/oauth/access_token"

    def test_copilot_token_url(self, tmp_path):
        mgr = make_manager(tmp_path)
        assert mgr.copilot_token_url == "https://api.github.com/copilot_internal/v2/token"

    def test_domain_attr(self, tmp_path):
        mgr = make_manager(tmp_path)
        assert mgr.domain == "github.com"


# ---------------------------------------------------------------------------
# 2. Enterprise domain via constructor arg
# ---------------------------------------------------------------------------

class TestEnterpriseDomainArg:
    def test_device_code_url(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="parexel.ghe.com")
        assert mgr.device_code_url == "https://parexel.ghe.com/login/device/code"

    def test_device_auth_url(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="parexel.ghe.com")
        assert mgr.device_auth_url == "https://parexel.ghe.com/login/oauth/access_token"

    def test_copilot_token_url(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="parexel.ghe.com")
        assert mgr.copilot_token_url == "https://api.parexel.ghe.com/copilot_internal/v2/token"

    def test_domain_attr(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="parexel.ghe.com")
        assert mgr.domain == "parexel.ghe.com"


# ---------------------------------------------------------------------------
# 3. Enterprise domain via env var
# ---------------------------------------------------------------------------

class TestEnterpriseDomainEnv:
    def test_device_code_url(self, tmp_path):
        mgr = make_manager(tmp_path, env_domain="parexel.ghe.com")
        assert mgr.device_code_url == "https://parexel.ghe.com/login/device/code"

    def test_device_auth_url(self, tmp_path):
        mgr = make_manager(tmp_path, env_domain="parexel.ghe.com")
        assert mgr.device_auth_url == "https://parexel.ghe.com/login/oauth/access_token"

    def test_copilot_token_url(self, tmp_path):
        mgr = make_manager(tmp_path, env_domain="parexel.ghe.com")
        assert mgr.copilot_token_url == "https://api.parexel.ghe.com/copilot_internal/v2/token"


# ---------------------------------------------------------------------------
# 4. Domain normalisation — pasted URL stripped to bare host
# ---------------------------------------------------------------------------

class TestDomainNormalization:
    def test_https_url_with_trailing_slash(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="https://parexel.ghe.com/")
        assert mgr.domain == "parexel.ghe.com"
        assert mgr.device_code_url == "https://parexel.ghe.com/login/device/code"

    def test_https_url_no_trailing_slash(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="https://parexel.ghe.com")
        assert mgr.domain == "parexel.ghe.com"

    def test_bare_host_unchanged(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="parexel.ghe.com")
        assert mgr.domain == "parexel.ghe.com"

    def test_schemeless_double_slash(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="//parexel.ghe.com")
        assert mgr.domain == "parexel.ghe.com"


# ---------------------------------------------------------------------------
# 5. get_api_base() — no network calls (patch get_token)
# ---------------------------------------------------------------------------

class TestGetApiBase:
    def _mgr_with_token(self, tmp_path, token_str, enterprise_domain=None):
        """Build a manager with _session_token pre-set; patch get_token to no-op."""
        mgr = make_manager(tmp_path, enterprise_domain=enterprise_domain)
        mgr._session_token = token_str
        # Patch get_token so it just returns the pre-set token without network I/O.
        with patch.object(mgr, "get_token", return_value=token_str):
            pass  # patch applied only inside the with-block; set it persistently below
        mgr.get_token = lambda force_refresh=False: token_str  # type: ignore[method-assign]
        return mgr

    def test_proxy_ep_in_token_enterprise(self, tmp_path):
        """proxy-ep present → replace leading proxy. with api."""
        token = "tid=abc;exp=999;proxy-ep=proxy.parexel.ghe.com;cst=x"
        mgr = self._mgr_with_token(tmp_path, token, enterprise_domain="parexel.ghe.com")
        assert mgr.get_api_base() == "https://api.parexel.ghe.com"

    def test_proxy_ep_ignored_on_default_domain(self, tmp_path):
        """Default github.com ignores proxy-ep entirely (backward-compat).

        Even when the session token carries a proxy-ep, the default domain
        must return the byte-for-byte public endpoint.
        """
        token = "tid=abc;exp=999;proxy-ep=proxy.individual.githubcopilot.com;cst=x"
        mgr = self._mgr_with_token(tmp_path, token)
        assert mgr.get_api_base() == "https://api.githubcopilot.com"

    def test_proxy_ep_enterprise_subdomain_of_copilot(self, tmp_path):
        """Enterprise proxy-ep pointing at *.githubcopilot.com is trusted."""
        token = "tid=abc;exp=999;proxy-ep=proxy.individual.githubcopilot.com;cst=x"
        mgr = self._mgr_with_token(tmp_path, token, enterprise_domain="parexel.ghe.com")
        assert mgr.get_api_base() == "https://api.individual.githubcopilot.com"

    def test_no_proxy_ep_enterprise_fallback(self, tmp_path):
        """No proxy-ep + enterprise domain → copilot-api.<domain>."""
        token = "tid=abc;exp=999"
        mgr = self._mgr_with_token(tmp_path, token, enterprise_domain="parexel.ghe.com")
        assert mgr.get_api_base() == "https://copilot-api.parexel.ghe.com"

    def test_no_proxy_ep_default_domain(self, tmp_path):
        """No proxy-ep + default domain → api.githubcopilot.com."""
        token = "tid=abc;exp=999"
        mgr = self._mgr_with_token(tmp_path, token)
        assert mgr.get_api_base() == "https://api.githubcopilot.com"

    def test_none_session_token_default(self, tmp_path):
        """_session_token is None (get_token returns empty) → default URL."""
        mgr = make_manager(tmp_path)
        mgr._session_token = None
        mgr.get_token = lambda force_refresh=False: ""  # type: ignore[method-assign]
        assert mgr.get_api_base() == "https://api.githubcopilot.com"


# ---------------------------------------------------------------------------
# 6. Per-domain token cache filename
# ---------------------------------------------------------------------------

class TestTokenCacheFilename:
    def test_github_com_filename(self, tmp_path):
        mgr = make_manager(tmp_path)
        # token-<sanitized>-<hash8>.json
        assert mgr.token_file.name.startswith("token-github.com-")
        assert mgr.token_file.name.endswith(".json")

    def test_enterprise_filename(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="parexel.ghe.com")
        assert mgr.token_file.name.startswith("token-parexel.ghe.com-")
        assert mgr.token_file.name.endswith(".json")

    def test_filename_is_deterministic(self, tmp_path):
        mgr_a = make_manager(tmp_path, enterprise_domain="parexel.ghe.com")
        mgr_b = make_manager(tmp_path, enterprise_domain="parexel.ghe.com")
        assert mgr_a.token_file == mgr_b.token_file

    def test_filenames_differ(self, tmp_path):
        mgr_default = make_manager(tmp_path)
        mgr_enterprise = make_manager(tmp_path, enterprise_domain="parexel.ghe.com")
        assert mgr_default.token_file != mgr_enterprise.token_file

    def test_colliding_sanitized_domains_differ(self, tmp_path):
        """Raw domains that sanitize to the same string get distinct files.

        ``a:b.com`` and ``a/b.com`` both normalize/sanitize differently at the
        host level, but the appended hash guarantees no cache-file collision
        even where the sanitized human-readable part would coincide.
        """
        mgr_1 = make_manager(tmp_path, enterprise_domain="alpha.example.com")
        mgr_2 = make_manager(tmp_path, enterprise_domain="beta.example.com")
        assert mgr_1.token_file != mgr_2.token_file


# ---------------------------------------------------------------------------
# 7. Backward-compat + normalization edge cases (regression)
# ---------------------------------------------------------------------------

class TestNormalizationEdgeCases:
    def test_uppercase_default_host_lowercased(self, tmp_path):
        mgr = make_manager(tmp_path, enterprise_domain="GitHub.com")
        assert mgr.domain == "github.com"
        assert mgr.device_code_url == "https://github.com/login/device/code"

    def test_uppercase_default_proxy_ep_still_default_base(self, tmp_path):
        """Uppercase github.com + a proxy-ep token still yields the public base.

        Guards backward-compat: the github.com short-circuit fires after
        normalization, so api base is the byte-for-byte public endpoint even
        when a proxy-ep is present.
        """
        mgr = make_manager(tmp_path, enterprise_domain="GitHub.com")
        mgr._session_token = "tid=x;proxy-ep=proxy.evil.com;exp=1"
        mgr.get_token = lambda force_refresh=False: mgr._session_token  # type: ignore[method-assign]
        assert mgr.domain == "github.com"
        assert mgr.get_api_base() == "https://api.githubcopilot.com"

    def test_whitespace_only_enterprise_domain_falls_back(self, tmp_path):
        """A whitespace-only override must not yield https:///... URLs."""
        mgr = make_manager(tmp_path, enterprise_domain="   ")
        assert mgr.domain == "github.com"
        assert mgr.device_code_url == "https://github.com/login/device/code"
        assert mgr.copilot_token_url == "https://api.github.com/copilot_internal/v2/token"

    def test_host_with_port_dropped(self, tmp_path):
        """A :port suffix is dropped consistently from the bare host."""
        mgr = make_manager(tmp_path, enterprise_domain="parexel.ghe.com:443")
        assert mgr.domain == "parexel.ghe.com"
        assert mgr.device_code_url == "https://parexel.ghe.com/login/device/code"


class TestProxyEpSecurity:
    """SSRF guard: untrusted proxy-ep hosts must be rejected (HIGH-2)."""

    def _mgr(self, tmp_path, token, enterprise_domain):
        mgr = CopilotTokenManager(
            config_dir=str(tmp_path), enterprise_domain=enterprise_domain
        )
        mgr._session_token = token
        mgr.get_token = lambda force_refresh=False: token  # type: ignore[method-assign]
        return mgr

    def test_hostile_proxy_ep_rejected_falls_back(self, tmp_path):
        """proxy-ep pointing at an unrelated host is ignored → enterprise default."""
        token = "tid=abc;exp=999;proxy-ep=proxy.evil.com;cst=x"
        mgr = self._mgr(tmp_path, token, "parexel.ghe.com")
        assert mgr.get_api_base() == "https://copilot-api.parexel.ghe.com"

    def test_valid_enterprise_proxy_ep_accepted(self, tmp_path):
        """proxy-ep on the enterprise domain is trusted → api.<host>."""
        token = "tid=abc;exp=999;proxy-ep=proxy.parexel.ghe.com;cst=x"
        mgr = self._mgr(tmp_path, token, "parexel.ghe.com")
        assert mgr.get_api_base() == "https://api.parexel.ghe.com"

    def test_proxy_ep_substring_not_matched(self, tmp_path):
        """A key whose name merely contains 'proxy-ep' as a substring is ignored.

        Exact key=value parsing means a bogus 'xproxy-ep=...' pair must not be
        treated as the real proxy-ep; with no real proxy-ep we fall back.
        """
        token = "tid=abc;xproxy-ep=proxy.evil.com;exp=999"
        mgr = self._mgr(tmp_path, token, "parexel.ghe.com")
        assert mgr.get_api_base() == "https://copilot-api.parexel.ghe.com"

    def test_lookalike_suffix_host_rejected(self, tmp_path):
        """A host that ends with the domain string but isn't a real subdomain.

        ``evilparexel.ghe.com`` ends with ``parexel.ghe.com`` only if we use a
        naive endswith without the dot boundary; the guard requires an exact
        match or a ``.<domain>`` boundary, so this is rejected.
        """
        token = "tid=abc;proxy-ep=proxy.evilparexel.ghe.com;exp=1"
        mgr = self._mgr(tmp_path, token, "parexel.ghe.com")
        # api.evilparexel.ghe.com does NOT end with ".parexel.ghe.com" → rejected.
        assert mgr.get_api_base() == "https://copilot-api.parexel.ghe.com"
