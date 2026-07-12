import type { Task, TaskStatus } from "./types.js";

export type TaskSortKey = "id" | "updated" | "status";
export type TaskSortDirection = "asc" | "desc";
export type LegacyTaskSortOrder = "id" | "status" | "recent" | "oldest";

export const DEFAULT_STATUS_ORDER: readonly TaskStatus[] = ["completed", "in_progress", "pending"];

export interface TaskSortConfig {
  sortBy?: TaskSortKey;
  sortDirection?: TaskSortDirection;
  statusOrder?: readonly TaskStatus[];
  /** Legacy settings retained for existing tasks-config.json files. */
  sortOrder?: LegacyTaskSortOrder;
  reverseSort?: boolean;
}

export interface ResolvedTaskSort {
  sortBy: TaskSortKey;
  sortDirection: TaskSortDirection;
  statusOrder: TaskStatus[];
}

function validSortKey(value: unknown): value is TaskSortKey {
  return value === "id" || value === "updated" || value === "status";
}

function validDirection(value: unknown): value is TaskSortDirection {
  return value === "asc" || value === "desc";
}

function normalizeStatusOrder(value: unknown): TaskStatus[] {
  if (!Array.isArray(value) || value.length !== DEFAULT_STATUS_ORDER.length) {
    return [...DEFAULT_STATUS_ORDER];
  }
  const statuses = new Set(value);
  if (statuses.size !== DEFAULT_STATUS_ORDER.length || DEFAULT_STATUS_ORDER.some(status => !statuses.has(status))) {
    return [...DEFAULT_STATUS_ORDER];
  }
  return [...value] as TaskStatus[];
}

/** Resolve new settings while preserving the behavior of legacy sortOrder values. */
export function resolveTaskSort(config: TaskSortConfig): ResolvedTaskSort {
  const legacy = config.sortOrder;
  const hasNewSettings = validSortKey(config.sortBy) || validDirection(config.sortDirection) ||
    config.statusOrder !== undefined;
  const useLegacyReverse = config.reverseSort === true && !hasNewSettings;
  const sortBy = validSortKey(config.sortBy)
    ? config.sortBy
    : legacy === "status"
      ? "status"
      : legacy === "recent" || legacy === "oldest"
        ? "updated"
        : "id";
  const defaultDirection = legacy === "recent" ? "desc" : "asc";
  const sortDirection = validDirection(config.sortDirection)
    ? config.sortDirection
    : useLegacyReverse
      ? defaultDirection === "asc" ? "desc" : "asc"
      : defaultDirection;
  const statusOrder = normalizeStatusOrder(config.statusOrder);
  if (useLegacyReverse && sortBy === "status") statusOrder.reverse();

  return { sortBy, sortDirection, statusOrder };
}

function compareIds(a: Task, b: Task): number {
  const numeric = Number(a.id) - Number(b.id);
  return Number.isNaN(numeric) ? a.id.localeCompare(b.id, undefined, { numeric: true }) : numeric;
}

/** Return a sorted copy. Status order controls groups; direction controls tasks within each group. */
export function sortTasks(tasks: readonly Task[], config: TaskSortConfig): Task[] {
  const { sortBy, sortDirection, statusOrder } = resolveTaskSort(config);
  const direction = sortDirection === "desc" ? -1 : 1;
  const statusRanks = new Map(statusOrder.map((status, index) => [status, index]));

  return [...tasks].sort((a, b) => {
    if (sortBy === "status") {
      const statusComparison = (statusRanks.get(a.status) ?? statusOrder.length) -
        (statusRanks.get(b.status) ?? statusOrder.length);
      return statusComparison || direction * compareIds(a, b);
    }
    if (sortBy === "updated") {
      return direction * (a.updatedAt - b.updatedAt || compareIds(a, b));
    }
    return direction * compareIds(a, b);
  });
}
