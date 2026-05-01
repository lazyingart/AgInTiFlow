export async function captureSnapshot(page, store, step) {
  const snapshot = await page
    .evaluate(() => {
      const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
      };

      document.querySelectorAll("[data-agent-id]").forEach((el) => el.removeAttribute("data-agent-id"));

      const candidates = Array.from(
        document.querySelectorAll("a, button, input, textarea, select, [role='button'], [contenteditable='true']")
      );

      const elements = [];

      for (const el of candidates) {
        if (!isVisible(el)) continue;
        if (elements.length >= 50) break;

        const id = String(elements.length + 1);
        el.setAttribute("data-agent-id", id);

        const tag = el.tagName.toLowerCase();
        elements.push({
          id,
          tag,
          role: el.getAttribute("role") || "",
          text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
          ariaLabel: (el.getAttribute("aria-label") || "").trim().slice(0, 100),
          placeholder: (el.getAttribute("placeholder") || "").trim().slice(0, 100),
          href: tag === "a" ? (el.getAttribute("href") || "").trim() : "",
          inputType: tag === "input" ? (el.getAttribute("type") || "text").trim() : "",
          autocomplete: (el.getAttribute("autocomplete") || "").trim(),
        });
      }

      return {
        title: document.title,
        url: window.location.href,
        pageText: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 2500),
        elements,
      };
    })
    .catch((error) => ({
      title: "Browser page open",
      url: page.url(),
      pageText: `DOM snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 2500),
      elements: [],
      snapshotWarning: "dom-unavailable",
    }));

  const screenshotPath = store.screenshotPath(step);
  let savedScreenshotPath = screenshotPath;
  let screenshotWarning = "";
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    savedScreenshotPath = "";
    screenshotWarning = `Screenshot unavailable: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
  }
  const snapshotPath = await store.saveSnapshot(step, { ...snapshot, screenshotWarning });

  return {
    ...snapshot,
    screenshotPath: savedScreenshotPath,
    screenshotWarning,
    snapshotPath,
  };
}
