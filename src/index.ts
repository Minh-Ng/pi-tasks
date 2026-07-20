/**
 * @tintinweb/pi-tasks — A pi extension providing Claude Code-style task tracking and coordination.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields, status, dependencies
 *   TaskOutput   — Get output from a background task process
 *   TaskStop     — Stop a running background task process
 *   TaskExecute  — Execute tasks as subagents (requires @tintinweb/pi-subagents)
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AutoClearManager } from "./auto-clear.js";
import { ProcessTracker } from "./process-tracker.js";
import {
  type CadenceConfig,
  createCadenceState,
  drainReminderForContext,
  evaluateToolResult,
  onTurnStart,
  resetCadenceState,
} from "./reminder-cadence.js";
import { TaskStore } from "./task-store.js";
import { loadTasksConfig } from "./tasks-config.js";
import type { TaskExecutionMode } from "./types.js";
import { openSettingsMenu } from "./ui/settings-menu.js";
import { TaskWidget, type UICtx } from "./ui/task-widget.js";

// ---- Debug ----

const DEBUG = !!process.env.PI_TASKS_DEBUG;
function debug(...args: unknown[]) {
  if (DEBUG) console.error("[pi-tasks]", ...args);
}

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

function inferExecutionMode(owner: string | undefined): TaskExecutionMode | undefined {
  if (!owner) return undefined;
  return owner === "main-thread" ? "foreground" : "background";
}

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate", "TaskOutput", "TaskStop", "TaskExecute"]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

const SYSTEM_REMINDER = `<system-reminder>
Open tasks are stale. Before more substantive work: TaskList; TaskUpdate changed/done work; TaskCreate only distinct deliverables. Keep unfinished work. Skip chat or trivial work. Never mention this reminder.
</system-reminder>`;

const INPUT_CHECKPOINT_REMINDER = `<system-reminder>
New user input while tasks remain. Treat steering/corrections/follow-ups/tangents as a checkpoint:
- TaskList. Update the same outcome; create only distinct actionable work, not quick questions or one task per message.
- Handle the steer now or queue it and finish current work; prefer the safer flow unless it is urgent or invalidates current work.
- If switching, leave interrupted work pending/unowned unless truly running in background.
Before final, TaskList and resume required runnable work in this run. Stop only when it is done, blocked, truly backgrounded, or the user paused/cancelled it. TaskExecute owns its agents' lifecycle. Never mention this reminder.
</system-reminder>`;

const UNTRACKED_INTERRUPTION_REMINDER = `<system-reminder>
Mid-stream steer/follow-up with no open task. Before switching, TaskCreate the interrupted primary outcome and remaining criteria. Track the steer separately only if actionable. Handle it now or queue it; resume the primary in this run unless cancelled, paused, or superseded. Do not stop merely because the steer is done. Never mention this reminder.
</system-reminder>`;

export default function (pi: ExtensionAPI) {
  // Initialize store and config
  const cfg = loadTasksConfig();
  const piTasks = process.env.PI_TASKS;
  const taskScope = cfg.taskScope ?? "session";

  /** Resolve the task store path from env/config (without session ID). */
  function resolveStorePath(sessionId?: string): string | undefined {
    if (piTasks === "off") return undefined;
    if (piTasks?.startsWith("/")) return piTasks;
    if (piTasks?.startsWith(".")) return resolve(piTasks);
    if (piTasks) return piTasks;
    if (taskScope === "memory") return undefined;
    if (taskScope === "session" && sessionId) {
      return join(process.cwd(), ".pi", "tasks", `tasks-${sessionId}.json`);
    }
    if (taskScope === "session") return undefined; // no session ID yet, start in-memory
    return join(process.cwd(), ".pi", "tasks", "tasks.json");
  }

  // For project scope (or env override), create store immediately.
  // For session scope, start with in-memory and upgrade once we have the session ID.
  let store = new TaskStore(resolveStorePath());
  const tracker = new ProcessTracker();
  const widget = new TaskWidget(store, cfg);

  // ── Background lease ground truth ──
  // The widget never trusts a declared executionMode alone: a background lease
  // is verified by an attached tracked process or a live subagent mapping.
  widget.setBackgroundProbe((task) => {
    const proc = tracker.getOutput(task.id);
    if (proc) {
      if (proc.status === "running") return { state: "running" };
      return {
        state: "exited",
        ok: proc.status === "completed",
        detail: proc.exitCode !== undefined ? `exit ${proc.exitCode}` : proc.status,
      };
    }
    const agentId = task.metadata?.agentId;
    if (agentId && agentTaskMap.has(agentId)) return { state: "running" };
    return { state: "unverified" };
  });

  // ── Subagent integration state ──
  /** Latest ExtensionContext — refreshed on every tool execution so cascade always has a valid one. */
  let latestCtx: ExtensionContext | undefined;
  /** Cascade config — set by TaskExecute, consumed by completion listener. */
  let cascadeConfig: { additionalContext?: string; model?: string; maxTurns?: number } | undefined;
  /** Maps agent IDs to task IDs for O(1) completion lookup. */
  const agentTaskMap = new Map<string, string>();

  // ── Subagent RPC helpers ──

  /** RPC reply envelope — matches pi-mono's RpcResponse shape. */
  type RpcReply<T = void> =
    | { success: true; data?: T }
    | { success: false; error: string };

  /** Call a subagents RPC method: emit request, wait for scoped reply, unwrap envelope. */
  function rpcCall<T>(channel: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const requestId = randomUUID();
    debug(`rpc:send ${channel}`, { requestId });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        debug(`rpc:timeout ${channel}`, { requestId });
        reject(new Error(`${channel} timeout`));
      }, timeoutMs);
      const unsub = pi.events.on(`${channel}:reply:${requestId}`, (raw: unknown) => {
        unsub(); clearTimeout(timer);
        debug(`rpc:reply ${channel}`, { requestId, raw });
        const reply = raw as RpcReply<T>;
        if (reply.success) resolve(reply.data as T);
        else reject(new Error(reply.error));
      });
      pi.events.emit(channel, { requestId, ...params });
      debug(`rpc:emitted ${channel}`, { requestId });
    });
  }

  /** Spawn a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function spawnSubagent(type: string, prompt: string, options?: any): Promise<string> {
    debug("spawn:call", { type, options: { ...options, prompt: undefined } });
    return rpcCall<{ id: string }>("subagents:rpc:spawn", { type, prompt, options }, 30_000)
      .then(d => { debug("spawn:ok", d); return d.id; });
  }

  /** Stop a subagent via pi.events RPC (requires @tintinweb/pi-subagents extension). */
  function stopSubagent(agentId: string): Promise<void> {
    return rpcCall<void>("subagents:rpc:stop", { agentId }, 10_000).catch(() => {});
  }

  // ── Subagent extension presence & version detection ──
  const PROTOCOL_VERSION = 2;
  let subagentsAvailable = false;
  let pendingWarning: string | undefined;

  /** Ping subagents and check protocol version. Works with any handler version. */
  function checkSubagentsVersion() {
    const requestId = randomUUID();
    const timer = setTimeout(() => { unsub(); }, 5_000);
    const unsub = pi.events.on(`subagents:rpc:ping:reply:${requestId}`, (raw: unknown) => {
      unsub(); clearTimeout(timer);
      const remoteVersion = (raw as any)?.data?.version as number | undefined;
      if (remoteVersion === undefined) {
        pendingWarning =
          "@tintinweb/pi-subagents is outdated — please update for task execution support.";
      } else if (remoteVersion > PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-tasks is outdated (protocol v${PROTOCOL_VERSION}, ` +
          `pi-subagents has v${remoteVersion}) — please update for task execution support.`;
      } else if (remoteVersion < PROTOCOL_VERSION) {
        pendingWarning =
          `@tintinweb/pi-subagents is outdated (protocol v${remoteVersion}, ` +
          `pi-tasks has v${PROTOCOL_VERSION}) — please update for task execution support.`;
      } else {
        subagentsAvailable = true;
      }
    });
    pi.events.emit("subagents:rpc:ping", { requestId });
  }

  checkSubagentsVersion();
  pi.events.on("subagents:ready", () => checkSubagentsVersion());

  /** Build a prompt for a task being executed by a subagent.
   *  Injects completed dependency results so cascaded agents have context from prerequisites.
   */
  function buildTaskPrompt(
    task: { id: string; subject: string; description: string; blockedBy?: string[] },
    additionalContext?: string,
  ): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;

    // Inject completed dependency results so cascaded agents have full context
    if (task.blockedBy && task.blockedBy.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.blockedBy) {
        const dep = store.get(depId);
        if (dep?.metadata?.result) {
          const result = dep.metadata.result.length > 4000
            ? dep.metadata.result.slice(0, 4000) + "\n\n[... truncated — use TaskGet for full output]"
            : dep.metadata.result;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${result}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  const autoClear = new AutoClearManager(
    () => store,
    () => cfg.autoClearCompleted ?? "on_list_complete",
    () => cfg.autoClearDelayTurns ?? 4,
  );

  // ── Subagent completion listener ──
  // Listens for subagent lifecycle events to update task status and optionally cascade.

  // Success → mark task completed, cascade if enabled
  pi.events.on("subagents:completed", async (data) => {
    const { id, result } = data as { id: string; result?: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    store.update(task.id, { status: "completed", metadata: { ...task.metadata, result } });
    widget.setActiveTask(task.id, false);

    // Auto-cascade: find unblocked dependents with agentType
    if ((cfg.autoCascade ?? false) && cascadeConfig && latestCtx) {
      const unblocked = store.list().filter(t =>
        t.status === "pending" &&
        t.metadata?.agentType &&
        t.blockedBy.includes(task.id) &&
        t.blockedBy.every(depId => store.get(depId)?.status === "completed")
      );
      for (const next of unblocked) {
        store.update(next.id, { status: "in_progress" });
        const prompt = buildTaskPrompt(next, cascadeConfig.additionalContext);
        try {
          const agentId = await spawnSubagent(next.metadata.agentType, prompt, {
            description: next.subject,
            isBackground: true,
            maxTurns: cascadeConfig.maxTurns,
            ...(cascadeConfig.model ? { model: cascadeConfig.model } : {}),
          });
          agentTaskMap.set(agentId, next.id);
          store.update(next.id, { owner: agentId, executionMode: "background", metadata: { ...next.metadata, agentId } });
          widget.setActiveTask(next.id, true, "background", true);
        } catch (err: any) {
          store.update(next.id, { status: "pending", metadata: { ...next.metadata, lastError: err.message } });
        }
      }
    }
    autoClear.trackCompletion(task.id, cadence.currentTurn);
    widget.update();
  });

  // Failure → store error, revert to pending, don't cascade (branch stops)
  // Intentional stop (status === "stopped") → mark completed, preserve partial result
  pi.events.on("subagents:failed", (data) => {
    const { id, error, result, status } = data as { id: string; error?: string; result?: string; status: string };
    const taskId = agentTaskMap.get(id);
    if (!taskId) return;
    agentTaskMap.delete(id);
    const task = store.get(taskId);
    if (!task) return;

    if (status === "stopped") {
      // Intentional stop — mark completed, preserve partial result
      store.update(task.id, { status: "completed", metadata: { ...task.metadata, result: result || task.metadata?.result } });
      autoClear.trackCompletion(task.id, cadence.currentTurn);
    } else {
      // Actual error — revert to pending
      store.update(task.id, { status: "pending", metadata: { ...task.metadata, lastError: error || status } });
      autoClear.resetBatchCountdown();
    }
    widget.setActiveTask(task.id, false);
    widget.update();
  });

  // ── Session-scoped store upgrade ──
  // For session scope, the store starts in-memory (no session ID at init time).
  // Upgrade to file-backed on first context arrival (turn_start, before_agent_start,
  // or tool_execution_start — whichever fires first).
  let storeUpgraded = false;
  let persistedTasksShown = false;
  function upgradeStoreIfNeeded(ctx: ExtensionContext) {
    if (storeUpgraded) return;
    if (taskScope === "session" && !piTasks) {
      const sessionId = ctx.sessionManager.getSessionId();
      const path = resolveStorePath(sessionId);
      store = new TaskStore(path);
      widget.setStore(store);
    }
    storeUpgraded = true;
  }

  /** Restore widget on session start/resume if there's unfinished work.
   *  On new sessions, auto-clear if all tasks are completed (clean slate).
   *  On resume, always show tasks (user may want to review).
   *  Only runs once — the first caller wins. */
  function showPersistedTasks(isResume = false) {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every(t => t.status === "completed")) {
        store.clearCompleted();
        if (taskScope === "session") store.deleteFileIfEmpty();
      } else {
        widget.update();
      }
    }
  }

  // ── Turn tracking for system-reminder injection ──
  // Cadence decisions live in `reminder-cadence.ts` so they're
  // unit-testable without spinning up a fake ExtensionAPI.
  const cadence = createCadenceState();
  let inputCheckpointDue = false;
  let untrackedInterruptionDue = false;
  const cadenceConfig: CadenceConfig = {
    reminderInterval: REMINDER_INTERVAL,
    taskToolNames: TASK_TOOL_NAMES,
  };

  pi.on("turn_start", async (_event, ctx) => {
    onTurnStart(cadence);
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    if (autoClear.onTurnStart(cadence.currentTurn)) widget.update();
  });

  // Every human/API message is a task-state checkpoint while unfinished work
  // exists. Queueing here catches ordinary prompts, mid-stream steering, and
  // queued follow-ups; the context hook drains it exactly once before the next
  // model call. Extension-authored messages are excluded to avoid self-triggering.
  pi.on("input", async (event) => {
    if (event.source !== "extension") {
      if (store.list().some(task => task.status !== "completed")) {
        inputCheckpointDue = true;
      } else if (event.streamingBehavior === "steer" || event.streamingBehavior === "followUp") {
        untrackedInterruptionDue = true;
      }
    }
    return { action: "continue" as const };
  });

  // ── Agent run lifecycle → execution-state truth ──
  // Between agent_end and the next agent_start the agent is waiting on human
  // input: foreground leases pause (frozen timer, "waiting on input") instead
  // of pretending work continues. On agent_end we also reconcile background
  // leases against ground truth and queue a one-shot reminder for stale ones.
  let pendingStateNotices: string[] = [];

  pi.on("agent_start", async () => {
    widget.setAgentActive(true);
  });

  pi.on("agent_end", async () => {
    widget.setAgentActive(false);
    const notices: string[] = [];
    for (const task of store.list()) {
      if (task.status !== "in_progress") continue;
      const { mode, live } = widget.getExecutionState(task.id);
      if (mode !== "background" || !live) continue;
      const proc = tracker.getOutput(task.id);
      if (proc && proc.status !== "running") {
        notices.push(
          `Task #${task.id} ("${task.subject}") background process ${proc.status === "completed" ? "completed" : `finished with status ${proc.status}`}${proc.exitCode !== undefined ? ` (exit ${proc.exitCode})` : ""}. Harvest its output with TaskOutput and update the task.`,
        );
      } else if (!proc && !(task.metadata?.agentId && agentTaskMap.has(task.metadata.agentId))) {
        notices.push(
          `Task #${task.id} ("${task.subject}") is marked background but no tracked process or subagent is attached (unverified). Reconcile it: mark it completed if the work is done, return it to pending, or set executionMode to none for claimed-but-unmonitored work.`,
        );
      }
    }
    pendingStateNotices = notices;
  });

  // ── Token usage tracking ──
  // Feed per-turn token counts from assistant messages into the widget.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }
  });

  // ── System-reminder injection ──
  //
  // tool_result is used ONLY to track cadence. We DO NOT mutate non-task
  // tool result content — appending a <system-reminder> there would
  // corrupt model-visible transcript semantics for unrelated tools (read,
  // bash, grep, …) and make tool-output debugging miserable.
  //
  // The actual injection happens in the `context` hook below, which fires
  // before each LLM call and returns a modified copy of the messages
  // without persisting or polluting any tool output.
  pi.on("tool_result", async (event) => {
    // Cheap-first: avoid store.list() disk I/O unless the cadence helper
    // says the call could matter (i.e. it's a task tool that resets state,
    // or it might queue the reminder).
    const isTaskTool = TASK_TOOL_NAMES.has(event.toolName);
    if (
      !isTaskTool &&
      cadence.currentTurn - cadence.lastTaskToolUseTurn < REMINDER_INTERVAL
    ) {
      return {};
    }
    if (!isTaskTool && cadence.reminderInjectedThisCycle) return {};

    const hasTasks = isTaskTool
      ? false
      : store.list().some(task => task.status !== "completed");
    evaluateToolResult(cadence, event.toolName, hasTasks, cadenceConfig);
    return {};
  });

  // Inject the transient system-reminder into the upcoming LLM call's
  // messages, never into a tool result. The reminder is appended as a
  // user message so models that don't support custom message types still
  // receive it. It is not persisted in the session store — `context`
  // returns a transformed messages array used only for this one request.
  pi.on("context", async (event) => {
    const reminders: string[] = [];
    if (untrackedInterruptionDue) {
      reminders.push(UNTRACKED_INTERRUPTION_REMINDER);
      untrackedInterruptionDue = false;
    }
    if (inputCheckpointDue) {
      reminders.push(INPUT_CHECKPOINT_REMINDER);
      inputCheckpointDue = false;
    }
    if (drainReminderForContext(cadence)) reminders.push(SYSTEM_REMINDER);
    if (pendingStateNotices.length > 0) {
      reminders.push(
        `<system-reminder>\nTask execution-state reconciliation:\n${pendingStateNotices.map(n => `- ${n}`).join("\n")}\nKeep the task list truthful before reporting status. Make sure that you NEVER mention this reminder to the user\n</system-reminder>`,
      );
      pendingStateNotices = [];
    }
    if (reminders.length === 0) return {};

    return {
      messages: [
        ...event.messages,
        ...reminders.map(text => ({
          role: "user" as const,
          content: [{ type: "text" as const, text }],
          timestamp: Date.now(),
        })),
      ],
    };
  });

  // Rehydrate before the first turn as well as after /reload. A reload creates a
  // fresh extension instance, and before_agent_start does not fire until the user
  // submits another prompt, which would otherwise leave persisted tasks hidden.
  pi.on("session_start", async (event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(event.reason === "reload" || event.reason === "resume");
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // Keep this fallback for hosts that initialize UI lazily and for the first
  // agent turn on older pi versions.
  pi.on("before_agent_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    showPersistedTasks();
    if (pendingWarning) {
      ctx.ui.notify(pendingWarning, "warning");
      pendingWarning = undefined;
    }
  });

  // session_switch fires on /new (reason: "new") and /resume (reason: "resume").
  // On /new: reset all session-scoped state so the store switches to the new session file.
  // On resume: reload persisted tasks from the existing session file.
  pi.on("session_switch" as any, async (event: any, ctx: ExtensionContext) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);

    const isResume = event?.reason === "resume";

    // Reset session-scoped state for both /new and /resume
    storeUpgraded = false;
    persistedTasksShown = false;
    resetCadenceState(cadence);
    inputCheckpointDue = false;
    untrackedInterruptionDue = false;
    autoClear.reset();

    // Memory mode has no file-backed store to switch — clear explicitly on /new
    if (!isResume && taskScope === "memory") {
      store.clearAll();
    }

    upgradeStoreIfNeeded(ctx);
    showPersistedTasks(isResume);
  });

  // Keep latestCtx fresh on every tool execution as well.
  pi.on("tool_execution_start", async (_event, ctx) => {
    latestCtx = ctx;
    widget.setUICtx(ctx.ui as UICtx);
    upgradeStoreIfNeeded(ctx);
    widget.update();
  });

  // ──────────────────────────────────────────────────
  // Tool 1: TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## Task-List Guidance

- Create tasks for multi-step work or distinct deliverables; skip trivial or informational requests.
- Before large, branching, or multi-domain work, decompose it into coherent outcomes that can be owned and verified independently. Do not split trivial linear steps into task-sized overhead.
- Make delegated tasks self-contained: include the objective, scope boundaries, relevant context and constraints, expected deliverable, and observable acceptance criteria.
- Use blockedBy only for real prerequisites. Leave independent tasks unblocked, and create an explicit integration or end-to-end verification task when multiple outputs must combine.
- Never run concurrent write tasks with overlapping scope; partition file/component ownership or serialize the work.
- Update an existing task when the outcome is unchanged; create a new one only for distinct work.
- Mark tasks in_progress only while being worked and completed only when fully done.
- The coordinator must reconcile delegated outputs and verify the integrated result before declaring the user's goal complete.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown while a foreground/background live lease is active (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks
- Include \`agentType\` (e.g., "general-purpose", "Explore") to mark tasks for subagent execution via TaskExecute`,
    promptSnippet: "Decompose meaningful work into independently owned, verifiable tasks",
    promptGuidelines: [
      "For large or branching work, create coherent tasks that can be owned and verified independently; do not task trivial linear steps.",
      "Make delegated tasks self-contained with scope, constraints, deliverables, and observable acceptance criteria.",
      "Encode only real prerequisites as dependencies; add an integration or end-to-end verification task when outputs must combine.",
      "Do not run concurrent write tasks with overlapping scope; partition ownership or serialize them.",
      "Update the same outcome instead of duplicating it, and complete tasks only after their acceptance criteria are verified.",
      "Reconcile delegated outputs and verify the integrated result before declaring the user's goal complete.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown while a live foreground/background execution lease is active (e.g., 'Running tests')" })),
      agentType: Type.Optional(Type.String({ description: "Agent type for subagent execution (e.g., 'general-purpose', 'Explore'). Tasks with agentType can be started via TaskExecute." })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Arbitrary metadata to attach to the task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      autoClear.resetBatchCountdown();
      const meta = params.metadata ?? {};
      if (params.agentType) meta.agentType = params.agentType;
      const task = store.create(params.subject, params.description, params.activeForm, Object.keys(meta).length > 0 ? meta : undefined);
      widget.update();
      return Promise.resolve(textResult(`Task #${task.id} created successfully: ${task.subject}`));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on (status: 'pending', no owner, not blocked)
- To check overall progress on the project
- To find tasks that are blocked and need dependencies resolved
- After completing a task, to check for newly unblocked work or claim the next available task
- When priorities are unclear, pick any task and work on it to completion

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'
- **owner**: Agent ID if assigned, empty if available
- **blockedBy**: List of open task IDs that must be resolved first (tasks with blockedBy cannot be claimed until dependencies resolve)

Use TaskGet with a specific task ID to view full details including description and comments.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      // Sort: pending first (by ID), then in_progress (by ID), then completed (by ID)
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map(task => {
        const execution = widget.getExecutionState(task.id);
        const status = task.status === "in_progress"
          ? execution.live
            ? `in_progress/${execution.mode}`
            : execution.mode
              ? `in_progress/unmonitored-${execution.mode}`
              : "in_progress/claimed"
          : task.status;
        let line = `#${task.id} [${status}] ${task.subject}`;

        if (task.owner) {
          line += ` (${task.owner})`;
        }

        // Only show non-completed blockers
        if (task.blockedBy.length > 0) {
          const openBlockers = task.blockedBy.filter(bid => {
            const blocker = store.get(bid);
            return blocker && blocker.status !== "completed";
          });
          if (openBlockers.length > 0) {
            line += ` [blocked by ${openBlockers.map(id => "#" + id).join(", ")}]`;
          }
        }

        return line;
      });

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- To understand task dependencies (what it blocks, what blocks it)
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'
- **blocks**: Tasks waiting on this one to complete
- **blockedBy**: Tasks that must complete before this one can start

## Tips

- After fetching a task, verify its blockedBy list is empty before beginning work.
- Use TaskList to see all tasks in summary form.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
      ];
      if (task.owner) {
        lines.push(`Owner: ${task.owner}`);
      }
      if (task.status === "in_progress") {
        const execution = widget.getExecutionState(task.id);
        lines.push(`Execution: ${execution.mode ?? "claimed"} (${execution.live ? "live in this session" : "no live lease in this session"})`);
      }
      lines.push(`Description: ${desc}`);

      if (task.blockedBy.length > 0) {
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return blocker && blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          lines.push(`Blocked by: ${openBlockers.map(id => "#" + id).join(", ")}`);
        }
      }
      if (task.blocks.length > 0) {
        lines.push(`Blocks: ${task.blocks.map(id => "#" + id).join(", ")}`);
      }

      // Show metadata if non-empty
      const metaKeys = Object.keys(task.metadata);
      if (metaKeys.length > 0) {
        lines.push(`Metadata: ${JSON.stringify(task.metadata)}`);
      }

      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress with executionMode foreground BEFORE active main-thread work
- Use executionMode background only while a real process/subagent is running; use none for claimed/unmonitored work
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer
- When establishing dependencies between tasks

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown only while a live execution lease is active (e.g., "Running tests")
- **owner**: Change the task owner (agent name)
- **executionMode**: \`foreground\`, \`background\`, or \`none\`. A timer/spinner starts only for an explicit live mode. \`main-thread\` owners infer foreground; other owners infer background for compatibility.
- **metadata**: Merge metadata keys into the task (set a key to null to delete it)
- **addBlocks**: Mark tasks that cannot start until this one completes
- **addBlockedBy**: Mark tasks that must complete before this one can start

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark foreground work as active:
\`\`\`json
{"taskId": "1", "status": "in_progress", "owner": "main-thread", "executionMode": "foreground"}
\`\`\`

Mark a real background process as active:
\`\`\`json
{"taskId": "1", "status": "in_progress", "owner": "pid-1234", "executionMode": "background"}
\`\`\`

Mark work as claimed without implying live execution:
\`\`\`json
{"taskId": "1", "status": "in_progress", "executionMode": "none"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\`

Claim a task by setting owner:
\`\`\`json
{"taskId": "1", "owner": "my-name"}
\`\`\`

Set up task dependencies:
\`\`\`json
{"taskId": "2", "addBlockedBy": ["1"]}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
        type: "string",
        enum: ["pending", "in_progress", "completed", "deleted"],
        description: "New status for the task",
      })),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(Type.String({ description: "Present continuous form shown while a live execution lease is active" })),
      owner: Type.Optional(Type.String({ description: "New owner for the task" })),
      executionMode: Type.Optional(Type.Unsafe<"foreground" | "background" | "none">({
        type: "string",
        enum: ["foreground", "background", "none"],
        description: "Live execution kind. Use none for claimed/unmonitored in-progress work.",
      })),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Metadata keys to merge into the task. Set a key to null to delete it." })),
      addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
      addBlockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that block this task" })),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const current = store.get(params.taskId);
      if (!current) return Promise.resolve(textResult(`Task #${params.taskId} not found`));
      const { taskId, executionMode, ...updates } = params;
      const resultingStatus = updates.status === "deleted" ? "deleted" : (updates.status ?? current.status);
      const resultingOwner = updates.owner ?? current.owner;
      const selectedMode: TaskExecutionMode | null | undefined = executionMode === "none"
        ? null
        : executionMode ?? ((updates.status === "in_progress" || updates.owner !== undefined)
          ? inferExecutionMode(resultingOwner)
          : undefined);
      if (selectedMode && resultingStatus !== "in_progress") {
        return Promise.resolve(textResult("executionMode requires status in_progress"));
      }
      const fields = {
        ...updates,
        ...(selectedMode !== undefined ? { executionMode: selectedMode } : {}),
      };
      const { task, changedFields, warnings } = store.update(taskId, fields);

      if (changedFields.length === 0 && !task) {
        return Promise.resolve(textResult(`Task #${taskId} not found`));
      }

      const establishesLiveLease = selectedMode !== undefined || updates.status === "in_progress";
      if (task?.status === "in_progress" && task.executionMode && establishesLiveLease) {
        widget.setActiveTask(taskId, true, task.executionMode, true);
        autoClear.resetBatchCountdown();
      } else if (selectedMode === null || (fields.status !== undefined && fields.status !== "in_progress")) {
        widget.setActiveTask(taskId, false);
        if (fields.status === "pending") autoClear.resetBatchCountdown();
        if (fields.status === "completed") autoClear.trackCompletion(taskId, cadence.currentTurn);
      }

      widget.update();
      let msg = `Updated task #${taskId} ${changedFields.join(", ")}`;
      if (warnings.length > 0) {
        msg += ` (warning: ${warnings.join("; ")})`;
      }
      return Promise.resolve(textResult(msg));
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 5: TaskOutput
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskOutput",
    label: "TaskOutput",
    description: `- Retrieves output from a running or completed task (background shell, agent, or remote session)
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status
- Task IDs can be found using the /tasks command
- Works with all task types: background shells, async agents, and remote sessions`,
    parameters: Type.Object({
      task_id: Type.String({ description: "The task ID to get output from" }),
      block: Type.Boolean({ description: "Whether to wait for completion", default: true }),
      timeout: Type.Number({ description: "Max wait time in ms", default: 30000, minimum: 0, maximum: 600000 }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
      const { task_id, block, timeout } = params;

      const processOutput = tracker.getOutput(task_id);
      if (!processOutput) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs (resolve agent ID → task ID)
        let resolvedId = task_id;
        if (!store.get(resolvedId)) {
          // Check if this is an agent ID mapped to a task
          for (const [agentId, taskId] of agentTaskMap) {
            if (agentId === task_id || agentId.startsWith(task_id)) { resolvedId = taskId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (!task) throw new Error(`No task found with ID ${task_id}`);

        if (task.metadata?.agentId) {
          // Subagent task — wait for completion if blocking
          if (block && task.status === "in_progress") {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => { unsubOk(); unsubFail(); resolve(); }, timeout ?? 30000);
              const cleanup = () => { clearTimeout(timer); resolve(); };
              const unsubOk = pi.events.on("subagents:completed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              const unsubFail = pi.events.on("subagents:failed", (d: unknown) => {
                if ((d as any).id === task.metadata?.agentId) { unsubOk(); unsubFail(); cleanup(); }
              });
              // Re-check in case status changed between the outer check and listener registration
              const current = store.get(task_id);
              if (current && current.status !== "in_progress") { unsubOk(); unsubFail(); cleanup(); }
              signal?.addEventListener("abort", () => { unsubOk(); unsubFail(); cleanup(); }, { once: true });
            });
          }
          const updated = store.get(task_id) ?? task;
          return textResult(`Task #${task_id} [${updated.status}] — subagent ${task.metadata.agentId}`);
        }
        throw new Error(`No background process for task ${task_id}`);
      }

      if (block && processOutput.status === "running") {
        const result = await tracker.waitForCompletion(task_id, timeout ?? 30000, signal ?? undefined);
        if (result) {
          return textResult(
            `Task #${task_id} (${result.status})${result.exitCode !== undefined ? ` exit code: ${result.exitCode}` : ""}\n\n${result.output}`,
          );
        }
      }

      return textResult(
        `Task #${task_id} (${processOutput.status})${processOutput.exitCode !== undefined ? ` exit code: ${processOutput.exitCode}` : ""}\n\n${processOutput.output}`,
      );
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 6: TaskStop
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskStop",
    label: "TaskStop",
    description: `
- Stops a running background task by its ID
- Takes a task_id parameter identifying the task to stop
- Returns a success or failure status
- Use this tool when you need to terminate a long-running task`,
    parameters: Type.Object({
      task_id: Type.Optional(Type.String({ description: "The ID of the background task to stop" })),
      shell_id: Type.Optional(Type.String({ description: "Deprecated: use task_id instead" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const taskId = params.task_id ?? params.shell_id;
      if (!taskId) throw new Error("task_id is required");

      const stopped = await tracker.stop(taskId);
      if (!stopped) {
        // No shell process — check if this is a subagent task
        // Support both task IDs and agent IDs
        let resolvedId = taskId;
        if (!store.get(resolvedId)) {
          for (const [agentId, tId] of agentTaskMap) {
            if (agentId === taskId || agentId.startsWith(taskId)) { resolvedId = tId; break; }
          }
        }
        const task = store.get(resolvedId);
        if (task?.metadata?.agentId && task.status === "in_progress") {
          store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, cadence.currentTurn);
          await stopSubagent(task.metadata.agentId);
          widget.setActiveTask(taskId, false);
          widget.update();
          return textResult(`Task #${taskId} stopped successfully`);
        }
        throw new Error(`No running background process for task ${taskId}`);
      }

      store.update(taskId, { status: "completed" });
      autoClear.trackCompletion(taskId, cadence.currentTurn);
      widget.setActiveTask(taskId, false);
      widget.update();
      return textResult(`Task #${taskId} stopped successfully`);
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 7: TaskExecute
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskExecute",
    label: "TaskExecute",
    description: `Execute one or more tasks as subagents.

## When to Use This Tool

- To start execution of tasks that have \`agentType\` set (created via TaskCreate with agentType parameter)
- Tasks must be \`pending\` with all blockedBy dependencies \`completed\`
- Each task runs as an independent background subagent

## Parameters

- **task_ids**: Array of task IDs to execute
- **additional_context**: Extra context appended to each agent's prompt
- **model**: Model override for agents (e.g., "sonnet", "haiku")
- **max_turns**: Maximum turns per agent`,
    promptGuidelines: [
      "Never use the Agent tool for tasks launched via TaskExecute — agents are already running.",
    ],
    parameters: Type.Object({
      task_ids: Type.Array(Type.String(), { description: "Task IDs to execute as subagents" }),
      additional_context: Type.Optional(Type.String({ description: "Extra context for agent prompts" })),
      model: Type.Optional(Type.String({ description: "Model override for agents" })),
      max_turns: Type.Optional(Type.Number({ description: "Max turns per agent", minimum: 1 })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!subagentsAvailable) {
        return textResult(
          "Subagent execution is currently unavailable (@tintinweb/pi-subagents not loaded " +
          "or version mismatch). You can run these as plain Agent-tool spawns, but pi-tasks " +
          "won't track them — status stays pending, cascade won't fire, TaskOutput stays empty."
        );
      }

      const results: string[] = [];
      const launched: string[] = [];

      for (const taskId of params.task_ids) {
        const task = store.get(taskId);
        if (!task) {
          results.push(`#${taskId}: not found`);
          continue;
        }
        if (task.status !== "pending") {
          results.push(`#${taskId}: not pending (status: ${task.status})`);
          continue;
        }
        if (!task.metadata?.agentType) {
          results.push(`#${taskId}: no agentType set — create with agentType parameter or update metadata`);
          continue;
        }

        // Check all blockers are completed
        const openBlockers = task.blockedBy.filter(bid => {
          const blocker = store.get(bid);
          return !blocker || blocker.status !== "completed";
        });
        if (openBlockers.length > 0) {
          results.push(`#${taskId}: blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
          continue;
        }

        // Mark in_progress and spawn agent via RPC
        store.update(taskId, { status: "in_progress" });
        const prompt = buildTaskPrompt(task, params.additional_context);
        try {
          const agentId = await spawnSubagent(task.metadata.agentType, prompt, {
            description: task.subject,
            isBackground: true,
            maxTurns: params.max_turns,
            ...(params.model ? { model: params.model } : {}),
          });
          agentTaskMap.set(agentId, taskId);
          store.update(taskId, { owner: agentId, executionMode: "background", metadata: { ...task.metadata, agentId } });
          widget.setActiveTask(taskId, true, "background", true);
          launched.push(`#${taskId} → agent ${agentId}`);
        } catch (err: any) {
          debug(`spawn:error task=#${taskId}`, err);
          store.update(taskId, { status: "pending" });
          results.push(`#${taskId}: spawn failed — ${err.message}`);
        }
      }

      // Save cascade config for the completion listener
      cascadeConfig = {
        additionalContext: params.additional_context,
        model: params.model,
        maxTurns: params.max_turns,
      };

      widget.update();

      const lines: string[] = [];
      if (launched.length > 0) {
        lines.push(
          `Launched ${launched.length} agent(s):\n${launched.join("\n")}\n` +
          `Use TaskOutput to check progress. Do not spawn additional agents for these tasks.`
        );
      }
      if (results.length > 0) lines.push(`Skipped:\n${results.join("\n")}`);
      if (lines.length === 0) lines.push("No tasks to execute.");

      return textResult(lines.join("\n\n"));
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter(t => t.status === "completed").length;

        const choices: string[] = [
          `View all tasks (${taskCount})`,
          "Create task",
        ];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);
        choices.push("Settings");

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice === "Settings") {
          await settingsMenu();
        } else if (choice.startsWith("Clear completed")) {
          store.clearCompleted();
          if (taskScope === "session") store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          store.clearAll();
          if (taskScope === "session") store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusIcon = (status: string) => {
          switch (status) {
            case "completed": return "✔";
            case "in_progress": return "◼";
            default: return "◻";
          }
        };

        const choices = tasks.map(t =>
          `${statusIcon(t.status)} #${t.id} [${t.status}] ${t.subject}`
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Extract task ID from selection
        const match = selected.match(/#(\d+)/);
        if (match) await viewTaskDetail(match[1]);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          store.update(taskId, { status: "in_progress", executionMode: null });
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, cadence.currentTurn);
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          store.update(taskId, { status: "deleted" });
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const settingsMenu = (): Promise<void> =>
        openSettingsMenu(ui, cfg, mainMenu, cfg.autoClearDelayTurns ?? 4);

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        store.create(subject, description);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}
