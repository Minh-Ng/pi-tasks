/**
 * settings-menu.ts — Settings panel with global defaults and project overrides.
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import {
  getTasksConfigLayerValue,
  type PersistedTasksConfig,
  setTasksConfigLayerValue,
  type TasksConfig,
  type TasksConfigKey,
  type TasksConfigPaths,
  type TasksConfigScope,
} from "../tasks-config.js";

export type SettingsUI = {
  custom<T>(
    factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
    options?: { overlay?: boolean; overlayOptions?: any },
  ): Promise<T>;
};

type ConfigSetting = {
  id: TasksConfigKey;
  label: string;
  description: string;
  values: string[];
  parse: (value: string) => PersistedTasksConfig[TasksConfigKey];
  format?: (value: PersistedTasksConfig[TasksConfigKey]) => string;
};

const asString = (value: string) => value as PersistedTasksConfig[TasksConfigKey];
const asBoolean = (value: string) => value === "on";
const asNumber = (value: string) => Number(value);
const formatBoolean = (value: PersistedTasksConfig[TasksConfigKey]) => value ? "on" : "off";

export async function openSettingsMenu(
  ui: SettingsUI,
  cfg: TasksConfig,
  onBack: () => Promise<void>,
  _clearDelayTurns: number,
  configPaths: TasksConfigPaths = {},
): Promise<void> {
  await ui.custom((_tui, theme, _kb, done) => {
    let editingScope: TasksConfigScope = "project";
    const settings: ConfigSetting[] = [
      {
        id: "taskScope",
        label: "Task storage",
        description:
          "memory: not persisted. session: one file per session. project: shared in the project. " +
          "Takes effect on next session start.",
        values: ["memory", "session", "project"],
        parse: asString,
      },
      {
        id: "autoCascade",
        label: "Auto-execute with agents",
        description: "Automatically start pending agent tasks when dependencies complete.",
        values: ["on", "off"],
        parse: asBoolean,
        format: formatBoolean,
      },
      {
        id: "autoClearCompleted",
        label: "Auto-clear completed tasks",
        description:
          "never: keep completed tasks. on_list_complete: clear when all are done. " +
          "on_task_complete: clear each completed task.",
        values: ["never", "on_list_complete", "on_task_complete"],
        parse: asString,
      },
      {
        id: "autoClearDelayTurns",
        label: "Auto-clear delay (turns)",
        description: "How many turns completed tasks linger before automatic clearing.",
        values: ["1", "2", "3", "4", "5", "6", "8", "10", "12", "16"],
        parse: asNumber,
      },
      {
        id: "showAll",
        label: "Show all tasks in widget",
        description: "Show every task instead of applying the visible limit.",
        values: ["on", "off"],
        parse: asBoolean,
        format: formatBoolean,
      },
      {
        id: "maxVisible",
        label: "Max visible tasks in widget",
        description: "Visible task limit when 'Show all tasks' is off.",
        values: ["5", "10", "15", "20", "30", "50", "100"],
        parse: asNumber,
      },
      {
        id: "sortOrder",
        label: "Widget sort order",
        description: "Sort by creation id, status, most recent update, or oldest update.",
        values: ["id", "status", "recent", "oldest"],
        parse: asString,
      },
      {
        id: "sortDirection",
        label: "Widget sort direction",
        description: "Use the selected sort order ascending or descending.",
        values: ["ascending", "descending"],
        parse: asString,
      },
      {
        id: "hiddenAt",
        label: "Hidden tasks position",
        description: "Choose which end of an overflowing task list is collapsed.",
        values: ["bottom", "top"],
        parse: asString,
      },
    ];

    const displayedValue = (setting: ConfigSetting): string => {
      const value = getTasksConfigLayerValue(cfg, editingScope, setting.id);
      if (value === undefined) return "inherit";
      return setting.format?.(value) ?? String(value);
    };

    const items: SettingItem[] = [
      {
        id: "settingsScope",
        label: "Editing settings",
        description:
          "global sets defaults for every project; project overrides them here. " +
          "inherit means built-in default globally or global default in a project.",
        currentValue: editingScope,
        values: ["global", "project"],
      },
      ...settings.map((setting) => ({
        id: setting.id,
        label: setting.label,
        description: setting.description,
        currentValue: displayedValue(setting),
        values: ["inherit", ...setting.values],
      })),
    ];

    const list = new SettingsList(
      items,
      /* maxVisible */ 10,
      getSettingsListTheme(),
      /* onChange */ (id, newValue) => {
        if (id === "settingsScope") {
          editingScope = newValue as TasksConfigScope;
          for (const setting of settings) {
            list.updateValue(setting.id, displayedValue(setting));
          }
          return;
        }

        const setting = settings.find((candidate) => candidate.id === id);
        if (!setting) return;
        setTasksConfigLayerValue(
          cfg,
          editingScope,
          setting.id,
          newValue === "inherit" ? undefined : setting.parse(newValue),
          configPaths,
        );
        list.updateValue(setting.id, displayedValue(setting));
      },
      /* onCancel */ () => done(undefined),
    );

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
