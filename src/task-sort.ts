import type { Task, TaskStatus } from "./types.js";

export type TaskSortKey = "id" | "updated" | "status";
export type TaskSortDirection = "asc" | "desc";
export type LegacyTaskSortOrder = "id" | "status" | "recent" | "oldest";
export type TaskSortRule =
  | { field: "id" | "updatedAt"; direction: TaskSortDirection }
  | { field: "status"; order: TaskStatus[] };

export const SORT_SCHEMA_VERSION = 1;
export const DEFAULT_STATUS_ORDER: readonly TaskStatus[] = ["completed", "in_progress", "pending"];
const DEFAULT_RULES: readonly TaskSortRule[] = [{ field: "id", direction: "asc" }];

export interface TaskSortConfig {
  sortSchemaVersion?: number;
  sortRules?: unknown;
  /** Previous structured settings retained for compatibility. */
  sortBy?: TaskSortKey;
  sortDirection?: TaskSortDirection;
  statusOrder?: readonly TaskStatus[];
  /** Legacy settings retained for compatibility. */
  sortOrder?: LegacyTaskSortOrder;
  reverseSort?: boolean;
}

export interface NormalizedTaskSort {
  rules: TaskSortRule[];
  source: "rules" | "structured" | "legacy" | "default";
  warnings: string[];
}

export interface ResolvedTaskSort {
  sortBy: TaskSortKey;
  sortDirection: TaskSortDirection;
  statusOrder: TaskStatus[];
}

function validSortKey(value: unknown): value is TaskSortKey {
  return value === "id" || value === "updated" || value === "status";
}

function validDirection(value: unknown): value is TaskSortDirection {
  return value === "asc" || value === "desc";
}

function validStatusOrder(value: unknown): value is TaskStatus[] {
  if (!Array.isArray(value) || value.length !== DEFAULT_STATUS_ORDER.length) return false;
  const statuses = new Set(value);
  return statuses.size === DEFAULT_STATUS_ORDER.length &&
    DEFAULT_STATUS_ORDER.every(status => statuses.has(status));
}

function cloneRules(rules: readonly TaskSortRule[]): TaskSortRule[] {
  return rules.map(rule => rule.field === "status"
    ? { field: "status", order: [...rule.order] }
    : { ...rule });
}

function validateRules(value: unknown): { rules?: TaskSortRule[]; errors: string[] } {
  if (!Array.isArray(value) || value.length === 0) {
    return { errors: ["sortRules must be a non-empty array"] };
  }

  const rules: TaskSortRule[] = [];
  const fields = new Set<string>();
  const errors: string[] = [];
  for (const [index, candidate] of value.entries()) {
    if (!candidate || typeof candidate !== "object") {
      errors.push(`sortRules[${index}] must be an object`);
      continue;
    }
    const rule = candidate as Record<string, unknown>;
    const field = rule.field;
    if (field !== "id" && field !== "updatedAt" && field !== "status") {
      errors.push(`sortRules[${index}] has unknown field`);
      continue;
    }
    if (fields.has(field)) {
      errors.push(`sortRules contains duplicate field "${field}"`);
      continue;
    }
    fields.add(field);

    if (field === "status") {
      if (!validStatusOrder(rule.order)) {
        errors.push(`sortRules[${index}].order must contain each task status exactly once`);
      } else {
        rules.push({ field, order: [...rule.order] });
      }
    } else if (!validDirection(rule.direction)) {
      errors.push(`sortRules[${index}].direction must be "asc" or "desc"`);
    } else {
      rules.push({ field, direction: rule.direction });
    }
  }

  if (rules.at(-1)?.field !== "id") {
    errors.push("sortRules must end with an ID rule for deterministic tie-breaking");
  }
  return errors.length > 0 ? { errors } : { rules, errors };
}

function structuredRules(config: TaskSortConfig, warnings: string[]): TaskSortRule[] {
  const sortBy = validSortKey(config.sortBy) ? config.sortBy : "id";
  const direction = validDirection(config.sortDirection) ? config.sortDirection : "asc";
  const statusOrder = validStatusOrder(config.statusOrder)
    ? [...config.statusOrder]
    : [...DEFAULT_STATUS_ORDER];
  if (config.sortBy !== undefined && !validSortKey(config.sortBy)) {
    warnings.push("sortBy is invalid; using ID sorting");
  }
  if (config.sortDirection !== undefined && !validDirection(config.sortDirection)) {
    warnings.push("sortDirection is invalid; using ascending order");
  }
  if (config.statusOrder !== undefined && !validStatusOrder(config.statusOrder)) {
    warnings.push("statusOrder is invalid; using the default status order");
  }

  if (sortBy === "status") {
    return [{ field: "status", order: statusOrder }, { field: "id", direction }];
  }
  if (sortBy === "updated") {
    return [{ field: "updatedAt", direction }, { field: "id", direction }];
  }
  return [{ field: "id", direction }];
}

function legacyRules(config: TaskSortConfig, warnings: string[]): TaskSortRule[] {
  const order = config.sortOrder;
  if (order !== undefined && order !== "id" && order !== "status" && order !== "recent" && order !== "oldest") {
    warnings.push("sortOrder is invalid; using ID sorting");
  }
  if (config.reverseSort !== undefined && typeof config.reverseSort !== "boolean") {
    warnings.push("reverseSort is invalid; treating it as disabled");
  }
  const reverse = config.reverseSort === true;
  if (order === "status") {
    const statuses = [...DEFAULT_STATUS_ORDER];
    if (reverse) statuses.reverse();
    return [
      { field: "status", order: statuses },
      { field: "id", direction: reverse ? "desc" : "asc" },
    ];
  }
  if (order === "recent" || order === "oldest") {
    const normallyDescending = order === "recent";
    const descending = reverse ? !normallyDescending : normallyDescending;
    const direction = descending ? "desc" : "asc";
    return [{ field: "updatedAt", direction }, { field: "id", direction }];
  }
  return [{ field: "id", direction: reverse ? "desc" : "asc" }];
}

/** Normalize without mutating or rewriting the persisted configuration. */
export function normalizeTaskSort(config: TaskSortConfig): NormalizedTaskSort {
  const warnings: string[] = [];
  if (config.sortRules !== undefined) {
    if (config.sortSchemaVersion !== undefined && config.sortSchemaVersion !== SORT_SCHEMA_VERSION) {
      warnings.push(`sortSchemaVersion ${config.sortSchemaVersion} is unsupported`);
    } else {
      const validated = validateRules(config.sortRules);
      if (validated.rules) {
        return { rules: cloneRules(validated.rules), source: "rules", warnings };
      }
      warnings.push(...validated.errors);
    }
  }

  const hasStructured = config.sortBy !== undefined || config.sortDirection !== undefined ||
    config.statusOrder !== undefined;
  if (hasStructured) {
    return { rules: structuredRules(config, warnings), source: "structured", warnings };
  }
  const hasLegacy = config.sortOrder !== undefined || config.reverseSort !== undefined;
  if (hasLegacy) {
    return { rules: legacyRules(config, warnings), source: "legacy", warnings };
  }
  return { rules: cloneRules(DEFAULT_RULES), source: "default", warnings };
}

/** Adapt normalized rules for the simple interactive settings controls. */
export function resolveTaskSort(config: TaskSortConfig): ResolvedTaskSort {
  const { rules } = normalizeTaskSort(config);
  const primary = rules[0];
  const idRule = rules.find(rule => rule.field === "id") as { field: "id"; direction: TaskSortDirection };
  const statusRule = rules.find(rule => rule.field === "status") as
    | Extract<TaskSortRule, { field: "status" }>
    | undefined;
  return {
    sortBy: primary.field === "updatedAt" ? "updated" : primary.field,
    sortDirection: primary.field === "status" ? idRule.direction : primary.direction,
    statusOrder: statusRule ? [...statusRule.order] : [...DEFAULT_STATUS_ORDER],
  };
}

function compareIds(a: Task, b: Task): number {
  const aId = String(a.id ?? "");
  const bId = String(b.id ?? "");
  const canonicalId = /^(0|[1-9]\d*)$/;
  const aIsCanonical = canonicalId.test(aId);
  const bIsCanonical = canonicalId.test(bId);
  if (aIsCanonical && bIsCanonical) {
    const aNumber = BigInt(aId);
    const bNumber = BigInt(bId);
    return aNumber < bNumber ? -1 : aNumber > bNumber ? 1 : 0;
  }
  if (aIsCanonical !== bIsCanonical) return aIsCanonical ? -1 : 1;
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** Return a sorted copy using the first rule that distinguishes each pair. */
export function sortTasks(tasks: readonly Task[], config: TaskSortConfig): Task[] {
  const { rules } = normalizeTaskSort(config);
  return [...tasks].sort((a, b) => {
    for (const rule of rules) {
      let comparison = 0;
      if (rule.field === "status") {
        const aRank = rule.order.indexOf(a.status);
        const bRank = rule.order.indexOf(b.status);
        comparison = (aRank < 0 ? rule.order.length : aRank) -
          (bRank < 0 ? rule.order.length : bRank);
      } else if (rule.field === "updatedAt") {
        const aTime = Number(a.updatedAt);
        const bTime = Number(b.updatedAt);
        const aIsFinite = Number.isFinite(aTime);
        const bIsFinite = Number.isFinite(bTime);
        if (aIsFinite !== bIsFinite) {
          comparison = aIsFinite ? -1 : 1; // malformed timestamps always sort last
        } else if (aIsFinite && bIsFinite) {
          comparison = aTime - bTime;
          if (rule.direction === "desc") comparison *= -1;
        }
      } else {
        comparison = compareIds(a, b);
        if (rule.direction === "desc") comparison *= -1;
      }
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}
