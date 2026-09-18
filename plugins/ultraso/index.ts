/**
 * ultraso 插件装配入口（斜杠命令版，无发光）
 *
 * 用法：/ultraso <问题> 走 ultra 档；普通问题走普通档，不注入编排指令。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ULTRASO_NOTICE } from "./ultra.ts";

// 用法提示文案：命令无参时复用
const USAGE = "用法：/ultraso <问题> 走 ultra 档（例如：/ultraso 今天北京天气怎么样？）。";

export default function (pi: ExtensionAPI): void {
  // 命令内无法直接发用户消息：置位后经 pi.sendUserMessage 走运行时统一发送。
  // 该方法挂在扩展根对象上，命令上下文 ctx 内无此方法。
  let ultraArmed = false;

  pi.on("before_agent_start", async (event) => {
    if (!ultraArmed) {
      return undefined;
    }
    ultraArmed = false;
    return { systemPrompt: event.systemPrompt + "\n\n" + ULTRASO_NOTICE };
  });

  pi.registerCommand("ultraso", {
    description: "ultra 档扇出：多供应商并行搜索抓取验证（用法：/ultraso <问题>）",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify(USAGE, "info");
        return;
      }
      ultraArmed = true;
      pi.sendUserMessage(query);
    },
  });
}
