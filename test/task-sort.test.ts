import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATUS_ORDER,
  type LegacyTaskSortOrder,
  normalizeTaskSort,
  resolveTaskSort,
  SORT_SCHEMA_VERSION,
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

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}

function legacySort(tasks: readonly Task[], sortOrder: LegacyTaskSortOrder, reverseSort: boolean): Task[] {
  const statusRank = (status: TaskStatus) => status === "completed" ? 0 : status === "in_progress" ? 1 : 2;
  const sorted = [...tasks].sort((a, b) => {
    if (sortOrder === "status") {
      return statusRank(a.status) - statusRank(b.status) || Number(a.id) - Number(b.id);
    }
    if (sortOrder === "recent") {
      return b.updatedAt - a.updatedAt || Number(b.id) - Number(a.id);
    }
    if (sortOrder === "oldest") {
      return a.updatedAt - b.updatedAt || Number(a.id) - Number(b.id);
    }
    return Number(a.id) - Number(b.id);
  });
  return reverseSort ? sorted.reverse() : sorted;
}

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

  it("supports custom multi-level declarative rules", () => {
    const tasks = [
      task("1", "pending", 10),
      task("2", "in_progress", 20),
      task("3", "pending", 30),
      task("4", "pending", 30),
    ];
    const sorted = sortTasks(tasks, {
      sortSchemaVersion: SORT_SCHEMA_VERSION,
      sortRules: [
        { field: "status", order: ["in_progress", "pending", "completed"] },
        { field: "updatedAt", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    });
    expect(sorted.map(item => item.id)).toEqual(["2", "3", "4", "1"]);
  });

  it("handles malformed persisted task fields without bypassing deterministic tie-breakers", () => {
    const malformedTimestamp = task("2", "pending", Number.NaN);
    const validTimestamp = task("1", "pending", 10);
    const laterTimestamp = task("3", "pending", 20);
    const unknownStatus = { ...task("4", "pending", 5), status: "unknown" } as unknown as Task;
    const rules = [
      { field: "status", order: ["pending", "in_progress", "completed"] },
      { field: "updatedAt", direction: "asc" },
      { field: "id", direction: "asc" },
    ];
    const outputs = permutations([malformedTimestamp, unknownStatus, validTimestamp, laterTimestamp])
      .map(input => sortTasks(input, { sortRules: rules }).map(item => item.id));
    expect(outputs.every(output => JSON.stringify(output) === JSON.stringify(["1", "3", "2", "4"]))).toBe(true);
  });

  it("uses a total order for canonical, numerically unusual, and nonnumeric IDs", () => {
    const tasks = [
      task("1", "pending"),
      task("01", "pending"),
      task("0x10", "pending"),
      task("0xg", "pending"),
      task("é", "pending"),
      task("e\u0301", "pending"),
    ];
    const outputs = permutations(tasks)
      .map(input => sortTasks(input, { sortRules: [{ field: "id", direction: "asc" }] }).map(item => item.id));
    expect(outputs.every(output => JSON.stringify(output) === JSON.stringify(outputs[0]))).toBe(true);
    expect(new Set(outputs[0]).size).toBe(tasks.length);
  });

  it.each([
    { sortRules: [] },
    { sortRules: [{ field: "updatedAt", direction: "desc" }] },
    { sortRules: [{ field: "id", direction: "sideways" }] },
    { sortRules: [{ field: "unknown", direction: "asc" }, { field: "id", direction: "asc" }] },
    { sortRules: [{ field: "id", direction: "asc" }, { field: "id", direction: "desc" }] },
    { sortRules: [
      { field: "status", order: ["pending", "pending", "completed"] },
      { field: "id", direction: "asc" },
    ] },
  ])("rejects malformed declarative rules %#", config => {
    const normalized = normalizeTaskSort(config);
    expect(normalized.source).toBe("default");
    expect(normalized.rules).toEqual([{ field: "id", direction: "asc" }]);
    expect(normalized.warnings.length).toBeGreaterThan(0);
  });

  it("uses deterministic schema precedence without mixing generations", () => {
    const validRules = [{ field: "id", direction: "desc" }] as const;
    expect(normalizeTaskSort({
      sortSchemaVersion: SORT_SCHEMA_VERSION,
      sortRules: validRules,
      sortBy: "updated",
      sortOrder: "recent",
    }).source).toBe("rules");

    const structured = normalizeTaskSort({
      sortRules: [{ field: "updatedAt", direction: "desc" }], // invalid: no ID tiebreaker
      sortBy: "status",
      sortOrder: "recent",
    });
    expect(structured.source).toBe("structured");
    expect(structured.rules[0].field).toBe("status");

    const legacy = normalizeTaskSort({
      sortRules: [],
      sortOrder: "recent",
    });
    expect(legacy.source).toBe("legacy");
    expect(legacy.rules[0]).toEqual({ field: "updatedAt", direction: "desc" });
  });

  it("does not interpret rules from an unsupported schema version", () => {
    const normalized = normalizeTaskSort({
      sortSchemaVersion: SORT_SCHEMA_VERSION + 1,
      sortRules: [{ field: "id", direction: "desc" }],
    });
    expect(normalized.source).toBe("default");
    expect(normalized.rules).toEqual([{ field: "id", direction: "asc" }]);
    expect(normalized.warnings.join(" ")).toContain("unsupported");
  });

  it("normalization is idempotent and does not mutate configured rules", () => {
    const configuredRules = [
      { field: "status", order: ["pending", "in_progress", "completed"] },
      { field: "id", direction: "desc" },
    ] as const;
    const first = normalizeTaskSort({ sortSchemaVersion: SORT_SCHEMA_VERSION, sortRules: configuredRules });
    first.rules.reverse();
    const second = normalizeTaskSort({ sortSchemaVersion: SORT_SCHEMA_VERSION, sortRules: configuredRules });
    const third = normalizeTaskSort({ sortSchemaVersion: SORT_SCHEMA_VERSION, sortRules: second.rules });
    expect(second.rules).toEqual(third.rules);
    expect(configuredRules[0].field).toBe("status");
  });

  it("matches the old comparator exactly across varied task sets and every legacy combination", () => {
    let seed = 0x12345678;
    const random = () => {
      seed = (1664525 * seed + 1013904223) >>> 0;
      return seed;
    };
    const statuses: TaskStatus[] = ["pending", "in_progress", "completed"];
    for (let sample = 0; sample < 100; sample++) {
      const tasks = Array.from({ length: 25 }, (_, index) =>
        task(String(index + 1), statuses[random() % statuses.length], random() % 7));
      for (const sortOrder of ["id", "status", "recent", "oldest"] as LegacyTaskSortOrder[]) {
        for (const reverseSort of [false, true]) {
          const expected = legacySort(tasks, sortOrder, reverseSort).map(item => item.id);
          const actual = sortTasks(tasks, { sortOrder, reverseSort }).map(item => item.id);
          expect(actual).toEqual(expected);
        }
      }
    }
  });
});
