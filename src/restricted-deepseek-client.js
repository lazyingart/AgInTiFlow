import { createRestrictedDeepSeekProvider, createRestrictedProviderFailure } from "./restricted-application.js";
import { dataFields } from "./restricted-application-contract.js";
import { createDeepSeekHttpTransport } from "./restricted-deepseek-http.js";

// An explicit optional companion; the core SDK does not import this module.
// App-owned credential/scope only. Construction starts no HTTP request.
export function createRestrictedDeepSeekClient(options) {
  const fields = dataFields(options, ["apiKey", "model", "userId", "timeoutMs", "maxConcurrency"], ["apiKey", "model", "userId"]);
  const transport = createDeepSeekHttpTransport(fields, createRestrictedProviderFailure);
  return Object.freeze({
    provider: createRestrictedDeepSeekProvider({ model: fields.model, complete: transport.complete }),
    close: transport.close,
  });
}
