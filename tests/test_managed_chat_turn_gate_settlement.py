from __future__ import annotations

import json
from pathlib import Path

from loopx.bootstrap import bootstrap_project
from loopx.managed_chat_turn_projection import project_completed_managed_task_turn


GOAL_ID = "managed-goal"
AGENT_ID = "codex"
GATE_TEXT = (
    "Provide readable source material or authorize a runtime that can read it "
    "and write LoopX state; this does not authorize external publication."
)


def _goal_fixture(tmp_path: Path) -> tuple[Path, Path, Path]:
    project = tmp_path / "project"
    project.mkdir()
    registry_path = project / ".loopx" / "registry.json"
    runtime_root = tmp_path / "runtime"
    bootstrap_project(
        project=project,
        registry_path=registry_path,
        runtime_root=runtime_root,
        goal_id=GOAL_ID,
        objective="Complete one governed task.",
        domain="project-goal-control-plane",
        role="primary",
        parent_goal_id=None,
        state_file=None,
        goal_doc=None,
        adapter_kind="generic_project_goal_v0",
        adapter_status="connected",
        next_probe=None,
        spawn_allowed=False,
        max_children=0,
        allowed_domains=[],
        write_scope=[str(project)],
        onboarding_scan_enabled=False,
        force=False,
        dry_run=False,
        sync_global=False,
    )
    registry = json.loads(registry_path.read_text(encoding="utf-8"))
    registry["goals"][0]["coordination"] = {
        "registered_agents": [AGENT_ID],
        "agent_model": "peer_v1",
    }
    registry_path.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    state_file = project / ".codex" / "goals" / GOAL_ID / "ACTIVE_GOAL_STATE.md"
    return registry_path, runtime_root, state_file


def _session(*, channel_id: str = "task.todo-managed") -> dict[str, object]:
    return {
        "goal_id": GOAL_ID,
        "agent_id": AGENT_ID,
        "session_id": "session-managed",
        "channel_id": channel_id,
    }


def _completed_turn(*, with_gate: bool = True) -> dict[str, object]:
    return {
        "turn_id": "turn-managed",
        "status": "completed",
        "completed_at": "2026-09-07T04:51:52Z",
        "response": {
            "message": "The task needs one bounded owner decision.",
            "proposals": [
                {
                    "kind": "todo",
                    "text": GATE_TEXT,
                    "priority": "P1",
                    "rationale": "The execution sandbox cannot cross this authority boundary.",
                }
            ],
            "gate": (
                {
                    "kind": "host_gate",
                    "summary": "Required read and LoopX write authority are unavailable.",
                    "next_action": "Resolve the bounded authority gate.",
                }
                if with_gate
                else None
            ),
        },
    }


def test_completed_managed_task_materializes_one_blocking_user_gate(tmp_path: Path) -> None:
    registry_path, runtime_root, state_file = _goal_fixture(tmp_path)

    result = project_completed_managed_task_turn(
        runtime_root=runtime_root,
        registry_path=registry_path,
        session=_session(),
        turn=_completed_turn(),
    )

    assert result["gate_materialization"] == {
        "schema_version": "managed_chat_gate_materialization_v0",
        "status": "materialized",
        "goal_id": GOAL_ID,
        "agent_id": AGENT_ID,
        "todo_id": result["gate_materialization"]["todo_id"],
        "blocks_agent": AGENT_ID,
    }
    state = state_file.read_text(encoding="utf-8")
    assert state.count(GATE_TEXT) == 1
    assert "task_class=user_gate" in state
    assert f"blocks_agent={AGENT_ID}" in state
    assert "external publication" in state
    assert "execution sandbox" not in state

    replay = project_completed_managed_task_turn(
        runtime_root=runtime_root,
        registry_path=registry_path,
        session=_session(),
        turn=_completed_turn(),
    )

    assert replay["gate_materialization"]["status"] == "already_materialized"
    assert replay["gate_materialization"]["todo_id"] == result["gate_materialization"]["todo_id"]
    assert state_file.read_text(encoding="utf-8").count(GATE_TEXT) == 1


def test_completed_managed_task_without_gate_keeps_outcome_neutral_projection(
    tmp_path: Path,
) -> None:
    registry_path, runtime_root, state_file = _goal_fixture(tmp_path)

    result = project_completed_managed_task_turn(
        runtime_root=runtime_root,
        registry_path=registry_path,
        session=_session(),
        turn=_completed_turn(with_gate=False),
    )

    assert result["gate_materialization"]["status"] == "not_requested"
    assert GATE_TEXT not in state_file.read_text(encoding="utf-8")


def test_non_task_chat_never_materializes_agent_proposals(tmp_path: Path) -> None:
    registry_path, runtime_root, state_file = _goal_fixture(tmp_path)

    result = project_completed_managed_task_turn(
        runtime_root=runtime_root,
        registry_path=registry_path,
        session=_session(channel_id="goal.managed-goal"),
        turn=_completed_turn(),
    )

    assert result["status"] == "not_applicable"
    assert GATE_TEXT not in state_file.read_text(encoding="utf-8")
