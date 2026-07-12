import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATUS_ORDER,
  resolveTaskSort,
  sortTasks,
  type TaskSortDirection,
} from "../src/task-sort.js";
import type { Task, TaskStatus } from "../src/types.js";

function task(id: string, status: TaskStatus, updatedAt = Number(id)): Task {
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

const STATUS_PERMUTATIONS: TaskStatus[][] = [
  ["completed", "in_progress", "pending"],
  ["completed", "pending", "in_progress"],
  ["in_progress", "completed", "pending"],
  ["in_progress", "pending", "completed"],
  ["pending", "completed", "in_progress"],
  ["pending", "in_progress", "completed"],
];

describe("task sorting", () => {
  it.each([
    ["asc", ["1", "2", "10"]],
    ["desc", ["10", "2", "1"]],
  ] as const)("sorts numeric task IDs %s", (sortDirection, expected) => {
    const tasks = [task("10", "pending"), task("1", "pending"), task("2", "pending")];
    expect(sortTasks(tasks, { sortBy: "id", sortDirection }).map(item => item.id)).toEqual(expected);
  });

  it.each([
    ["asc", ["2", "3", "1"]],
    ["desc", ["1", "3", "2"]],
  ] as const)("sorts update times %s with ID tie-breaking", (sortDirection, expected) => {
    const tasks = [task("1", "pending", 30), task("2", "pending", 10), task("3", "pending", 10)];
    expect(sortTasks(tasks, { sortBy: "updated", sortDirection }).map(item => item.id)).toEqual(expected);
  });

  for (const statusOrder of STATUS_PERMUTATIONS) {
    for (const sortDirection of ["asc", "desc"] as TaskSortDirection[]) {
      it(`supports ${statusOrder.join(" → ")} with IDs ${sortDirection}`, () => {
        const tasks = statusOrder.flatMap(status => [task("2", status), task("1", status)]);
        const sorted = sortTasks(tasks, { sortBy: "status", statusOrder, sortDirection });
        const expectedIds = sortDirection === "asc" ? ["1", "2"] : ["2", "1"];

        expect(sorted.map(item => item.status)).toEqual(statusOrder.flatMap(status => [status, status]));
        for (const status of statusOrder) {
          expect(sorted.filter(item => item.status === status).map(item => item.id)).toEqual(expectedIds);
        }
      });
    }
  }

  it("does not mutate its input array", () => {
    const tasks = [task("2", "pending"), task("1", "completed")];
    const original = [...tasks];
    const sorted = sortTasks(tasks, { sortBy: "id" });

    expect(tasks).toEqual(original);
    expect(sorted).not.toBe(tasks);
  });

  it.each([
    { statusOrder: ["pending", "pending", "completed"] },
    { statusOrder: ["pending", "completed"] },
    { statusOrder: ["pending", "in_progress", "unknown"] },
    { statusOrder: "pending,in_progress,completed" },
  ])("falls back safely for malformed status order %#", malformed => {
    const resolved = resolveTaskSort(malformed as any);
    expect(resolved.statusOrder).toEqual(DEFAULT_STATUS_ORDER);
  });

  it("returns a fresh default status order so callers cannot mutate the constant", () => {
    const first = resolveTaskSort({});
    first.statusOrder.reverse();
    expect(resolveTaskSort({}).statusOrder).toEqual(DEFAULT_STATUS_ORDER);
  });

  it.each([
    ["id", "id", "asc"],
    ["status", "status", "asc"],
    ["recent", "updated", "desc"],
    ["oldest", "updated", "asc"],
  ] as const)("preserves legacy sortOrder=%s", (sortOrder, sortBy, sortDirection) => {
    expect(resolveTaskSort({ sortOrder })).toMatchObject({ sortBy, sortDirection });
  });

  it.each([
    ["id", "id", "desc", ["completed", "in_progress", "pending"]],
    ["status", "status", "desc", ["pending", "in_progress", "completed"]],
    ["recent", "updated", "asc", ["completed", "in_progress", "pending"]],
    ["oldest", "updated", "desc", ["completed", "in_progress", "pending"]],
  ] as const)("preserves legacy reverseSort with sortOrder=%s", (sortOrder, sortBy, sortDirection, statusOrder) => {
    expect(resolveTaskSort({ sortOrder, reverseSort: true })).toEqual({ sortBy, sortDirection, statusOrder });
  });

  it("preserves legacy reverseSort when sortOrder is omitted", () => {
    expect(resolveTaskSort({ reverseSort: true })).toMatchObject({ sortBy: "id", sortDirection: "desc" });
  });

  it("prefers explicit new settings over legacy settings", () => {
    expect(resolveTaskSort({
      sortBy: "id",
      sortDirection: "desc",
      sortOrder: "recent",
      reverseSort: true,
    })).toMatchObject({ sortBy: "id", sortDirection: "desc" });
  });

  it("falls back safely for malformed sort key and direction", () => {
    expect(resolveTaskSort({ sortBy: "bad", sortDirection: "sideways" } as any)).toMatchObject({
      sortBy: "id",
      sortDirection: "asc",
    });
  });
});
