import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createRestrictedApplicationRunner, createRestrictedOpenAIProvider, createRestrictedDeepSeekProvider, createRestrictedProviderFailure, createRestrictedToolFailure } from "../src/restricted-application.js";

const schema = { type: "object", properties: { answer: { type: "string", maxLength: 80 } }, required: ["answer"], additionalProperties: false };
const input = { input: [{ type: "text", text: "just check the status please, don't change anything" }] };
const final = () => ({ type: "final", value: { answer: "Observed status only." } });
const read = () => ({ type: "tool_calls", calls: [{ id: "read_status_1", name: "read_status", arguments: {} }] });
const closed = { type: "object", properties: {}, required: [], additionalProperties: false };
const make = (complete, tools = [], limits = {}) => createRestrictedApplicationRunner({
  provider: { supportsImages: false, complete }, tools, instructions: "Return an uncommitted status proposal based on authorized evidence.",
  outputSchema: schema, limits: { timeoutMs: 1000, maxConcurrency: 1, ...limits },
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const invalid = (shape, value, touch) => {
  if (shape === "proxy") return new Proxy(value, { get(target, key, receiver) { touch(); return Reflect.get(target, key, receiver); } });
  if (shape === "promise-proxy") return new Proxy(Promise.resolve(value), { get(target, key, receiver) { touch(); return Reflect.get(target, key, receiver); } });
  if (shape === "hidden-then-getter") { Object.defineProperty(value, "then", { get() { touch(); return undefined; } }); return value; }
  if (shape === "throwing-then-getter") { Object.defineProperty(value, "then", { get() { touch(); throw Error("private result detail"); } }); return value; }
  if (shape === "thenable") return { then(resolve) { touch(); resolve(value); } };
  if (shape === "inherited-then-getter") return Object.assign(Object.create({ get then() { touch(); return undefined; } }), value);
  throw Error("UNKNOWN_FIXTURE");
};

for (const shape of ["proxy", "promise-proxy", "hidden-then-getter", "throwing-then-getter", "thenable", "inherited-then-getter"]) {
  test(`normalized provider rejects ${shape} before any result hook`, async () => {
    let hooks = 0, calls = 0;
    const app = make(() => ++calls === 1 ? invalid(shape, final(), () => hooks++) : final());
    await assert.rejects(app.run(input), error => error.code === "INVALID_DATA");
    assert.equal(hooks, 0); assert.equal(calls, 1);
    assert.equal((await app.run(input)).status, "completed");
    assert.equal(calls, 2, "a rejected synchronous result must not strand capacity");
  });
  test(`read callback rejects ${shape} before any result hook or provider continuation`, async () => {
    let hooks = 0, providers = 0, reads = 0;
    const app = make(() => { providers++; return read(); }, [{ name: "read_status", description: "Read the authorized status.",
      inputSchema: closed, outputSchema: schema, readOnly: true,
      execute() { reads++; return invalid(shape, { answer: "Observed." }, () => hooks++); } }]);
    await assert.rejects(app.run(input), error => error.code === "INVALID_DATA");
    assert.equal(hooks, 0); assert.equal(providers, 1); assert.equal(reads, 1);
  });
}

test("plain synchronous and native async results preserve the complete read/final loop", async () => {
  for (const asynchronous of [false, true]) {
    let providers = 0, reads = 0;
    const complete = request => { providers++; return request.messages.at(-1).role === "tool" ? final() : read(); };
    const execute = () => { reads++; return { answer: "Observed." }; };
    const app = make(asynchronous ? async request => complete(request) : complete, [{ name: "read_status", description: "Read the authorized status.",
      inputSchema: closed, outputSchema: schema, readOnly: true, execute: asynchronous ? async () => execute() : execute }]);
    const result = await app.run(input);
    assert.equal(result.proposal.answer, "Observed status only.");
    assert.equal(providers, 2); assert.equal(reads, 1); assert.deepEqual({ ...result.usage }, { steps: 2, toolCalls: 1 });
  }
});

test("native promises carrying inert ALS and symbol metadata remain supported", async () => {
  const storage = new AsyncLocalStorage(); let symbolReads = 0;
  const app = make(() => storage.run({ scope: "authorized" }, () => {
    const promise = Promise.resolve(final());
    Object.defineProperty(promise, Symbol("inert-metadata"), { get() { symbolReads++; return "not data"; } });
    assert.ok(Reflect.ownKeys(promise).length > 0);
    assert.ok(Reflect.ownKeys(promise).every(key => typeof key === "symbol"));
    return promise;
  }));
  assert.equal((await app.run(input)).status, "completed"); assert.equal(symbolReads, 0);
});

test("genuine host-owned Promise subclass behavior remains supported", async () => {
  let observations = 0;
  class HostPromise extends Promise {
    static get [Symbol.species]() { return Promise; }
    then(resolve, reject) { observations++; return super.then(resolve, reject); }
  }
  const app = make(() => new HostPromise(resolve => resolve(final())));
  assert.equal((await app.run(input)).status, "completed");
  assert.equal(observations, 1);
});

test("a forged Promise prototype is data, never an executable async protocol", async () => {
  const app = make(() => Object.create(Promise.prototype));
  await assert.rejects(app.run(input), error => error.code === "INVALID_DATA");
});

for (const lateFailure of [false, true]) {
  test(`cancelled native callback retains capacity through late ${lateFailure ? "rejection" : "fulfillment"}`, { timeout: 5000 }, async () => {
    const entered = deferred(), pending = deferred(), control = new AbortController();
    const unhandled = []; const receive = error => unhandled.push(error); process.on("unhandledRejection", receive);
    let calls = 0;
    const app = make(() => { calls++; if (calls === 1) { entered.resolve(); return pending.promise; } return final(); });
    try {
      const running = app.run(input, { signal: control.signal }); running.catch(() => {});
      await entered.promise; control.abort();
      await assert.rejects(running, error => error.code === "CANCELLED");
      await assert.rejects(app.run(input), error => error.code === "BUSY");
      if (lateFailure) pending.reject(Error("private callback detail")); else pending.resolve(final());
      await new Promise(setImmediate);
      assert.equal((await app.run(input)).status, "completed");
      assert.equal(getEventListeners(control.signal, "abort").length, 0);
      assert.deepEqual(unhandled, []);
    } finally { pending.resolve(final()); control.abort(); process.removeListener("unhandledRejection", receive); }
  });
}

test("host-issued provider and read failure metadata survives sync and native rejection", async () => {
  for (const asynchronous of [false, true]) {
    const providerFailure = createRestrictedProviderFailure({ category: "quota" });
    const failProvider = () => { throw providerFailure; };
    const app = make(asynchronous ? async () => failProvider() : failProvider);
    await assert.rejects(app.run(input), error => error.code === "PROVIDER_FAILED" && error.providerFailure.category === "quota");
    const toolFailure = createRestrictedToolFailure({ category: "not_found" });
    const failRead = () => { throw toolFailure; };
    const reader = make(() => read(), [{ name: "read_status", description: "Read the authorized status.", inputSchema: closed, outputSchema: schema,
      readOnly: true, execute: asynchronous ? async () => failRead() : failRead }]);
    await assert.rejects(reader.run(input), error => error.code === "TOOL_FAILED" && error.toolFailure.category === "not_found");
  }
});

const nativeFactories = [
  ["explicit OpenAI-compatible", complete => createRestrictedOpenAIProvider({ model: "host-selected-model", supportsImages: false, complete })],
  ...["deepseek-flash", "deepseek-v4-pro"].map(model => [model, complete => createRestrictedDeepSeekProvider({ model, complete })]),
];
const nativeFinal = () => ({ choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ answer: "Observed status only." }) } }] });
const nativeRead = () => ({ choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
  tool_calls: [{ id: "read_status_1", type: "function", function: { name: "read_status", arguments: "{}" } }] } }] });
const nativeApp = (provider, execute = () => ({ answer: "Observed." })) => createRestrictedApplicationRunner({
  provider, instructions: "Read the authorized current status; return a proposal only. Never change or save anything.", outputSchema: schema,
  tools: [{ name: "read_status", description: "Read the authorized current status.", inputSchema: closed, outputSchema: schema, readOnly: true, execute }],
  limits: { timeoutMs: 1000, maxConcurrency: 1 },
});

for (const [name, factory] of nativeFactories) {
  for (const shape of ["proxy", "promise-proxy", "hidden-then-getter", "throwing-then-getter", "thenable", "inherited-then-getter"]) {
    test(`${name} rejects synchronous ${shape} before native final or read adoption`, async () => {
      for (const toolCall of [false, true]) {
        let hooks = 0, attempts = 0, reads = 0;
        const app = nativeApp(factory(() => ++attempts === 1
          ? invalid(shape, toolCall ? nativeRead() : nativeFinal(), () => hooks++) : nativeFinal()), () => { reads++; return { answer: "Observed." }; });
        await assert.rejects(app.run(input), error => error.code === "PROVIDER_FAILED");
        assert.equal(hooks, 0, "raw native response hooks must stay inert");
        assert.equal(reads, 0); assert.equal(attempts, 1);
        assert.equal((await app.run(input)).status, "completed", "invalid data must not strand capacity");
        assert.equal(reads, 0); assert.equal(attempts, 2);
      }
    });
  }

  test(`${name} rejects own then data instead of discarding response ambiguity`, async () => {
    for (const then of [null, false, "not an async protocol"]) {
      let attempts = 0, reads = 0;
      const app = nativeApp(factory(() => { attempts++; return { ...nativeRead(), then }; }), () => { reads++; return { answer: "Observed." }; });
      await assert.rejects(app.run(input), error => error.code === "PROVIDER_FAILED");
      assert.equal(attempts, 1); assert.equal(reads, 0);
    }
  });

  test(`${name} preserves plain, native and SDK-subclass read/final responses`, async () => {
    class HostPromise extends Promise { static get [Symbol.species]() { return Promise; } }
    const storage = new AsyncLocalStorage();
    for (const mode of ["plain", "async", "subclass", "als"]) {
      let attempts = 0, reads = 0, symbolReads = 0;
      const app = nativeApp(factory(() => {
        const wire = ++attempts === 1 ? nativeRead() : nativeFinal();
        if (mode === "plain") return wire;
        if (mode === "async") return Promise.resolve(wire);
        if (mode === "subclass") return new HostPromise(resolve => resolve(wire));
        return storage.run({ owner: "fixture" }, () => {
          const promise = Promise.resolve(wire);
          Object.defineProperty(promise, Symbol("inert"), { get() { symbolReads++; return "unused"; } });
          return promise;
        });
      }), () => { reads++; return { answer: "Observed." }; });
      assert.equal((await app.run(input)).proposal.answer, "Observed status only.");
      assert.equal(attempts, 2); assert.equal(reads, 1); assert.equal(symbolReads, 0);
    }
  });
}

test("native adapters retain cancelled pending transport capacity without unhandled rejection", { timeout: 5000 }, async () => {
  const unhandled = []; const receive = error => unhandled.push(error); process.on("unhandledRejection", receive);
  try {
    for (const [, factory] of nativeFactories) {
      const entered = deferred(), pending = deferred(), control = new AbortController(); let attempts = 0;
      const app = nativeApp(factory(() => { if (++attempts === 1) { entered.resolve(); return pending.promise; } return nativeFinal(); }));
      const running = app.run(input, { signal: control.signal }); running.catch(() => {});
      await entered.promise; control.abort();
      await assert.rejects(running, error => error.code === "CANCELLED");
      await assert.rejects(app.run(input), error => error.code === "BUSY");
      pending.reject(Error("private transport detail"));
      await new Promise(setImmediate);
      assert.equal((await app.run(input)).status, "completed");
      assert.equal(getEventListeners(control.signal, "abort").length, 0);
    }
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener("unhandledRejection", receive); }
});
