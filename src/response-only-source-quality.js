import { isDeepStrictEqual } from "node:util";

const BOUNDED_SOURCE_PACKET_PATTERN =
  /(?:bounded\s+(?:exact[- ]source|source|transcript)\s+packet|exact[- ]source\s+packet)\s*:\s*```(?:json)?\s*([\s\S]*?)\s*```/giu;

const SPEECH_SUMMARY_REQUEST_PATTERNS = [
  /\b(?:summari[sz]e|describe|explain)\b[^.\n]{0,100}\b(?:actual\s+)?(?:speech|spoken\s+content|dialogue|audio|transcript(?:ion)?)\b/iu,
  /\b(?:actual\s+)?(?:speech|spoken\s+content|dialogue|audio|transcript(?:ion)?)\b[^.\n]{0,100}\b(?:summary|summari[sz]e|description|describe|explain)\b/iu,
  /(?:总结|總結|概括|摘要|说明|說明|分析).{0,28}(?:实际语音|實際語音|讲话|講話|对白|對白|对话|對話|音频|音頻|转写|轉寫|转录|轉錄)/u,
  /(?:实际语音|實際語音|讲话|講話|对白|對白|对话|對話|音频|音頻|转写|轉寫|转录|轉錄).{0,28}(?:总结|總結|概括|摘要|说明|說明|分析)/u,
  /(?:実際の)?(?:発話|音声|会話|対話|文字起こし).{0,32}(?:要約|まとめ|説明|分析)/u,
  /(?:要約|まとめ|説明|分析).{0,32}(?:実際の)?(?:発話|音声|会話|対話|文字起こし)/u,
];

const TRANSCRIPT_LIMITATION_PATTERNS = [
  /\bno\s+(?:audible|discernible|intelligible|recognizable|recognisable)?\s*(?:speech|dialogue|spoken\s+content)\b/iu,
  /\b(?:transcript|transcription|speech|spoken\s+content|audio|dialogue)\b[^.\n]{0,140}\b(?:cannot|can't|could\s+not|failed|failure|insufficient|not\s+enough|too\s+repetitive|unreliable|unusable|unable|invalid|degenerate)\b/iu,
  /\b(?:cannot|can't|could\s+not|failed|failure|insufficient|not\s+enough|too\s+repetitive|unreliable|unusable|unable|invalid|degenerate)\b[^.\n]{0,140}\b(?:transcript|transcription|speech|spoken\s+content|audio|dialogue|summari[sz]e|recover)\b/iu,
  /(?:没有|沒有|无|無).{0,16}(?:可辨识|可辨識|清晰|有效|实际|實際)?(?:语音|語音|讲话|講話|对白|對白|对话|對話)/u,
  /(?:转写|轉寫|转录|轉錄|语音|語音|音频|音頻|对白|對白|对话|對話).{0,60}(?:异常|異常|重复|重複|失真|不可用|不可靠|不足|失败|失敗|无法|無法|不能|没有可概括|沒有可概括)/u,
  /(?:无法|無法|不能|未能|不可靠|不可用|没有可概括|沒有可概括).{0,60}(?:实际语音|實際語音|讲话|講話|对白|對白|对话|對話|音频|音頻|转写|轉寫|转录|轉錄|概括|总结|總結)/u,
  /(?:文字起こし|発話|音声|会話|対話).{0,70}(?:異常|反復|不十分|失敗|信頼でき|利用でき|要約でき)/u,
  /(?:信頼でき|利用でき|要約でき|不十分|失敗).{0,70}(?:文字起こし|発話|音声|会話|対話)/u,
  /(?:聞き取れる|判別できる|明瞭な).{0,12}(?:発話|音声|会話).{0,8}(?:ない|ありません)/u,
];

const RESPONSE_ONLY_PRIMARY_TEXT_KEYS = [
  "response",
  "chat_reply",
  "ack",
  "message",
  "summary",
  "confirmation",
];

function firstMarkedJsonValue(text = "", markerPattern, opening, closing) {
  const source = String(text || "");
  const marker = markerPattern.exec(source);
  markerPattern.lastIndex = 0;
  if (!marker) return null;
  const start = source.indexOf(opening, marker.index + marker[0].length);
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
    if (char === '"') {
      quote = char;
      continue;
    }
    if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function markedJsonValues(text = "", markerSource, opening, closing) {
  const source = String(text || "");
  const values = [];
  const markers = [...source.matchAll(new RegExp(markerSource, "giu"))];
  for (const marker of markers) {
    const value = firstMarkedJsonValue(
      source.slice(marker.index),
      new RegExp(`^${markerSource}`, "iu"),
      opening,
      closing
    );
    if (value !== null) values.push(value);
  }
  return values;
}

function parseStrictJsonObject(text = "") {
  const raw = String(text || "").trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu)?.[1];
  try {
    const parsed = JSON.parse(String(fenced ?? raw).trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function primaryResponseTexts(result = "") {
  const parsed = parseStrictJsonObject(result);
  if (!parsed) return [String(result || "").trim()].filter(Boolean);
  return RESPONSE_ONLY_PRIMARY_TEXT_KEYS
    .filter((key) => typeof parsed[key] === "string" && parsed[key].trim())
    .map((key) => parsed[key].trim());
}

function normalizeContextText(text = "") {
  return String(text || "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function currentMessageSections(goal = "") {
  const source = String(goal || "");
  const marker = /(?:^|\n)Current message:\s*(?:\n|$)/giu;
  const end = /\n+(?:Recent same-chat context|Private same-member knowledge|Current exact-chat active task|Recent context|Current coalesced request):/iu;
  return [...source.matchAll(marker)].map((match) => {
    const tail = source.slice(match.index + match[0].length);
    const boundary = tail.search(end);
    return (boundary >= 0 ? tail.slice(0, boundary) : tail).trim();
  }).filter(Boolean);
}

function priorSelfMessages(goal = "") {
  const contexts = markedJsonValues(
    goal,
    "(?:^|\\n)Recent same-chat context:\\s*",
    "[",
    "]"
  );
  return contexts.flatMap((context) => Array.isArray(context) ? context : [])
    .filter((entry) => entry?.is_self === true && typeof entry.content === "string")
    .map((entry) => entry.content.trim())
    .filter(Boolean);
}

function containsExplicitCurrentRepeat(goal = "", responseText = "") {
  const normalized = normalizeContextText(responseText);
  if (!normalized) return false;
  const repeatIntent = /\b(?:repeat|quote|echo|return\s+exactly|verbatim)\b|(?:原样|原樣|逐字|照抄|重复|重複|引用).{0,24}(?:这|這|下|句|话|話|内容|內容)|(?:そのまま|逐語|引用|繰り返).{0,24}(?:文|内容|発言)/iu;
  return currentMessageSections(goal).some((section) =>
    repeatIntent.test(section) && normalizeContextText(section).includes(normalized)
  );
}

function isSubstantiveExactReplay(candidate = "", prior = "") {
  const left = normalizeContextText(candidate);
  const right = normalizeContextText(prior);
  if (!left || left !== right) return false;
  return (left.match(/[\p{L}\p{N}]/gu) || []).length >= 12;
}

export function assessResponseOnlyContextEcho({ goal = "", result = "" } = {}) {
  const parsedResult = parseStrictJsonObject(result);
  const scopeObjects = markedJsonValues(
    goal,
    "AGINTI_EVIDENCE_SCOPE_JSON:\\s*",
    "{",
    "}"
  );
  if (
    parsedResult &&
    scopeObjects.some((scope) =>
      scope && typeof scope === "object" && !Array.isArray(scope) &&
      isDeepStrictEqual(scope, parsedResult)
    )
  ) {
    return {
      checked: true,
      ok: false,
      reason: "control-envelope-echo",
    };
  }

  const selfMessages = priorSelfMessages(goal);
  for (const candidate of primaryResponseTexts(result)) {
    if (containsExplicitCurrentRepeat(goal, candidate)) continue;
    if (selfMessages.some((prior) => isSubstantiveExactReplay(candidate, prior))) {
      return {
        checked: true,
        ok: false,
        reason: "prior-self-message-echo",
      };
    }
  }
  return {
    checked: Boolean(scopeObjects.length || selfMessages.length),
    ok: true,
    reason: "No stale response-only context replay was detected.",
  };
}

export function responseOnlyContextEchoRepairInstruction(assessment = {}, outputContractText = "") {
  return [
    assessment.reason === "control-envelope-echo"
      ? "Your previous answer copied the host's response-only control envelope instead of answering the current request."
      : "Your previous answer copied a prior bot-authored chat message instead of answering the different current inbound message.",
    "Answer the authoritative current message now. Use prior chat only as context; do not replay an earlier bot response or runtime metadata.",
    outputContractText
      ? `Preserve the explicit output contract exactly: ${outputContractText}. Return one JSON object with no prose or markdown fence.`
      : "Preserve the authoritative request's output shape exactly.",
  ].join(" ");
}

export function responseOnlyContextEchoStopMessage(goal = "") {
  const text = String(goal || "");
  if (/[\u3040-\u30ff]/u.test(text)) {
    return "現在の依頼への回答を生成できず、以前のボット応答または制御情報を繰り返したため停止しました。";
  }
  if (/\p{Script=Han}/u.test(text)) {
    return "未能生成针对当前消息的回答；模型重复了先前的机器人回复或控制信息，因此已停止。";
  }
  return "No current-turn answer was produced; the model repeated prior bot output or response-only control metadata, so the turn was stopped.";
}

function parseBoundedSourcePackets(text = "") {
  const packets = [];
  for (const match of String(text || "").matchAll(BOUNDED_SOURCE_PACKET_PATTERN)) {
    try {
      const packet = JSON.parse(match[1]);
      if (packet && typeof packet === "object" && !Array.isArray(packet)) packets.push(packet);
    } catch {
      // Ignore malformed prose examples; the response contract validator owns JSON output.
    }
  }
  return packets;
}

function responseReaderText(result = "") {
  const raw = String(result || "").trim();
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/giu, ""));
    const strings = [];
    const visit = (value) => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") Object.values(value).forEach(visit);
    };
    visit(parsed);
    return strings.join("\n");
  } catch {
    return raw;
  }
}

function normalizedTranscriptContent(transcript = "") {
  return String(transcript || "")
    .replace(
      /\[(?:\d{1,2}:)?\d{2}:\d{2}(?:\.\d+)?\s*[-–—]\s*(?:\d{1,2}:)?\d{2}:\d{2}(?:\.\d+)?\]/gu,
      " "
    )
    .normalize("NFKC")
    .toLocaleLowerCase();
}

export function assessTranscriptUsability(transcript = "", durationSeconds = 0) {
  const content = normalizedTranscriptContent(transcript);
  const tokens = content.match(/[\p{L}\p{N}]+/gu) || [];
  const contentCharacterCount = (content.match(/[\p{L}\p{N}]/gu) || []).length;
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const frequencies = [...counts.values()].sort((left, right) => right - left);
  const tokenCount = tokens.length;
  const uniqueTokenCount = counts.size;
  const uniqueRatio = tokenCount ? uniqueTokenCount / tokenCount : 0;
  const dominantRatio = tokenCount ? (frequencies[0] || 0) / tokenCount : 0;
  const topThreeRatio = tokenCount
    ? frequencies.slice(0, 3).reduce((sum, count) => sum + count, 0) / tokenCount
    : 0;
  const duration = Math.max(0, Number(durationSeconds || 0));
  const tooSparse =
    duration >= 20 &&
    contentCharacterCount < Math.max(8, Math.floor(duration * 0.35));
  const stronglyRepetitive =
    tokenCount >= 12 &&
    uniqueRatio <= 0.25 &&
    dominantRatio >= 0.35 &&
    topThreeRatio >= 0.75;
  const unusable = tokenCount === 0 || tooSparse || stronglyRepetitive;
  return {
    usable: !unusable,
    reason: tokenCount === 0
      ? "empty-transcript"
      : tooSparse
        ? "duration-content-mismatch"
        : stronglyRepetitive
          ? "strongly-repetitive-transcript"
          : "usable-transcript",
    tokenCount,
    contentCharacterCount,
    uniqueTokenCount,
    uniqueRatio,
    dominantRatio,
    topThreeRatio,
    durationSeconds: duration,
  };
}

export function assessBoundedTranscriptResponse({ goal = "", result = "" } = {}) {
  const packets = parseBoundedSourcePackets(goal);
  const packet = [...packets].reverse().find((candidate) => typeof candidate.transcript === "string");
  const speechSummaryRequested = SPEECH_SUMMARY_REQUEST_PATTERNS.some((pattern) => pattern.test(String(goal || "")));
  if (!packet || !speechSummaryRequested) {
    return {
      checked: false,
      ok: true,
      reason: "No bounded speech-summary contract was detected.",
    };
  }

  const quality = assessTranscriptUsability(
    packet.transcript,
    packet.source?.duration_seconds ?? packet.duration_seconds
  );
  if (quality.usable) {
    return {
      checked: true,
      ok: true,
      reason: "The bounded transcript is usable for a speech summary.",
      quality,
    };
  }

  const readerText = responseReaderText(result);
  const limitationDisclosed = TRANSCRIPT_LIMITATION_PATTERNS.some((pattern) => pattern.test(readerText));
  return {
    checked: true,
    ok: limitationDisclosed,
    reason: limitationDisclosed
      ? "The response truthfully discloses the bounded transcript limitation."
      : "The bounded transcript is unusable, but the response does not disclose that actual speech cannot be summarized reliably.",
    limitationDisclosed,
    quality,
  };
}

export function boundedTranscriptRepairInstruction(assessment = {}, outputContractText = "") {
  const quality = assessment.quality || {};
  return [
    "The bounded transcript cannot support a reliable summary of the actual speech.",
    `Transcript quality: ${quality.reason || "unusable-transcript"}; tokens=${quality.tokenCount || 0}; unique=${quality.uniqueTokenCount || 0}.`,
    "Do not infer spoken content, visuals, or events from the title, description, hashtags, or author.",
    "State briefly that the transcription is repetitive, sparse, or otherwise unreliable and that the actual speech cannot be summarized reliably.",
    "You may identify the video and describe a title-based theme only when you label it explicitly as coming from the title or description, not from the speech.",
    "Keep any requested truthful delivery statement.",
    outputContractText
      ? `Preserve the explicit output contract exactly: ${outputContractText}. Return one JSON object with no prose or markdown fence.`
      : "Preserve the authoritative request's output shape exactly.",
  ].join(" ");
}
