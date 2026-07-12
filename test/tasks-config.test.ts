import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SORT_SCHEMA_VERSION } from "../src/task-sort.js";
import { writeTasksConfig } from "../src/tasks-config.js";

describe("task configuration writes", () => {
  it("atomically replaces the complete JSON document without leaving temporary files", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-tasks-config-"));
    const path = join(directory, "nested", "tasks-config.json");
    try {
      writeTasksConfig(path, { showAll: true, sortOrder: "recent" });
      writeTasksConfig(path, {
        showAll: false,
        sortSchemaVersion: SORT_SCHEMA_VERSION,
        sortRules: [{ field: "id", direction: "desc" }],
      });

      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        showAll: false,
        sortSchemaVersion: SORT_SCHEMA_VERSION,
        sortRules: [{ field: "id", direction: "desc" }],
      });
      expect(readdirSync(join(directory, "nested"))).toEqual(["tasks-config.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves the existing document and cleans up when serialization fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-tasks-config-failure-"));
    const path = join(directory, "tasks-config.json");
    try {
      writeTasksConfig(path, { showAll: true });
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      expect(() => writeTasksConfig(path, circular as any)).toThrow();
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ showAll: true });
      expect(readdirSync(directory)).toEqual(["tasks-config.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
