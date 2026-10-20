import { PROFILE, createRequest, reject } from "./illustration-contract.js";

const MAX_RESPONSE = Math.ceil(PROFILE.maxImageBytes / 3) * 4 + 65536;
// Explicit host-supplied credential only. No environment/config discovery, URL
// downloads, submit retries, polling, provider fallback or raw response logging.
// fetchImpl is a trusted host dependency (offline qualification uses a fake).
export function createVeniceIllustrationTransport({ apiKey, fetchImpl = globalThis.fetch }) {
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{16,256}(?![\s\S])/.test(apiKey) || typeof fetchImpl !== "function") reject("ILLUSTRATION_TRANSPORT_UNAVAILABLE", 503);
  return Object.freeze({
    async submit(request, signal) {
      const r = createRequest(request);
      const deadline = new AbortController();
      const combined = AbortSignal.any([signal, deadline.signal]);
      if (combined.aborted) reject("ILLUSTRATION_RECOVERY_REQUIRED", 503);
      const timer = setTimeout(() => deadline.abort(), PROFILE.timeoutMs);
      let reader, response;
      try {
        response = await fetchImpl(PROFILE.endpoint, {
          method: "POST", redirect: "error", signal: combined,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: PROFILE.model, prompt: r.prompt, width: PROFILE.width, height: PROFILE.height, format: PROFILE.format, variants: PROFILE.variants, return_binary: false, safe_mode: true }),
        });
        if (!response.ok || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get("content-type") || "")) reject();
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE)) reject();
        reader = response.body.getReader();
        let size = 0;
        const chunks = [];
        while (true) {
          if (combined.aborted) reject();
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > MAX_RESPONSE) reject();
          chunks.push(Buffer.from(value));
        }
        const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
        if (!Array.isArray(payload.images) || payload.images.length !== 1) reject();
        const encoded = payload.images[0];
        if (typeof encoded !== "string" || !encoded || encoded.length % 4 || encoded.length > Math.ceil(PROFILE.maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) reject();
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.length > PROFILE.maxImageBytes || bytes.toString("base64") !== encoded) reject();
        return bytes;
      } catch { reject("ILLUSTRATION_RECOVERY_REQUIRED", 503); }
      finally {
        clearTimeout(timer);
        deadline.abort();
        // Abandon unread error bodies as well as acquired readers. A broken
        // injected stream must not hold the result hostage during cleanup.
        try { (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {}); } catch {}
        if (reader) { try { reader.releaseLock(); } catch {} }
      }
    },
  });
}
