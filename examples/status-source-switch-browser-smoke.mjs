#!/usr/bin/env node
// Regression smoke for local/SSH status-source request ordering.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupBrowserSmoke,
  launchBrowser,
  loadPlaywright,
  startViteDashboardServer,
  waitForHttp,
} from "./dashboard-browser-smoke-support.mjs";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardDir = resolve(repoRoot, "apps/presentation/dashboard");
const outputDir = resolve(repoRoot, "output/playwright/status-source-switch");
const port = Number(process.env.LOOPX_STATUS_SOURCE_SWITCH_PORT ?? "5197");
const packaged = process.env.LOOPX_STATUS_SOURCE_SWITCH_PACKAGED === "1";

function startServer() {
  if (packaged) {
    return spawn(process.env.LOOPX_PYTHON_BIN || "python3", [
      "-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", resolve(repoRoot, "loopx/web"),
    ], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: "ignore",
    });
  }
  return startViteDashboardServer({ dashboardDir, port });
}

function statusPayload(goalId, displayName, { userGate = false } = {}) {
  const payload = structuredClone(require(resolve(repoRoot, "examples/status.example.json")));
  const goal = payload.run_history.goals[0];
  goal.id = goalId;
  goal.display_name = displayName;
  for (const item of payload.attention_queue.items ?? []) {
    item.goal_id = goalId;
    for (const todo of item.agent_todos?.items ?? []) todo.goal_id = goalId;
    for (const todo of item.user_todos?.items ?? []) todo.goal_id = goalId;
    if (userGate) {
      const gate = {
        action_kind: "resolve_managed_chat_gate",
        blocks_agent: "codex",
        bound_agent: "codex",
        done: false,
        goal_id: goalId,
        index: 1,
        role: "user",
        schema_version: "todo_item_v0",
        status: "open",
        task_class: "user_gate",
        text: "Approve the selected workspace and continue the Goal.",
        todo_id: "todo_remote_gate",
        updated_at: "2026-09-07T12:41:15Z",
      };
      item.status = "active_state_user_gate";
      item.waiting_on = "controller";
      item.user_todos = {
        done_count: 0,
        items: [gate],
        open_count: 1,
        source_section: "User Todo / Owner Review Reading Queue",
        total_count: 1,
      };
    }
  }
  return payload;
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveDeferred) => { resolvePromise = resolveDeferred; });
  return { promise, resolve: resolvePromise };
}

async function selectedSourceLabel(select) {
  return select.locator(".personal-select-value").innerText();
}

async function selectSource(page, select, label) {
  await select.click();
  await page.getByRole("listbox", { name: "选择控制面来源" }).getByRole("option", { name: label, exact: true }).click();
}

async function main() {
  const { chromium, webkit } = loadPlaywright();
  const browserType = process.env.LOOPX_BROWSER === "webkit" ? webkit : chromium;
  await mkdir(outputDir, { recursive: true });
  const server = startServer();
  let browser;
  try {
    const appUrl = `http://127.0.0.1:${port}/${packaged ? "chat/" : ""}`;
    await waitForHttp(appUrl);
    browser = process.env.LOOPX_BROWSER === "webkit"
      ? await browserType.launch({ headless: true })
      : await launchBrowser(browserType);
    const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
    const state = {
      ensureGates: new Map(),
      ensureStartedByHost: new Map(),
      statusGates: new Map(),
      statusRequestsByPort: new Map(),
      statusStartedByPort: new Map(),
      localActionRequests: [],
      remoteActionRequests: [],
    };
    const payloads = new Map([
      ["local", statusPayload("local-goal", "Local Goal Only")],
      ["8766", statusPayload("local-goal", "Local Goal Only")],
      ["8876", statusPayload("remote-a-goal", "Remote A Goal Only")],
      ["8976", statusPayload("remote-b-goal", "Remote B Goal Only", { userGate: true })],
      ["9076", statusPayload("crossed-goal", "Wrong Machine Goal")],
    ]);

    await page.addInitScript(() => {
      localStorage.setItem("loopx-status-source-catalog-v1", JSON.stringify({
        schemaVersion: 1,
        sources: [
          { kind: "ssh_tunnel", label: "Remote A", sshHostAlias: "remote-a", statusUrl: "http://127.0.0.1:8876/status.json" },
          { kind: "ssh_tunnel", label: "Remote B", sshHostAlias: "remote-b", statusUrl: "http://127.0.0.1:8976/status.json" },
          {
            kind: "ssh_tunnel",
            label: "Crossed manual source",
            sourceBinding: { machineId: "expected-manual-machine", controlPlaneInstanceId: "expected-manual-instance", schemaVersion: "ssh_source_binding_v2" },
            statusUrl: "http://127.0.0.1:9076/status.json",
          },
        ],
      }));
    });
    await page.route(`http://127.0.0.1:${port}/ssh-hosts`, (route) => route.fulfill({
      contentType: "application/json",
      json: { ok: true, schema_version: "ssh_host_catalog_v0", hosts: [] },
      status: 200,
    }));
    await page.route(`http://127.0.0.1:${port}/api/ssh-source/ensure`, async (route) => {
      const body = route.request().postDataJSON();
      const host = String(body.host_alias ?? "");
      state.ensureStartedByHost.get(host)?.();
      await state.ensureGates.get(host);
      await route.fulfill({
        contentType: "application/json",
        json: {
          ok: true,
          remote_started: true,
          source_binding: {
            machine_id: `${host}-machine`,
            control_plane_instance_id: `${host}-instance`,
            schema_version: "ssh_source_binding_v2",
          },
          status_url: `http://127.0.0.1:${body.local_port}/status.json`,
          tunnel_required: true,
        },
        status: 200,
      });
    });
    const installStatusRoute = async (url, key) => {
      await page.route(`${url}*`, async (route) => {
        state.statusRequestsByPort.set(key, (state.statusRequestsByPort.get(key) ?? 0) + 1);
        state.statusStartedByPort.get(key)?.();
        await state.statusGates.get(key);
        await route.fulfill({ contentType: "application/json", json: payloads.get(key), status: 200 });
      });
    };
    await installStatusRoute(`http://127.0.0.1:${port}/status.json`, "local");
    await installStatusRoute("http://127.0.0.1:8766/status.json", "8766");
    await installStatusRoute("http://127.0.0.1:8876/status.json", "8876");
    await installStatusRoute("http://127.0.0.1:8976/status.json", "8976");
    await installStatusRoute("http://127.0.0.1:9076/status.json", "9076");
    await page.route("http://127.0.0.1:9076/api/chat/capabilities", (route) => route.fulfill({
      contentType: "application/json",
      json: {
        machine_id: "wrong-manual-machine",
        control_plane_instance_id: "wrong-manual-instance",
        ok: true,
        schema_version: "loopx_chat_capabilities_v1",
      },
      status: 200,
    }));
    await page.route("http://127.0.0.1:8876/api/chat/capabilities", (route) => route.fulfill({
      contentType: "application/json",
      json: {
        ok: true,
        schema_version: "loopx_chat_capabilities_v1",
        runtime_identity: {
          schema_version: "loopx_runtime_identity_v1",
          package_version: "0.6.0",
          release_id: "browser-smoke",
          source_revision: "browser-smoke",
        },
        machine_id: "remote-a-machine",
        control_plane_instance_id: "remote-a-instance",
        remote_goal_creation: "preview_locked_instance_bound",
        agent_backend: "multi_adapter",
        sandbox: "read-only",
        approval_policy: "never",
        todo_write: "preview_locked",
        goal_id: null,
        typed_actions: true,
        action_kinds: ["goal.create"],
        adapters: [],
      },
      status: 200,
    }));
    await page.route("http://127.0.0.1:8876/api/actions/**", async (route) => {
      const request = route.request();
      const body = request.postDataJSON();
      state.remoteActionRequests.push({ body, headers: request.headers(), url: request.url() });
      const applying = request.url().endsWith("/apply");
      const proposal = {
        schema_version: "loopx_chat_action_proposal_v1",
        proposal_id: "remote-goal-browser-smoke",
        action_kind: "goal.create",
        summary: body.summary ?? "Create remote Goal",
        normalized_parameters: applying
          ? { goal_id: "remote-browser-goal", title: "远端发布准备" }
          : body.normalized_parameters,
        context: applying ? { kind: "manager" } : body.context,
        expected_state_fingerprint: "sha256:remote-browser-smoke",
        permission_classification: "workspace_write_on_confirmation",
        validation_evidence: [],
        available_transitions: ["apply"],
        status: applying ? "applied" : "preview_ready",
        receipt: applying ? { projection_verified: true } : null,
        stale: null,
        created_at: "2026-09-06T00:00:00Z",
        updated_at: "2026-09-06T00:00:00Z",
      };
      await route.fulfill({ contentType: "application/json", json: { ok: true, proposal }, status: 200 });
    });
    await page.route(`http://127.0.0.1:${port}/api/actions/**`, async (route) => {
      state.localActionRequests.push(route.request().url());
      await route.fulfill({ contentType: "application/json", json: { ok: false, error: "wrong control plane" }, status: 500 });
    });

    await page.goto(appUrl, { waitUntil: "networkidle" });
    await page.getByText("Local Goal Only", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
    if ((state.statusRequestsByPort.get("local") ?? 0) === 0) throw new Error("The bare Dashboard did not request its same-origin /status.json source");
    if ((state.statusRequestsByPort.get("8766") ?? 0) !== 0) throw new Error("The bare Dashboard bypassed the Vite proxy and requested browser-local port 8766");
    const sourceSelect = page.getByRole("combobox", { name: "选择控制面来源" });

    const remoteAStatusGate = deferred();
    const remoteAStatusStarted = deferred();
    state.statusGates.set("8876", remoteAStatusGate.promise);
    state.statusStartedByPort.set("8876", remoteAStatusStarted.resolve);
    await selectSource(page, sourceSelect, "Remote A");
    await remoteAStatusStarted.promise;
    await selectSource(page, sourceSelect, "Remote B");
    await page.getByText("Remote B Goal Only", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
    const remoteAResponse = page.waitForResponse(
      (response) => response.url().startsWith("http://127.0.0.1:8876/status.json"),
    );
    remoteAStatusGate.resolve();
    await remoteAResponse;
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    if (await selectedSourceLabel(sourceSelect) !== "Remote B") throw new Error("A stale status response moved the source selector away from Remote B");
    if (await page.getByText("Remote A Goal Only", { exact: true }).count()) throw new Error("A stale Remote A payload replaced Remote B goals");
    if (!new URL(page.url()).searchParams.get("statusUrl")?.includes("8976")) throw new Error(`The route did not retain Remote B: ${page.url()}`);

    await page.getByText("Remote B Goal Only", { exact: true }).first().click();
    const goalTabs = page.getByRole("navigation", { name: "Goal 视图" });
    await goalTabs.getByRole("button", { name: "Tasks" }).click();
    await page.getByText("Approve the selected workspace and continue the Goal.", { exact: true }).click();
    const remoteGateDrawer = page.getByRole("dialog");
    const remoteGateText = await remoteGateDrawer.innerText();
    const expectedRemoteCommand = "loopx todo complete --goal-id remote-b-goal --todo-id todo_remote_gate --decision-outcome approve --execute";
    if (!remoteGateText.includes(expectedRemoteCommand)) {
      throw new Error(`A read-only SSH gate omitted its executable owner command: ${remoteGateText}`);
    }
    if (!remoteGateText.includes("Remote B")) {
      throw new Error(`A read-only SSH gate omitted its owning source: ${remoteGateText}`);
    }
    await remoteGateDrawer.getByRole("button", { name: /关闭详情/ }).click();

    state.statusGates.delete("8876");
    state.statusRequestsByPort.set("8876", 0);
    const remoteAEnsureGate = deferred();
    const remoteAEnsureStarted = deferred();
    state.ensureGates.set("remote-a", remoteAEnsureGate.promise);
    state.ensureStartedByHost.set("remote-a", remoteAEnsureStarted.resolve);
    await selectSource(page, sourceSelect, "Remote A");
    await remoteAEnsureStarted.promise;
    await selectSource(page, sourceSelect, "本机");
    await page.getByText("Local Goal Only", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
    const remoteAEnsureResponse = page.waitForResponse((response) => response.url().endsWith("/api/ssh-source/ensure"));
    remoteAEnsureGate.resolve();
    await remoteAEnsureResponse;
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    if (await selectedSourceLabel(sourceSelect) !== "本机") throw new Error("A late SSH ensure completion overrode the newer local selection");
    if ((state.statusRequestsByPort.get("8876") ?? 0) !== 0) throw new Error("A superseded SSH selection still started its status request");
    if (await page.getByText("Remote A Goal Only", { exact: true }).count()) throw new Error("A superseded SSH selection replaced local goals");

    await selectSource(page, sourceSelect, "Remote A");
    await page.getByText("Remote A Goal Only", { exact: true }).first().waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("button", { name: "启用远端 Goal 创建" }).click();
    await page.getByText("SSH 隧道 · 可创建 Goal", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByRole("button", { name: "创建 Goal" }).first().click();
    const composer = page.getByRole("textbox", { name: "发送消息" });
    await composer.fill("我想创建一个长期 Goal：\n目标：https://jira.example.test/browse/PROJECT-123\n完成标准：创建 PR\n继续方式：不开启 Heartbeat");
    await composer.press("Control+Enter");
    await page.getByText("确认执行", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    const confirmationCard = page.locator(".personal-confirmation-card");
    await confirmationCard.getByRole("heading", { name: "创建 Goal：PROJECT-123", exact: true }).waitFor({ state: "visible" });
    const confirmationText = await confirmationCard.innerText();
    for (const expected of ["创建 PR", "确认后允许写入", "Codex", "Remote A · 已配置工作区", "未启用", "Goal 完成时"]) {
      if (!confirmationText.includes(expected)) throw new Error(`Goal confirmation omitted ${expected}: ${confirmationText}`);
    }
    for (const forbidden of ["jira.example.test", "workspace_write_on_confirmation", "{\"enabled\"", "goal_complete", "Goal ID"]) {
      if (confirmationText.includes(forbidden)) throw new Error(`Goal confirmation exposed ${forbidden}: ${confirmationText}`);
    }
    if (await page.locator(".personal-proposal-explainer").count()) throw new Error("Goal confirmation repeated its consequence copy");
    if (await confirmationCard.locator("dd").evaluateAll((elements) => elements.some((element) => !(element.textContent ?? "").trim()))) {
      throw new Error(`Goal confirmation rendered an empty decision row: ${confirmationText}`);
    }
    const confirmationOverflow = await confirmationCard.evaluate((element) => element.scrollWidth - element.clientWidth);
    if (confirmationOverflow > 1) throw new Error(`Goal confirmation has ${confirmationOverflow}px horizontal overflow`);
    if (state.remoteActionRequests.length !== 1) throw new Error(`Expected one remote preview before confirmation, received ${state.remoteActionRequests.length}`);
    if (state.remoteActionRequests.at(-1)?.body?.normalized_parameters?.title !== "PROJECT-123") {
      throw new Error(`Issue-key title was not preserved in the remote preview: ${JSON.stringify(state.remoteActionRequests.at(-1)?.body)}`);
    }
    await page.screenshot({ path: resolve(outputDir, "remote-goal-confirmation.png"), fullPage: false, animations: "disabled" });
    await page.setViewportSize({ width: 430, height: 900 });
    const narrowConfirmationOverflow = await confirmationCard.evaluate((element) => element.scrollWidth - element.clientWidth);
    if (narrowConfirmationOverflow > 1) throw new Error(`Narrow Goal confirmation has ${narrowConfirmationOverflow}px horizontal overflow`);
    await page.screenshot({ path: resolve(outputDir, "remote-goal-confirmation-narrow.png"), fullPage: false, animations: "disabled" });
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.getByRole("button", { name: "创建 Goal 并开始首轮" }).click();
    await page.getByText("已完成：创建 Goal：远端发布准备", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    if (state.remoteActionRequests.length !== 2) throw new Error(`Expected remote preview/apply, received ${state.remoteActionRequests.length} requests`);
    if (state.localActionRequests.length !== 0) throw new Error(`Remote Goal creation hit the local control plane: ${state.localActionRequests.join(", ")}`);
    if (!state.remoteActionRequests.every((request) => request.headers["x-loopx-control-plane-instance"] === "remote-a-instance")) {
      throw new Error("Remote Goal creation did not pin the capability-handshake instance");
    }

    const crossedCapabilityResponse = page.waitForResponse(
      (response) => response.url() === "http://127.0.0.1:9076/api/chat/capabilities",
    );
    await selectSource(page, sourceSelect, "Crossed manual source");
    await crossedCapabilityResponse;
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    if ((state.statusRequestsByPort.get("9076") ?? 0) !== 0) {
      throw new Error("Selecting a crossed manual source rebound it to the wrong control plane");
    }
    if (await page.getByText("Wrong Machine Goal", { exact: true }).count()) {
      throw new Error("A crossed manual source rendered the wrong machine");
    }
    await page.screenshot({ path: resolve(outputDir, "local-after-races.png"), fullPage: false, animations: "disabled" });
    console.log(`status source switch browser smoke (${packaged ? "packaged" : "development"}): ok`);
  } finally {
    await cleanupBrowserSmoke({ browser, fixturePaths: [], server });
  }
}

await main();
