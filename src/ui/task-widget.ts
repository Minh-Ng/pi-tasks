/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Display style matches Claude Code's task list:
 *   ✔ completed tasks (strikethrough + dim)
 *   ◼ in_progress tasks
 *   ◻ pending tasks
 *   ✳/✽ foreground execution (star spinner with activeForm text)
 *   ◐/◓/◑/◒ background execution (distinct spinner and label)
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { TaskSortCache } from "../task-sort.js";
import type { TaskStore } from "../task-store.js";
import type { TasksConfig } from "../tasks-config.js";

// ---- Truncation ----

import type { Task, TaskExecutionMode } from "../types.js";

function truncateFromTop(tasks: Task[], limit: number): Task[] {
  return tasks.slice(-limit);
}

function truncateFromBottom(tasks: Task[], limit: number): Task[] {
  return tasks.slice(0, limit);
}

const TRUNCATE_FNS = { top: truncateFromTop, bottom: truncateFromBottom };

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Foreground and background work deliberately use different animation vocabularies. */
const FOREGROUND_SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const BACKGROUND_SPINNER = ["◐", "◓", "◑", "◒"];

const DEFAULT_MAX_VISIBLE_TASKS = 10;

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

/** Format milliseconds as a human-readable duration (e.g., "2m 49s", "1h 3m"). */
function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

/** Format token count with k suffix (e.g., "4.1k", "850"). */
function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}

function boundedProgressLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > 48 ? `${normalized.slice(0, 47)}…` : normalized;
}

function nonnegativeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Render only the bounded, documented metadata.progress contract. */
export function formatTaskProgress(metadata: Record<string, any> | undefined, now = Date.now()): string | undefined {
  const value = metadata?.progress;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const progress = value as Record<string, unknown>;
  const parts: string[] = [];
  const phase = boundedProgressLabel(progress.phase);
  const operation = boundedProgressLabel(progress.currentOperation);
  if (phase) parts.push(phase);
  if (operation && operation !== phase) parts.push(operation);

  const operations = progress.operations && typeof progress.operations === "object" && !Array.isArray(progress.operations)
    ? progress.operations as Record<string, unknown>
    : undefined;
  const completed = nonnegativeCount(progress.completed) ?? nonnegativeCount(operations?.completed);
  const total = nonnegativeCount(progress.total) ?? nonnegativeCount(progress.cardsTotal);
  const seen = nonnegativeCount(progress.seen) ?? nonnegativeCount(operations?.seen);
  if (completed !== undefined && total !== undefined && total > 0) parts.push(`${completed}/${total}`);
  else if (completed !== undefined && seen !== undefined && seen > 0) parts.push(`${completed}/${seen} ops`);

  const activityValue = progress.lastActivityAt;
  const activityMs = typeof activityValue === "number" ? activityValue : typeof activityValue === "string" ? Date.parse(activityValue) : Number.NaN;
  if (Number.isFinite(activityMs) && activityMs <= now) {
    const age = now - activityMs;
    parts.push(age >= 120_000 ? `stalled ${formatDuration(age)}` : `active ${formatDuration(age)} ago`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Live execution leases owned by this extension runtime. Persisted task state alone is never proof of live work. */
  private liveExecutions = new Map<string, TaskExecutionMode>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Cached task ordering, kept separate from store persistence and mutation concerns. */
  private taskSort = new TaskSortCache();
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;

  constructor(
    private store: TaskStore,
    private config: TasksConfig = {},
  ) {}

  setStore(store: TaskStore) {
    this.store = store;
    this.taskSort.clear();
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Start or stop a live execution lease. In-progress status by itself does not start a timer. */
  setActiveTask(taskId: string | undefined, active = true, mode?: TaskExecutionMode, restart = false) {
    if (taskId && active) {
      const task = this.store.get(taskId);
      const executionMode = mode ?? task?.executionMode ?? (task?.metadata?.agentId ? "background" : "foreground");
      const previousMode = this.liveExecutions.get(taskId);
      this.liveExecutions.set(taskId, executionMode);
      if (!this.metrics.has(taskId) || previousMode !== executionMode || restart) {
        this.metrics.set(taskId, {
          startedAt: task?.executionStartedAt ?? Date.now(),
          inputTokens: 0,
          outputTokens: 0,
        });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.liveExecutions.delete(taskId);
      this.metrics.delete(taskId);
    }
    this.update();
  }

  /** Return the current runtime's execution lease, if any. */
  getExecutionState(taskId: string): { mode?: TaskExecutionMode; live: boolean } {
    const liveMode = this.liveExecutions.get(taskId);
    if (liveMode) return { mode: liveMode, live: true };
    const task = this.store.get(taskId);
    return { mode: task?.executionMode ?? (task?.metadata?.agentId ? "background" : undefined), live: false };
  }

  /** Record token usage for currently live executions only. */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    for (const id of this.liveExecutions.keys()) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 150);
    }
  }

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const sortOrder = this.config.sortOrder ?? "id";
    const sortDirection = this.config.sortDirection ?? "ascending";
    const tasks = this.taskSort.sort(this.store.snapshot(), sortOrder, sortDirection);
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    const completed = tasks.filter(t => t.status === "completed");
    const inProgress = tasks.filter(t => t.status === "in_progress");
    const pending = tasks.filter(t => t.status === "pending");
    const foregroundCount = inProgress.filter(t => this.liveExecutions.get(t.id) === "foreground").length;
    const backgroundCount = inProgress.filter(t => this.liveExecutions.get(t.id) === "background").length;
    const claimedCount = inProgress.length - foregroundCount - backgroundCount;

    const parts: string[] = [];
    if (completed.length > 0) parts.push(`${completed.length} done`);
    if (foregroundCount > 0) parts.push(`${foregroundCount} foreground`);
    if (backgroundCount > 0) parts.push(`${backgroundCount} background`);
    if (claimedCount > 0) parts.push(`${claimedCount} claimed`);
    if (pending.length > 0) parts.push(`${pending.length} open`);
    const statusText = `${tasks.length} tasks (${parts.join(", ")})`;
    const lines: string[] = [truncate(theme.fg("accent", "●") + " " + theme.fg("accent", statusText))];

    const showAll = this.config.showAll ?? false;
    const limit = this.config.maxVisible ?? DEFAULT_MAX_VISIBLE_TASKS;
    const hiddenAt = this.config.hiddenAt ?? "bottom";
    const visible = showAll ? tasks : TRUNCATE_FNS[hiddenAt](tasks, limit);

    const hiddenCount = tasks.length - visible.length;
    const overflowLine = hiddenCount > 0
      ? truncate(theme.fg("dim", `    … and ${hiddenCount} more`))
      : undefined;

    if (overflowLine && hiddenAt === "top") {
      lines.push(overflowLine);
    }
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const liveMode = task.status === "in_progress" ? this.liveExecutions.get(task.id) : undefined;

      let icon: string;
      if (liveMode === "foreground") {
        icon = theme.fg("accent", FOREGROUND_SPINNER[this.widgetFrame % FOREGROUND_SPINNER.length]);
      } else if (liveMode === "background") {
        icon = theme.fg("accent", BACKGROUND_SPINNER[this.widgetFrame % BACKGROUND_SPINNER.length]);
      } else if (task.status === "completed") {
        icon = theme.fg("success", "✔");
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", "◼");
      } else {
        icon = "◻";
      }

      let suffix = "";
      if (task.status === "pending" && task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = this.store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          suffix = theme.fg("dim", ` › blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }

      let text: string;
      if (liveMode) {
        const form = task.activeForm || task.subject;
        const executionOwner = task.owner ?? (task.metadata?.agentId ? `agent ${task.metadata.agentId.slice(0, 5)}` : undefined);
        const owner = executionOwner ? `: ${executionOwner}` : "";
        const modeLabel = theme.fg("dim", `[${liveMode}${owner}]`);
        const progress = liveMode === "background" ? formatTaskProgress(task.metadata) : undefined;
        const progressLabel = progress ? ` ${theme.fg("dim", `‹ ${progress}`)}` : "";
        const m = this.metrics.get(task.id);
        let stats = "";
        if (m) {
          const elapsed = formatDuration(Date.now() - m.startedAt);
          const tokenParts: string[] = [];
          if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} · ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + "…")} ${modeLabel}${progressLabel}${stats}`;
      } else if (task.status === "completed") {
        text = `  ${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else if (task.status === "in_progress") {
        const declaredMode = task.executionMode ?? (task.metadata?.agentId ? "background" : undefined);
        const executionOwner = task.owner ?? (task.metadata?.agentId ? `agent ${task.metadata.agentId.slice(0, 5)}` : undefined);
        const stateLabel = declaredMode
          ? `[${declaredMode} · unmonitored${executionOwner ? ` · ${executionOwner}` : ""}]`
          : "[claimed · no live execution]";
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject} ${theme.fg("dim", stateLabel)}`;
      } else {
        text = `  ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (overflowLine && hiddenAt !== "top") {
      lines.push(overflowLine);
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.snapshot();

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Prune stale live leases (deleted, no longer in progress, or mode changed externally).
    for (const [id, mode] of this.liveExecutions) {
      const task = this.store.get(id);
      if (!task || task.status !== "in_progress" || (task.executionMode !== undefined && task.executionMode !== mode)) {
        this.liveExecutions.delete(id);
        this.metrics.delete(id);
      }
    }

    // Only a live runtime lease animates and advances a timer.
    const hasActiveSpinner = tasks.some(task => this.liveExecutions.has(task.id) && task.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.liveExecutions.clear();
    this.metrics.clear();
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
