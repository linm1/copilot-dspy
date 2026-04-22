"""DSPy GitHub Copilot Language Model Client

A portable DSPy BaseLM implementation that authenticates via GitHub's
OAuth device flow and routes requests through the Copilot chat API.

Usage::

    from copilot_dspy_client import CopilotLM
    import dspy

    lm = CopilotLM(model="gpt-4o")
    dspy.configure(lm=lm)

    predict = dspy.Predict("question -> answer")
    print(predict(question="What is DSPy?").answer)

Auth:
    First run triggers GitHub device flow — a code is displayed in the
    terminal and the user enters it at github.com/login/device. The
    resulting token is cached at ~/.config/copilot-dspy/token.json for
    subsequent runs.
"""

import os
import json
import time
import logging
from typing import Optional, Any, Dict, List, Tuple
from datetime import datetime, timedelta
from pathlib import Path
import threading
import hashlib

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

import dspy
from dspy.clients.base_lm import BaseLM

logger = logging.getLogger(__name__)

# Identity headers required by the Copilot API gateway on every request.
# These identify this client as VS Code — the only client type GitHub
# currently authorises for third-party Copilot API access.
VS_CODE_HEADERS: Dict[str, str] = {
    "Editor-Version": "vscode/1.99.3",
    "Editor-Plugin-Version": "copilot-chat/0.26.7",
    "Copilot-Integration-Id": "vscode-chat",
    "User-Agent": "GitHubCopilotChat/0.26.7",
}


def _make_retry_session() -> requests.Session:
    """Create a requests.Session with automatic retry on transient errors."""
    session = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session


class CopilotTokenManager:
    """
    Manages the three-step GitHub Copilot token lifecycle:

    1. OAuth device flow → long-lived ``ghu_*`` token (cached to disk).
    2. ``/copilot_internal/v2/token`` exchange → short-lived session token (~25 min).
    3. Automatic re-exchange when the session token nears expiry.

    The VS Code GitHub App client ID (``Iv1.b507a08c87ecfe98``) is the only
    client ID GitHub authorises for third-party Copilot access; you cannot
    substitute your own OAuth app here.
    """

    DEVICE_CODE_URL = "https://github.com/login/device/code"
    DEVICE_AUTH_URL = "https://github.com/login/oauth/access_token"
    # Exchanges the OAuth ghu_* token for a short-lived Copilot session token.
    COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"

    _FALLBACK_CLIENT_ID = "Iv1.b507a08c87ecfe98"
    GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

    def __init__(self, config_dir: Optional[str] = None):
        self.config_dir = Path(config_dir or Path.home() / ".config" / "copilot-dspy")
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.token_file = self.config_dir / "token.json"
        self.lock = threading.Lock()
        self._token_cache: Optional[Dict[str, Any]] = None
        self.CLIENT_ID = os.environ.get("GITHUB_CLIENT_ID", self._FALLBACK_CLIENT_ID)
        self._session_token: Optional[str] = None
        self._session_token_expires_at: float = 0.0
        self._http = _make_retry_session()

    def get_token(self, force_refresh: bool = False) -> str:
        """
        Return a valid short-lived Copilot session token, refreshing as needed.

        Flow:
          1. Load (or acquire via device flow) the long-lived OAuth token.
          2. Exchange it for a session token (~25 min TTL).
          3. Cache in memory; only re-exchange when it nears expiry.
        """
        with self.lock:
            if not force_refresh:
                if self._session_token and time.time() < self._session_token_expires_at - 60:
                    logger.debug("Using cached session token")
                    return self._session_token

            if not force_refresh:
                token_data = self._load_cached_token()
                if token_data and self._is_token_valid(token_data):
                    oauth_token = token_data["access_token"]
                else:
                    logger.info("Initiating token refresh...")
                    oauth_token = self._acquire_or_refresh_token()
            else:
                logger.info("Forcing token refresh...")
                oauth_token = self._acquire_or_refresh_token()

            session_token, expires_at = self._get_session_token(oauth_token)
            self._session_token = session_token
            self._session_token_expires_at = expires_at
            return session_token

    def _get_session_token(self, oauth_token: str) -> Tuple[str, float]:
        """Exchange an OAuth ghu_* token for a short-lived Copilot session token."""
        response = self._http.get(
            self.COPILOT_TOKEN_URL,
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {oauth_token}",
                **VS_CODE_HEADERS,
            },
        )
        response.raise_for_status()
        data = response.json()
        token = data["token"]
        expires_at = float(data.get("expires_at", time.time() + 1500))
        logger.debug("Obtained session token (expires in ~%.0fs)", expires_at - time.time())
        return token, expires_at

    def _load_cached_token(self) -> Optional[Dict[str, Any]]:
        """Load the OAuth token from disk, returning None on any failure."""
        if self._token_cache is not None:
            return self._token_cache
        if not self.token_file.exists():
            return None
        try:
            with open(self.token_file, "r") as f:
                self._token_cache = json.load(f)
            return self._token_cache
        except (json.JSONDecodeError, IOError) as e:
            logger.warning("Failed to load token file: %s", e)
            return None

    def _is_token_valid(self, token_data: Dict[str, Any]) -> bool:
        """Return True if the stored OAuth token has more than 5 minutes remaining."""
        raw = token_data.get("expires_at")
        if not raw:
            return True  # No expiry set — treat as valid; 401 will force refresh
        try:
            expires_at = datetime.fromisoformat(raw)
        except ValueError:
            return True  # Unparseable — treat as valid
        return datetime.now() < (expires_at - timedelta(minutes=5))

    def _acquire_or_refresh_token(self) -> str:
        """Try refresh token first; fall back to device flow."""
        token_data = self._load_cached_token()
        refresh_token = token_data.get("refresh_token") if token_data else None
        if refresh_token:
            try:
                return self._refresh_token(refresh_token)
            except Exception as e:
                logger.warning("Token refresh failed: %s — falling back to device flow", e)
        return self._device_flow_auth()

    def _device_flow_auth(self) -> str:
        """Run GitHub OAuth device flow and return the new ghu_* access token."""
        response = self._http.post(
            self.DEVICE_CODE_URL,
            data={"client_id": self.CLIENT_ID, "scope": "read:user"},
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        device_response = response.json()

        device_code = device_response["device_code"]
        user_code = device_response["user_code"]
        verification_uri = device_response["verification_uri"]

        print(
            f"\n{'=' * 60}\n"
            f"Authenticate with GitHub Copilot:\n\n"
            f"1. Visit: {verification_uri}\n"
            f"2. Enter code: {user_code}\n"
            f"3. Authorize the application\n"
            f"{'=' * 60}\n",
            flush=True,
        )

        interval = device_response.get("interval", 5)
        for _ in range(120):  # 10-minute window
            time.sleep(interval)
            resp = self._http.post(
                self.DEVICE_AUTH_URL,
                data={
                    "client_id": self.CLIENT_ID,
                    "device_code": device_code,
                    "grant_type": self.GRANT_TYPE,
                },
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()
            auth_response = resp.json()

            if "access_token" in auth_response:
                token_data = self._prepare_token_data(auth_response)
                self._save_token(token_data)
                logger.info("Successfully authenticated!")
                return token_data["access_token"]

            error = auth_response.get("error")
            if error == "authorization_pending":
                continue
            if error == "slow_down":
                # GitHub is asking us to poll less frequently.
                interval += 5
                continue
            raise RuntimeError(
                f"Authentication failed: {auth_response.get('error_description', error)}"
            )

        raise RuntimeError("Device flow authentication timed out after 10 minutes")

    def _refresh_token(self, refresh_token: str) -> str:
        """Attempt to renew the OAuth token using a stored refresh_token."""
        resp = self._http.post(
            self.DEVICE_AUTH_URL,
            data={
                "client_id": self.CLIENT_ID,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            },
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        auth_response = resp.json()
        if "access_token" in auth_response:
            token_data = self._prepare_token_data(auth_response)
            self._save_token(token_data)
            return token_data["access_token"]
        raise RuntimeError(
            f"Token refresh failed: {auth_response.get('error_description')}"
        )

    @staticmethod
    def _prepare_token_data(auth_response: Dict[str, Any]) -> Dict[str, Any]:
        """Build a storable token dict from an OAuth response payload."""
        now = datetime.now()
        expires_in = auth_response.get("expires_in", 28800)
        return {
            "access_token": auth_response["access_token"],
            "refresh_token": auth_response.get("refresh_token"),
            "token_type": auth_response.get("token_type", "Bearer"),
            "expires_at": (now + timedelta(seconds=expires_in)).isoformat(),
            "acquired_at": now.isoformat(),
        }

    def _save_token(self, token_data: Dict[str, Any]) -> None:
        """Persist token to disk. Permissions are owner-only on POSIX; no-op on Windows."""
        with open(self.token_file, "w") as f:
            json.dump(token_data, f, indent=2)
        try:
            os.chmod(self.token_file, 0o600)
        except OSError:
            pass
        self._token_cache = token_data


class CopilotLMCache:
    """Thread-safe in-memory response cache with TTL."""

    def __init__(self, ttl_seconds: int = 3600):
        self.ttl = ttl_seconds
        self._cache: Dict[str, Tuple[Any, float]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> Optional[Any]:
        with self._lock:
            entry = self._cache.get(key)
            if entry is None:
                return None
            value, ts = entry
            if time.time() - ts < self.ttl:
                return value
            del self._cache[key]
        return None

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._cache[key] = (value, time.time())

    def make_key(self, messages: List[Dict[str, str]], **kwargs: Any) -> str:
        content = json.dumps(messages, sort_keys=True) + json.dumps(kwargs, sort_keys=True)
        return hashlib.md5(content.encode()).hexdigest()


class CopilotLM(BaseLM):
    """
    DSPy BaseLM implementation backed by the GitHub Copilot Chat API.

    Drop this into any DSPy project::

        from copilot_dspy_client import CopilotLM
        import dspy

        lm = CopilotLM(model="gpt-4o")
        dspy.configure(lm=lm)

        predict = dspy.Predict("question -> answer")
        print(predict(question="What is 2+2?").answer)

    On first run the GitHub device flow prompts you to authorise in a
    browser; subsequent runs reuse the cached token from
    ``~/.config/copilot-dspy/token.json``.
    """

    COPILOT_API_BASE = "https://api.githubcopilot.com"
    REQUEST_TIMEOUT = 60

    def __init__(
        self,
        model: str = "gpt-4o",
        cache_ttl: int = 3600,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        top_p: float = 1.0,
        token_manager: Optional[CopilotTokenManager] = None,
    ):
        """
        Args:
            model: Copilot model name (e.g. ``"gpt-4o"``, ``"gpt-3.5-turbo"``).
            cache_ttl: Response cache TTL in seconds. Set to 0 to disable.
            temperature: Sampling temperature (0.0–2.0).
            max_tokens: Maximum tokens in each response.
            top_p: Nucleus sampling parameter.
            token_manager: Optional custom token manager (default: new instance).
        """
        super().__init__(model=model)
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.top_p = top_p
        self.token_manager = token_manager or CopilotTokenManager()
        self.cache = CopilotLMCache(ttl_seconds=cache_ttl)
        self._http = _make_retry_session()
        self._metrics_lock = threading.Lock()
        self.request_count = 0
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        logger.info("Initialized CopilotLM with model=%s", model)

    def forward(self, prompt: str, **kwargs: Any) -> str:
        """Send a plain-text prompt; return the first completion as a string."""
        outputs = self.__call__(messages=[{"role": "user", "content": prompt}], **kwargs)
        if not outputs:
            raise RuntimeError("Copilot API returned no choices")
        return outputs[0]["text"]

    def __call__(
        self,
        prompt: Optional[str] = None,
        messages: Optional[List[Dict[str, str]]] = None,
        **kwargs: Any,
    ) -> List[Dict[str, Any]]:
        """
        Call the Copilot chat completions endpoint.

        Returns a list of ``{"text": <content>, "logprobs": ...}`` dicts —
        one per choice — in the format DSPy adapters expect.
        """
        if messages is None:
            messages = [{"role": "user", "content": prompt}] if prompt else []

        cache_key = self.cache.make_key(messages, **kwargs)
        cached = self.cache.get(cache_key)
        if cached is not None:
            logger.debug("Cache hit")
            return cached

        request_body = self._build_request(messages, **kwargs)
        response = self._make_request(request_body)

        usage = response.get("usage", {})
        with self._metrics_lock:
            self.request_count += 1
            self.total_input_tokens += usage.get("prompt_tokens", 0)
            self.total_output_tokens += usage.get("completion_tokens", 0)

        outputs = [
            {"text": choice["message"]["content"], "logprobs": choice.get("logprobs")}
            for choice in response.get("choices", [])
        ]
        self.cache.set(cache_key, outputs)
        return outputs

    def _build_request(self, messages: List[Dict[str, str]], **kwargs: Any) -> Dict[str, Any]:
        return {
            "model": self.model,
            "messages": messages,
            "temperature": kwargs.get("temperature", self.temperature),
            "max_tokens": kwargs.get("max_tokens", self.max_tokens),
            "top_p": kwargs.get("top_p", self.top_p),
        }

    def _make_request(self, request_body: Dict[str, Any]) -> Dict[str, Any]:
        """POST to the Copilot chat completions endpoint with retry and token refresh."""
        token = self.token_manager.get_token()
        url = f"{self.COPILOT_API_BASE}/chat/completions"

        for attempt in range(3):
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "Openai-Intent": "conversation-edits",
                **VS_CODE_HEADERS,
            }
            try:
                response = self._http.post(
                    url,
                    json=request_body,
                    headers=headers,
                    timeout=self.REQUEST_TIMEOUT,
                )

                if response.status_code == 401:
                    logger.warning(
                        "Session token rejected (401) — refreshing (attempt %d/3)", attempt + 1
                    )
                    time.sleep(2 ** attempt)
                    token = self.token_manager.get_token(force_refresh=True)
                    continue

                response.raise_for_status()
                return response.json()

            except requests.exceptions.Timeout:
                if attempt < 2:
                    wait = 2 ** attempt
                    logger.warning("Request timed out — retrying in %ds", wait)
                    time.sleep(wait)
                else:
                    raise

            except requests.exceptions.RequestException as e:
                if attempt < 2:
                    wait = 2 ** attempt
                    logger.warning("Request failed: %s — retrying in %ds", e, wait)
                    time.sleep(wait)
                else:
                    raise

        raise RuntimeError("Copilot API request failed after 3 attempts")

    def get_usage(self) -> Dict[str, int]:
        """Return cumulative token usage since construction or last reset_usage()."""
        with self._metrics_lock:
            return {
                "requests": self.request_count,
                "input_tokens": self.total_input_tokens,
                "output_tokens": self.total_output_tokens,
                "total_tokens": self.total_input_tokens + self.total_output_tokens,
            }

    def reset_usage(self) -> None:
        """Reset all usage counters to zero."""
        with self._metrics_lock:
            self.request_count = 0
            self.total_input_tokens = 0
            self.total_output_tokens = 0
