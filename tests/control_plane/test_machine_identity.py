from __future__ import annotations

import json
import re

import pytest

from loopx.control_plane.status.machine_identity import (
    MachineIdentityError,
    load_or_create_machine_identity,
)


def test_machine_identity_survives_control_plane_restarts(tmp_path) -> None:
    runtime_root = tmp_path / "runtime"

    first = load_or_create_machine_identity(runtime_root)
    second = load_or_create_machine_identity(runtime_root)

    assert first == second
    assert first["schema_version"] == "loopx_machine_identity_v1"
    assert re.fullmatch(r"[A-Za-z0-9_-]{24,160}", first["machine_id"])


def test_machine_identity_corruption_fails_closed_instead_of_rotating(tmp_path) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_root.mkdir(parents=True)
    (runtime_root / "machine-identity.json").write_text(
        json.dumps({"schema_version": "loopx_machine_identity_v1"}) + "\n",
        encoding="utf-8",
    )

    with pytest.raises(MachineIdentityError, match="invalid persisted machine identity"):
        load_or_create_machine_identity(runtime_root)
