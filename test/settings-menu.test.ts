import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTasksConfig, type TasksConfigPaths } from "../src/tasks-config.js";
import { openSettingsMenu, type SettingsUI } from "../src/ui/settings-menu.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getSettingsListTheme: () => ({
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: ">",
    hint: (text: string) => text,
  }),
}));

const down = "\u001b[B";
const enter = "\r";
const escapeKey = "\u001b";
const theme = { bold: (text: string) => text, fg: (_color: string, text: string) => text };

function scriptedUI(inputs: string[]): SettingsUI {
  return {
    async custom(factory) {
      let finish!: () => void;
      const completed = new Promise<void>((resolve) => { finish = resolve; });
      const component = factory({}, theme, {}, finish);
      for (const input of inputs) component.handleInput(input);
      await completed;
      return undefined as never;
    },
  };
}

describe("layered settings menu", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("edits global defaults, project overrides, and inherit through one generic UI", async () => {
    root = mkdtempSync(join(tmpdir(), "pi-tasks-settings-"));
    const paths: TasksConfigPaths = {
      projectPath: join(root, "project", ".pi", "tasks-config.json"),
      globalPath: join(root, "home", ".pi", "agent", "tasks-config.json"),
    };
    let config = loadTasksConfig(paths);

    // Scope starts at project. Enter wraps it to global, then set taskScope
    // from inherit to memory.
    await openSettingsMenu(
      scriptedUI([enter, down, enter, escapeKey]),
      config,
      async () => {},
      4,
      paths,
    );
    expect(JSON.parse(readFileSync(paths.globalPath!, "utf-8"))).toEqual({
      taskScope: "memory",
    });

    // Reopen in project scope and cycle taskScope from inherit to session.
    config = loadTasksConfig(paths);
    await openSettingsMenu(
      scriptedUI([down, enter, enter, escapeKey]),
      config,
      async () => {},
      4,
      paths,
    );
    expect(config.taskScope).toBe("session");
    expect(JSON.parse(readFileSync(paths.projectPath!, "utf-8"))).toEqual({
      taskScope: "session",
    });

    // Cycle project taskScope from session through project to inherit.
    await openSettingsMenu(
      scriptedUI([down, enter, enter, escapeKey]),
      config,
      async () => {},
      4,
      paths,
    );
    expect(config.taskScope).toBe("memory");
    expect(JSON.parse(readFileSync(paths.projectPath!, "utf-8"))).toEqual({});
  });
});
