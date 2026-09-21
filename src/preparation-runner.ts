import { createHash } from "node:crypto";
import type { InboxTask } from "./message-inbox.ts";
import { validatePreparationOutput, type PreparationJson, type PreparationStepKind } from "./preparation-plan.ts";
import { validatePreparedAuthorization, validateUserCredentialPreparationIntent, validateUserCredentialPreparationResult,
  type PreparedAuthorization, type UserCredentialPreparationIntent } from "./prepared-authorization.ts";
import type { GatewayStore } from "./store.ts";

// 步骤保存失败不能被附件容错降级成“附件不可读”，否则会越过未知副作用继续派发。
export class PreparationCheckpointError extends Error {}

export class PreparationRunner {
  private task: InboxTask;
  private store: GatewayStore;
  private credentialRunning = false;
  constructor(store: GatewayStore, task: InboxTask, target: { sessionId?: string; reusable: boolean }) {
    this.store = store;
    this.task = task.preparationPlan ? task : store.inbox.beginPreparationPlan(task, target);
    if (!this.task.preparationPlan) throw new PreparationCheckpointError("准备计划未保存");
  }
  get target() { return structuredClone(this.task.preparationPlan!.target); }

  async userCredential(input: unknown, capture: () => UserCredentialPreparationIntent,
    operation: (intent: UserCredentialPreparationIntent, recovering: boolean) => Promise<PreparedAuthorization> | PreparedAuthorization): Promise<PreparedAuthorization> {
    if (this.credentialRunning) throw new PreparationCheckpointError("用户凭证准备仍在进行中，不能重复恢复");
    this.credentialRunning = true;
    try { return await this.runUserCredential(input, capture, operation); }
    finally { this.credentialRunning = false; }
  }

  private async runUserCredential(input: unknown, capture: () => UserCredentialPreparationIntent,
    operation: (intent: UserCredentialPreparationIntent, recovering: boolean) => Promise<PreparedAuthorization> | PreparedAuthorization): Promise<PreparedAuthorization> {
    const plan = this.task.preparationPlan!, previous = plan.steps.find(step => step.id === "user-credential");
    let fingerprint: string, intent = previous?.authorizationIntent;
    try {
      validatePreparationOutput(input);
      fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (!previous) {
        const captured: unknown = capture();
        // capture必须是同步快照，不能等异步结果后再决定原任务身份。
        if (captured instanceof Promise) {
          void Promise.prototype.then.call(captured, undefined, () => {});
          throw new Error();
        }
        validateUserCredentialPreparationIntent(captured);
        intent = structuredClone(captured);
      } else if (previous.state === "pending" && !intent) throw new Error();
      this.task = this.store.inbox.beginPreparationStep(this.task, plan.id, {
        id: "user-credential", kind: "hook", inputFingerprint: fingerprint,
        ...(intent === undefined ? {} : { authorizationIntent: intent })
      });
    } catch { throw new PreparationCheckpointError("用户凭证准备意图无效或未保存，未继续执行"); }
    const step = this.task.preparationPlan!.steps.find(item => item.id === "user-credential")!;
    if (step.state === "completed") {
      validatePreparedAuthorization(step.output);
      return structuredClone(step.output);
    }
    const expected = this.task, original = structuredClone(intent!);
    const result = await operation(structuredClone(original), Boolean(previous));
    try {
      validateUserCredentialPreparationResult(original, result);
      this.task = this.store.inbox.completePreparationStep(expected, plan.id, "user-credential", result);
    } catch { throw new PreparationCheckpointError("用户凭证准备结果与原意图不一致或未保存，保留原任务等待核查"); }
    return structuredClone(result);
  }

  async step<T>(id: string, kind: PreparationStepKind, input: unknown, operation: (recovering: boolean) => Promise<T> | T): Promise<T> {
    const plan = this.task.preparationPlan!;
    let fingerprint: string;
    try { fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
    catch { throw new PreparationCheckpointError("准备步骤输入无法序列化，未继续执行"); }
    const previous = plan.steps.find(step => step.id === id);
    try {
      this.task = this.store.inbox.beginPreparationStep(this.task, plan.id, { id, kind, inputFingerprint: fingerprint });
    } catch { throw new PreparationCheckpointError("准备步骤绑定或检查点保存失败，未继续执行"); }
    const step = this.task.preparationPlan!.steps.find(step => step.id === id)!;
    if (step.state === "completed") return structuredClone(step.output) as T;
    if (previous && !["attachment", "mount", "creation"].includes(kind)) {
      throw new PreparationCheckpointError("准备步骤结果尚未保存，不能重读上下文或重复执行开发者回调");
    }
    const value = await operation(Boolean(previous));
    // 业务对象的可选属性按已有JSON API语义省略；存储层仍严格校验JSON结构。
    let output: PreparationJson;
    try { output = JSON.parse(JSON.stringify(value === undefined ? null : value)) as PreparationJson; }
    catch { throw new PreparationCheckpointError("准备步骤结果无法序列化，未继续执行"); }
    try { this.task = this.store.inbox.completePreparationStep(this.task, plan.id, id, output); }
    catch { throw new PreparationCheckpointError("准备步骤结果未保存，保留原任务等待核查"); }
    return structuredClone(output) as T;
  }
}
