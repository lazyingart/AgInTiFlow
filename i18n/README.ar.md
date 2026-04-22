[English](../README.md) · [العربية](README.ar.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Tiếng Việt](README.vi.md) · [中文 (简体)](README.zh-Hans.md) · [中文（繁體）](README.zh-Hant.md) · [Deutsch](README.de.md) · [Русский](README.ru.md)

<p align="center">
  <img src="https://raw.githubusercontent.com/lachlanchen/lachlanchen/main/figs/banner.png" alt="Lachlan Chen banner" width="960" />
</p>

<p align="center">
  <img src="../logos/banner.png" alt="AgInTiFlow banner" width="960" />
</p>

# AgInTiFlow

AgInTiFlow هو وكيل من AgInTi للتحكم المنضبط في المتصفح والأدوات المحلية: أتمتة الويب، محادثات مستمرة، تشغيل قابل للاستئناف، وأوامر محلية محمية.

## لمحة

| المجال | الاتجاه |
| --- | --- |
| الحلقة الأساسية | تخطيط -> استخدام أدوات -> تسجيل أحداث -> إنهاء أو استئناف |
| المتصفح | Playwright، تشغيل عند الحاجة، قائمة سماح للنطاقات |
| النماذج | Tool calling متوافق مع OpenAI مع إعدادات OpenAI و DeepSeek |
| الأدوات المحلية | Shell اختياري مع guardrails و Docker sandbox |
| الذاكرة | حالة الجلسة، إعدادات محفوظة، ومتابعة المحادثة |

## تشغيل سريع

```bash
cd /home/lachlan/ProjectsLFS/Agent/AgInTiFlow
npm install
npx playwright install chromium
npm run web
```

افتح `http://127.0.0.1:3210`.

```bash
AGENT_PROVIDER=deepseek npm start -- "List this folder"
```

## الأمان

- كلمات المرور والإجراءات التخريبية محجوبة ما لم يتم تفعيلها صراحة.
- shell اختياري ويمكن تشغيله داخل Docker بلا شبكة.
- كل طلب أداة ونتيجته يتم تسجيلهما في `.sessions/`.

## التطوير

```bash
npm run check
node tools/readme_prompt_tool.js agintiflow
```
