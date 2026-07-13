// Global defaults live at ~/.pi/agent/tasks-config.json.
// Project overrides live at <cwd>/.pi/tasks-config.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskSortDirection, TaskSortOrder } from "./task-sort.js";

export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";

export interface PersistedTasksConfig {
  taskScope?: "memory" | "session" | "project";
  autoCascade?: boolean;
  autoClearCompleted?: AutoClearMode;
  autoClearDelayTurns?: number;
  showAll?: boolean;
  maxVisible?: number;
  sortOrder?: TaskSortOrder;
  sortDirection?: TaskSortDirection;
  hiddenAt?: "top" | "bottom";
}

export type TasksConfigKey = keyof PersistedTasksConfig;
export type TasksConfigScope = "global" | "project";

export interface TasksConfigLayers {
  global: PersistedTasksConfig;
  project: PersistedTasksConfig;
}

export interface TasksConfig extends PersistedTasksConfig {
  /** Runtime-only source layers used by the settings UI. */
  configLayers?: TasksConfigLayers;
}

export interface TasksConfigPaths {
  projectPath?: string;
  globalPath?: string;
}

export const TASKS_CONFIG_DEFAULTS: Required<PersistedTasksConfig> = {
  taskScope: "session",
  autoCascade: false,
  autoClearCompleted: "on_list_complete",
  autoClearDelayTurns: 4,
  showAll: false,
  maxVisible: 10,
  sortOrder: "id",
  sortDirection: "ascending",
  hiddenAt: "bottom",
};

const CONFIG_KEYS = Object.keys(TASKS_CONFIG_DEFAULTS) as TasksConfigKey[];
const AUTO_CLEAR_MODES = new Set<AutoClearMode>([
  "never",
  "on_list_complete",
  "on_task_complete",
]);

function resolvePaths(paths: TasksConfigPaths = {}) {
  return {
    projectPath: paths.projectPath ?? join(process.cwd(), ".pi", "tasks-config.json"),
    globalPath: paths.globalPath ?? join(homedir(), ".pi", "agent", "tasks-config.json"),
  };
}

function readConfig(path: string): PersistedTasksConfig {
  try {
    return sanitizeConfig(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return {};
  }
}

function writeConfig(path: string, config: PersistedTasksConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

function isValidValue(key: TasksConfigKey, value: unknown): boolean {
  switch (key) {
    case "taskScope": return value === "memory" || value === "session" || value === "project";
    case "autoCascade":
    case "showAll": return typeof value === "boolean";
    case "autoClearCompleted": return AUTO_CLEAR_MODES.has(value as AutoClearMode);
    case "autoClearDelayTurns": return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 100;
    case "maxVisible": return Number.isInteger(value) && Number(value) > 0;
    case "sortOrder": return value === "id" || value === "status" || value === "recent" || value === "oldest";
    case "sortDirection": return value === "ascending" || value === "descending";
    case "hiddenAt": return value === "top" || value === "bottom";
  }
}

function sanitizeConfig(value: unknown): PersistedTasksConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const config: PersistedTasksConfig = {};
  for (const key of CONFIG_KEYS) {
    if (isValidValue(key, source[key])) {
      Object.assign(config, { [key]: source[key] });
    }
  }
  return config;
}

function layersFor(config: TasksConfig): TasksConfigLayers {
  if (config.configLayers) return config.configLayers;
  const layers = { global: {}, project: sanitizeConfig(config) };
  config.configLayers = layers;
  return layers;
}

function applyEffectiveValues(config: TasksConfig): void {
  const layers = layersFor(config);
  Object.assign(config, TASKS_CONFIG_DEFAULTS, layers.global, layers.project);
}

export function loadTasksConfig(paths: TasksConfigPaths = {}): TasksConfig {
  const { projectPath, globalPath } = resolvePaths(paths);
  const config: TasksConfig = {
    configLayers: {
      global: readConfig(globalPath),
      project: readConfig(projectPath),
    },
  };
  applyEffectiveValues(config);
  return config;
}

export function getTasksConfigLayerValue<K extends TasksConfigKey>(
  config: TasksConfig,
  scope: TasksConfigScope,
  key: K,
): PersistedTasksConfig[K] {
  return layersFor(config)[scope][key];
}

export function setTasksConfigLayerValue<K extends TasksConfigKey>(
  config: TasksConfig,
  scope: TasksConfigScope,
  key: K,
  value: PersistedTasksConfig[K] | undefined,
  paths: TasksConfigPaths = {},
): void {
  const layers = layersFor(config);
  if (value === undefined) {
    delete layers[scope][key];
  } else if (isValidValue(key, value)) {
    Object.assign(layers[scope], { [key]: value });
  } else {
    throw new Error(`Invalid ${key} setting: ${String(value)}`);
  }
  applyEffectiveValues(config);

  const { projectPath, globalPath } = resolvePaths(paths);
  writeConfig(scope === "global" ? globalPath : projectPath, layers[scope]);
}

/** Backward-compatible project-local save for external callers. */
export function saveTasksConfig(config: TasksConfig, paths: TasksConfigPaths = {}): void {
  const { projectPath } = resolvePaths(paths);
  const project = sanitizeConfig(config);
  writeConfig(projectPath, project);
  config.configLayers = {
    global: config.configLayers?.global ?? {},
    project,
  };
  applyEffectiveValues(config);
}
