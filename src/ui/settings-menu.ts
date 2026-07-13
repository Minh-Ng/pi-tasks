/**
 * settings-menu.ts — Polished settings panel for /tasks → Settings.
 *
 * Uses ui.custom() + SettingsList for native TUI rendering with keyboard
 * navigation, live toggle, and per-row descriptions — matching pi-coding-agent's
 * own settings panel style.
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { type AutoClearMode, saveTasksConfig, type TasksConfig } from "../tasks-config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type SettingsUI = {
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

// ── Settings panel ──────────────────────────────────────────────────────────

export async function openSettingsMenu(
  ui: SettingsUI,
  cfg: TasksConfig,
  onBack: () => Promise<void>,
  clearDelayTurns: number,
): Promise<void> {
  await ui.custom((_tui, theme, _kb, done) => {
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
        id: "sortOrder",
        label: "Widget sort order",
        description:
          '"status" groups by completed → in-progress → pending. ' +
          '"id" sorts by creation order.',
        currentValue: cfg.sortOrder ?? "id",
        values: ["id", "status", "recent", "oldest"],
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
        id: "globalAutoClearCompleted",
        label: "Default auto-clear completed tasks",
        description:
          "Global default for projects without an override. " +
          "never: keep completed tasks. on_list_complete: clear when all are done. " +
          `on_task_complete: clear each completed task after ~${clearDelayTurns} turns.`,
        currentValue: cfg.globalAutoClearCompleted ?? "on_list_complete",
        values: ["never", "on_list_complete", "on_task_complete"],
      },
      {
        id: "autoClearCompleted",
        label: "Auto-clear in this project",
        description:
          "use_global: inherit the global default. Choose another value to override it only here.",
        currentValue: cfg.autoClearCompletedSource === "project"
          ? (cfg.autoClearCompleted ?? "on_list_complete")
          : "use_global",
        values: ["use_global", "never", "on_list_complete", "on_task_complete"],
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
        if (id === "globalAutoClearCompleted") {
          cfg.globalAutoClearCompleted = newValue as AutoClearMode;
          if (cfg.autoClearCompletedSource !== "project") {
            cfg.autoClearCompleted = cfg.globalAutoClearCompleted;
          }
          saveTasksConfig(cfg);
        }
        if (id === "autoClearCompleted") {
          if (newValue === "use_global") {
            cfg.autoClearCompletedSource = "global";
            cfg.autoClearCompleted = cfg.globalAutoClearCompleted ?? "on_list_complete";
          } else {
            cfg.autoClearCompletedSource = "project";
            cfg.autoClearCompleted = newValue as AutoClearMode;
          }
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
        if (id === "sortOrder") {
          cfg.sortOrder = newValue as TasksConfig["sortOrder"];
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
