(function initConversationApi(global) {
  const NAMESPACE = "__CHATGPT_HELPER__";

  class ConversationResponseError extends Error {
    constructor(message) {
      super(message);
      this.name = "ConversationResponseError";
    }
  }

  function getConversationId(pathname = global.location?.pathname || "") {
    const match = String(pathname).match(/(?:^|\/)c\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function normalizeQuestionTitle(rawText) {
    const firstLine = String(rawText || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .find((line) => !/^(你说|您说|你问|用户|You said|You)\s*[:：]?$/i.test(line));

    const normalized = (firstLine || "")
      .replace(/^(你说|您说|你问|用户|You said|You)\s*[:：]\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();

    return Array.from(normalized).slice(0, 120).join("");
  }

  function extractPartText(part) {
    if (typeof part === "string") {
      return part;
    }

    if (part && typeof part === "object" && typeof part.text === "string") {
      return part.text;
    }

    return "";
  }

  function extractMessageText(message) {
    const parts = message?.content?.parts;
    if (!Array.isArray(parts)) {
      return "";
    }

    return parts
      .map(extractPartText)
      .filter((part) => part.trim())
      .join("\n")
      .trim();
  }

  function assertConversationPayload(payload) {
    if (!payload || typeof payload !== "object") {
      throw new ConversationResponseError("会话响应不是对象");
    }

    if (!payload.mapping || typeof payload.mapping !== "object" || Array.isArray(payload.mapping)) {
      throw new ConversationResponseError("会话响应缺少 mapping");
    }

    if (typeof payload.current_node !== "string" || !payload.current_node) {
      throw new ConversationResponseError("会话响应缺少 current_node");
    }

    if (!Object.prototype.hasOwnProperty.call(payload.mapping, payload.current_node)) {
      throw new ConversationResponseError("current_node 未指向有效节点");
    }
  }

  function buildActiveBranch(payload) {
    assertConversationPayload(payload);

    const visited = new Set();
    const reversed = [];
    let nodeId = payload.current_node;

    while (nodeId !== null) {
      if (visited.has(nodeId)) {
        throw new ConversationResponseError("会话父链存在循环");
      }

      const node = payload.mapping[nodeId];
      if (!node || typeof node !== "object") {
        throw new ConversationResponseError("会话父链引用了不存在的节点");
      }

      visited.add(nodeId);
      const message = node.message || null;
      reversed.push({
        nodeId,
        messageId:
          typeof message?.id === "string" && message.id
            ? message.id
            : nodeId,
        role:
          typeof message?.author?.role === "string"
            ? message.author.role
            : null,
        branchIndex: -1,
        message
      });

      if (node.parent !== null && typeof node.parent !== "string") {
        throw new ConversationResponseError("会话节点包含无效父节点引用");
      }

      nodeId = node.parent;
    }

    return reversed.reverse().map((entry, branchIndex) => ({
      ...entry,
      branchIndex
    }));
  }

  function buildQuestionItems(branch) {
    if (!Array.isArray(branch)) {
      return [];
    }

    return branch
      .filter((entry) => entry?.role === "user")
      .map((entry) => {
        const fullText = extractMessageText(entry.message);
        const title = normalizeQuestionTitle(fullText);
        if (!title) {
          return null;
        }

        return {
          id: `question-${entry.messageId}`,
          messageId: entry.messageId,
          nodeId: entry.nodeId,
          title,
          branchIndex: entry.branchIndex,
          element: null,
          source: "api"
        };
      })
      .filter(Boolean);
  }

  global[NAMESPACE] = global[NAMESPACE] || {};
  global[NAMESPACE].conversationApi = {
    ConversationResponseError,
    buildActiveBranch,
    buildQuestionItems,
    getConversationId,
    normalizeQuestionTitle
  };
})(globalThis);
