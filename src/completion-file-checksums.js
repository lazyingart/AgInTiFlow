// A contradiction check for explicit SHA-256 file claims, not a general prose
// verifier. Only native receipts supplied by the runtime are evidence. Quoted
// examples, other algorithms/files, and unlabeled hex are not checksum claims.
const SHA256 = /^[a-f0-9]{64}$/i;
const LABEL = /\bsha[-_\u2010-\u2015 ]?256\b/giu;
const HASH = /(?<![a-f0-9])(?:[a-f0-9]{4,60}\s*(?:…|\.{3})\s*[a-f0-9]{4,60}|[a-f0-9]{64})(?![a-f0-9])/giu;
const CONNECTOR = /^(?:[\s`"'*:=：()\[\],\-]|the\b|of\b|for\b|file\b|is\b|was\b|equals\b|has\b|unchanged\b|verified\b|的|文件|檔案|为|為|是|は|の|値|です)*$/iu;
const NONASSERTION = /\b(?:example|sample|literal|placeholder|hypothetical|expected|incorrect|wrong|invalid|quote|quoted|quotation|previous|former|old|original)\b|示例|例子|样例|範例|例示|引用|期待|期望|预期|預期|修改前|变更前|先前|原先|以前の|変更前|誤った|错误|錯誤/iu;
const PATH_EDGE = /[\p{L}\p{N}_./\\\-]/u;
const MAX_TEXT = 128 * 1024;
const MAX_LABELS = 256, MAX_MENTIONS = 1024, MAX_VALUES_PER_LABEL = 8;
const READ_ONLY_TOOLS = new Set(["read_file", "inspect_project", "list_files", "search_files", "read_image", "open_workspace_file", "finish"]);

function relativeReceiptPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !/[\0\r\n\\]/u.test(value) && !value.startsWith("/") &&
    !value.split("/").some(s => !s || s === "." || s === "..") && !/^[a-z]:/iu.test(value);
}

export function nativeFileChecksumReceipts(events = []) {
  const receipts = new Map();
  for (const event of events) {
    if (!["tool.started", "tool.completed", "tool.failed", "tool.blocked"].includes(event?.type)) continue;
    const data = event.data || {};
    // A failed command can still mutate files. Do not carry an earlier read
    // through an execution/mutation with unknown effects. A new read restores it.
    if (!READ_ONLY_TOOLS.has(data.toolName)) receipts.clear();
    if (data.toolName === "read_file" && event.type !== "tool.completed") {
      if (relativeReceiptPath(data.args?.path)) receipts.delete(data.args.path);
      else receipts.clear();
    }
    if (event.type !== "tool.completed") continue;
    if (data.toolName === "read_file" && relativeReceiptPath(data.path)) receipts.delete(data.path);
    if (data.toolName !== "read_file" || data.ok !== true || data.blocked || data.skipped ||
        !relativeReceiptPath(data.path) || typeof data.sha256 !== "string" || !SHA256.test(data.sha256)) continue;
    receipts.set(data.path, { path: data.path, sha256: data.sha256.toLowerCase() });
  }
  return [...receipts.values()];
}

function mentions(text, file) {
  const spans = [];
  for (let at = text.indexOf(file); at >= 0; at = text.indexOf(file, at + file.length)) {
    const before = text[at - 1], after = text[at + file.length];
    if ((!before || before !== ":" && !PATH_EDGE.test(before)) && (!after || !PATH_EDGE.test(after))) spans.push({ start: at, end: at + file.length });
    if (spans.length > MAX_MENTIONS) break;
  }
  return spans;
}

function claimUnits(text) {
  const units = [];
  let fence = false;
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*(?:```|~~~)/u.test(line)) { fence = !fence; continue; }
    if (fence || /^\s*>/u.test(line)) continue;
    for (const unit of line.split(/[;；。！？]|(?<=[.!?])\s+|\b(?:but|whereas)\b|但是|しかし/iu)) {
      const trimmed = unit.trim();
      if (/^(?:"[\s\S]*"|'[\s\S]*'|“[\s\S]*”|「[\s\S]*」)$/u.test(trimmed)) continue;
      units.push(unit);
    }
  }
  return units;
}

export function assessFileChecksumClaims({ text = "", receipts = [] } = {}) {
  const known = receipts.filter(r => relativeReceiptPath(r?.path) && typeof r.sha256 === "string" && SHA256.test(r.sha256) && text.includes(r.path));
  const issues = [], checkedPaths = new Set();
  if (!known.length || !/\bsha[-_\u2010-\u2015 ]?256\b/iu.test(text)) return { checked: false, ok: true, issues, receipts: [] };
  if (text.length > MAX_TEXT) return { checked: true, ok: false, issues: [{ reason: "checksum-text-limit" }], receipts: [] };
  const limit = () => ({ checked: true, ok: false, issues: [{ reason: "checksum-assessment-limit" }], receipts: [] });
  let labelCount = 0, mentionCount = 0;
  for (const unit of claimUnits(text)) {
    const labels = [...unit.matchAll(LABEL)];
    labelCount += labels.length;
    if (labelCount > MAX_LABELS) return limit();
    if (!labels.length) continue;
    // Find each path once per unit, never once per label/value. These counters
    // bound hostile repetition independently of provider output-token limits.
    const scoped = [];
    for (const receipt of known) {
      const spans = mentions(unit, receipt.path);
      mentionCount += spans.length;
      if (mentionCount > MAX_MENTIONS) return limit();
      for (const span of spans) scoped.push({ receipt, span });
    }
    for (const label of labels) {
      const labelEnd = label.index + label[0].length;
      let valueCount = 0;
      for (const value of unit.slice(labelEnd, labelEnd + 1200).matchAll(HASH)) {
        if (++valueCount > MAX_VALUES_PER_LABEL) return limit();
        const hashStart = labelEnd + value.index;
        const bindings = [];
        for (const { receipt, span } of scoped) {
          // Accept only adjacent file metadata or 'SHA-256 of <file> is <hash>'.
          if (span.end <= label.index && label.index - span.end <= 80 &&
              CONNECTOR.test(unit.slice(span.end, label.index)) && CONNECTOR.test(unit.slice(labelEnd, hashStart))) bindings.push({ receipt, start: span.start });
          else if (span.start >= labelEnd && span.end <= hashStart &&
              CONNECTOR.test(unit.slice(labelEnd, span.start)) && CONNECTOR.test(unit.slice(span.end, hashStart))) bindings.push({ receipt, start: label.index });
        }
        if (bindings.length !== 1) continue;
        const { receipt, start } = bindings[0];
        if (NONASSERTION.test(unit.slice(Math.max(0, start - 32), label.index))) break;
        if (/^[\s`"']*(?:ではない|ではなく|じゃない|不是|並非|并非)/u.test(unit.slice(hashStart + value[0].length))) break;
        // A whole quoted assertion is handled above; inline quotes used only as
        // file/hash delimiters do not exempt a factual metadata claim.
        checkedPaths.add(receipt.path);
        const parts = value[0].replace(/\s/gu, "").toLowerCase().split(/…|\.{3}/u);
        const matches = parts.length === 1 ? receipt.sha256.toLowerCase() === parts[0]
          : parts[0].length + parts[1].length < 64 && receipt.sha256.toLowerCase().startsWith(parts[0]) && receipt.sha256.toLowerCase().endsWith(parts[1]);
        if (!matches) issues.push({ path: receipt.path, reason: "native-file-checksum-mismatch" });
        break;
      }
    }
  }
  return { checked: checkedPaths.size > 0, ok: issues.length === 0, issues,
    receipts: known.filter(r => checkedPaths.has(r.path)).map(r => ({ path: r.path, sha256: r.sha256.toLowerCase() })) };
}
