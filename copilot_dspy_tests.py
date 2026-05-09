import asyncio
import copy
import threading
from datetime import datetime, timedelta
from unittest.mock import patch

from copilot_dspy_client import CopilotLM, CopilotTokenManager, uses_max_completion_tokens


# ---------------------------------------------------------------------------
# Helpers shared by CopilotLM tests
# ---------------------------------------------------------------------------

def _make_stub_token_manager(tmp_path):
    return CopilotTokenManager(config_dir=str(tmp_path))


def _make_lm(tmp_path):
    """Create a CopilotLM whose token manager uses a tmp config dir."""
    token_manager = CopilotTokenManager(config_dir=str(tmp_path))
    token_manager._session_token = "fake-session-token"
    token_manager._session_token_expires = datetime.now() + timedelta(hours=1)
    return CopilotLM(model="gpt-4o", token_manager=token_manager)


_FAKE_API_RESPONSE = {
    "model": "gpt-4o",
    "choices": [
        {
            "message": {"role": "assistant", "content": "Hello!"},
            "logprobs": None,
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 10, "completion_tokens": 5},
}


def test_acquire_or_refresh_token_skips_null_refresh_token(tmp_path):
    token_manager = CopilotTokenManager(config_dir=str(tmp_path))
    token_manager._save_token(
        {
            "access_token": "expired-access-token",
            "refresh_token": None,
            "token_type": "bearer",
            "expires_at": (datetime.now() - timedelta(hours=1)).isoformat(),
            "acquired_at": datetime.now().isoformat(),
        }
    )

    manager = CopilotTokenManager(config_dir=str(tmp_path))

    refresh_calls = []
    device_flow_calls = []

    def fake_refresh_token(refresh_token):
        refresh_calls.append(refresh_token)
        return "refreshed-token"

    def fake_device_flow_auth():
        device_flow_calls.append(True)
        return "device-flow-token"

    manager._refresh_token = fake_refresh_token
    manager._device_flow_auth = fake_device_flow_auth

    token = manager._acquire_or_refresh_token()

    assert token == "device-flow-token"
    assert refresh_calls == []
    assert device_flow_calls == [True]


def test_is_token_valid_returns_true_when_no_expires_at(tmp_path):
    manager = CopilotTokenManager(config_dir=str(tmp_path))
    assert manager._is_token_valid({"access_token": "ghu_abc"}) is True


def test_is_token_valid_returns_true_when_expires_at_unparseable(tmp_path):
    manager = CopilotTokenManager(config_dir=str(tmp_path))
    assert manager._is_token_valid({"access_token": "ghu_abc", "expires_at": "not-a-date"}) is True


def test_is_token_valid_returns_false_when_expired(tmp_path):
    manager = CopilotTokenManager(config_dir=str(tmp_path))
    expired = (datetime.now() - timedelta(hours=1)).isoformat()
    assert manager._is_token_valid({"access_token": "ghu_abc", "expires_at": expired}) is False


def test_is_token_valid_returns_true_when_not_expired(tmp_path):
    manager = CopilotTokenManager(config_dir=str(tmp_path))
    future = (datetime.now() + timedelta(hours=1)).isoformat()
    assert manager._is_token_valid({"access_token": "ghu_abc", "expires_at": future}) is True


# ---------------------------------------------------------------------------
# __deepcopy__ tests
# ---------------------------------------------------------------------------

def test_deepcopy_preserves_config(tmp_path):
    lm = _make_lm(tmp_path)
    lm.temperature = 0.3
    lm.max_tokens = 512
    lm.top_p = 0.9

    lm_copy = copy.deepcopy(lm)

    assert lm_copy.model == lm.model
    assert lm_copy.temperature == lm.temperature
    assert lm_copy.max_tokens == lm.max_tokens
    assert lm_copy.top_p == lm.top_p


def test_deepcopy_does_not_raise(tmp_path):
    """deepcopy must not error on threading.Lock objects."""
    lm = _make_lm(tmp_path)
    copy.deepcopy(lm)  # should not raise


def test_deepcopy_shares_token_manager(tmp_path):
    """The copy should reuse the same token manager instance."""
    lm = _make_lm(tmp_path)
    lm_copy = copy.deepcopy(lm)
    assert lm_copy.token_manager is lm.token_manager


def test_deepcopy_memo_populated(tmp_path):
    """deepcopy should register the new instance in the memo dict."""
    lm = _make_lm(tmp_path)
    memo = {}
    lm_copy = lm.__deepcopy__(memo)
    assert memo[id(lm)] is lm_copy


# ---------------------------------------------------------------------------
# aforward() tests
# ---------------------------------------------------------------------------

def test_aforward_returns_copilot_response_shape(tmp_path):
    """aforward() must return an object whose attribute layout matches what
    DSPy's BaseLM._process_completion accesses."""
    lm = _make_lm(tmp_path)

    with patch.object(lm, "_make_request", return_value=_FAKE_API_RESPONSE):
        response = asyncio.run(lm.aforward(prompt="Hi"))

    # DSPy accesses response.choices[i].message.content
    assert len(response.choices) == 1
    choice = response.choices[0]
    assert choice.message.content == "Hello!"
    assert choice.message.role == "assistant"
    assert choice.logprobs is None
    assert choice.finish_reason == "stop"
    # DSPy also reads response.model and response._hidden_params
    assert response.model == "gpt-4o"
    assert hasattr(response, "_hidden_params")


def test_aforward_updates_metrics(tmp_path):
    """aforward() must increment request_count and token counters."""
    lm = _make_lm(tmp_path)

    with patch.object(lm, "_make_request", return_value=_FAKE_API_RESPONSE):
        asyncio.run(lm.aforward(prompt="Hi"))

    usage = lm.get_usage()
    assert usage["requests"] == 1
    assert usage["input_tokens"] == 10
    assert usage["output_tokens"] == 5


def test_aforward_with_messages(tmp_path):
    """aforward() should accept an explicit messages list."""
    lm = _make_lm(tmp_path)
    messages = [{"role": "user", "content": "What is 2+2?"}]

    with patch.object(lm, "_make_request", return_value=_FAKE_API_RESPONSE) as mock_req:
        asyncio.run(lm.aforward(messages=messages))

    called_body = mock_req.call_args[0][0]
    assert called_body["messages"] == messages


def test_aforward_concurrent_calls_do_not_share_session(tmp_path):
    """Concurrent aforward() invocations must each use their own HTTP session."""
    lm = _make_lm(tmp_path)
    sessions_seen = []
    # Barrier ensures both threads are alive (and holding their sessions)
    # at the same time, so we can compare actual object identity.
    barrier = threading.Barrier(2)

    def capturing_make_request(self, body, session=None):
        sessions_seen.append(session)
        barrier.wait()  # hold until both threads have recorded their session
        return _FAKE_API_RESPONSE

    async def run_concurrent():
        with patch.object(CopilotLM, "_make_request", capturing_make_request):
            await asyncio.gather(
                lm.aforward(prompt="first"),
                lm.aforward(prompt="second"),
            )

    asyncio.run(run_concurrent())

    # Each call must have used a distinct session object
    assert len(sessions_seen) == 2
    assert sessions_seen[0] is not sessions_seen[1]


def test_aforward_cache_hit_skips_make_request(tmp_path):
    """Second aforward() call with the same inputs should return a cached _CopilotResponse
    without invoking _make_request again."""
    lm = _make_lm(tmp_path)

    with patch.object(lm, "_make_request", return_value=_FAKE_API_RESPONSE) as mock_req:
        first = asyncio.run(lm.aforward(prompt="cached prompt"))
        second = asyncio.run(lm.aforward(prompt="cached prompt"))

    # _make_request must only be called once
    assert mock_req.call_count == 1
    # Both calls must return a valid _CopilotResponse
    assert second.choices[0].message.content == "Hello!"
    assert second.model == "gpt-4o"


def test_aforward_and_call_share_cache(tmp_path):
    """__call__() and aforward() with the same logical request should share the cache entry."""
    lm = _make_lm(tmp_path)
    messages = [{"role": "user", "content": "shared prompt"}]

    with patch.object(lm, "_make_request", return_value=_FAKE_API_RESPONSE) as mock_req:
        # First call via __call__() populates the cache
        lm(messages=messages)
        # Second call via aforward() should hit the cache
        response = asyncio.run(lm.aforward(messages=messages))

    # _make_request must only be called once across both methods
    assert mock_req.call_count == 1
    assert response.choices[0].message.content == "Hello!"


# ---------------------------------------------------------------------------
# uses_max_completion_tokens + _build_request tests
# ---------------------------------------------------------------------------

def test_uses_max_completion_tokens_for_gpt5_models():
    assert uses_max_completion_tokens("gpt-5") is True
    assert uses_max_completion_tokens("gpt-5.4") is True
    assert uses_max_completion_tokens("gpt-5-mini") is True


def test_uses_max_completion_tokens_is_false_for_gpt4_models():
    assert uses_max_completion_tokens("gpt-4o") is False
    assert uses_max_completion_tokens("gpt-4o-mini") is False
    assert uses_max_completion_tokens("gpt-50") is False  # must not match gpt-5 prefix


def test_build_request_uses_max_completion_tokens_for_gpt5_models(tmp_path):
    lm = CopilotLM(model="gpt-5.4", token_manager=_make_stub_token_manager(tmp_path))
    request = lm._build_request([{"role": "user", "content": "hi"}])
    assert "max_completion_tokens" in request
    assert "max_tokens" not in request


def test_build_request_uses_max_tokens_for_gpt4_models(tmp_path):
    lm = CopilotLM(model="gpt-4o", token_manager=_make_stub_token_manager(tmp_path))
    request = lm._build_request([{"role": "user", "content": "hi"}])
    assert "max_tokens" in request
    assert "max_completion_tokens" not in request


def test_build_request_preserves_temperature_and_top_p(tmp_path):
    lm = CopilotLM(model="gpt-4o", temperature=0.3, top_p=0.9, token_manager=_make_stub_token_manager(tmp_path))
    request = lm._build_request([{"role": "user", "content": "hi"}], temperature=0.5)
    assert request["temperature"] == 0.5   # kwarg override
    assert request["top_p"] == 0.9         # instance default
