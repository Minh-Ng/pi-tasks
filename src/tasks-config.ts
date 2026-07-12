// <cwd>/.pi/tasks-config.json — persists extension settings across sessions

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskSortDirection, TaskSortKey } from "./task-sort.js";
import type { TaskStatus } from "./types.js";

export interface TasksConfig {
  taskScope?: "memory" | "session" | "project";  // default: "session"
  autoCascade?: boolean;   // default: false
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";  // default: "on_list_complete"
  showAll?: boolean;                     // default: false
  maxVisible?: number;                   // default: 10
  sortBy?: TaskSortKey;                                  // default: "id"
  sortDirection?: TaskSortDirection;                     // default: "asc"
  statusOrder?: TaskStatus[];                            // default: completed → in_progress → pending
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

export function saveTasksConfig(config: TasksConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
