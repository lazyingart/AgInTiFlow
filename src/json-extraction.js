function uniqueList(values = []) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function parseJsonObject(candidate = "") {
  const text = String(candidate || "").replace(/^\uFEFF/, "").trim();
  if (!text) return null;
  const variants = [
    text,
    // Hosted model wrappers occasionally produce near-JSON with trailing
    // commas. Keep the repair narrow so malformed structure still fails.
    text.replace(/,\s*([}\]])/g, "$1"),
  ];
  for (const variant of uniqueList(variants)) {
    try {
      const parsed = JSON.parse(variant);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next narrow repair variant.
    }
  }
  return null;
}

export function firstJsonObject(text = "") {
  const source = String(text || "").trim();
  if (!source) return null;
  const direct = parseJsonObject(source);
  if (direct) return direct;

  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) {
    const parsedFenced = parseJsonObject(fenced);
    if (parsedFenced) return parsedFenced;
  }

  const start = source.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote) {
      if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return parseJsonObject(source.slice(start, index + 1));
      }
    }
  }
  return null;
}
