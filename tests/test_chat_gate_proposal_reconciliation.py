from __future__ import annotations

import json
import threading
from pathlib import Path
from urllib.request import Request
from urllib.request import urlopen

import pytest

from loopx.chat_action_store import ChatActionStore
from loopx.chat_actions import ChatActionService
from loopx.chat_server import ChatHTTPServer, ChatRequestHandler
from loopx.todos import add_goal_todo, complete_goal_todo


GOAL_ID = "goal-one"
AGENT_ID = "codex"
DECISION_SCOPE = "direction:action:publish_release"


def _service_with_gate(tmp_path: Path) -> tuple[ChatActionService, str]:
    project = tmp_path / "project"
    runtime_root = tmp_path / "runtime"
    state = project / "ACTIVE_GOAL_STATE.md"
    state.parent.mkdir(parents=True)
    state.write_text(
        "---\nstatus: active\nupdated_at: 2026-09-01T00:00:00Z\n---\n\n"
        "# Active Goal State\n\n"
        "## User Todo / Owner Review Reading Queue\n\n"
        "## Agent Todo\n",
        encoding="utf-8",
    )
    registry = project / ".loopx" / "registry.json"
    registry.parent.mkdir(parents=True)
    registry.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "common_runtime_root": str(runtime_root),
                "goals": [
                    {
                        "id": GOAL_ID,
                        "repo": str(project),
                        "state_file": "ACTIVE_GOAL_STATE.md",
                        "coordination": {
                            "agent_model": "peer_v1",
                            "registered_agents": [AGENT_ID],
                        },
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )
    gate = add_goal_todo(
        registry_path=registry,
        goal_id=GOAL_ID,
        role="user",
        text="Approve publishing the validated release.",
        task_class="user_gate",
        blocks_agent=AGENT_ID,
        decision_scope=DECISION_SCOPE,
    )
    return (
        ChatActionService(
            store=ChatActionStore(runtime_root / "chat" / "actions"),
            registry_path=registry,
        ),
        str(gate["todo_id"]),
    )


def _preview_gate(
    service: ChatActionService,
    todo_id: str,
    *,
    decision: str,
    suffix: str,
) -> dict[str, object]:
    return service.preview(
        {
            "action_kind": "gate.resolve",
            "summary": f"Resolve the owner gate with {decision}",
            "normalized_parameters": {
                "goal_id": GOAL_ID,
                "todo_id": todo_id,
                "decision": decision,
            },
            "context": {"kind": "goal", "goal_id": GOAL_ID},
            "idempotency_key": f"gate-{decision}-{suffix}",
        }
    )


def _mark_gated(service: ChatActionService, proposal: dict[str, object]) -> None:
    service.store.mark_gated(
        str(proposal["proposal_id"]),
        gate={
            "kind": "canonical_authority_required",
            "summary": "Resolve this decision through the canonical Todo authority.",
            "next_action": "Complete the referenced User Todo.",
        },
    )


def _complete_gate(
    service: ChatActionService,
    todo_id: str,
    *,
    decision: str,
) -> None:
    completed = complete_goal_todo(
        registry_path=service.registry_path,
        goal_id=GOAL_ID,
        todo_id=todo_id,
        role="user",
        decision_outcome=decision,
        evidence="Owner recorded the bounded decision.",
    )
    assert completed["ok"] is True
    assert completed["decision_outcome"] == decision


def _assert_reconciled(
    proposal: dict[str, object],
    *,
    todo_id: str,
    decision: str,
) -> None:
    assert proposal["status"] == "applied"
    receipt = proposal["receipt"]
    assert isinstance(receipt, dict)
    assert receipt["outcome"] == "canonical_gate_already_resolved"
    assert receipt["projection_verified"] is True
    assert receipt["decision_outcome"] == decision
    assert receipt["resource_ids"] == {
        "goal_id": GOAL_ID,
        "todo_id": todo_id,
    }


@pytest.mark.parametrize("decision", ["approve", "reject", "cancel"])
def test_load_reconciles_matching_terminal_gate_decision(
    tmp_path: Path,
    decision: str,
) -> None:
    service, todo_id = _service_with_gate(tmp_path)
    proposal = _preview_gate(service, todo_id, decision=decision, suffix="load")
    _mark_gated(service, proposal)
    _complete_gate(service, todo_id, decision=decision)

    reconciled = service.load(str(proposal["proposal_id"]))

    assert reconciled is not None
    _assert_reconciled(reconciled, todo_id=todo_id, decision=decision)
    assert service.store.load(str(proposal["proposal_id"])) == reconciled


def test_load_preserves_an_open_canonical_gate(tmp_path: Path) -> None:
    service, todo_id = _service_with_gate(tmp_path)
    proposal = _preview_gate(service, todo_id, decision="approve", suffix="open")
    _mark_gated(service, proposal)

    loaded = service.load(str(proposal["proposal_id"]))

    assert loaded is not None
    assert loaded["status"] == "gated"
    assert loaded["receipt"] is None


def test_load_marks_a_conflicting_terminal_decision_stale(tmp_path: Path) -> None:
    service, todo_id = _service_with_gate(tmp_path)
    proposal = _preview_gate(service, todo_id, decision="approve", suffix="conflict")
    _mark_gated(service, proposal)
    _complete_gate(service, todo_id, decision="reject")

    reconciled = service.load(str(proposal["proposal_id"]))

    assert reconciled is not None
    assert reconciled["status"] == "stale"
    assert reconciled["receipt"] is None
    assert reconciled["stale"]["reason"] == "canonical_gate_decision_conflict"
    assert reconciled["stale"]["requested_decision"] == "approve"
    assert reconciled["stale"]["canonical_decision_outcome"] == "reject"


def test_recheck_reuses_the_terminal_proposal_instead_of_creating_a_duplicate(
    tmp_path: Path,
) -> None:
    service, todo_id = _service_with_gate(tmp_path)
    proposal = _preview_gate(service, todo_id, decision="approve", suffix="recheck")
    _mark_gated(service, proposal)
    _complete_gate(service, todo_id, decision="approve")

    reconciled = service.regenerate(str(proposal["proposal_id"]))

    assert reconciled["proposal_id"] == proposal["proposal_id"]
    _assert_reconciled(reconciled, todo_id=todo_id, decision="approve")
    assert len(service.store.list(goal_id=GOAL_ID)) == 1


def test_http_recheck_returns_existing_terminal_proposal_without_created_status(
    tmp_path: Path,
) -> None:
    service, todo_id = _service_with_gate(tmp_path)
    proposal = _preview_gate(service, todo_id, decision="approve", suffix="http-recheck")
    _mark_gated(service, proposal)
    _complete_gate(service, todo_id, decision="approve")
    server = ChatHTTPServer(("127.0.0.1", 0), ChatRequestHandler)
    server.control_plane_instance_id = "gate-reconciliation-test"
    server.action_store = service.store
    server.action_service = service
    server.verbose = False
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        request = Request(
            f"http://127.0.0.1:{server.server_port}/api/actions/"
            f"{proposal['proposal_id']}/regenerate",
            data=b"{}",
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request) as response:
            payload = json.load(response)
            status = response.status
    finally:
        server.shutdown()
        server.server_close()
        worker.join()

    assert status == 200
    assert payload["proposal"]["proposal_id"] == proposal["proposal_id"]
    _assert_reconciled(payload["proposal"], todo_id=todo_id, decision="approve")


def test_http_list_reconciles_duplicate_proposals_and_leaves_unrelated_gate_open(
    tmp_path: Path,
) -> None:
    service, settled_todo_id = _service_with_gate(tmp_path)
    duplicate_ready = _preview_gate(
        service,
        settled_todo_id,
        decision="approve",
        suffix="duplicate-ready",
    )
    duplicate_gated = _preview_gate(
        service,
        settled_todo_id,
        decision="approve",
        suffix="duplicate-gated",
    )
    _mark_gated(service, duplicate_gated)
    unrelated = add_goal_todo(
        registry_path=service.registry_path,
        goal_id=GOAL_ID,
        role="user",
        text="Approve a separate protected action.",
        task_class="user_gate",
        blocks_agent=AGENT_ID,
        decision_scope="direction:action:separate_action",
    )
    unrelated_proposal = _preview_gate(
        service,
        str(unrelated["todo_id"]),
        decision="approve",
        suffix="unrelated",
    )
    _mark_gated(service, unrelated_proposal)
    _complete_gate(service, settled_todo_id, decision="approve")

    server = ChatHTTPServer(("127.0.0.1", 0), ChatRequestHandler)
    server.action_store = service.store
    server.action_service = service
    server.verbose = False
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        with urlopen(
            f"http://127.0.0.1:{server.server_port}/api/actions"
            f"?goal_id={GOAL_ID}&context_kind=goal"
        ) as response:
            payload = json.load(response)
    finally:
        server.shutdown()
        server.server_close()
        worker.join()

    by_id = {proposal["proposal_id"]: proposal for proposal in payload["proposals"]}
    for proposal in (duplicate_ready, duplicate_gated):
        _assert_reconciled(
            by_id[str(proposal["proposal_id"])],
            todo_id=settled_todo_id,
            decision="approve",
        )
    assert by_id[str(unrelated_proposal["proposal_id"])]["status"] == "gated"
    assert service.store.load(str(unrelated_proposal["proposal_id"]))["status"] == "gated"


def test_reconciled_list_preserves_status_filter_validation(tmp_path: Path) -> None:
    service, _todo_id = _service_with_gate(tmp_path)

    with pytest.raises(ValueError, match="supported typed action state"):
        service.list(status="not-a-state")
