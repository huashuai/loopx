from __future__ import annotations

import subprocess
from unittest import mock
from types import SimpleNamespace

import pytest

from loopx.chat_ssh_source_api import SshSourceRequestMixin
from loopx.control_plane.status.ssh_tunnel import ensure_ssh_source


def test_ensure_ssh_source_opens_tunnel_and_returns_status_url() -> None:
    calls: list[list[str]] = []
    probe_count = 0

    identity = {
        "machine_id": "ark-stable-machine-identity",
        "control_plane_instance_id": "ark-machine-instance",
    }

    def fake_loopback(port: int, **kwargs: object) -> dict[str, str] | None:
        nonlocal probe_count
        probe_count += 1
        return identity if probe_count >= 2 else None

    with mock.patch(
        "loopx.control_plane.status.ssh_tunnel.configured_ssh_host_aliases",
        return_value=["ark-devbox"],
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_control_identity",
        fake_loopback,
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_status_ok", return_value=False
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._remote_control_identity",
        return_value=identity,
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel.subprocess.run",
        side_effect=lambda args, **kwargs: calls.append(list(args)),
    ):
        result = ensure_ssh_source("ark-devbox", 8877, wait_seconds=0.01)

    assert result == {
        "ok": True,
        "status_url": "http://127.0.0.1:8877/status.json",
        "control_url": "http://127.0.0.1:8877",
        "tunnel_required": True,
        "remote_started": False,
        "source_binding": {
            "schema_version": "ssh_source_binding_v2",
            "machine_id": "ark-stable-machine-identity",
            "control_plane_instance_id": "ark-machine-instance",
        },
    }
    tunnel_call = calls[0]
    assert tunnel_call[0] == "ssh"
    assert "-L" in tunnel_call
    assert "8877:127.0.0.1:8767" in tunnel_call
    assert "ark-devbox" in tunnel_call
    # The alias and port are passed as separate argv entries, never through a shell.
    assert "; " not in " ".join(tunnel_call)


def test_ensure_ssh_source_starts_remote_control_plane_when_missing() -> None:
    probe_count = 0

    identity = {
        "machine_id": "ark-stable-machine-identity",
        "control_plane_instance_id": "ark-machine-instance",
    }

    def fake_loopback(port: int, **kwargs: object) -> dict[str, str] | None:
        nonlocal probe_count
        probe_count += 1
        return identity if probe_count >= 3 else None

    with mock.patch(
        "loopx.control_plane.status.ssh_tunnel.configured_ssh_host_aliases",
        return_value=["ark-devbox"],
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_control_identity",
        fake_loopback,
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_status_ok", return_value=False
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._remote_control_identity",
        side_effect=[None, identity],
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._start_remote_control", return_value=None
    ) as start_remote, mock.patch(
        "loopx.control_plane.status.ssh_tunnel.subprocess.run", return_value=None
    ):
        result = ensure_ssh_source("ark-devbox", 8877, wait_seconds=0.01)

    start_remote.assert_called_once_with("ark-devbox")
    assert result["remote_started"] is True


def test_ensure_ssh_source_rejects_a_legacy_status_only_tunnel() -> None:
    with mock.patch(
        "loopx.control_plane.status.ssh_tunnel.configured_ssh_host_aliases",
        return_value=["ark-devbox"],
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_control_identity",
        return_value=None,
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_status_ok", return_value=True
    ), mock.patch("loopx.control_plane.status.ssh_tunnel.subprocess.run") as run:
        with pytest.raises(ValueError, match="status-only"):
            ensure_ssh_source("ark-devbox", 8877)

    run.assert_not_called()


def test_ensure_ssh_source_reuses_only_the_requested_remote_instance() -> None:
    with mock.patch(
        "loopx.control_plane.status.ssh_tunnel.configured_ssh_host_aliases",
        return_value=["ark-devbox"],
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_control_identity",
        return_value={
            "machine_id": "other-stable-machine-identity",
            "control_plane_instance_id": "other-machine-instance",
        },
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._remote_control_identity",
        return_value={
            "machine_id": "ark-stable-machine-identity",
            "control_plane_instance_id": "ark-machine-instance",
        },
    ), mock.patch("loopx.control_plane.status.ssh_tunnel.subprocess.run") as run:
        with pytest.raises(ValueError, match="different SSH source"):
            ensure_ssh_source("ark-devbox", 8877)

    run.assert_not_called()


def test_ensure_ssh_source_reports_unverifiable_remote_without_claiming_mismatch() -> None:
    with mock.patch(
        "loopx.control_plane.status.ssh_tunnel.configured_ssh_host_aliases",
        return_value=["ark-devbox"],
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_control_identity",
        return_value={
            "machine_id": "occupied-stable-machine-identity",
            "control_plane_instance_id": "occupied-port-instance",
        },
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._remote_control_identity",
        return_value=None,
    ), mock.patch("loopx.control_plane.status.ssh_tunnel.subprocess.run") as run:
        with pytest.raises(ConnectionError, match="could not verify"):
            ensure_ssh_source("ark-devbox", 8877)

    run.assert_not_called()


def test_ensure_ssh_source_returns_the_verified_instance_binding() -> None:
    identity = {
        "machine_id": "ark-stable-machine-identity",
        "control_plane_instance_id": "ark-machine-instance",
    }
    with mock.patch(
        "loopx.control_plane.status.ssh_tunnel.configured_ssh_host_aliases",
        return_value=["ark-devbox"],
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_control_identity",
        return_value=identity,
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._remote_control_identity",
        return_value=identity,
    ), mock.patch("loopx.control_plane.status.ssh_tunnel.subprocess.run") as run:
        result = ensure_ssh_source("ark-devbox", 8877)

    assert result["source_binding"] == {
        "schema_version": "ssh_source_binding_v2",
        "machine_id": "ark-stable-machine-identity",
        "control_plane_instance_id": "ark-machine-instance",
    }
    assert result["tunnel_required"] is False
    run.assert_not_called()


def test_ensure_ssh_source_returns_stable_machine_and_process_identities() -> None:
    identity = {
        "machine_id": "ark-stable-machine-identity",
        "control_plane_instance_id": "ark-process-instance-one",
    }
    with mock.patch(
        "loopx.control_plane.status.ssh_tunnel.configured_ssh_host_aliases",
        return_value=["ark-devbox"],
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._loopback_control_identity",
        return_value=identity,
    ), mock.patch(
        "loopx.control_plane.status.ssh_tunnel._remote_control_identity",
        return_value=identity,
    ), mock.patch("loopx.control_plane.status.ssh_tunnel.subprocess.run"):
        result = ensure_ssh_source("ark-devbox", 8877)

    assert result["source_binding"] == {
        "schema_version": "ssh_source_binding_v2",
        "machine_id": "ark-stable-machine-identity",
        "control_plane_instance_id": "ark-process-instance-one",
    }


def test_ensure_ssh_source_rejects_unknown_alias() -> None:
    with mock.patch(
        "loopx.control_plane.status.ssh_tunnel.configured_ssh_host_aliases",
        return_value=["ark-devbox"],
    ):
        with pytest.raises(ValueError, match="unknown SSH host alias"):
            ensure_ssh_source("evil-host;id", 8877)


def test_ensure_ssh_source_rejects_invalid_port() -> None:
    with mock.patch(
        "loopx.control_plane.status.ssh_tunnel.configured_ssh_host_aliases",
        return_value=["ark-devbox"],
    ):
        with pytest.raises(ValueError, match="local tunnel port"):
            ensure_ssh_source("ark-devbox", 22)
        with pytest.raises(ValueError, match="local tunnel port"):
            ensure_ssh_source("ark-devbox", "8877")


class _SshSourceHandler(SshSourceRequestMixin):
    def __init__(self, *, host: str = "127.0.0.1") -> None:
        self.server = SimpleNamespace(server_address=(host, 8767), ssh_config_path=None)
        self.errors: list[tuple[str, int]] = []
        self.payloads: list[dict[str, object]] = []

    def _read_json(self) -> dict[str, object]:
        return {"host_alias": "ark-devbox", "local_port": 8877}

    def _require_loopback_origin(self) -> bool:
        return True

    def _send_error(self, message: str, **kwargs: object) -> None:
        self.errors.append((message, int(kwargs.get("status") or 400)))

    def _send_json(
        self, payload: dict[str, object], *, status: int = 200
    ) -> None:
        self.payloads.append(payload)


def test_ssh_source_request_mixin_delegates_validated_loopback_request() -> None:
    handler = _SshSourceHandler()
    receipt = {"ok": True, "status_url": "http://127.0.0.1:8877/status.json"}

    with mock.patch(
        "loopx.chat_ssh_source_api.ensure_ssh_source", return_value=receipt
    ) as ensure:
        handler._ssh_source_ensure()

    ensure.assert_called_once_with(
        "ark-devbox", 8877, ssh_config_path=None
    )
    assert handler.payloads == [receipt]
    assert handler.errors == []


def test_ssh_source_request_mixin_rejects_non_loopback_server() -> None:
    handler = _SshSourceHandler(host="0.0.0.0")

    with mock.patch("loopx.chat_ssh_source_api.ensure_ssh_source") as ensure:
        handler._ssh_source_ensure()

    ensure.assert_not_called()
    assert handler.payloads == []
    assert handler.errors == [
        ("SSH source management requires a loopback LoopX Chat server.", 403)
    ]


def test_ssh_source_request_mixin_returns_bootstrap_failure_without_dropping_connection() -> None:
    handler = _SshSourceHandler()

    with mock.patch(
        "loopx.chat_ssh_source_api.ensure_ssh_source",
        side_effect=subprocess.CalledProcessError(1, ["ssh"]),
    ):
        handler._ssh_source_ensure()

    assert handler.payloads == []
    assert handler.errors == [
        ("Could not start the remote LoopX control plane for this SSH source.", 502)
    ]
