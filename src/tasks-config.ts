// <cwd>/.pi/tasks-config.json — persists extension settings across sessions

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskSortDirection, TaskSortKey, TaskSortRule } from "./task-sort.js";
import type { TaskStatus } from "./types.js";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  showAll?: boolean;                     // default: false
  maxVisible?: number;                   // default: 10
  sortSchemaVersion?: number;
  sortRules?: TaskSortRule[];
  sortBy?: TaskSortKey;                                  // compatibility
  sortDirection?: TaskSortDirection;                     // compatibility
  statusOrder?: TaskStatus[];                            // compatibility
  /** Legacy settings retained for existing configuration files. */
  sortOrder?: "id" | "status" | "recent" | "oldest";
  reverseSort?: boolean;
  hiddenAt?: "top" | "bottom";                         // default: "bottom"
}

const CONFIG_PATH = join(process.cwd(), ".pi", "tasks-config.json");

export function loadTasksConfig(): TasksConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch { return {}; }
}

export function writeTasksConfig(path: string, config: TasksConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    renameSync(tmpPath, path);
  } finally {
    try { unlinkSync(tmpPath); } catch { /* already renamed or never written */ }
  }
}

export function saveTasksConfig(config: TasksConfig): void {
  writeTasksConfig(CONFIG_PATH, config);
}
