/**
 * settings-menu.ts — Polished settings panel for /tasks → Settings.
 *
 * Uses ui.custom() + SettingsList for native TUI rendering with keyboard
 * navigation, live toggle, and per-row descriptions — matching pi-coding-agent's
 * own settings panel style.
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import {
  normalizeTaskSort,
  resolveTaskSort,
  SORT_SCHEMA_VERSION,
  type TaskSortDirection,
  type TaskSortRule,
} from "../task-sort.js";
import { saveTasksConfig, type TasksConfig } from "../tasks-config.js";
import type { TaskStatus } from "../types.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SettingsUI = {
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

// ── Settings panel ──────────────────────────────────────────────────────────

const STATUS_ORDER_OPTIONS: Record<string, TaskStatus[]> = {
  "completed → active → pending": ["completed", "in_progress", "pending"],
  "completed → pending → active": ["completed", "pending", "in_progress"],
  "active → completed → pending": ["in_progress", "completed", "pending"],
  "active → pending → completed": ["in_progress", "pending", "completed"],
  "pending → completed → active": ["pending", "completed", "in_progress"],
  "pending → active → completed": ["pending", "in_progress", "completed"],
};

function statusOrderLabel(order: readonly TaskStatus[]): string {
  return Object.entries(STATUS_ORDER_OPTIONS).find(([, candidate]) =>
    candidate.every((status, index) => status === order[index])
  )?.[0] ?? "completed → active → pending";
}

/** Materialize any older format as versioned rules when an interactive sort setting changes. */
export function updateTaskSortSetting(cfg: TasksConfig, id: string, newValue: string): boolean {
  if (id !== "sortBy" && id !== "sortDirection" && id !== "statusOrder") return false;
  if (id === "sortBy" && newValue !== "created" && newValue !== "updated" && newValue !== "status") return false;
  if (id === "sortDirection" && newValue !== "asc" && newValue !== "desc") return false;
  const selectedStatusOrder = id === "statusOrder" ? STATUS_ORDER_OPTIONS[newValue] : undefined;
  if (id === "statusOrder" && !selectedStatusOrder) return false;

  const normalized = normalizeTaskSort(cfg);
  const resolved = resolveTaskSort(cfg);
  const direction: TaskSortDirection = id === "sortDirection"
    ? newValue as TaskSortDirection
    : resolved.sortDirection;
  let rules: TaskSortRule[];
  if (id === "sortDirection") {
    rules = normalized.rules.map(rule => rule.field === "status"
      ? { field: "status", order: [...rule.order] }
      : { ...rule, direction });
  } else if (id === "statusOrder") {
    rules = [
      { field: "status", order: [...selectedStatusOrder!] },
      ...normalized.rules.filter(rule => rule.field !== "status").map(rule => ({ ...rule })),
    ];
  } else {
    const sortBy = newValue === "created" ? "id" : newValue;
    rules = sortBy === "status"
      ? [{ field: "status", order: [...resolved.statusOrder] }, { field: "id", direction }]
      : sortBy === "updated"
        ? [{ field: "updatedAt", direction }, { field: "id", direction }]
        : [{ field: "id", direction }];
  }

  cfg.sortSchemaVersion = SORT_SCHEMA_VERSION;
  cfg.sortRules = rules;
  delete cfg.sortBy;
  delete cfg.sortDirection;
  delete cfg.statusOrder;
  delete cfg.sortOrder;
  delete cfg.reverseSort;
  return true;
}

export async function openSettingsMenu(
  ui: SettingsUI,
  cfg: TasksConfig,
  onBack: () => Promise<void>,
  clearDelayTurns: number,
): Promise<void> {
  await ui.custom((_tui, theme, _kb, done) => {
    const resolvedSort = resolveTaskSort(cfg);
    const items: SettingItem[] = [
      {
        id: "taskScope",
        label: "Task storage",
        description:
          "memory: tasks live only in memory, lost when session ends. " +
          "session: persisted per session (tasks-<sessionId>.json), survives resume. " +
          "project: shared across all sessions (tasks.json). " +
          "Takes effect on next session start.",
        currentValue: cfg.taskScope ?? "session",
        values: ["memory", "session", "project"],
      },
      {
        id: "autoCascade",
        label: "Auto-execute with agents",
        description:
          "When ON: pending agent tasks start automatically once their dependencies complete. " +
          "When OFF: use TaskExecute to launch them manually.",
        currentValue: (cfg.autoCascade ?? false) ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showAll",
        label: "Show all tasks in widget",
        description:
          "When ON, every task is shown regardless of the visible limit. " +
          "When OFF, the list is capped by 'Max visible tasks'.",
        currentValue: (cfg.showAll ?? false) ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "maxVisible",
        label: "Max visible tasks in widget",
        description:
          "Only applies when 'Show all tasks' is OFF. " +
          "Caps how many task lines the widget shows.",
        currentValue: String(cfg.maxVisible ?? 10),
        values: ["5", "10", "15", "20", "30", "50", "100"],
      },
      {
        id: "sortBy",
        label: "Widget sort by",
        description:
          '"created" uses task IDs, "updated" uses the last change time, ' +
          'and "status" groups tasks using the configured status order.',
        currentValue: resolvedSort.sortBy === "id" ? "created" : resolvedSort.sortBy,
        values: ["created", "updated", "status"],
      },
      {
        id: "sortDirection",
        label: "Widget sort direction",
        description:
          "Ascending means oldest/lowest ID first; descending means newest/highest ID first. " +
          "With status sorting, this controls IDs within each group.",
        currentValue: resolvedSort.sortDirection,
        values: ["asc", "desc"],
      },
      {
        id: "statusOrder",
        label: "Sort by status order",
        description:
          "Selecting an order switches the widget to status sorting. Active means in-progress.",
        currentValue: statusOrderLabel(resolvedSort.statusOrder),
        values: Object.keys(STATUS_ORDER_OPTIONS),
      },
      {
        id: "hiddenAt",
        label: "Hidden tasks position",
        description:
          '"bottom" hides tasks from the end of the list. ' +
          '"top" hides tasks from the start (useful with status sort to collapse completed tasks).',
        currentValue: cfg.hiddenAt ?? "bottom",
        values: ["bottom", "top"],
      },
      {
        id: "autoClearCompleted",
        label: "Auto-clear completed tasks",
        description:
          "never: completed tasks stay visible until manually cleared. " +
          "on_list_complete: cleared automatically after all tasks are done. " +
          "on_task_complete: each task cleared shortly after it completes. " +
          `Clearing lags ~${clearDelayTurns} turns.`,
        currentValue: cfg.autoClearCompleted ?? "on_list_complete",
        values: ["never", "on_list_complete", "on_task_complete"],
      },
    ];

    const list = new SettingsList(
      items,
      /* maxVisible */ 10,
      getSettingsListTheme(),
      /* onChange */ (id, newValue) => {
        if (id === "autoCascade") {
          cfg.autoCascade = newValue === "on";
          saveTasksConfig(cfg);
        }
        if (id === "taskScope") {
          cfg.taskScope = newValue as "memory" | "session" | "project";
          saveTasksConfig(cfg);
        }
        if (id === "autoClearCompleted") {
          cfg.autoClearCompleted = newValue as TasksConfig["autoClearCompleted"];
          saveTasksConfig(cfg);
        }
        if (id === "showAll") {
          cfg.showAll = newValue === "on";
          saveTasksConfig(cfg);
        }
        if (id === "maxVisible") {
          cfg.maxVisible = Number(newValue);
          saveTasksConfig(cfg);
        }
        if (updateTaskSortSetting(cfg, id, newValue)) {
          saveTasksConfig(cfg);
        }
        if (id === "hiddenAt") {
          cfg.hiddenAt = newValue as "top" | "bottom";
          saveTasksConfig(cfg);
        }
      },
      /* onCancel */ () => done(undefined),
    );

    // Container doesn't forward handleInput to children — subclass to fix.
    class SettingsPanel extends Container {
      handleInput(data: string) { list.handleInput(data); }
    }

    const root = new SettingsPanel();
    root.addChild(new Text(theme.bold(theme.fg("accent", "⚙  Task Settings")), 0, 0));
    root.addChild(new Spacer(1));
    root.addChild(list);

    return root;
  });

  return onBack();
}
