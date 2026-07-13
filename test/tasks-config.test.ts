import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTasksConfigLayerValue,
  loadTasksConfig,
  type PersistedTasksConfig,
  saveTasksConfig,
  setTasksConfigLayerValue,
  TASKS_CONFIG_DEFAULTS,
  type TasksConfigKey,
  type TasksConfigPaths,
} from "../src/tasks-config.js";

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("layered tasks config persistence", () => {
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

  it("uses built-in defaults when neither layer defines a setting", () => {
    const config = loadTasksConfig(paths);

    for (const [key, value] of Object.entries(TASKS_CONFIG_DEFAULTS)) {
      expect(config[key as TasksConfigKey]).toBe(value);
    }
    expect(config.configLayers).toEqual({ global: {}, project: {} });
  });

  it("merges project overrides over global defaults", () => {
    writeFileSync(paths.globalPath, JSON.stringify({
      taskScope: "project",
      autoCascade: true,
      autoClearCompleted: "on_task_complete",
      autoClearDelayTurns: 8,
      showAll: true,
      maxVisible: 30,
      sortOrder: "recent",
      hiddenAt: "top",
    }));
    writeFileSync(paths.projectPath, JSON.stringify({
      taskScope: "session",
      autoClearDelayTurns: 2,
      maxVisible: 15,
    }));

    const config = loadTasksConfig(paths);
    expect(config).toMatchObject({
      taskScope: "session",
      autoCascade: true,
      autoClearCompleted: "on_task_complete",
      autoClearDelayTurns: 2,
      showAll: true,
      maxVisible: 15,
      sortOrder: "recent",
      hiddenAt: "top",
    });
  });

  it("can set every setting globally through the generic layer API", () => {
    const config = loadTasksConfig(paths);
    const values: Required<PersistedTasksConfig> = {
      taskScope: "project",
      autoCascade: true,
      autoClearCompleted: "on_task_complete",
      autoClearDelayTurns: 6,
      showAll: true,
      maxVisible: 50,
      sortOrder: "oldest",
      hiddenAt: "top",
    };

    for (const [key, value] of Object.entries(values)) {
      setTasksConfigLayerValue(
        config,
        "global",
        key as TasksConfigKey,
        value,
        paths,
      );
    }

    expect(readJson(paths.globalPath)).toEqual(values);
    expect(loadTasksConfig({ ...paths, projectPath: join(root, "other", ".pi", "tasks-config.json") }))
      .toMatchObject(values);
  });

  it("can override and then inherit any setting at project level", () => {
    const config = loadTasksConfig(paths);
    setTasksConfigLayerValue(config, "global", "autoClearDelayTurns", 8, paths);
    setTasksConfigLayerValue(config, "project", "autoClearDelayTurns", 2, paths);

    expect(config.autoClearDelayTurns).toBe(2);
    expect(getTasksConfigLayerValue(config, "project", "autoClearDelayTurns")).toBe(2);

    setTasksConfigLayerValue(config, "project", "autoClearDelayTurns", undefined, paths);
    expect(config.autoClearDelayTurns).toBe(8);
    expect(readJson(paths.projectPath)).toEqual({});
  });

  it("preserves legacy project files as overrides", () => {
    writeFileSync(paths.globalPath, JSON.stringify({ autoClearCompleted: "on_task_complete" }));
    writeFileSync(paths.projectPath, JSON.stringify({
      autoClearCompleted: "never",
      maxVisible: 20,
    }));

    const config = loadTasksConfig(paths);
    expect(config.autoClearCompleted).toBe("never");
    expect(config.maxVisible).toBe(20);
    expect(config.configLayers?.project).toEqual({
      autoClearCompleted: "never",
      maxVisible: 20,
    });
  });

  it("ignores malformed and out-of-range values in either layer", () => {
    writeFileSync(paths.globalPath, JSON.stringify({
      autoClearDelayTurns: 0,
      maxVisible: -1,
      autoCascade: "yes",
      hiddenAt: "middle",
    }));

    expect(loadTasksConfig(paths)).toMatchObject(TASKS_CONFIG_DEFAULTS);
  });

  it("retains backward-compatible project-local full saves", () => {
    const expected = { autoClearCompleted: "never", maxVisible: 15 } as const;
    const config = { ...expected };
    saveTasksConfig(config, paths);

    expect(readJson(paths.projectPath)).toEqual(expected);
    expect(loadTasksConfig(paths)).toMatchObject(expected);
  });
});
