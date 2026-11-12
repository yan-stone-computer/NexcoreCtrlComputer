<p align="center">
  <img src="./assets/hero.svg" alt="NexcoreCtrlComputer" width="100%">
</p>

<h1 align="center">NexcoreCtrlComputer</h1>

<p align="center">
  <strong>给 Computer-use Agent 的控制平面。</strong><br>
  无障碍树优先，一个 MCP 工具，动作可验证，显著减少视觉 token。
</p>

> Agent 不需要一张 4K 截图，才能点击一个叫“保存”的按钮。

很多电脑操控框架依靠截图、坐标和大量工具定义循环，延迟高、token 贵，窗口
稍微变化还会点错。NexcoreCtrlComputer 把操作系统无障碍树作为主接口，用短生命
周期元素引用完成精确操作，并在 **agent-desktop**、**agent-browser**、可选
**PyAutoGUI** 兜底之上提供统一控制层。

## 为什么值得用

| 传统方案 | Nexcore |
|---|---|
| 截图贵且存在歧义 | 角色、名称、引用的语义快照 |
| DPI 或布局一变坐标就失效 | 无障碍优先的语义动作 |
| 工具太多挤占上下文 | 只暴露一个 `computer` 工具 |
| `ok: true` 不代表页面真的变了 | 可选 `expect` 后置验证 |
| 复杂应用快照爆炸 | 节点上限、精确查询、区域钻取 |
| 重试可能重复点击 | 保留底层安全重试策略 |
| 像素操控默认风险高 | 带界面/坐标模式默认关闭 |

## 三步跑起来

```bash
npm install -g github:yan-stone-computer/NexcoreCtrlComputer
npm install -g agent-desktop agent-browser
python -m pip install pyautogui                         # 可选兜底
nexcore doctor
```

桌面观察：

```bash
nexcore observe '{"surface":"desktop","app":"Calculator","query":"7"}'
```

浏览器点击并验证跳转：

```bash
nexcore act '{
  "surface":"browser",
  "url":"https://example.com",
  "action":"click",
  "target":{"role":"link","name":"Learn more"},
  "expect":{"property":"url","value":"https://www.iana.org/help/example-domains"}
}'
```

整个过程不把截图发送给模型，目标通过角色和名称精确定位。

## 一个工具，而不是几十个

```json
{
  "mcpServers": {
    "nexcore": {
      "command": "nexcore",
      "args": ["mcp"],
      "env": {
        "NEXCORE_SESSION": "default",
        "NEXCORE_ALLOWED_APPS": "Calculator,notepad.exe",
        "NEXCORE_ALLOWED_DOMAINS": "example.com"
      }
    }
  }
}
```

支持 `status`、`observe`、`act`、`run`、`close`，动作涵盖点击、输入、按键、
选择、勾选、展开、滚动、截图和显式坐标点击。多步任务可在一次 `run` 中完成，
减少模型往返。

## JS API

```bash
npm install github:yan-stone-computer/NexcoreCtrlComputer
```

```js
import { createComputer } from "nexcorectrlcomputer";

const computer = await createComputer({
  session: "demo",
  policy: {
    allowedApps: ["Calculator"],
    allowedDomains: ["example.com"],
    allowHeaded: false,
    allowCoordinates: false
  }
});

const view = await computer.observe({
  surface: "browser",
  url: "https://example.com"
});
console.log(view.text, view.estimatedTokens);

await computer.act({
  surface: "browser",
  action: "click",
  target: { role: "link", name: "Learn more" }
});

await computer.close();
```

## 实测压缩

```text
30 个节点的合成无障碍树
原始 JSON: 8,406 bytes  (~2,102 估算 token)
压缩快照: 2,155 bytes    (~539 估算 token)
减少: 74.4%
```

这是固定测试夹具上的 UTF-8 字节与 `bytes / 4` 估算，不等同于模型账单；
实际收益取决于界面密度和查询范围。真正的大头是让截图默认留在本地。

## 安全默认值

- 默认禁止物理界面输入。
- 默认禁止坐标点击。
- 支持应用和域名白名单。
- PyAutoGUI 保留屏幕角落紧急停止。
- 失效引用必须失败，不能猜一个长得像的控件。
- `nexcore close` 不会关闭用户正在使用的其他应用。

详细说明见 [SECURITY.md](./SECURITY.md)。

## 架构边界

Nexcore 自己负责编排、压缩、策略、验证和协议适配；系统无障碍与 CDP 能力由
专业后端负责。项目不复制三份上游源码，而是通过稳定 CLI 契约组合能力，并在
[NOTICE](./NOTICE) 中明确许可证和用途。

Windows 上已经完成真实桌面快照、桌面值验证、浏览器点击、URL 验证和 MCP
冒烟测试。macOS 与 Linux 复用同一后端抽象，但欢迎补充真实平台 CI。

如果这个项目帮你省掉了一轮截图循环，给一个 Star，并带着最难的电脑操控流程
来提 Issue。
