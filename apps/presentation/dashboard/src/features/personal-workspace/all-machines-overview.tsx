import { Activity, AlertTriangle, CircleCheck, Clock3, RefreshCw, ServerOff } from "lucide-react";

import type {
  AllMachinesMachine,
  AllMachinesOverview,
  MachineGoalRef,
  MachineHealthState,
} from "./all-machines-model";
import { GoalSidebar } from "./goal-sidebar";
import { localizedGoalState, useWorkspaceI18n } from "./i18n";
import type { StatusSourceControl } from "./status-source-switcher";
import { WorkspaceShell } from "./workspace-shell";
import type { WorkspaceTheme } from "./workspace-theme";

const healthIcon: Record<MachineHealthState, typeof Activity> = {
  degraded: AlertTriangle,
  healthy: CircleCheck,
  loading: RefreshCw,
  stale: Clock3,
  unavailable: ServerOff,
};

function observationLabel(value: number | null, locale: string, now: number) {
  if (value === null) return null;
  const elapsedSeconds = Math.max(0, Math.round((now - value) / 1_000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (elapsedSeconds < 60) return formatter.format(-elapsedSeconds, "second");
  return formatter.format(-Math.round(elapsedSeconds / 60), "minute");
}

function MachineHealthRow({ machine, now }: { machine: AllMachinesMachine; now: number }) {
  const { locale, t } = useWorkspaceI18n();
  const Icon = healthIcon[machine.health];
  const observed = observationLabel(machine.lastSuccessAt, locale, now);
  return (
    <article className="all-machines-health-row" data-health={machine.health}>
      <span className="all-machines-health-icon"><Icon aria-hidden="true" className={machine.health === "loading" ? "is-spinning" : undefined} size={16} /></span>
      <div>
        <strong>{machine.ref.sourceLabel}</strong>
        <small>{t(`allMachines.health.${machine.health}`)}</small>
      </div>
      <span>{t("allMachines.goalCount", { count: machine.activeGoalCount })}</span>
      <span>{t("allMachines.todoCount", { count: machine.openTodoCount })}</span>
      <time dateTime={machine.lastSuccessAt ? new Date(machine.lastSuccessAt).toISOString() : undefined} title={machine.lastSuccessAt ? new Date(machine.lastSuccessAt).toLocaleString(locale) : undefined}>
        {observed ?? t("allMachines.neverObserved")}
      </time>
    </article>
  );
}

export function AllMachinesOverviewPage({
  error,
  now,
  onOpenMachineGoal,
  onRefresh,
  overview,
  refreshing,
  statusSourceControl,
  theme,
}: {
  error?: string | null;
  now: number;
  onOpenMachineGoal: (ref: MachineGoalRef) => void;
  onRefresh: () => void;
  overview: AllMachinesOverview;
  refreshing: boolean;
  statusSourceControl: StatusSourceControl;
  theme: WorkspaceTheme;
}) {
  const { locale, t } = useWorkspaceI18n();
  return (
    <WorkspaceShell
      drawerOpen={false}
      main={<div className="personal-channel"><main aria-labelledby="all-machines-title" className="all-machines-overview">
        <header className="all-machines-header">
          <div>
            <span className="all-machines-eyebrow">{t("allMachines.eyebrow")}</span>
            <h1 id="all-machines-title">{t("allMachines.title")}</h1>
            <p>{t("allMachines.readOnlyDescription")}</p>
          </div>
          <button aria-busy={refreshing || undefined} disabled={refreshing} onClick={onRefresh} type="button">
            <RefreshCw aria-hidden="true" className={refreshing ? "is-spinning" : undefined} size={15} />
            {refreshing ? t("allMachines.refreshing") : t("allMachines.refresh")}
          </button>
        </header>

        {error ? <p className="all-machines-error" role="alert">{error}</p> : null}

        <section aria-label={t("allMachines.summary")} className="all-machines-summary">
          <span><strong>{overview.totals.machineCount}</strong>{t("allMachines.machines")}</span>
          <span><strong>{overview.totals.healthyMachineCount}</strong>{t("allMachines.healthyMachines")}</span>
          <span><strong>{overview.totals.ongoingGoalCount}</strong>{t("allMachines.ongoingGoals")}</span>
          <span><strong>{overview.totals.openTodoCount}</strong>{t("allMachines.openTodos")}</span>
        </section>

        <section className="all-machines-section">
          <header><div><h2>{t("allMachines.machineHealth")}</h2><p>{t("allMachines.machineHealthDescription")}</p></div></header>
          <div className="all-machines-health-list">
            {overview.machines.map((machine) => <MachineHealthRow key={machine.ref.sourceId} machine={machine} now={now} />)}
          </div>
        </section>

        <section className="all-machines-section">
          <header><div><h2>{t("allMachines.ongoingWork")}</h2><p>{t("allMachines.ongoingWorkDescription")}</p></div></header>
          <div aria-label={t("allMachines.ongoingWork")} className="all-machines-goal-table" role="table">
            <div className="all-machines-goal-head" role="row">
              <span role="columnheader">{t("allMachines.source")}</span>
              <span role="columnheader">{t("common.goal")}</span>
              <span role="columnheader">{t("common.status")}</span>
              <span role="columnheader">{t("allMachines.openTodos")}</span>
              <span role="columnheader">{t("allMachines.activity")}</span>
            </div>
            {overview.goals.length ? overview.goals.map((row) => (
              <button
                aria-label={t("allMachines.openGoalOnSource", { goal: row.goal.title, source: row.ref.sourceLabel })}
                className="all-machines-goal-row"
                key={row.key}
                onClick={() => onOpenMachineGoal(row.ref)}
                role="row"
                type="button"
              >
                <span className="all-machines-source" role="cell">{row.ref.sourceLabel}</span>
                <span role="cell"><strong>{row.goal.title}</strong><small>{row.topTodo?.text ?? row.goal.nextSentence}</small></span>
                <span role="cell">{localizedGoalState(row.goal.state, locale)}</span>
                <span role="cell">{row.openTodoCount}</span>
                <span role="cell">{row.goal.latestActivity ? new Date(row.goal.latestActivity).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : t("home.noActivity")}</span>
              </button>
            )) : <p className="all-machines-empty">{t("allMachines.empty")}</p>}
          </div>
        </section>
      </main></div>}
      sidebar={<GoalSidebar
        attentionCount={overview.totals.openTodoCount}
        goals={[]}
        onSelectGoal={() => undefined}
        selectedGoalId={null}
        statusSourceControl={statusSourceControl}
      />}
      theme={theme}
    />
  );
}
