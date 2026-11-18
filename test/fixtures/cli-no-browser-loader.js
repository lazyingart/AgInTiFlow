// Simulate an unavailable browser dependency in headless CLI processes.
export function resolve(specifier, context, nextResolve) {
  if (specifier === "playwright" || specifier.startsWith("playwright/")) {
    throw new Error("Headless CLI attempted to load Playwright");
  }
  return nextResolve(specifier, context);
}
