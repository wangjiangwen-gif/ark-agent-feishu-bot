import { createHash } from "node:crypto";
import type { InboxTask } from "./message-inbox.ts";
import type { PreparationJson, PreparationStepKind } from "./preparation-plan.ts";
import type { GatewayStore } from "./store.ts";

// 步骤保存失败不能被附件容错降级成“附件不可读”，否则会越过未知副作用继续派发。
export class PreparationCheckpointError extends Error {}

export class PreparationRunner {
  private task: InboxTask;
  private store: GatewayStore;
  constructor(store: GatewayStore, task: InboxTask, target: { sessionId?: string; reusable: boolean }) {
    this.store = store;
    this.task = task.preparationPlan ? task : store.inbox.beginPreparationPlan(task, target);
    if (!this.task.preparationPlan) throw new PreparationCheckpointError("准备计划未保存");
  }
  get target() { return structuredClone(this.task.preparationPlan!.target); }

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
