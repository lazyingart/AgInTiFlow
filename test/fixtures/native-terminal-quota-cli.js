const nativeFetch = globalThis.fetch;
const target = new URL(process.env.AGINTI_TEST_QUOTA_ORIGIN);
if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") throw new Error("Invalid owned fixture origin");
globalThis.fetch = (input, init) => {
  const actual = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (actual.origin !== "https://api.deepseek.com") throw new Error("OFFLINE_CLI_NETWORK_ESCAPE_REFUSED");
  return Reflect.apply(nativeFetch, globalThis, [new URL(actual.pathname, target), init]);
};
