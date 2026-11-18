import { parentPort } from "node:worker_threads";
import Ajv from "ajv";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

// Cache only compiled contracts. Each is compiled independently so a previous
// caller's $id can never resolve a reference in another caller's contract.
const cache = new Map();
function validatorFor(source) {
  let validate = cache.get(source);
  if (validate) return validate;
  const schema = JSON.parse(source);
  let Engine = Ajv;
  const dialect = typeof schema.$schema === "string" ? schema.$schema.replace(/#$/, "") : "";
  if (dialect === "https://json-schema.org/draft/2020-12/schema") Engine = Ajv2020;
  if (dialect === "https://json-schema.org/draft/2019-09/schema") Engine = Ajv2019;
  const engine = new Engine({
    strict: false, strictSchema: true, strictNumbers: true, ownProperties: true,
    allErrors: false, addUsedSchema: false, logger: false,
  });
  addFormats(engine);
  // Synchronous compilation has no remote reference loader. Validation never
  // coerces values, inserts defaults, removes fields, or runs custom keywords.
  validate = engine.compile(schema);
  if (validate.$async) throw new Error("Asynchronous schema");
  if (cache.size === 16) cache.delete(cache.keys().next().value);
  cache.set(source, validate);
  return validate;
}

parentPort?.on("message", ({ source, checkOnly, value }) => {
  let validate;
  try {
    validate = validatorFor(source);
  } catch {
    parentPort.postMessage({ status: "invalidSchema" });
    return;
  }
  if (checkOnly) {
    parentPort.postMessage({ status: "valid" });
    return;
  }
  try {
    if (validate(value)) {
      parentPort.postMessage({ status: "valid" });
    } else {
      const keyword = validate.errors?.[0]?.keyword || "schema";
      // Values and schema fragments may contain private application text.
      parentPort.postMessage({ status: "invalidValue", keyword });
    }
  } catch {
    parentPort.postMessage({ status: "validationFailed" });
  } finally {
    validate.errors = null;
  }
});
