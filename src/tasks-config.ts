// Project settings live at <cwd>/.pi/tasks-config.json.
// The global auto-clear default lives at ~/.pi/agent/tasks-config.json.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AutoClearMode = "never" | "on_list_complete" | "on_task_complete";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: AutoClearMode;  // effective mode; default: "on_list_complete"
  showAll?: boolean;                     // default: false
  maxVisible?: number;                   // default: 10
  sortOrder?: "id" | "status" | "recent" | "oldest";  // default: "id"
  hiddenAt?: "top" | "bottom";                         // default: "bottom"
  /** Runtime settings state; persisted only in the global config. */
  globalAutoClearCompleted?: AutoClearMode;
  /** Runtime settings state; determines whether the project stores an override. */
  autoClearCompletedSource?: "global" | "project";
}

export interface TasksConfigPaths {
  projectPath?: string;
  globalPath?: string;
}

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

function readConfig(path: string): TasksConfig {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(path: string, config: TasksConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

function isAutoClearMode(value: AutoClearMode | undefined): value is AutoClearMode {
  return value !== undefined && AUTO_CLEAR_MODES.has(value);
}

export function loadTasksConfig(paths: TasksConfigPaths = {}): TasksConfig {
  const { projectPath, globalPath } = resolvePaths(paths);
  const projectConfig = readConfig(projectPath);
  const globalConfig = readConfig(globalPath);
  const projectMode = isAutoClearMode(projectConfig.autoClearCompleted)
    ? projectConfig.autoClearCompleted
    : undefined;
  let globalMode = isAutoClearMode(globalConfig.autoClearCompleted)
    ? globalConfig.autoClearCompleted
    : undefined;

  // Seed the global default from a legacy project value without removing that
  // project's override. Other projects can then inherit the same default.
  if (!globalMode && projectMode) {
    globalMode = projectMode;
    try {
      writeConfig(globalPath, {
        ...globalConfig,
        autoClearCompleted: globalMode,
      });
    } catch {
      // A read-only global config directory should not prevent the extension loading.
    }
  }

  return {
    ...projectConfig,
    autoClearCompleted: projectMode ?? globalMode,
    globalAutoClearCompleted: globalMode,
    autoClearCompletedSource: projectMode ? "project" : "global",
  };
}

export function saveTasksConfig(config: TasksConfig, paths: TasksConfigPaths = {}): void {
  const { projectPath, globalPath } = resolvePaths(paths);
  const {
    autoClearCompleted,
    globalAutoClearCompleted,
    autoClearCompletedSource,
    ...projectSettings
  } = config;
  const projectConfig: TasksConfig = projectSettings;

  // Calls made without source metadata retain the original project-local save
  // behavior. Settings-menu calls always provide the explicit source.
  if (autoClearCompletedSource !== "global" && isAutoClearMode(autoClearCompleted)) {
    projectConfig.autoClearCompleted = autoClearCompleted;
  }
  writeConfig(projectPath, projectConfig);

  if (isAutoClearMode(globalAutoClearCompleted)) {
    writeConfig(globalPath, {
      ...readConfig(globalPath),
      autoClearCompleted: globalAutoClearCompleted,
    });
  }
}
