[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

AgInTiFlow là agent của AgInTi để điều khiển trình duyệt và công cụ cục bộ một cách có kiểm soát: tự động hóa web, hội thoại bền vững, phiên có thể tiếp tục và lệnh cục bộ được bảo vệ.

## Tổng quan

| Khu vực | Hướng |
| --- | --- |
| Vòng lặp chính | Lập kế hoạch -> dùng công cụ -> ghi sự kiện -> kết thúc hoặc tiếp tục |
| Trình duyệt | Playwright, khởi động khi cần, allowlist domain |
| Mô hình | Tool calling tương thích OpenAI, preset OpenAI và DeepSeek |
| Công cụ cục bộ | Shell tùy chọn, guardrails, Docker sandbox |
| Bộ nhớ | Trạng thái phiên, cài đặt bền vững, tiếp tục chat |

## Chạy nhanh

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

Mở `http://127.0.0.1:3210`.

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder"
```

## An toàn

- Mật khẩu và hành động phá hủy bị chặn nếu chưa bật rõ ràng.
- Shell là tùy chọn và có thể chạy trong Docker không có mạng.
- Mọi yêu cầu công cụ và kết quả được ghi vào `.sessions/`.

## Phát triển

```bash
npm run check
node tools/readme_prompt_tool.js agintiflow
```
