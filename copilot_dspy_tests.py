from datetime import datetime, timedelta

from copilot_dspy_client import CopilotTokenManager


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
