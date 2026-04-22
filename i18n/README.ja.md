[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner-opaque.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

AgInTiFlow は、AgInTi のブラウザおよびローカルツール制御エージェントです。Web 自動化、永続チャット、再開可能な実行、安全なローカルコマンドを扱います。

## 概要

| 領域 | 方針 |
| --- | --- |
| 中核ループ | 計画 -> ツール実行 -> イベント記録 -> 完了または再開 |
| ブラウザ | Playwright、遅延起動、ドメイン allowlist |
| モデル | OpenAI 互換 tool calling、OpenAI / DeepSeek プリセット |
| ローカルツール | 任意の shell、guardrails、Docker sandbox |
| メモリ | セッション状態、永続設定、会話継続 |

## クイックスタート

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

`http://127.0.0.1:3210` を開きます。

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder"
```

## 安全性

- パスワード入力と破壊的操作は明示的に有効化しない限りブロックされます。
- Shell は任意で、ネットワークなしの Docker 内でも実行できます。
- すべてのツール要求と結果は `.sessions/` に記録されます。

## 開発

```bash
npm run check
node tools/readme_prompt_tool.js agintiflow
```
