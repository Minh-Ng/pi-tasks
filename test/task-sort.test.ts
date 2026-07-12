import { describe, expect, it, vi } from "vitest";
import { sortTasks, TaskSortCache } from "../src/task-sort.js";
import type { Task, TaskStatus } from "../src/types.js";

function task(id: string, status: TaskStatus = "pending", updatedAt = Number(id)): Task {
  return {
    id,
    subject: `Task ${id}`,
    description: "Desc",
    status,
    metadata: {},
    blocks: [],
    blockedBy: [],
    createdAt: Number(id),
    updatedAt,
  };
}

describe("task sorting", () => {
  it("sorts a copy in either direction without mutating input", () => {
    const input = [task("3"), task("1"), task("2")];

    expect(sortTasks(input).map(item => item.id)).toEqual(["1", "2", "3"]);
    expect(sortTasks(input, "id", "descending").map(item => item.id)).toEqual(["3", "2", "1"]);
    expect(input.map(item => item.id)).toEqual(["3", "1", "2"]);
  });

  it("preserves existing status and update-time semantics", () => {
    const input = [
      task("1", "pending", 20),
      task("2", "completed", 30),
      task("3", "in_progress", 10),
    ];

    expect(sortTasks(input, "status").map(item => item.id)).toEqual(["2", "3", "1"]);
    expect(sortTasks(input, "recent").map(item => item.id)).toEqual(["2", "1", "3"]);
    expect(sortTasks(input, "oldest").map(item => item.id)).toEqual(["3", "1", "2"]);
  });

  it("reuses cached ordering while sort keys are unchanged", () => {
    const cache = new TaskSortCache();
    const input = [task("3"), task("1"), task("2")];
    const sortSpy = vi.spyOn(Array.prototype, "sort");
    try {
      cache.sort(input, "status", "descending");
      const callsAfterFirstSort = sortSpy.mock.calls.length;
      cache.sort(input, "status", "descending");
      expect(sortSpy).toHaveBeenCalledTimes(callsAfterFirstSort);
    } finally {
      sortSpy.mockRestore();
    }
  });

  it("re-sorts when a relevant key changes", () => {
    const cache = new TaskSortCache();
    const input = [task("1"), task("2")];
    expect(cache.sort(input, "status").map(item => item.id)).toEqual(["1", "2"]);

    input[1].status = "completed";

    expect(cache.sort(input, "status").map(item => item.id)).toEqual(["2", "1"]);
  });

  it("returns current task objects when non-sort fields change", () => {
    const cache = new TaskSortCache();
    const initial = [task("2"), task("1")];
    cache.sort(initial, "id");
    const refreshed = initial.map(item => ({ ...item, subject: `Refreshed ${item.id}` }));

    const sorted = cache.sort(refreshed, "id");

    expect(sorted.map(item => item.subject)).toEqual(["Refreshed 1", "Refreshed 2"]);
    expect(sorted[0]).toBe(refreshed[1]);
  });
});
