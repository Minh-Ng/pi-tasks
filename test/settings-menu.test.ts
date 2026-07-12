import { describe, expect, it } from "vitest";
import type { TasksConfig } from "../src/tasks-config.js";
import { updateTaskSortSetting } from "../src/ui/settings-menu.js";

describe("sorting settings migration", () => {
  it("materializes the complete legacy recent sort before changing status order", () => {
    const cfg: TasksConfig = { sortOrder: "recent" };

    expect(updateTaskSortSetting(cfg, "statusOrder", "pending → active → completed")).toBe(true);
    expect(cfg).toMatchObject({
      sortBy: "updated",
      sortDirection: "desc",
      statusOrder: ["pending", "in_progress", "completed"],
    });
    expect(cfg).not.toHaveProperty("sortOrder");
    expect(cfg).not.toHaveProperty("reverseSort");
  });

  it("materializes legacy reverse status groups before changing direction", () => {
    const cfg: TasksConfig = { sortOrder: "status", reverseSort: true };

    expect(updateTaskSortSetting(cfg, "sortDirection", "asc")).toBe(true);
    expect(cfg).toEqual({
      sortBy: "status",
      sortDirection: "asc",
      statusOrder: ["pending", "in_progress", "completed"],
    });
  });

  it.each([
    ["created", "id"],
    ["updated", "updated"],
    ["status", "status"],
  ] as const)("maps the visible sort-by value %s to %s", (visibleValue, sortBy) => {
    const cfg: TasksConfig = { sortOrder: "oldest" };
    updateTaskSortSetting(cfg, "sortBy", visibleValue);
    expect(cfg).toMatchObject({ sortBy, sortDirection: "asc" });
  });

  it("does not mutate config for unrelated settings", () => {
    const cfg: TasksConfig = { sortOrder: "recent", showAll: true };
    expect(updateTaskSortSetting(cfg, "showAll", "off")).toBe(false);
    expect(cfg).toEqual({ sortOrder: "recent", showAll: true });
  });

  it("rejects an unknown status-order option without partially migrating config", () => {
    const cfg: TasksConfig = { sortOrder: "recent" };
    expect(updateTaskSortSetting(cfg, "statusOrder", "unknown")).toBe(false);
    expect(cfg).toEqual({ sortOrder: "recent" });
  });
});
