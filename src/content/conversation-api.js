(function initConversationApi(global) {
  const NAMESPACE = "__CHATGPT_HELPER__";
  const SESSION_ENDPOINT = "/api/auth/session";
  const CONVERSATION_ENDPOINT_PREFIX = "/backend-api/conversations/";
  const PAGE_SIZE = 100;
  const MAX_PAGE_COUNT = 100;
  const CLIENT_BOOTSTRAP_SELECTOR = "#client-bootstrap[type='application/json']";
  let cachedClientAuth = null;
  const FINGERPRINT_SALT = (() => {
    const values = new Uint32Array(2);
    if (global.crypto?.getRandomValues) {
      global.crypto.getRandomValues(values);
    } else {
      values[0] = Math.floor(Math.random() * 0xffffffff);
      values[1] = Math.floor(Math.random() * 0xffffffff);
    }
    return `${values[0].toString(16)}${values[1].toString(16)}`;
  })();

  class ConversationResponseError extends Error {
    constructor(message) {
      super(message);
      this.name = "ConversationResponseError";
    }
  }

  class ConversationRequestError extends Error {
    constructor(status, code = null) {
      super(`会话请求失败（HTTP ${status}${code ? `，${code}` : ""}）`);
      this.name = "ConversationRequestError";
      this.status = status;
      this.code = code;
    }
  }

  function getConversationId(pathname = global.location?.pathname || "") {
    const match = String(pathname).match(/(?:^|\/)c\/([^/?#]+)/i);
    if (!match) {
      return null;
    }

    try {
      return decodeURIComponent(match[1]);
    } catch (error) {
      if (error instanceof URIError) {
        return null;
      }
      throw error;
    }
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

  function createTextFingerprint(rawText) {
    const normalized = normalizeMessageText(rawText);
    if (!normalized) {
      return null;
    }

    const input = `${FINGERPRINT_SALT}\u0000${normalized}`;
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193);
      second = Math.imul(second ^ code, 0x85ebca6b);
    }
    return `v1-${(first >>> 0).toString(16).padStart(8, "0")}${(
      second >>> 0
    )
      .toString(16)
      .padStart(8, "0")}`;
  }

  function normalizeMessageText(rawText) {
    return String(rawText || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
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

  function assertPaginatedConversationPayload(payload, { initial = false } = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ConversationResponseError("会话响应不是对象");
    }
    if (!Array.isArray(payload.messages)) {
      throw new ConversationResponseError("会话响应缺少 messages");
    }
    if (!payload.page_info || typeof payload.page_info !== "object") {
      throw new ConversationResponseError("会话响应缺少 page_info");
    }
    if (typeof payload.page_info.has_previous_page !== "boolean") {
      throw new ConversationResponseError("会话响应包含无效分页信息");
    }
    if (payload.page_info.has_previous_page &&
      (typeof payload.page_info.start_cursor !== "string" || !payload.page_info.start_cursor)) {
      throw new ConversationResponseError("会话响应缺少历史分页游标");
    }
    if (initial && payload.messages.length > 0) {
      if (typeof payload.current_node !== "string" || !payload.current_node) {
        throw new ConversationResponseError("会话响应缺少 current_node");
      }
      if (!payload.messages.some((message) => message?.id === payload.current_node)) {
        throw new ConversationResponseError("current_node 未指向有效消息");
      }
    }
    const ids = new Set();
    payload.messages.forEach((message) => {
      if (!message || typeof message !== "object" || typeof message.id !== "string" || !message.id) {
        throw new ConversationResponseError("会话响应包含无效消息");
      }
      if (ids.has(message.id)) {
        throw new ConversationResponseError("会话响应包含重复消息");
      }
      ids.add(message.id);
      if (typeof message.author?.role !== "string") {
        throw new ConversationResponseError("会话消息缺少作者角色");
      }
    });
  }

  function buildMessageBranch(messages) {
    if (!Array.isArray(messages)) {
      throw new ConversationResponseError("会话消息列表无效");
    }
    return messages.map((message, branchIndex) => ({
      nodeId: message.id,
      messageId: message.id,
      role: message.author.role,
      branchIndex,
      message
    }));
  }

  function buildQuestionItems(branch) {
    if (!Array.isArray(branch)) {
      return [];
    }

    return branch
      .filter((entry) => entry?.role === "user")
      .map((entry) => {
        const fullText = normalizeMessageText(extractMessageText(entry.message));
        const title = normalizeQuestionTitle(fullText);
        if (!title) {
          return null;
        }

        return {
          id: `question-${entry.messageId}`,
          messageId: entry.messageId,
          nodeId: entry.nodeId,
          title,
          fullText,
          textFingerprint: createTextFingerprint(fullText),
          branchIndex: entry.branchIndex,
          element: null,
          source: "api"
        };
      })
      .filter(Boolean);
  }

  function mergeQuestionItems(apiItems, domItems) {
    const canonical = Array.isArray(apiItems)
      ? apiItems.map((item) => ({ ...item }))
      : [];
    const rendered = Array.isArray(domItems) ? domItems : [];
    const byMessageId = new Map(
      canonical
        .filter((item) => item.messageId)
        .map((item) => [item.messageId, item])
    );
    const matchedIds = new Set();

    rendered.forEach((domItem) => {
      const match = domItem.messageId
        ? byMessageId.get(domItem.messageId)
        : null;
      if (!match) {
        return;
      }

      match.element = domItem.element || null;
      matchedIds.add(match.id);
    });

    const unmatchedTail = canonical.slice(Math.max(canonical.length - 4, 0));
    const pending = rendered.filter((domItem) => {
      if (domItem.messageId && byMessageId.has(domItem.messageId)) {
        return false;
      }

      const normalizedDomText = normalizeMessageText(domItem.fullText);
      const domFingerprint = createTextFingerprint(normalizedDomText);
      const textMatch = unmatchedTail.find((item) => {
        const itemFingerprint =
          item.textFingerprint || createTextFingerprint(item.fullText);
        return (
          !matchedIds.has(item.id) &&
          itemFingerprint &&
          itemFingerprint === domFingerprint
        );
      });

      if (textMatch) {
        textMatch.element = domItem.element || null;
        matchedIds.add(textMatch.id);
        return false;
      }

      return true;
    });

    return canonical.concat(pending.map((item) => ({ ...item })));
  }

  function createConversationCacheEntry(result) {
    return {
      branch: (Array.isArray(result?.branch) ? result.branch : []).map(
        ({ nodeId, messageId, role, branchIndex }) => ({
          nodeId,
          messageId,
          role,
          branchIndex
        })
      ),
      questions: (Array.isArray(result?.questions) ? result.questions : []).map(
        ({
          id,
          messageId,
          nodeId,
          title,
          fullText,
          textFingerprint,
          branchIndex,
          source
        }) => ({
          id,
          messageId,
          nodeId,
          title,
          textFingerprint:
            textFingerprint || createTextFingerprint(fullText),
          branchIndex,
          source
        })
      )
    };
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

  function readClientBootstrapAuth(documentRef = global.document) {
    if (!documentRef?.querySelector) {
      return null;
    }

    const script = documentRef.querySelector(CLIENT_BOOTSTRAP_SELECTOR);
    if (!script?.textContent) {
      return null;
    }

    try {
      const payload = JSON.parse(script.textContent);
      const accessToken = payload?.session?.accessToken;
      if (typeof accessToken !== "string" || !accessToken) {
        return null;
      }
      const expiresAt = Date.parse(payload?.session?.expires || "");
      if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        return null;
      }
      return {
        accessToken,
        accountId:
          typeof payload?.session?.account?.id === "string"
            ? payload.session.account.id
            : null,
        sessionId:
          typeof payload?.sessionId === "string"
            ? payload.sessionId
            : null
      };
    } catch (error) {
      return null;
    }
  }

  function waitForClientBootstrapAuth(options = {}) {
    if (cachedClientAuth) {
      return Promise.resolve({ ...cachedClientAuth });
    }

    const documentRef = options.documentRef || global.document;
    const initial = readClientBootstrapAuth(documentRef);
    if (initial) {
      cachedClientAuth = initial;
      return Promise.resolve({ ...initial });
    }
    if (!documentRef?.documentElement) {
      return Promise.resolve(null);
    }

    const MutationObserverImpl =
      options.MutationObserverImpl || global.MutationObserver;
    if (typeof MutationObserverImpl !== "function") {
      return Promise.resolve(null);
    }

    const signal = options.signal;
    const timeoutMs = Math.max(Number(options.timeoutMs) || 1500, 0);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("会话请求已取消", "AbortError")
        );
        return;
      }

      let settled = false;
      let timeoutId = 0;
      const observer = new MutationObserverImpl(() => {
        const auth = readClientBootstrapAuth(documentRef);
        if (auth) {
          cachedClientAuth = auth;
          finish(auth);
        }
      });
      const onAbort = () => {
        finish(
          null,
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("会话请求已取消", "AbortError")
        );
      };

      function cleanup() {
        observer.disconnect();
        if (timeoutId) {
          global.clearTimeout(timeoutId);
        }
        signal?.removeEventListener("abort", onAbort);
      }

      function finish(auth, error) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve(auth ? { ...auth } : null);
        }
      }

      observer.observe(documentRef.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      timeoutId = global.setTimeout(() => finish(null), timeoutMs);
    });
  }

  function createAuthHeaders(auth) {
    const headers = {};
    if (auth?.accessToken) {
      headers.Authorization = `Bearer ${auth.accessToken}`;
    }
    if (auth?.accountId) {
      headers["chatgpt-account-id"] = auth.accountId;
    }
    if (auth?.sessionId) {
      headers["oai-session-id"] = auth.sessionId;
    }
    return Object.keys(headers).length ? headers : null;
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

  async function readErrorCode(response) {
    try {
      const payload = await response.clone().json();
      const candidates = [
        payload?.detail?.code,
        payload?.error?.code,
        payload?.code,
        typeof payload?.detail === "string" ? payload.detail : null,
        typeof payload?.error === "string" ? payload.error : null
      ];
      return candidates.find((code) => typeof code === "string" && code) || null;
    } catch (error) {
      return null;
    }
  }

  function createConversationPagePath(conversationId) {
    return `${CONVERSATION_ENDPOINT_PREFIX}${encodeURIComponent(conversationId)}?include_has_versions=true&num_turns=${PAGE_SIZE}`;
  }

  function createOlderMessagesPath(conversationId, cursor) {
    return `${CONVERSATION_ENDPOINT_PREFIX}${encodeURIComponent(conversationId)}/messages?before=${encodeURIComponent(cursor)}&include_has_versions=true&num_turns=${PAGE_SIZE}`;
  }

  async function loadConversation(conversationId, options = {}) {
    if (!conversationId) {
      throw new ConversationRequestError(400);
    }

    const fetchImpl = options.fetchImpl || global.fetch.bind(global);
    const timeoutMs = Number(options.timeoutMs) || 20000;
    const timeoutController = new AbortController();
    const timeoutId = global.setTimeout(() => timeoutController.abort(), timeoutMs);
    const linked = createLinkedAbortSignal(options.signal, timeoutController.signal);
    const signal = linked.signal;

    try {
      const bootstrapAuth = await waitForClientBootstrapAuth({
        documentRef: options.documentRef,
        MutationObserverImpl: options.MutationObserverImpl,
        signal,
        timeoutMs: options.bootstrapTimeoutMs
      });
      const auth = {
        accessToken: bootstrapAuth?.accessToken || null,
        accountId: bootstrapAuth?.accountId || null,
        sessionId: bootstrapAuth?.sessionId || null,
        sessionAttempted: false
      };
      const requestPage = async (path) => {
        const headers = createAuthHeaders(auth);
        const init = {
          credentials: "include",
          signal,
          ...(headers ? { headers } : {})
        };
        let response = await fetchImpl(path, init);
        let code = response.ok ? null : await readErrorCode(response);
        const shouldRefresh =
          !response.ok &&
          !auth.sessionAttempted &&
          (response.status === 401 || response.status === 403 ||
            (response.status === 404 && code === "conversation_inaccessible"));
        if (shouldRefresh) {
          auth.sessionAttempted = true;
          cachedClientAuth = null;
          auth.accountId = null;
          auth.sessionId = null;
          const session = await fetchSession(fetchImpl, signal);
          auth.accessToken = session.accessToken;
          cachedClientAuth = auth.accessToken
            ? {
                accessToken: auth.accessToken,
                accountId: null,
                sessionId: null
              }
            : null;
          const retryHeaders = createAuthHeaders(auth);
          response = await fetchImpl(path, {
            credentials: "include",
            signal,
            ...(retryHeaders ? { headers: retryHeaders } : {})
          });
          code = response.ok ? null : await readErrorCode(response);
          if (
            !response.ok &&
            (response.status === 401 || response.status === 403)
          ) {
            cachedClientAuth = null;
          }
        }
        if (!response.ok) {
          throw new ConversationRequestError(response.status, code);
        }
        try {
          return await response.json();
        } catch (error) {
          throw new ConversationResponseError("会话响应不是有效 JSON");
        }
      };

      const firstPayload = await requestPage(createConversationPagePath(conversationId));
      assertPaginatedConversationPayload(firstPayload, { initial: true });
      let messages = firstPayload.messages.slice();
      let cursor = firstPayload.page_info.has_previous_page
        ? firstPayload.page_info.start_cursor
        : null;
      const seenCursors = new Set();
      let pageCount = 1;
      while (cursor) {
        if (seenCursors.has(cursor)) {
          throw new ConversationResponseError("会话分页游标未推进");
        }
        if (pageCount >= MAX_PAGE_COUNT) {
          throw new ConversationResponseError("会话分页超过安全上限");
        }
        seenCursors.add(cursor);
        const olderPayload = await requestPage(
          createOlderMessagesPath(conversationId, cursor)
        );
        assertPaginatedConversationPayload(olderPayload);
        const merged = olderPayload.messages.concat(messages);
        const ids = new Set();
        messages = merged.filter((message) => {
          if (ids.has(message.id)) return false;
          ids.add(message.id);
          return true;
        });
        cursor = olderPayload.page_info.has_previous_page
          ? olderPayload.page_info.start_cursor
          : null;
        pageCount += 1;
      }

      const parsedBranch = buildMessageBranch(messages);
      return {
        branch: parsedBranch.map(({ nodeId, messageId, role, branchIndex }) => ({
          nodeId,
          messageId,
          role,
          branchIndex
        })),
        questions: buildQuestionItems(parsedBranch)
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
    buildMessageBranch,
    buildQuestionItems,
    createConversationCacheEntry,
    createTextFingerprint,
    createRequestGate,
    getConversationId,
    loadConversation,
    mergeQuestionItems,
    normalizeMessageText,
    normalizeQuestionTitle,
    readClientBootstrapAuth,
    waitForClientBootstrapAuth
  };
})(globalThis);
