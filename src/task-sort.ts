import type { Task } from "./types.js";

export type TaskSortOrder = "id" | "status" | "recent" | "oldest";
export type TaskSortDirection = "ascending" | "descending";

function sortById(a: Task, b: Task): number {
  return Number(a.id) - Number(b.id);
}

function sortByStatus(a: Task, b: Task): number {
  const rank = (status: string) => status === "completed" ? 0 : status === "in_progress" ? 1 : 2;
  return rank(a.status) - rank(b.status) || sortById(a, b);
}

function sortByRecent(a: Task, b: Task): number {
  return b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id);
}

function sortByOldest(a: Task, b: Task): number {
  return a.updatedAt - b.updatedAt || sortById(a, b);
}

const SORT_FNS: Record<TaskSortOrder, (a: Task, b: Task) => number> = {
  id: sortById,
  status: sortByStatus,
  recent: sortByRecent,
  oldest: sortByOldest,
};

/** Return a sorted copy without mutating the input array. */
export function sortTasks(
  tasks: readonly Task[],
  sortOrder: TaskSortOrder = "id",
  sortDirection: TaskSortDirection = "ascending",
): Task[] {
  const sorted = [...tasks].sort(SORT_FNS[sortOrder]);
  if (sortDirection === "descending") sorted.reverse();
  return sorted;
}

type CacheEntry = { signature: string; orderedIds: string[] };

/** Memoizes ordering while returning the current task objects on every call. */
export class TaskSortCache {
  private entries = new Map<string, CacheEntry>();

  clear(): void {
    this.entries.clear();
  }

  sort(
    tasks: readonly Task[],
    sortOrder: TaskSortOrder = "id",
    sortDirection: TaskSortDirection = "ascending",
  ): Task[] {
    const cacheKey = `${sortOrder}:${sortDirection}`;
    const signature = JSON.stringify(tasks.map(task =>
      sortOrder === "status"
        ? [task.id, task.status]
        : sortOrder === "recent" || sortOrder === "oldest"
          ? [task.id, task.updatedAt]
          : [task.id]));
    let entry = this.entries.get(cacheKey);
    if (!entry || entry.signature !== signature) {
      entry = {
        signature,
        orderedIds: sortTasks(tasks, sortOrder, sortDirection).map(task => task.id),
      };
      this.entries.set(cacheKey, entry);
    }

    const currentTasks = new Map(tasks.map(task => [task.id, task]));
    return entry.orderedIds.flatMap(id => {
      const task = currentTasks.get(id);
      return task ? [task] : [];
    });
  }
}
