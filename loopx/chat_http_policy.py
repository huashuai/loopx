from __future__ import annotations

import secrets

from .status_server import cors_response_headers


CONTROL_PLANE_INSTANCE_HEADER = "X-LoopX-Control-Plane-Instance"


def chat_cors_response_headers(origin: str | None) -> dict[str, str]:
    headers = cors_response_headers(origin)
    if headers:
        headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        headers["Access-Control-Allow-Headers"] = (
            f"Content-Type, {CONTROL_PLANE_INSTANCE_HEADER}"
        )
    return headers


def new_control_plane_instance_id() -> str:
    return secrets.token_urlsafe(24)


def control_plane_instance_mismatch(
    requested_instance: str | None,
    active_instance: str,
) -> bool:
    return bool(requested_instance and requested_instance != active_instance)


def control_plane_instance_mismatch_payload() -> dict[str, object]:
    return {
        "ok": False,
        "error": "The selected remote control-plane instance changed; reconnect before writing.",
        "error_code": "control_plane_instance_mismatch",
        "write_attempted": False,
    }
