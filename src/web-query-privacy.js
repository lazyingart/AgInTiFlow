import { redactSensitiveText } from "./redaction.js";

const PRIVATE_CONTEXT_TITLE_PATTERNS = [
  /^(?:private\s+)?(?:group\s+)?(?:chat|conversation|message|session)\s+(?:history|transcript|log|record)(?:\s+(?:for|of|with)\s+.+)?$/i,
  /^.+(?:'s|’s)\s+(?:chat|conversation|message|session)\s+(?:history|transcript|log|record)$/i,
  /^.+的(?:聊天|对话|会话|消息)(?:记录|历史)$/u,
  /^(?:聊天|对话|会话|消息)(?:记录|历史)\s*[:：-]\s*.+$/u,
  /^.+(?:との|の)(?:チャット|会話|メッセージ)(?:履歴|記録)$/u,
  /^(?:チャット|会話|メッセージ)(?:履歴|記録)\s*[:：-]\s*.+$/u,
];

function normalizeTitleLikeQuery(value) {
  return String(value || "")
    .trim()
    .replace(/^[\s"'“”‘’`「」『』《》【】\[\]()（）]+|[\s"'“”‘’`「」『』《》【】\[\]()（）]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function assessPublicWebQuery(value) {
  const query = String(value || "").trim();
  if (!query) return { allowed: true };

  if (redactSensitiveText(query) !== query) {
    return {
      allowed: false,
      category: "web-search-sensitive-query",
      reason:
        "The public search query contains secret-like material. Remove the credential or token and search only for the public topic.",
    };
  }

  const normalized = normalizeTitleLikeQuery(query);
  if (PRIVATE_CONTEXT_TITLE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      allowed: false,
      category: "web-search-private-context",
      reason:
        "The query looks like a private chat, message, or session-history title rather than a public research question. Search for the underlying public topic without names or transcript labels.",
    };
  }

  return { allowed: true };
}
