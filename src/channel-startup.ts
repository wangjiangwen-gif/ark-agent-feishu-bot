import type { ChannelAdapter, ChannelMessage } from "./channel.ts";

// 连接建立时即可收到消息，但必须先恢复持久化状态，才能交给业务调度器。
export async function startChannelAfterRecovery(
  channel: Pick<ChannelAdapter, "start" | "stop">,
  recover: () => void,
  accept: (message: ChannelMessage) => void,
  maxBuffered = 1000
): Promise<void> {
  let ready = false;
  let stopped = false;
  let overflow = false;
  const buffered: ChannelMessage[] = [];
  try {
    await channel.start(message => {
      if (stopped) return;
      if (ready) { accept(message); return; }
      if (buffered.length >= maxBuffered) { overflow = true; return; }
      buffered.push(message);
    });
    if (overflow) throw new Error("启动期间消息积压超限，未启动业务处理；请核查消息历史后重启");
    recover();
    // recover同步建立恢复状态；后台授权轮询无需阻塞其他用户的消息。
    ready = true;
    for (const message of buffered) accept(message);
    buffered.length = 0;
  } catch (error) {
    stopped = true;
    buffered.length = 0;
    try { await channel.stop(); }
    catch { console.warn("停止启动失败的Channel未完成，请检查连接状态"); }
    throw error;
  }
}
