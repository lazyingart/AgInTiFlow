[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner-opaque.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

AgInTiFlow는 AgInTi의 브라우저 및 로컬 도구 제어 에이전트입니다. 웹 자동화, 지속 대화, 재개 가능한 실행, 보호된 로컬 명령을 지원합니다.

## 개요

| 영역 | 방향 |
| --- | --- |
| 핵심 루프 | 계획 -> 도구 사용 -> 이벤트 기록 -> 완료 또는 재개 |
| 브라우저 | Playwright, 지연 시작, 도메인 allowlist |
| 모델 | OpenAI 호환 tool calling, OpenAI / DeepSeek 프리셋 |
| 로컬 도구 | 선택적 shell, guardrails, Docker sandbox |
| 메모리 | 세션 상태, 지속 설정, 대화 이어가기 |

## 빠른 시작

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

`http://127.0.0.1:3210` 을 여세요.

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder"
```

## 안전

- 비밀번호 입력과 파괴적 동작은 명시적으로 켜지 않으면 차단됩니다.
- Shell은 선택 사항이며 네트워크 없는 Docker 컨테이너에서도 실행할 수 있습니다.
- 모든 도구 요청과 결과는 `.sessions/` 에 기록됩니다.

## 개발

```bash
npm run check
node tools/readme_prompt_tool.js agintiflow
```
