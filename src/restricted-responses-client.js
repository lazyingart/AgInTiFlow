import { createRestrictedProviderFailure } from "./restricted-application.js";
import { createResponsesHttpTransport } from "./restricted-responses-http.js";

// Internal candidate only: no package export, default or application wiring.
// This is a Responses transport for the AgInTi loop, not a Codex CLI harness,
// account registration, token refresh or proof of authorized app/model access.
export function createRestrictedResponsesClient(options) {
  const transport = createResponsesHttpTransport(options, createRestrictedProviderFailure);
  return Object.freeze({
    provider: Object.freeze({ supportsImages: false, complete: transport.complete }),
    close: transport.close,
  });
}
