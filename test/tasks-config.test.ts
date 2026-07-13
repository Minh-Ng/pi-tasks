import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTasksConfig, saveTasksConfig, type TasksConfigPaths } from "../src/tasks-config.js";

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("tasks config persistence", () => {
  let root: string;
  let paths: Required<TasksConfigPaths>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pi-tasks-config-"));
    paths = {
      projectPath: join(root, "project-a", ".pi", "tasks-config.json"),
      globalPath: join(root, "home", ".pi", "agent", "tasks-config.json"),
    };
    mkdirSync(dirname(paths.projectPath), { recursive: true });
    mkdirSync(dirname(paths.globalPath), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("saves auto-clear globally while keeping other settings project-local", () => {
    saveTasksConfig({
      autoClearCompleted: "on_task_complete",
      maxVisible: 20,
      taskScope: "project",
    }, paths);

    expect(readJson(paths.projectPath)).toEqual({
      maxVisible: 20,
      taskScope: "project",
    });
    expect(readJson(paths.globalPath)).toEqual({
      autoClearCompleted: "on_task_complete",
    });
  });

  it("loads the global auto-clear preference in another project", () => {
    saveTasksConfig({ autoClearCompleted: "on_task_complete" }, paths);
    const otherProject = join(root, "project-b", ".pi", "tasks-config.json");
    mkdirSync(dirname(otherProject), { recursive: true });
    writeFileSync(otherProject, JSON.stringify({ showAll: true }), { flag: "w" });

    expect(loadTasksConfig({ ...paths, projectPath: otherProject })).toEqual({
      showAll: true,
      autoClearCompleted: "on_task_complete",
    });
  });

  it("migrates a legacy per-project auto-clear preference to global config", () => {
    writeFileSync(paths.projectPath, JSON.stringify({
      autoClearCompleted: "on_task_complete",
      sortOrder: "recent",
    }), { flag: "w" });

    expect(loadTasksConfig(paths)).toEqual({
      autoClearCompleted: "on_task_complete",
      sortOrder: "recent",
    });
    expect(readJson(paths.globalPath)).toEqual({
      autoClearCompleted: "on_task_complete",
    });
  });

  it("lets the global preference override stale project values", () => {
    writeFileSync(paths.projectPath, JSON.stringify({
      autoClearCompleted: "never",
    }), { flag: "w" });
    writeFileSync(paths.globalPath, JSON.stringify({
      autoClearCompleted: "on_task_complete",
    }), { flag: "w" });

    expect(loadTasksConfig(paths).autoClearCompleted).toBe("on_task_complete");
  });
});
