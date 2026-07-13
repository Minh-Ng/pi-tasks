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

  it("saves a global default while keeping other settings project-local", () => {
    saveTasksConfig({
      autoClearCompleted: "on_task_complete",
      globalAutoClearCompleted: "on_task_complete",
      autoClearCompletedSource: "global",
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

  it("loads the global default in a project without an override", () => {
    writeFileSync(paths.globalPath, JSON.stringify({
      autoClearCompleted: "on_task_complete",
    }));
    writeFileSync(paths.projectPath, JSON.stringify({ showAll: true }));

    expect(loadTasksConfig(paths)).toEqual({
      showAll: true,
      autoClearCompleted: "on_task_complete",
      globalAutoClearCompleted: "on_task_complete",
      autoClearCompletedSource: "global",
    });
  });

  it("gives a project override precedence over the global default", () => {
    writeFileSync(paths.globalPath, JSON.stringify({
      autoClearCompleted: "on_task_complete",
    }));
    writeFileSync(paths.projectPath, JSON.stringify({
      autoClearCompleted: "never",
    }));

    expect(loadTasksConfig(paths)).toEqual({
      autoClearCompleted: "never",
      globalAutoClearCompleted: "on_task_complete",
      autoClearCompletedSource: "project",
    });
  });

  it("seeds the global default from a legacy project value without removing its override", () => {
    writeFileSync(paths.projectPath, JSON.stringify({
      autoClearCompleted: "on_task_complete",
      sortOrder: "recent",
    }));

    expect(loadTasksConfig(paths)).toEqual({
      autoClearCompleted: "on_task_complete",
      sortOrder: "recent",
      globalAutoClearCompleted: "on_task_complete",
      autoClearCompletedSource: "project",
    });
    expect(readJson(paths.globalPath)).toEqual({
      autoClearCompleted: "on_task_complete",
    });
  });

  it("removes a project override when switched back to the global default", () => {
    writeFileSync(paths.projectPath, JSON.stringify({
      autoClearCompleted: "never",
      maxVisible: 15,
    }));
    writeFileSync(paths.globalPath, JSON.stringify({
      autoClearCompleted: "on_task_complete",
    }));
    const config = loadTasksConfig(paths);

    config.autoClearCompletedSource = "global";
    config.autoClearCompleted = config.globalAutoClearCompleted;
    saveTasksConfig(config, paths);

    expect(readJson(paths.projectPath)).toEqual({ maxVisible: 15 });
    expect(loadTasksConfig(paths).autoClearCompleted).toBe("on_task_complete");
  });

  it("retains project-local behavior for callers without source metadata", () => {
    saveTasksConfig({ autoClearCompleted: "never" }, paths);

    expect(readJson(paths.projectPath)).toEqual({ autoClearCompleted: "never" });
    expect(loadTasksConfig(paths).autoClearCompletedSource).toBe("project");
  });
});
