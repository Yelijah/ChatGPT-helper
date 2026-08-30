(function initConversationApi(global) {
  const NAMESPACE = "__CHATGPT_HELPER__";
  const SESSION_ENDPOINT = "/api/auth/session";
  const CONVERSATION_ENDPOINT_PREFIX = "/backend-api/conversation/";

  class ConversationResponseError extends Error {
    constructor(message) {
      super(message);
      this.name = "ConversationResponseError";
    }
  }

  class ConversationRequestError extends Error {
    constructor(status) {
      super(`会话请求失败（HTTP ${status}）`);
      this.name = "ConversationRequestError";
      this.status = status;
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

  function createLinkedAbortSignal(...signals) {
    const controller = new AbortController();
    const cleanups = [];

    signals.filter(Boolean).forEach((source) => {
      if (source.aborted) {
        controller.abort(source.reason);
        return;
      }

      const onAbort = () => controller.abort(source.reason);
      source.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => source.removeEventListener("abort", onAbort));
    });

    return {
      signal: controller.signal,
      cleanup() {
        cleanups.splice(0).forEach((cleanup) => cleanup());
      }
    };
  }

  async function fetchSession(fetchImpl, signal) {
    const response = await fetchImpl(SESSION_ENDPOINT, {
      credentials: "include",
      signal
    });

    if (!response.ok) {
      return { accessToken: null };
    }

    const payload = await response.json();
    return {
      accessToken:
        typeof payload?.accessToken === "string"
          ? payload.accessToken
          : null
    };
  }

  async function loadConversation(conversationId, options = {}) {
    if (!conversationId) {
      throw new ConversationRequestError(400);
    }

    const fetchImpl = options.fetchImpl || global.fetch.bind(global);
    const timeoutMs = Number(options.timeoutMs) || 8000;
    const timeoutController = new AbortController();
    const timeoutId = global.setTimeout(() => timeoutController.abort(), timeoutMs);
    const linked = createLinkedAbortSignal(options.signal, timeoutController.signal);
    const signal = linked.signal;

    try {
      const path = `${CONVERSATION_ENDPOINT_PREFIX}${encodeURIComponent(conversationId)}`;
      let response = await fetchImpl(path, {
        credentials: "include",
        signal
      });

      if (response.status === 401 || response.status === 403) {
        const session = await fetchSession(fetchImpl, signal);
        response = await fetchImpl(path, {
          credentials: "include",
          signal,
          headers: session.accessToken
            ? { Authorization: `Bearer ${session.accessToken}` }
            : undefined
        });
      }

      if (!response.ok) {
        throw new ConversationRequestError(response.status);
      }

      const payload = await response.json();
      const branch = buildActiveBranch(payload);
      return {
        branch,
        questions: buildQuestionItems(branch)
      };
    } finally {
      global.clearTimeout(timeoutId);
      linked.cleanup();
    }
  }

  function createRequestGate() {
    let generation = 0;
    let controller = null;

    return {
      next() {
        controller?.abort();
        controller = new AbortController();
        generation += 1;
        return { generation, signal: controller.signal };
      },
      isCurrent(value) {
        return value === generation && !controller?.signal.aborted;
      },
      abort() {
        controller?.abort();
        generation += 1;
      }
    };
  }

  global[NAMESPACE] = global[NAMESPACE] || {};
  global[NAMESPACE].conversationApi = {
    ConversationRequestError,
    ConversationResponseError,
    buildActiveBranch,
    buildQuestionItems,
    createRequestGate,
    getConversationId,
    loadConversation,
    normalizeQuestionTitle
  };
})(globalThis);
