#!/usr/bin/env node

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
const outputDir = resolve(repoRoot, "output/playwright/all-machines-overview");
const port = Number(process.env.LOOPX_ALL_MACHINES_PORT ?? "5199");
const appUrl = `http://127.0.0.1:${port}/`;

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveDeferred) => { resolvePromise = resolveDeferred; });
  return { promise, resolve: resolvePromise };
}

function statusPayload(sourceLabel) {
  const payload = structuredClone(require(resolve(repoRoot, "examples/status.example.json")));
  const goal = structuredClone(payload.run_history.goals[0]);
  goal.id = "shared-goal";
  goal.display_name = "Shared Goal";
  goal.activation_state = "active";
  goal.latest_runs = goal.latest_runs.slice(0, 1).map((run) => ({
    ...run,
    goal_id: "shared-goal",
    recommended_action: `Continue on ${sourceLabel}`,
  }));
  const baseQueue = structuredClone(payload.attention_queue.items[0]);
  const userTodo = {
    action_kind: "owner_review",
    done: false,
    goal_id: "shared-goal",
    index: 0,
    role: "user",
    schema_version: "todo_index_item_v0",
    source: "browser_smoke",
    status: "open",
    text: "Review shared Todo",
    title: "Review shared Todo",
    todo_id: "shared-todo",
  };
  const queue = {
    ...baseQueue,
    agent_todos: { ...baseQueue.agent_todos, done_count: 0, items: [], open_count: 0, total_count: 0 },
    goal_id: "shared-goal",
    recommended_action: `Review shared Todo on ${sourceLabel}`,
    user_todos: {
      done_count: 0,
      items: [userTodo],
      open_count: 1,
      source_section: "User Todo",
      total_count: 1,
    },
    waiting_on: "user_or_controller",
  };
  payload.goal_count = 1;
  payload.run_history.goal_count = 1;
  payload.run_history.goals = [goal];
  payload.attention_queue.item_count = 1;
  payload.attention_queue.items = [queue];
  payload.attention_queue.needs_user_or_controller = 1;
  payload.todo_index = {
    ...payload.todo_index,
    items: [userTodo],
  };
  payload.workspace_registry_revision = "browser-revision-1";
  return payload;
}

function directory() {
  return {
    goals: [{
      activation_state: "active",
      display_name: "Shared Goal",
      id: "shared-goal",
      registry_member: true,
    }],
    ok: true,
    registry_revision: "browser-revision-1",
    schema_version: "loopx_workspace_directory_v1",
  };
}

async function selectSource(page, label) {
  const select = page.getByRole("combobox", { name: "Select control plane source" });
  await select.click();
  await page.getByRole("listbox", { name: "Select control plane source" })
    .getByRole("option", { name: label, exact: true }).click();
}

async function main() {
  const { chromium } = loadPlaywright();
  await mkdir(outputDir, { recursive: true });
  const server = startViteDashboardServer({ dashboardDir, port });
  let browser;
  try {
    await waitForHttp(appUrl);
    browser = await launchBrowser(chromium);
    const page = await browser.newPage({ viewport: { height: 982, width: 1512 } });
    const payloads = new Map([
      ["local", statusPayload("This machine")],
      ["remote-a", statusPayload("Remote A")],
    ]);
    const requestLedger = [];
    let localExactGate = null;
    let localExactStarted = null;
    let ensureRequestCount = 0;

    await page.addInitScript(() => {
      localStorage.setItem("loopx-pw-locale", "en");
      localStorage.setItem("loopx-status-source-catalog-v1", JSON.stringify({
        schemaVersion: 1,
        sources: [
          { kind: "ssh_tunnel", label: "Remote A", statusUrl: "http://127.0.0.1:8876/status.json" },
          { kind: "ssh_tunnel", label: "Remote B", statusUrl: "http://127.0.0.1:8976/status.json" },
        ],
      }));
    });
    await page.route(`${appUrl}ssh-hosts`, (route) => route.fulfill({
      contentType: "application/json",
      json: { hosts: [], ok: true, schema_version: "ssh_host_catalog_v0" },
      status: 200,
    }));
    await page.route(`${appUrl}api/ssh-source/ensure`, (route) => {
      ensureRequestCount += 1;
      return route.fulfill({ contentType: "application/json", json: { ok: true }, status: 200 });
    });

    async function serveStatus(route, sourceId) {
      requestLedger.push({ method: route.request().method(), sourceId, url: route.request().url() });
      if (sourceId === "remote-b") {
        await route.fulfill({ contentType: "application/json", json: { ok: false }, status: 503 });
        return;
      }
      const url = new URL(route.request().url());
      if (url.searchParams.get("view") === "workspace-directory") {
        await route.fulfill({ contentType: "application/json", json: directory(), status: 200 });
        return;
      }
      if (url.searchParams.get("goal_id") === "shared-goal" && sourceId === "local" && localExactGate) {
        localExactStarted?.resolve();
        await localExactGate.promise;
      }
      await route.fulfill({ contentType: "application/json", json: payloads.get(sourceId), status: 200 });
    }

    await page.route(`${appUrl}status.json*`, (route) => serveStatus(route, "local"));
    await page.route("http://127.0.0.1:8876/status.json*", (route) => serveStatus(route, "remote-a"));
    await page.route("http://127.0.0.1:8976/status.json*", (route) => serveStatus(route, "remote-b"));

    await page.goto(`${appUrl}?view=all-machines`, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "All machines", exact: true }).waitFor();
    await page.locator(".all-machines-health-row").filter({ hasText: "Remote B" })
      .locator("text=Unavailable").waitFor();
    const sharedRows = page.locator(".all-machines-goal-row").filter({ hasText: "Shared Goal" });
    if (await sharedRows.count() !== 2) throw new Error("Same-id Goals on two machines were deduplicated");
    if (await sharedRows.filter({ hasText: "本机" }).count() !== 1) throw new Error("The local Goal lost its source namespace");
    if (await sharedRows.filter({ hasText: "Remote A" }).count() !== 1) throw new Error("The remote Goal lost its source namespace");
    if (await page.getByRole("button", { name: "Create Goal" }).count()) throw new Error("All machines exposed a write affordance");
    if (requestLedger.some((request) => request.method !== "GET")) throw new Error("All machines issued a non-GET status request");
    if (ensureRequestCount) throw new Error("All machines implicitly started an SSH tunnel");
    await page.screenshot({ path: resolve(outputDir, "desktop-first-screen.png"), fullPage: false, animations: "disabled" });

    localExactGate = deferred();
    localExactStarted = deferred();
    await sharedRows.filter({ hasText: "本机" }).click();
    await localExactStarted.promise;
    if (new URL(page.url()).searchParams.get("view") !== "all-machines") {
      throw new Error("Local Goal navigation left All machines before exact revalidation");
    }
    localExactGate.resolve();
    await page.waitForURL((url) => url.searchParams.get("view") === "machine" && url.searchParams.get("goalId") === "shared-goal");
    await page.getByRole("button", { name: "Create Goal" }).waitFor();

    await selectSource(page, "All machines");
    await page.getByRole("heading", { name: "All machines", exact: true }).waitFor();
    await page.locator(".all-machines-goal-row").filter({ hasText: "Shared Goal" }).first().waitFor();

    localExactGate = deferred();
    localExactStarted = deferred();
    await page.locator(".all-machines-goal-row").filter({ hasText: "本机" }).click();
    await localExactStarted.promise;
    await page.locator(".all-machines-goal-row").filter({ hasText: "Remote A" }).click();
    await page.waitForURL((url) => url.searchParams.get("view") === "machine" && url.searchParams.get("statusUrl")?.includes("8876"));
    await page.locator(".personal-read-only-source").filter({ hasText: "Remote A" }).waitFor();
    localExactGate.resolve();
    await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    if (!new URL(page.url()).searchParams.get("statusUrl")?.includes("8876")) {
      throw new Error("A stale local revalidation restored write authority over Remote A");
    }
    if (await page.getByRole("button", { name: "Create Goal" }).count()) {
      throw new Error("A remote machine exposed the local write affordance");
    }
    if (ensureRequestCount) throw new Error("Opening a remote Goal implicitly started an SSH tunnel");

    await selectSource(page, "All machines");
    await page.getByRole("heading", { name: "All machines", exact: true }).waitFor();
    await page.setViewportSize({ height: 844, width: 390 });
    await page.screenshot({ path: resolve(outputDir, "mobile-first-screen.png"), fullPage: false, animations: "disabled" });
    console.log(`all-machines-overview-browser-smoke: ok\npreview=${appUrl}?view=all-machines\nscreenshots=${outputDir}`);
  } finally {
    await cleanupBrowserSmoke({ browser, fixturePaths: [], server });
  }
}

await main();
