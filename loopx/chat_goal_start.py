"""Managed Goal-start authority and first-Turn prompt contracts."""

from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
from typing import Any, Mapping


MANAGED_GOAL_FIRST_TURN_SCHEMA_VERSION = "loopx_managed_goal_first_turn_v0"
WORKSPACE_WRITE_ON_CONFIRMATION = "workspace_write_on_confirmation"
READ_ONLY_PERMISSION = "read_only"
_PACKET_START = "LOOPX_FIRST_TURN_PACKET_START"
_PACKET_END = "LOOPX_FIRST_TURN_PACKET_END"


def goal_create_write_scope(*, permission: object, project: Path) -> list[str]:
    """Translate a reviewed Goal-create permission into its canonical scope."""

    normalized = str(permission or READ_ONLY_PERMISSION).strip()
    if normalized == READ_ONLY_PERMISSION:
        return []
    if normalized == WORKSPACE_WRITE_ON_CONFIRMATION:
        return [project.expanduser().resolve().as_posix()]
    raise ValueError(f"unsupported goal.create permission: {normalized or '<empty>'}")


def build_managed_goal_first_turn_packet(
    *,
    goal_id: str,
    agent_id: str,
    objective: str,
    quota_guard: Mapping[str, Any],
) -> dict[str, Any]:
    """Build the compact quota-owned contract passed to a managed first Turn."""

    sections: dict[str, dict[str, Any]] = {}
    for key in (
        "interaction_contract",
        "execution_obligation",
        "goal_boundary",
        "selected_todo",
        "todo_write_hint",
    ):
        value = quota_guard.get(key)
        if not isinstance(value, Mapping):
            raise ValueError(f"Goal first Turn quota guard is missing {key}")
        sections[key] = deepcopy(dict(value))

    if quota_guard.get("should_run") is not True:
        raise ValueError("Goal first Turn quota guard does not authorize delivery")
    selected_todo = sections["selected_todo"]
    if not str(selected_todo.get("todo_id") or "").strip():
        raise ValueError("Goal first Turn quota guard has no selected Todo identity")

    return {
        "schema_version": MANAGED_GOAL_FIRST_TURN_SCHEMA_VERSION,
        "goal_id": goal_id,
        "agent_id": agent_id,
        "objective": objective,
        **sections,
    }


def render_managed_goal_first_turn_message(packet: Mapping[str, Any]) -> str:
    """Render a typed packet plus minimal execution instructions for the Agent."""

    encoded = json.dumps(
        dict(packet),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return (
        "LoopX 已创建 Goal、选择 Todo，并完成本轮 quota 仲裁。"
        "下面的 typed packet 是本轮权威执行合同；不要再次请求 Goal/Todo 投影。"
        "必须按 execution_obligation 推进一个有界工作段，并只在 goal_boundary 内行动。"
        "若遇到真实权限或资料阻塞，使用 todo_write_hint 写入 durable User Gate，"
        "再按 interaction_contract.cli_channel 写回；聊天回复本身不算状态写回。\n"
        f"{_PACKET_START}\n{encoded}\n{_PACKET_END}"
    )
