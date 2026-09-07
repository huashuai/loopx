#!/usr/bin/env python3
"""Smoke-test durable resume, idempotency, and interruption in Chat runtime."""

from __future__ import annotations

import json
import stat
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from loopx.chat_runtime import ChatRuntimeController  # noqa: E402
from loopx.chat_store import ChatSessionStore  # noqa: E402


FAKE_CODEX = r'''#!/usr/bin/env python3
import json
import sys
import time

active_turn = None
turn_count = 0
assert "goals" not in sys.argv, sys.argv
for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    request_id = request.get("id")
    if method == "initialized":
        continue
    if method == "initialize":
        result = {"serverInfo": {"name": "fake-runtime-codex"}}
    elif method in {"thread/start", "thread/resume"}:
        result = {"thread": {"id": "durable-thread"}}
    elif method in {"thread/goal/set", "thread/goal/get"}:
        print(json.dumps({
            "id": request_id,
            "error": {"code": -32601, "message": "Goal mode must not be used for Chat"},
        }), flush=True)
        continue
    elif method == "turn/start":
        turn_count += 1
        active_turn = f"durable-turn-{turn_count}"
        print(json.dumps({"method": "turn/started", "params": {"threadId": "durable-thread", "turn": {"id": active_turn}}}), flush=True)
        print(json.dumps({"id": request_id, "result": {"turn": {"id": active_turn, "status": "running"}}}), flush=True)
        if "wait for interrupt" in json.dumps(request.get("params") or {}) or "wait for steer" in json.dumps(request.get("params") or {}):
            continue
        response = 'Visible runtime response.\n<loopx-review-json>' + json.dumps({
            "schema_version": "loopx_chat_agent_response_v0",
            "message": "Runtime response.",
            "proposals": [],
            "gate": None,
        }) + '</loopx-review-json>'
        print(json.dumps({"method": "item/agentMessage/delta", "params": {"threadId": "durable-thread", "turnId": active_turn, "delta": response}}), flush=True)
        print(json.dumps({"method": "turn/completed", "params": {"threadId": "durable-thread", "turn": {"id": active_turn}}}), flush=True)
        continue
    elif method == "turn/steer":
        assert request["params"]["expectedTurnId"] == active_turn, request
        print(json.dumps({"id": request_id, "result": {"turnId": active_turn}}), flush=True)
        response = 'Visible steered response.\n<loopx-review-json>' + json.dumps({
            "schema_version": "loopx_chat_agent_response_v0",
            "message": "Steered response.",
            "proposals": [],
            "gate": None,
        }) + '</loopx-review-json>'
        print(json.dumps({"method": "item/agentMessage/delta", "params": {"threadId": "durable-thread", "turnId": active_turn, "delta": response}}), flush=True)
        print(json.dumps({"method": "turn/completed", "params": {"threadId": "durable-thread", "turn": {"id": active_turn}}}), flush=True)
        continue
    elif method == "turn/interrupt":
        interrupted_turn = active_turn
        result = {}
        print(json.dumps({"id": request_id, "result": result}), flush=True)
        time.sleep(0.15)
        if interrupted_turn:
            print(json.dumps({"method": "turn/completed", "params": {"threadId": "durable-thread", "turn": {"id": interrupted_turn, "status": "interrupted"}}}), flush=True)
        continue
    else:
        result = {}
    print(json.dumps({"id": request_id, "result": result}), flush=True)
'''


def wait_for_active_turn(
    store: ChatSessionStore,
    *,
    session_id: str,
    turn_id: str,
    require_upstream: bool = False,
) -> dict[str, object]:
    deadline = time.monotonic() + 5
    current: dict[str, object] | None = None
    while time.monotonic() < deadline:
        current = store.load_turn(session_id, turn_id)
        if current and current.get("status") == "running":
            if not require_upstream or current.get("upstream_turn_id"):
                return current
        time.sleep(0.02)
    raise AssertionError(f"turn did not become active: {current}")


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="loopx-chat-runtime-") as raw_tmp:
        root = Path(raw_tmp)
        fake = root / "codex"
        fake.write_text(FAKE_CODEX, encoding="utf-8")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        store = ChatSessionStore(root / "runtime")
        first = ChatRuntimeController(store=store, codex_bin=str(fake))
        def open_goal_session() -> tuple[dict[str, object], bool]:
            return first.open_session(
                goal_id="durable-goal",
                agent_id="codex",
                work_dir=root,
                objective="Keep the thread durable.",
                mode="resume_latest",
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            opened = list(executor.map(lambda _: open_goal_session(), range(2)))
        assert sorted(resumed for _, resumed in opened) == [False, True], opened
        assert len({str(item[0]["session_id"]) for item in opened}) == 1, opened
        session, resumed = opened[0]
        session_id = session["session_id"]
        manager_one, manager_resumed = first.open_session(
            goal_id="durable-goal",
            agent_id="codex",
            work_dir=root,
            objective="Manage all Goals read-only.",
            mode="resume_latest",
            channel_id="manager",
            agent_goal_id="loopx-manager",
        )
        assert manager_resumed is False, manager_one
        manager_two, manager_resumed = first.open_session(
            goal_id="another-goal",
            agent_id="codex",
            work_dir=root,
            objective="Manage all Goals read-only.",
            mode="resume_latest",
            channel_id="manager",
            agent_goal_id="loopx-manager",
        )
        assert manager_resumed is True, manager_two
        assert manager_two["session_id"] == manager_one["session_id"], manager_two
        turn, created = first.submit_turn(
            session_id=session_id,
            client_turn_id="durable-client-turn",
            message="complete normally",
            work_dir=root,
            objective="Keep the thread durable.",
        )
        assert created is True
        completed = first.wait_for_turn(session_id=session_id, turn_id=turn["turn_id"], timeout_sec=3)
        assert completed["status"] == "completed", completed
        execution_session, resumed = first.open_session(
            goal_id="durable-goal",
            agent_id="codex",
            work_dir=root,
            objective="Create one bounded artifact.",
            mode="resume_latest",
            channel_id="task.todo-managed-start",
        )
        assert resumed is False, execution_session
        execution_turn, created = first.submit_turn(
            session_id=execution_session["session_id"],
            client_turn_id="managed-goal-start-turn",
            message="complete normally",
            work_dir=root,
            objective="Create one bounded artifact.",
        )
        assert created is True
        execution_turn = first.wait_for_turn(
            session_id=execution_session["session_id"],
            turn_id=execution_turn["turn_id"],
            timeout_sec=3,
        )
        assert execution_turn["status"] == "completed", execution_turn
        run_index = store.root.parent / "goals" / "durable-goal" / "runs" / "index.jsonl"
        assert run_index.exists(), run_index
        run_rows = [json.loads(line) for line in run_index.read_text(encoding="utf-8").splitlines()]
        assert len(run_rows) == 1, run_rows
        managed_turn = run_rows[0]["managed_chat_turn"]
        assert managed_turn["schema_version"] == "managed_chat_turn_projection_v0"
        assert managed_turn["session_id"] == execution_session["session_id"]
        assert managed_turn["turn_id"] == execution_turn["turn_id"]
        assert managed_turn["todo_id"] == "todo-managed-start"
        assert managed_turn["status"] == "completed"
        assert managed_turn["outcome_claimed"] is False
        assert managed_turn["raw_response_recorded"] is False
        run_record = Path(run_rows[0]["json_path"]).read_text(encoding="utf-8")
        assert "Runtime response." not in run_record, run_record
        first.close()

        second = ChatRuntimeController(store=store, codex_bin=str(fake))
        restored, resumed = second.open_session(
            goal_id="durable-goal",
            agent_id="codex",
            work_dir=root,
            objective="Keep the thread durable.",
            mode="resume_latest",
        )
        assert resumed is True and restored["session_id"] == session_id, restored
        slow, created = second.submit_turn(
            session_id=session_id,
            client_turn_id="interrupt-client-turn",
            message="wait for interrupt",
            work_dir=root,
            objective="Keep the thread durable.",
        )
        assert created is True
        wait_for_active_turn(
            store,
            session_id=session_id,
            turn_id=slow["turn_id"],
        )
        interrupted = second.interrupt_turn(session_id=session_id, turn_id=slow["turn_id"])
        assert interrupted["status"] == "interrupted", interrupted
        assert second.turn_event_buffers == {}, second.turn_event_buffers
        time.sleep(0.1)
        assert store.load_turn(session_id, slow["turn_id"])["status"] == "interrupted"
        assert store.load_session(session_id)["status"] == "ready"
        assert store.messages(session_id)[-1]["text"] == "已中断。你可以在当前会话继续发送消息。"
        continued, created = second.submit_turn(
            session_id=session_id,
            client_turn_id="continue-after-interrupt",
            message="complete normally after interrupt",
            work_dir=root,
            objective="Keep the thread durable.",
        )
        assert created is True
        continued = second.wait_for_turn(
            session_id=session_id,
            turn_id=continued["turn_id"],
            timeout_sec=3,
        )
        assert continued["status"] == "completed", continued

        steering_turn, created = second.submit_turn(
            session_id=session_id,
            client_turn_id="active-steering-turn",
            message="wait for steer",
            work_dir=root,
            objective="Keep the thread durable.",
        )
        assert created is True
        wait_for_active_turn(
            store,
            session_id=session_id,
            turn_id=steering_turn["turn_id"],
            require_upstream=True,
        )
        steered, delivered = second.steer_active_turn(
            session_id=session_id,
            client_ingress_id="lark-steer-one",
            message="steer this active turn",
        )
        assert delivered is True and steered["turn_id"] == steering_turn["turn_id"], steered
        steered = second.wait_for_turn(
            session_id=session_id,
            turn_id=steering_turn["turn_id"],
            timeout_sec=3,
        )
        assert steered["response"]["message"] == "Steered response.", steered
        duplicate, delivered = second.steer_active_turn(
            session_id=session_id,
            client_ingress_id="lark-steer-one",
            message="steer this active turn",
        )
        assert delivered is False and duplicate["turn_id"] == steering_turn["turn_id"]

        blocking, created = second.submit_turn(
            session_id=session_id,
            client_turn_id="queue-blocking-turn",
            message="wait for interrupt",
            work_dir=root,
            objective="Keep the thread durable.",
        )
        assert created is True
        queued_one, created = second.enqueue_turn(
            session_id=session_id,
            client_turn_id="lark-queue-one",
            message="queued one",
            work_dir=root,
            objective="Keep the thread durable.",
        )
        assert created is True and queued_one["status"] == "queued"
        queued_two, created = second.enqueue_turn(
            session_id=session_id,
            client_turn_id="lark-queue-two",
            message="queued two",
            work_dir=root,
            objective="Keep the thread durable.",
        )
        assert created is True and queued_two["status"] == "queued"
        second.interrupt_turn(session_id=session_id, turn_id=blocking["turn_id"])
        first_queued = second.wait_for_turn(
            session_id=session_id,
            turn_id=queued_one["turn_id"],
            timeout_sec=3,
        )
        second_queued = second.wait_for_turn(
            session_id=session_id,
            turn_id=queued_two["turn_id"],
            timeout_sec=3,
        )
        assert first_queued["status"] == "completed", first_queued
        assert second_queued["status"] == "completed", second_queued
        queue_messages = [
            item["text"]
            for item in store.messages(session_id)
            if item.get("turn_id") in {queued_one["turn_id"], queued_two["turn_id"]}
            and item.get("role") == "user"
        ]
        assert queue_messages == ["queued one", "queued two"], queue_messages
        second.close()

    print("loopx-chat-runtime-smoke: ok")


if __name__ == "__main__":
    main()
