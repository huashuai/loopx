"""Stable identity for one LoopX machine runtime root."""

from __future__ import annotations

import json
from pathlib import Path
import re
import secrets
from typing import TypedDict

from ...file_lock import exclusive_file_lock
from ...registry import atomic_write_json


MACHINE_IDENTITY_SCHEMA_VERSION = "loopx_machine_identity_v1"
MACHINE_IDENTITY_FILENAME = "machine-identity.json"
_MACHINE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{24,160}$")


class MachineIdentity(TypedDict):
    schema_version: str
    machine_id: str


class MachineIdentityError(RuntimeError):
    """Raised when a persisted machine identity cannot be trusted."""


def _read_machine_identity(path: Path) -> MachineIdentity:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise MachineIdentityError("invalid persisted machine identity") from error
    if not isinstance(payload, dict):
        raise MachineIdentityError("invalid persisted machine identity")
    machine_id = payload.get("machine_id")
    if (
        payload.get("schema_version") != MACHINE_IDENTITY_SCHEMA_VERSION
        or not isinstance(machine_id, str)
        or _MACHINE_ID_PATTERN.fullmatch(machine_id) is None
    ):
        raise MachineIdentityError("invalid persisted machine identity")
    return {
        "schema_version": MACHINE_IDENTITY_SCHEMA_VERSION,
        "machine_id": machine_id,
    }


def load_or_create_machine_identity(runtime_root: Path) -> MachineIdentity:
    """Return the runtime root's stable identity, creating it exactly once."""

    path = runtime_root.expanduser() / MACHINE_IDENTITY_FILENAME
    with exclusive_file_lock(path, operation="load_or_create_machine_identity"):
        if path.exists():
            return _read_machine_identity(path)
        identity: MachineIdentity = {
            "schema_version": MACHINE_IDENTITY_SCHEMA_VERSION,
            "machine_id": secrets.token_urlsafe(32),
        }
        atomic_write_json(path, identity)
        try:
            path.chmod(0o600)
        except OSError as error:
            raise MachineIdentityError("could not protect persisted machine identity") from error
        return identity
