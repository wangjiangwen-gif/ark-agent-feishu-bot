#!/usr/bin/env node
// Node 小岛：仅保留飞书 registerApp（扫码一键建应用）。
// Python 主体没有 registerApp 的等价物，故保留此脚本作为子进程调用。
//
// 用法：node register_app.mjs <output-json-path>
//   - 二维码与提示打印到 stderr（继承终端，供用户扫码）
//   - 成功后把 { appId, appSecret, userOpenId? } 写入 output-json-path
//
// 本 demo 去掉了用户 OAuth：Bot 只需 tenant 身份发消息 + 订阅消息事件。
import { writeFileSync } from "node:fs";
import * as Lark from "@larksuiteoapi/node-sdk";
import qrcodeTerminal from "qrcode-terminal";

const qr = qrcodeTerminal.default || qrcodeTerminal;

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error("用法：node register_app.mjs <output-json-path>");
    process.exit(2);
  }

  console.error("即将创建飞书机器人应用，请使用飞书扫码确认。");
  const credentials = await Lark.registerApp({
    source: "nio-ma-demo",
    appPreset: {
      name: "蔚来 MA Demo Bot",
      desc: "由火山方舟 Managed Agents 驱动的飞书机器人（迁移方案演示）"
    },
    addons: {
      // 仅 tenant 身份：发消息 + 订阅消息事件。不申请任何 user scope（无用户 OAuth）。
      scopes: { tenant: ["im:message:send_as_bot"], user: [] },
      events: { items: { tenant: ["im.message.receive_v1"] } }
    },
    onQRCodeReady(info) {
      qr.generate(info.url, { small: true });
      console.error(`如果二维码无法扫描，请打开：${info.url}`);
      console.error(`链接将在 ${info.expireIn} 秒后失效。`);
    }
  });

  const result = {
    appId: credentials.client_id,
    appSecret: credentials.client_secret,
    userOpenId: credentials.user_info?.open_id || null
  };
  writeFileSync(outputPath, JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
  console.error(`飞书应用已创建：${result.appId}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
