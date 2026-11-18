import { types } from "node:util";
import { addAbortListener } from "node:events";
import { createRestrictedApplicationChannel, RestrictedApplicationPipeError, PIPE_MAX_FRAME_BYTES } from "./channel.js";
import { dataFields, parseRestrictedJson } from "./internal/restricted-application-contract.js";

const then = Promise.prototype.then, apply = Reflect.apply;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const getBuffer = Object.getOwnPropertyDescriptor(typed, "buffer").get;
const getOffset = Object.getOwnPropertyDescriptor(typed, "byteOffset").get;
const getLength = Object.getOwnPropertyDescriptor(typed, "byteLength").get;
function sink(value) { apply(then, value, [undefined, () => {}]); return value; }
const pipeError = code => new RestrictedApplicationPipeError(code);

// Own only the supplied private streams. Import starts no reader, listener,
// provider or process. The embedding app supplies explicit bootstrap config.
export function serveRestrictedApplicationPipe(options) {
  const config = dataFields(options, ["input", "output", "scopeId", "provider", "instructions", "outputSchema", "tools", "limits", "closeGraceMs"],
    ["input", "output", "scopeId", "provider", "instructions", "outputSchema"]);
  const input = config.input, output = config.output;
  if (!input || !output || types.isProxy(input) || types.isProxy(output) ||
    typeof input[Symbol.asyncIterator] !== "function" || typeof input.destroy !== "function" ||
    typeof output.write !== "function" || typeof output.on !== "function" || typeof output.once !== "function" || typeof output.removeListener !== "function" || typeof output.destroy !== "function") throw pipeError("INVALID_TRANSPORT");
  const queue = [], writesAbort = new AbortController(); let pumping = false, stopping = false, stopped = false, failure = null, closePromise, pumpTask;
  const fail = code => { if (!failure) failure = pipeError(code); return failure; };
  function write(frame) {
    if (stopping || stopped || failure) return sink(Promise.reject(failure || pipeError("CLOSED")));
    let bytes;
    try { bytes = Buffer.from(JSON.stringify(frame) + "\n", "utf8"); }
    catch { return sink(Promise.reject(fail("OUTPUT_FAILED"))); }
    if (bytes.length > PIPE_MAX_FRAME_BYTES + 1 || queue.length >= 8) return sink(Promise.reject(fail("OUTPUT_LIMIT")));
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });sink(promise);
    queue.push({ bytes, resolve, reject }); pump(); return promise;
  }
  function writeOne(bytes) {
    const promise = new Promise((resolve, reject) => {
      let settled = false, subscription;
      const timer = setTimeout(() => finish(pipeError("OUTPUT_TIMEOUT")), 2500);
      const onError = () => finish(pipeError("OUTPUT_FAILED"));
      const onClose = () => finish(pipeError("OUTPUT_CLOSED"));
      function finish(error) {
        if (settled) return; settled = true;clearTimeout(timer);
        subscription?.[Symbol.dispose]();
        output.removeListener("error", onError);output.removeListener("close", onClose);
        if (error) reject(error);else resolve();
      }
      output.once("error", onError);output.once("close", onClose);
      subscription = addAbortListener(writesAbort.signal, () => finish(pipeError("CLOSED")));
      if (writesAbort.signal.aborted) { finish(pipeError("CLOSED")); return; }
      try { output.write(bytes, error => finish(error ? pipeError("OUTPUT_FAILED") : null)); }
      catch { finish(pipeError("OUTPUT_FAILED")); }
    });
    return sink(promise);
  }
  function pump() {
    if (pumping) return;
    pumping = true;
    pumpTask = (async () => {
      try {
        while (queue.length) {
          if (failure || stopping) throw failure || pipeError("CLOSED");
          const item = queue[0];
          try { await writeOne(item.bytes); item.resolve(); }
          catch { item.reject(fail("OUTPUT_FAILED")); throw failure; }
          finally { queue.shift(); }
        }
      } catch {
        for (const item of queue.splice(0)) item.reject(failure);
        try { input.destroy(); } catch { fail("INPUT_CLOSE_FAILED"); }
      } finally { pumping = false; }
    })();sink(pumpTask);
  }
  const channelConfig = { scopeId: config.scopeId, provider: config.provider, instructions: config.instructions,
    outputSchema: config.outputSchema, emit: write };
  for (const key of ["tools", "limits", "closeGraceMs"]) if (Object.hasOwn(config, key)) channelConfig[key] = config[key];
  const channel = createRestrictedApplicationChannel(channelConfig);
  // A Writable may emit error *after* invoking its write callback. Keep an
  // observer through stream close, including failure/explicit-close cleanup.
  const onTransportError = () => {
    fail("OUTPUT_FAILED");
    sink(channel.close());
    try { input.destroy(); } catch { fail("INPUT_CLOSE_FAILED"); }
  };
  let resolveOutputClosed;
  const outputClosed = new Promise(resolve => { resolveOutputClosed = resolve; });
  const onTransportClose = () => {
    output.removeListener("error", onTransportError);resolveOutputClosed();
    if (!stopping) {
      fail("OUTPUT_CLOSED");sink(channel.close());
      try { input.destroy(); } catch { fail("INPUT_CLOSE_FAILED"); }
    }
  };
  output.on("error", onTransportError);output.once("close", onTransportClose);
  const ready = write(channel.ready);sink(ready);
  function close() {
    if (!closePromise) {
      stopping = true;
      const promise = (async () => {
        writesAbort.abort();
        try { input.destroy(); } catch { fail("INPUT_CLOSE_FAILED"); }
        let result;
        try { result = await channel.close(); }
        finally {
          stopped = true;
          for (const item of queue.splice(0)) item.reject(failure || pipeError("CLOSED"));
          try { output.destroy(); } catch { fail("OUTPUT_CLOSE_FAILED"); }
          if (pumpTask) await pumpTask;
          let timer;
          try {
            await Promise.race([outputClosed, new Promise((_, reject) => {
              timer = setTimeout(() => reject(fail("OUTPUT_CLOSE_UNPROVEN")), 2500);
            })]);
          } finally { clearTimeout(timer); }
        }
        if (failure) throw failure;
        return result;
      })();closePromise = sink(promise);
    }
    return closePromise;
  }
  const done = (async () => {
    let pending = Buffer.alloc(0);
    try {
      await ready;
      for await (const raw of input) {
        if (stopping || stopped || failure) break;
        if (types.isProxy(raw) || !types.isUint8Array(raw)) throw pipeError("INVALID_TRANSPORT");
        const buffer = apply(getBuffer, raw, []);
        if (types.isSharedArrayBuffer(buffer)) throw pipeError("INVALID_TRANSPORT");
        const chunk = Buffer.from(buffer, apply(getOffset, raw, []), apply(getLength, raw, []));
        // Node's raw streams deliver bounded chunks; process one line at a time
        // without allocating an unbounded concatenation supplied by the host.
        let offset = 0;
        while (offset < chunk.byteLength) {
          const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.byteLength : newline;
          const part = chunk.subarray(offset, end);
          if (pending.length + part.length > PIPE_MAX_FRAME_BYTES) throw pipeError("FRAME_LIMIT");
          pending = Buffer.concat([pending, part]);
          if (newline < 0) break;
          if (!pending.length || pending[pending.length - 1] === 13) throw pipeError("INVALID_FRAME");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(pending);
          const frame = parseRestrictedJson(text); pending = Buffer.alloc(0);
          await channel.accept(frame); offset = newline + 1;
        }
      }
      if (pending.length && !stopping) throw pipeError("TRUNCATED_FRAME");
      if (failure) throw failure;
    } catch (error) {
      if (!stopping) fail(error instanceof RestrictedApplicationPipeError ? error.code : "INVALID_FRAME");
    } finally {
      await close();
    }
    if (failure) throw failure;
    return Object.freeze({ localCallbacksDrained: true, remoteTerminationProven: false });
  })();sink(done);
  return Object.freeze({ ready, done, close, inspect: channel.inspect });
}
