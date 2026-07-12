import { describe, expect, it } from "vitest";
import { SORT_SCHEMA_VERSION } from "../src/task-sort.js";
import type { TasksConfig } from "../src/tasks-config.js";
import { updateTaskSortSetting } from "../src/ui/settings-menu.js";

describe("sorting settings migration", () => {
  it("materializes legacy recent direction when selecting a status order", () => {
    const cfg: TasksConfig = { sortOrder: "recent" };

    expect(updateTaskSortSetting(cfg, "statusOrder", "pending → active → completed")).toBe(true);
    expect(cfg).toEqual({
      sortSchemaVersion: SORT_SCHEMA_VERSION,
      sortRules: [
        { field: "status", order: ["pending", "in_progress", "completed"] },
        { field: "updatedAt", direction: "desc" },
        { field: "id", direction: "desc" },
      ],
    });
  });

  it("materializes legacy reverse status groups before changing direction", () => {
    const cfg: TasksConfig = { sortOrder: "status", reverseSort: true };

    expect(updateTaskSortSetting(cfg, "sortDirection", "asc")).toBe(true);
    expect(cfg).toEqual({
      sortSchemaVersion: SORT_SCHEMA_VERSION,
      sortRules: [
        { field: "status", order: ["pending", "in_progress", "completed"] },
        { field: "id", direction: "asc" },
      ],
    });
  });

  it.each([
    ["created", [{ field: "id", direction: "asc" }]],
    ["updated", [{ field: "updatedAt", direction: "asc" }, { field: "id", direction: "asc" }]],
    ["status", [
      { field: "status", order: ["completed", "in_progress", "pending"] },
      { field: "id", direction: "asc" },
    ]],
  ] as const)("maps the visible sort-by value %s to versioned rules", (visibleValue, sortRules) => {
    const cfg: TasksConfig = { sortOrder: "oldest" };
    updateTaskSortSetting(cfg, "sortBy", visibleValue);
    expect(cfg).toEqual({ sortSchemaVersion: SORT_SCHEMA_VERSION, sortRules });
  });

  it("preserves advanced rule levels when changing direction", () => {
    const cfg: TasksConfig = {
      sortSchemaVersion: SORT_SCHEMA_VERSION,
      sortRules: [
        { field: "status", order: ["in_progress", "pending", "completed"] },
        { field: "updatedAt", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    };
    updateTaskSortSetting(cfg, "sortDirection", "asc");
    expect(cfg.sortRules).toEqual([
      { field: "status", order: ["in_progress", "pending", "completed"] },
      { field: "updatedAt", direction: "asc" },
      { field: "id", direction: "asc" },
    ]);
  });

  it("preserves secondary rules when changing an existing status order", () => {
    const cfg: TasksConfig = {
      sortSchemaVersion: SORT_SCHEMA_VERSION,
      sortRules: [
        { field: "status", order: ["completed", "in_progress", "pending"] },
        { field: "updatedAt", direction: "desc" },
        { field: "id", direction: "asc" },
      ],
    };
    updateTaskSortSetting(cfg, "statusOrder", "pending → active → completed");
    expect(cfg.sortRules).toEqual([
      { field: "status", order: ["pending", "in_progress", "completed"] },
      { field: "updatedAt", direction: "desc" },
      { field: "id", direction: "asc" },
    ]);
  });

  it("promotes a secondary status rule when selecting a status order", () => {
    const cfg: TasksConfig = {
      sortSchemaVersion: SORT_SCHEMA_VERSION,
      sortRules: [
        { field: "updatedAt", direction: "desc" },
        { field: "status", order: ["completed", "in_progress", "pending"] },
        { field: "id", direction: "asc" },
      ],
    };
    updateTaskSortSetting(cfg, "statusOrder", "active → pending → completed");
    expect(cfg.sortRules).toEqual([
      { field: "status", order: ["in_progress", "pending", "completed"] },
      { field: "updatedAt", direction: "desc" },
      { field: "id", direction: "asc" },
    ]);
  });

  it("preserves unrelated configuration fields while replacing old sort fields", () => {
    const cfg: TasksConfig = { sortOrder: "recent", showAll: true, maxVisible: 20 };
    updateTaskSortSetting(cfg, "sortDirection", "asc");
    expect(cfg.showAll).toBe(true);
    expect(cfg.maxVisible).toBe(20);
    expect(cfg).not.toHaveProperty("sortOrder");
  });

  it("does not mutate config for unrelated settings", () => {
    const cfg: TasksConfig = { sortOrder: "recent", showAll: true };
    expect(updateTaskSortSetting(cfg, "showAll", "off")).toBe(false);
    expect(cfg).toEqual({ sortOrder: "recent", showAll: true });
  });

  it.each([
    ["statusOrder", "unknown"],
    ["sortDirection", "sideways"],
    ["sortBy", "random"],
  ])("rejects invalid %s without partially migrating config", (id, value) => {
    const cfg: TasksConfig = { sortOrder: "recent" };
    expect(updateTaskSortSetting(cfg, id, value)).toBe(false);
    expect(cfg).toEqual({ sortOrder: "recent" });
  });
});
