// Project settings live at <cwd>/.pi/tasks-config.json.
// The auto-clear preference is global so it follows the user across projects.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  showAll?: boolean;                     // default: false
  maxVisible?: number;                   // default: 10
  sortOrder?: "id" | "status" | "recent" | "oldest";  // default: "id"
  hiddenAt?: "top" | "bottom";                         // default: "bottom"
}

export interface TasksConfigPaths {
  projectPath?: string;
  globalPath?: string;
}

const AUTO_CLEAR_MODES = new Set<TasksConfig["autoClearCompleted"]>([
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

function isAutoClearMode(value: TasksConfig["autoClearCompleted"]): value is NonNullable<TasksConfig["autoClearCompleted"]> {
  return AUTO_CLEAR_MODES.has(value);
}

export function loadTasksConfig(paths: TasksConfigPaths = {}): TasksConfig {
  const { projectPath, globalPath } = resolvePaths(paths);
  const projectConfig = readConfig(projectPath);
  const globalConfig = readConfig(globalPath);

  if (isAutoClearMode(globalConfig.autoClearCompleted)) {
    return { ...projectConfig, autoClearCompleted: globalConfig.autoClearCompleted };
  }

  // Migrate the legacy per-project preference once, then let it follow the user.
  if (isAutoClearMode(projectConfig.autoClearCompleted)) {
    try {
      writeConfig(globalPath, {
        ...globalConfig,
        autoClearCompleted: projectConfig.autoClearCompleted,
      });
    } catch {
      // A read-only global config directory should not prevent the extension loading.
    }
  }

  return projectConfig;
}

export function saveTasksConfig(config: TasksConfig, paths: TasksConfigPaths = {}): void {
  const { projectPath, globalPath } = resolvePaths(paths);
  const { autoClearCompleted, ...projectConfig } = config;
  writeConfig(projectPath, projectConfig);

  if (isAutoClearMode(autoClearCompleted)) {
    writeConfig(globalPath, {
      ...readConfig(globalPath),
      autoClearCompleted,
    });
  }
}
