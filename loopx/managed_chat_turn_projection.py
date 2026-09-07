"""Durable, outcome-neutral run projection for managed task Chat Turns."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from .control_plane.runtime.runtime_projection_writer import (
    write_compact_runtime_projection,
)
from .control_plane.runtime.time import now_local_iso


MANAGED_CHAT_TURN_PROJECTION_SCHEMA_VERSION = "managed_chat_turn_projection_v0"


def _render_markdown(record: dict[str, Any]) -> str:
    marker = record["managed_chat_turn"]
    return "\n".join(
        [
            "# LoopX Managed Chat Turn Projection",
            "",
            f"- goal_id: `{record.get('goal_id')}`",
            f"- classification: `{record.get('classification')}`",
            f"- generated_at: `{record.get('generated_at')}`",
            f"- agent_id: `{marker.get('agent_id')}`",
            f"- channel_id: `{marker.get('channel_id')}`",
            f"- todo_id: `{marker.get('todo_id')}`",
            f"- status: `{marker.get('status')}`",
            "- outcome_claimed: `False`",
            "- raw_response_recorded: `False`",
        ]
    )


def project_completed_managed_task_turn(
    *,
    runtime_root: Path,
    session: Mapping[str, Any],
    turn: Mapping[str, Any],
    dry_run: bool = False,
) -> dict[str, Any]:
    """Append one idempotent, response-free completion receipt for task Turns."""

    channel_id = str(session.get("channel_id") or "").strip()
    if not channel_id.startswith("task."):
        return {
            "ok": True,
            "status": "not_applicable",
            "reason": "managed Chat projection records task channels only",
        }
    status = str(turn.get("status") or "").strip()
    if status != "completed":
        raise ValueError("managed task Turn projection requires completed status")
    goal_id = str(session.get("goal_id") or "").strip()
    agent_id = str(session.get("agent_id") or "").strip()
    session_id = str(session.get("session_id") or "").strip()
    turn_id = str(turn.get("turn_id") or "").strip()
    todo_id = channel_id.removeprefix("task.").strip()
    if not all((goal_id, agent_id, session_id, turn_id, todo_id)):
        raise ValueError("managed task Turn projection is missing identity")
    generated_at = str(turn.get("completed_at") or now_local_iso())
    marker = {
        "schema_version": MANAGED_CHAT_TURN_PROJECTION_SCHEMA_VERSION,
        "source": "chat_runtime",
        "session_id": session_id,
        "turn_id": turn_id,
        "agent_id": agent_id,
        "channel_id": channel_id,
        "todo_id": todo_id,
        "status": status,
        "outcome_claimed": False,
        "raw_response_recorded": False,
    }
    record = {
        "generated_at": generated_at,
        "goal_id": goal_id,
        "classification": "managed_chat_turn_completed",
        "health_check": "managed Chat task Turn completed; no delivery outcome inferred",
        "agent_id": agent_id,
        "managed_chat_turn": marker,
    }
    index_record = dict(record)
    return write_compact_runtime_projection(
        target_runtime_root=runtime_root.expanduser().resolve(),
        goal_id=goal_id,
        record=record,
        index_record=index_record,
        marker_field="managed_chat_turn",
        identity_fields=("session_id", "turn_id", "status"),
        markdown_renderer=_render_markdown,
        dry_run=dry_run,
    )
