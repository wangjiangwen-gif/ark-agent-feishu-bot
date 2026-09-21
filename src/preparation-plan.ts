import { randomUUID } from "node:crypto";
import { configFingerprint } from "./session-config.ts";
import { validateUserCredentialPreparationIntent, validateUserCredentialPreparationResult,
  type UserCredentialPreparationIntent } from "./prepared-authorization.ts";

export type PreparationJson = null | boolean | number | string | PreparationJson[] | { [key: string]: PreparationJson };
export type PreparationTarget = { sessionId?: string; reusable: boolean };
export type PreparationStepKind = "observation" | "hook" | "attachment" | "mount" | "creation" | "snapshot";
export type PreparationStepInput = { id: string; kind: PreparationStepKind; inputFingerprint: string;
  authorizationIntent?: UserCredentialPreparationIntent };
export type PreparationStep = PreparationStepInput & (
  | { state: "pending"; output?: never }
  | { state: "completed"; output: PreparationJson }
);
export type PreparationPlan = { version: 1; id: string; createdAt: number; target: PreparationTarget; steps: PreparationStep[] };

export const MAX_PREPARATION_STEPS = 256;
export const MAX_PREPARATION_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_PREPARATION_PLAN_BYTES = 8 * 1024 * 1024;
const kinds = new Set<PreparationStepKind>(["observation", "hook", "attachment", "mount", "creation", "snapshot"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function createPreparationPlan(target: PreparationTarget): PreparationPlan {
  validateTarget(target);
  return { version: 1, id: randomUUID(), createdAt: Date.now(), target: structuredClone(target), steps: [] };
}

export function startPreparationStep(plan: PreparationPlan, input: PreparationStepInput): PreparationPlan {
  validatePreparationPlan(plan); validateStepInput(input);
  const existing = plan.steps.find(step => step.id === input.id);
  if (existing) {
    if (existing.kind !== input.kind || existing.inputFingerprint !== input.inputFingerprint
      || configFingerprint(existing.authorizationIntent ?? null) !== configFingerprint(input.authorizationIntent ?? null)) {
      throw new Error("准备步骤名称已绑定其他输入、类型或授权意图，不能替换");
    }
    return plan;
  }
  if (plan.steps.length >= MAX_PREPARATION_STEPS) throw new Error("准备步骤数量超过上限");
  const next: PreparationPlan = { ...plan, steps: [...plan.steps, { ...structuredClone(input), state: "pending" }] };
  validatePreparationPlan(next);
  return next;
}

export function finishPreparationStep(plan: PreparationPlan, id: string, output: PreparationJson): PreparationPlan {
  validatePreparationPlan(plan); validatePreparationOutput(output);
  const index = plan.steps.findIndex(step => step.id === id);
  if (index < 0) throw new Error("准备步骤不存在，不能补造完成回执");
  const previous = plan.steps[index];
  if (previous.state === "completed") {
    if (configFingerprint(previous.output) !== configFingerprint(output)) throw new Error("准备步骤已有完成回执，不能替换原结果");
    return plan;
  }
  const next: PreparationPlan = { ...plan, steps: plan.steps.map((step, position) => position === index
    ? { ...step, state: "completed", output: structuredClone(output) } : step) };
  validatePreparationPlan(next);
  return next;
}

export function preparationPlansEqual(left: PreparationPlan | undefined, right: PreparationPlan | undefined): boolean {
  if (!left || !right) return left === right;
  validatePreparationPlan(left); validatePreparationPlan(right);
  return configFingerprint(left) === configFingerprint(right);
}

export function validatePreparationPlan(value: unknown): asserts value is PreparationPlan {
  strictJson(value, MAX_PREPARATION_PLAN_BYTES, 40, 400_000);
  if (!exact(value, ["version", "id", "createdAt", "target", "steps"]) || value.version !== 1
    || typeof value.id !== "string" || !uuid.test(value.id) || !Number.isSafeInteger(value.createdAt)
    || Number(value.createdAt) <= 0 || Number(value.createdAt) > Date.now()
    || !Array.isArray(value.steps) || value.steps.length > MAX_PREPARATION_STEPS) throw new Error("准备计划结构、版本或大小无效");
  validateTarget(value.target);
  const seen = new Set<string>();
  for (const step of value.steps) {
    if (!plain(step) || !["pending", "completed"].includes(String(step.state))
      || !exact(step, ["id", "kind", "inputFingerprint", "state", ...(Object.hasOwn(step, "authorizationIntent") ? ["authorizationIntent"] : []),
        ...(step.state === "completed" ? ["output"] : [])])) {
      throw new Error("准备步骤结构或状态无效");
    }
    validateStepInput({ id: step.id, kind: step.kind, inputFingerprint: step.inputFingerprint,
      ...(Object.hasOwn(step, "authorizationIntent") ? { authorizationIntent: step.authorizationIntent } : {}) });
    if (seen.has(String(step.id))) throw new Error("准备步骤名称重复");
    seen.add(String(step.id));
    if (step.state === "completed") {
      validatePreparationOutput(step.output);
      if (step.authorizationIntent !== undefined) validateUserCredentialPreparationResult(step.authorizationIntent as UserCredentialPreparationIntent, step.output);
    }
  }
}

export function validatePreparationOutput(value: unknown): asserts value is PreparationJson {
  strictJson(value, MAX_PREPARATION_OUTPUT_BYTES, 32, 100_000);
}

function validateTarget(value: unknown): asserts value is PreparationTarget {
  strictJson(value, 1024, 2, 8);
  if (!plain(value) || !exact(value, ["reusable", ...(Object.hasOwn(value, "sessionId") ? ["sessionId"] : [])])
    || typeof value.reusable !== "boolean" || (Object.hasOwn(value, "sessionId") && !identifier(value.sessionId))) {
    throw new Error("准备计划目标绑定无效");
  }
}

function validateStepInput(value: unknown): asserts value is PreparationStepInput {
  strictJson(value, 8192, 5, 64);
  if (!exact(value, ["id", "kind", "inputFingerprint", ...(plain(value) && Object.hasOwn(value, "authorizationIntent") ? ["authorizationIntent"] : [])]) || !identifier(value.id)
    || !kinds.has(value.kind as PreparationStepKind) || typeof value.inputFingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(value.inputFingerprint)) throw new Error("准备步骤标识、类型或输入指纹无效");
  if (Object.hasOwn(value, "authorizationIntent")) {
    if (value.id !== "user-credential" || value.kind !== "hook") throw new Error("仅用户凭证准备步骤可以保存授权意图");
    validateUserCredentialPreparationIntent(value.authorizationIntent);
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && !/\s|[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(value, "utf8") <= 256;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, allowed: string[]): value is Record<string, unknown> {
  return plain(value) && Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key));
}

// 不通过JSON.stringify静默丢弃undefined、函数、稀疏数组或自定义实例；错误信息不带敏感原值。
function strictJson(value: unknown, maxBytes: number, maxDepth: number, maxNodes: number): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > maxDepth) throw new Error("invalid");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) throw new Error("invalid");
    if (!Array.isArray(item) && !plain(item)) throw new Error("invalid");
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item)) {
      if (Object.keys(descriptors).length !== item.length + 1) throw new Error("invalid");
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("invalid");
        visit(descriptor.value, depth + 1);
      }
    } else for (const descriptor of Object.values(descriptors)) {
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error("invalid");
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  try {
    visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) throw new Error("oversize");
  } catch { throw new Error("准备计划JSON结构无效或超过大小限制"); }
}
