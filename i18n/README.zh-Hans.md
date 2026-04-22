[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner-opaque.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

AgInTiFlow 是 AgInTi 的浏览器与工具使用智能体，用于可控网站自动化、持久对话、可恢复运行，以及受保护的本地命令。

## 概览

| 领域 | 方向 |
| --- | --- |
| 核心循环 | 规划 -> 使用工具 -> 记录事件 -> 完成或恢复 |
| 浏览器 | Playwright、延迟启动、域名 allowlist |
| 模型 | OpenAI 兼容 tool calling，内置 OpenAI 与 DeepSeek 预设 |
| 本地工具 | 可选 shell、guardrails、Docker sandbox |
| 记忆 | 会话状态、持久设置、对话延续 |

## 快速开始

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

打开 `http://127.0.0.1:3210`。

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder"
```

## 安全

- 默认阻止密码输入和破坏性动作。
- Shell 工具是可选的，也可以在无网络 Docker 容器中运行。
- 每次工具请求和结果都会记录到 `.sessions/`。

## 开发

```bash
npm run check
node tools/readme_prompt_tool.js agintiflow
```
