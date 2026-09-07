"""Canonical Todo reconciliation for typed Chat Gate proposals."""

from __future__ import annotations

from typing import Any

from .control_plane.todos.contract import (
    normalize_todo_decision_outcome,
    todo_terminal_for_status,
)
from .todos import list_goal_todos


class ChatGateActionMixin:
    """Keep canonical Gate readback separate from general action orchestration."""

    def _reconcile_gate_proposal(
        self,
        proposal: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if proposal is None or proposal.get("action_kind") != "gate.resolve":
            return proposal
        if proposal.get("status") not in {
            "preview_ready",
            "applying",
            "gated",
            "failed",
            "deferred",
        }:
            return proposal
        parameters = proposal.get("normalized_parameters")
        if not isinstance(parameters, dict):
            return proposal
        goal_id = str(parameters.get("goal_id") or "")
        todo_id = str(parameters.get("todo_id") or "")
        if not goal_id or not todo_id:
            return proposal
        try:
            todo_payload = list_goal_todos(
                registry_path=self.registry_path,
                goal_id=goal_id,
                role="user",
                todo_id=todo_id,
            )
        except (OSError, RuntimeError, ValueError):
            return proposal
        todo = todo_payload.get("todo")
        if not isinstance(todo, dict) or todo_payload.get("ambiguous"):
            return proposal
        canonical_status = str(todo.get("status") or "")
        if not todo_terminal_for_status(canonical_status):
            return proposal
        return self.store.reconcile_gate_resolution(
            str(proposal["proposal_id"]),
            canonical_status=canonical_status,
            canonical_decision_outcome=normalize_todo_decision_outcome(
                todo.get("decision_outcome")
            ),
        )
