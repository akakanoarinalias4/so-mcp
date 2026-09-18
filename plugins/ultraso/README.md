# ultraso 插件（高档标准模式，无发光）

`/ultraso <问题>` 走高档标准模式：先完整跑通一键验证保下限，再针对缺口增量深挖冲上限，最终在来源数、域名数、抓取数、时效备注四项上全面超过标准模式。普通问题走普通档，不注入编排指令。

## 文件分工

- `ultra.ts`：编排指令（`ULTRASO_NOTICE`）。
- `index.ts`：装配两件套（`before_agent_start` 注入、`ultraso` 命令）。

## 安装

方式一：复制到扩展目录（支持 `/reload` 热重载）：

```bash
mkdir -p ~/.omp/agent/extensions/ultraso
cp plugins/ultraso/{index.ts,ultra.ts,package.json} ~/.omp/agent/extensions/ultraso/
```

方式二：本地安装（以 `so-mcp` 仓库目录为例）：

```bash
omp plugin install ./plugins/ultraso
```

## 用法

- `/ultraso 今天北京天气怎么样？` 走高档标准模式（先一键验证拿基线，再补缺口深挖，最后合并裁决并声明四项数字与增量）。
- `/ultraso` 不带问题：回用法提示，不触发。
- 普通问题不带命令：走普通档，一键 `so_verify` 完成搜索验证，不做增量深挖。

## 验证

1. 发送 `/ultraso <问题>`，确认回复开头声明高档标准模式并列出四项数字与增量，且包含一键验证基线。
2. 发送普通问题，确认走普通档且无多余编排指令注入。
