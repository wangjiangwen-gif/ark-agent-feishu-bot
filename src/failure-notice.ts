import { ArkRunError, failureDiagnostic } from "./ark-errors.ts";

// 此标识只证明失败提示已经送达，不代表业务成功或成功回复已投递。
// 每次包装生成独立异常，避免原异常被复用时把旧投递证明带入另一轮。
const deliveredNotices = new WeakSet<Error>();

export function withDeliveredFailureNotice(error: unknown): ArkRunError {
  const marked = new ArkRunError(failureDiagnostic(error));
  deliveredNotices.add(marked);
  return marked;
}

export function isFailureNoticeDelivered(error: unknown): boolean {
  return error instanceof Error && deliveredNotices.has(error);
}
