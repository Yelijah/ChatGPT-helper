(function initDomAdapter(global) {
  const NAMESPACE = "__CHATGPT_HELPER__";
  const ITEM_ID_PREFIX = "chatgpt-helper-question";
  const MESSAGE_ID_PREFIX = "chatgpt-helper-message";
  const HEADING_ID_PREFIX = "chatgpt-helper-heading";
  const USER_SELECTORS = [
    "[data-message-author-role='user']",
    "[data-testid*='user-message']",
    "[data-testid*='conversation-turn-'][data-message-author-role='user']",
    "article [data-message-author-role='user']"
  ];
  const ASSISTANT_SELECTORS = [
    "[data-message-author-role='assistant']",
    "[data-testid*='assistant-message']",
    "[data-testid*='conversation-turn-'][data-message-author-role='assistant']",
    "article [data-message-author-role='assistant']"
  ];
  const KNOWN_CONVERSATION_ROUTE_PATTERNS = [
    /^\/c\/[^/]+/i,
    /^\/share\/[^/]+/i,
    /^\/projects?\/[^/]+(?:\/c\/[^/]+)?/i
  ];

  function getConversationRoot() {
    return document.querySelector("main");
  }

  function hasKnownConversationRoute() {
    return KNOWN_CONVERSATION_ROUTE_PATTERNS.some((pattern) =>
      pattern.test(window.location.pathname)
    );
  }

  function isConversationRoute() {
    const root = getConversationRoot();
    if (!root) {
      return hasKnownConversationRoute();
    }

    if (hasKnownConversationRoute()) {
      return true;
    }

    return hasConversationContent(root);
  }

  function normalizeTitle(rawText) {
    const sharedNormalizer = global[NAMESPACE]?.conversationApi?.normalizeQuestionTitle;
    if (typeof sharedNormalizer === "function") {
      return sharedNormalizer(rawText);
    }

    const firstLine = (rawText || "")
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);

    if (!firstLine) {
      return "未命名问题";
    }

    return firstLine
      .replace(/^(你说|您说|你问|用户|You said|You)\s*[:：]\s*/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "未命名问题";
  }

  function normalizeFullText(rawText) {
    const sharedNormalizer = global[NAMESPACE]?.conversationApi?.normalizeMessageText;
    if (typeof sharedNormalizer === "function") {
      return sharedNormalizer(rawText);
    }

    return String(rawText || "")
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }

  function findTurnContainer(node) {
    if (!(node instanceof HTMLElement)) {
      return null;
    }

    return (
      node.closest("article") ||
      node.closest("[data-testid^='conversation-turn-']") ||
      node.closest("[data-message-id]") ||
      node
    );
  }

  function getSourceMessageId(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    return (
      element.getAttribute("data-message-id") ||
      element.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      null
    );
  }

  function getTextLength(element) {
    return (element?.innerText || "").replace(/\s+/g, "").length;
  }

  function isVisibleConversationBlock(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.closest(".chatgpt-helper-sidebar")) {
      return false;
    }

    if (element.closest(".chatgpt-helper-message-outline")) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.height > 24 && rect.width > 120;
  }

  function looksLikeUserTurn(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const directRole = element.matches?.("[data-message-author-role='user']");
    const nestedRole = element.querySelector?.("[data-message-author-role='user']");
    const editButton = element.querySelector?.(
      "button[aria-label*='Edit'], button[aria-label*='编辑'], button[data-testid*='edit']"
    );
    const branchButton = element.querySelector?.(
      "button[aria-label*='Branch'], button[aria-label*='分支']"
    );
    const textLength = getTextLength(element);

    return (
      Boolean(directRole || nestedRole || editButton || branchButton) &&
      textLength > 0 &&
      isVisibleConversationBlock(element)
    );
  }

  // 判断节点是否像 AI 回复轮次。
  function looksLikeAssistantTurn(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const directRole = element.matches?.("[data-message-author-role='assistant']");
    const nestedRole = element.querySelector?.("[data-message-author-role='assistant']");
    const contentElement = findAssistantContentElement(element);

    return Boolean(directRole || nestedRole || contentElement) && isVisibleConversationBlock(element);
  }

  function getPrimaryCandidates(root) {
    const nodes = USER_SELECTORS.flatMap((selector) =>
      Array.from(root.querySelectorAll(selector))
    );

    return nodes
      .map(findTurnContainer)
      .filter(Boolean);
  }

  // 使用优先选择器查找 AI 回复候选节点。
  function getAssistantPrimaryCandidates(root) {
    const nodes = ASSISTANT_SELECTORS.flatMap((selector) =>
      Array.from(root.querySelectorAll(selector))
    );

    return nodes
      .map(findTurnContainer)
      .filter(Boolean);
  }

  // 在优先选择器失效时回退扫描 article 节点。
  function getAssistantFallbackCandidates(root) {
    return Array.from(root.querySelectorAll("article")).filter((article) => {
      return looksLikeAssistantTurn(article);
    });
  }

  // 使用启发式规则兜底识别 AI 回复节点。
  function getAssistantHeuristicCandidates(root) {
    const candidates = Array.from(
      root.querySelectorAll("[data-testid^='conversation-turn-'], [data-message-id], article, section")
    );

    return candidates.filter((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      if (looksLikeUserTurn(element) || !looksLikeAssistantTurn(element)) {
        return false;
      }

      return isVisibleConversationBlock(element);
    });
  }

  function getFallbackCandidates(root) {
    return Array.from(root.querySelectorAll("article")).filter((article) => {
      return looksLikeUserTurn(article);
    });
  }

  function getHeuristicCandidates(root) {
    const candidates = Array.from(
      root.querySelectorAll("[data-testid^='conversation-turn-'], [data-message-id], article, section")
    );

    return candidates.filter((element) => {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      if (!looksLikeUserTurn(element)) {
        return false;
      }

      return isVisibleConversationBlock(element);
    });
  }

  function dedupeElements(elements) {
    const seen = new Set();
    const deduped = [];

    elements.forEach((element) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }

      if (seen.has(element)) {
        return;
      }

      seen.add(element);
      deduped.push(element);
    });

    return deduped;
  }

  function extractQuestionText(element) {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    const contentSelectors = [
      "[data-message-author-role='user'] .whitespace-pre-wrap",
      "[data-message-author-role='user'] [class*='whitespace-pre-wrap']",
      "[data-message-author-role='user'] [data-testid='user-message']",
      "[data-message-author-role='user'] [dir='auto']",
      "[data-message-author-role='user'] .markdown",
      "[data-message-author-role='user'] .prose",
      "[data-message-author-role='user'] p",
      "[data-testid*='user-message'] .whitespace-pre-wrap",
      "[data-testid*='user-message'] [class*='whitespace-pre-wrap']",
      "[data-testid*='user-message'] [dir='auto']",
      "[data-testid*='user-message'] .markdown",
      "[data-testid*='user-message'] .prose",
      "[data-testid*='conversation-turn-'] [dir='auto']",
      "[data-testid*='conversation-turn-'] .markdown",
      "[data-message-id] [dir='auto']",
      "[data-message-id] .markdown",
      "[data-message-id] .prose"
    ];

    for (const selector of contentSelectors) {
      const matched = Array.from(element.querySelectorAll(selector))
        .map((node) => node.textContent?.trim() || "")
        .find((text) => text && !/^(你说|您说|你问|用户|You said|You)\s*[:：]?$/i.test(text));

      if (matched) {
        return matched;
      }
    }

    const cleanedLines = (element.innerText || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^(你说|您说|你问|用户|You said|You)\s*[:：]?$/i.test(line))
      .filter((line) => !/^(编辑消息|Edit message|复制|Copy|赞|踩|重新生成|Regenerate)$/i.test(line));

    return cleanedLines[0] || "";
  }

  // 查找 AI 回复中承载 Markdown 内容的元素。
  function findAssistantContentElement(element) {
    if (!(element instanceof HTMLElement)) {
      return null;
    }

    const selectors = [
      "[data-message-author-role='assistant'] .markdown",
      "[data-message-author-role='assistant'] .prose",
      "[data-message-author-role='assistant'] [class*='markdown']",
      "[data-message-author-role='assistant'] [class*='prose']",
      ".markdown",
      ".prose"
    ];

    for (const selector of selectors) {
      const matched = element.querySelector(selector);
      if (matched instanceof HTMLElement) {
        return matched;
      }
    }

    const roleElement = element.matches("[data-message-author-role='assistant']")
      ? element
      : element.querySelector("[data-message-author-role='assistant']");

    return roleElement instanceof HTMLElement ? roleElement : null;
  }

  function collectCandidateElements(root) {
    if (!(root instanceof HTMLElement)) {
      return [];
    }

    const primary = getPrimaryCandidates(root);
    const fallback = primary.length ? [] : getFallbackCandidates(root);
    const heuristic = primary.length || fallback.length ? [] : getHeuristicCandidates(root);
    return dedupeElements(primary.length ? primary : fallback.length ? fallback : heuristic);
  }

  // 汇总并去重 AI 回复候选节点。
  function collectAssistantCandidateElements(root) {
    if (!(root instanceof HTMLElement)) {
      return [];
    }

    const primary = getAssistantPrimaryCandidates(root);
    const fallback = primary.length ? [] : getAssistantFallbackCandidates(root);
    const heuristic = primary.length || fallback.length ? [] : getAssistantHeuristicCandidates(root);
    return dedupeElements(primary.length ? primary : fallback.length ? fallback : heuristic);
  }

  function hasConversationContent(root) {
    return collectCandidateElements(root).length > 0;
  }

  function buildQuestionItems() {
    const root = getConversationRoot();
    if (!root) {
      return [];
    }

    const candidates = collectCandidateElements(root);
    if (!candidates.length) {
      return [];
    }

    return candidates
      .map((element, index) => {
        const messageId = getSourceMessageId(element);
        const id = messageId
          ? `question-${messageId}`
          : `${ITEM_ID_PREFIX}-pending-${index + 1}`;
        const fullText = normalizeFullText(extractQuestionText(element));
        element.dataset.chatgptHelperQuestionId = id;

        return {
          id,
          messageId,
          nodeId: null,
          title: normalizeTitle(fullText),
          fullText,
          branchIndex: null,
          element,
          index,
          source: "dom"
        };
      })
      .filter((item) => item.title);
  }

  function getDomQuestionItems() {
    return buildQuestionItems();
  }

  function getQuestionItems() {
    return getDomQuestionItems();
  }

  function findMessageElement(messageId) {
    if (!messageId) {
      return null;
    }

    const root = getConversationRoot();
    if (!root) {
      return null;
    }

    const matched = root.querySelector(
      `[data-message-id='${CSS.escape(String(messageId))}']`
    );
    const element = matched instanceof HTMLElement ? findTurnContainer(matched) : null;
    return element?.isConnected && isVisibleConversationBlock(element)
      ? element
      : null;
  }

  function getRenderedMessageEntries() {
    const root = getConversationRoot();
    if (!root) {
      return [];
    }

    const seen = new Set();
    const entries = [];

    root.querySelectorAll("[data-message-id]").forEach((node) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }

      if (node.closest(".chatgpt-helper-sidebar, .chatgpt-helper-message-outline")) {
        return;
      }

      const messageId = node.getAttribute("data-message-id");
      if (!messageId || seen.has(messageId)) {
        return;
      }

      const element = findTurnContainer(node);
      if (!element?.isConnected || !isVisibleConversationBlock(element)) {
        return;
      }

      seen.add(messageId);
      entries.push({ messageId, element });
    });

    return entries;
  }

  // 为 AI 回复生成可复用的大纲消息 ID。
  function getStableMessageId(element, index) {
    if (!(element instanceof HTMLElement)) {
      return `${MESSAGE_ID_PREFIX}-${index + 1}`;
    }

    if (element.dataset.chatgptHelperMessageId) {
      return element.dataset.chatgptHelperMessageId;
    }

    const sourceId =
      element.getAttribute("data-message-id") ||
      element.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      element.getAttribute("data-testid") ||
      `${index + 1}`;
    const id = `${MESSAGE_ID_PREFIX}-${String(sourceId).replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
    element.dataset.chatgptHelperMessageId = id;
    return id;
  }

  // 获取当前会话中可建立大纲的 AI 回复消息。
  function getAssistantMessages() {
    const root = getConversationRoot();
    if (!root) {
      return [];
    }

    return collectAssistantCandidateElements(root)
      .map((element, index) => {
        const contentElement = findAssistantContentElement(element);
        if (!contentElement) {
          return null;
        }

        return {
          id: getStableMessageId(element, index),
          element,
          contentElement,
          index
        };
      })
      .filter(Boolean);
  }

  function assignHeadingId(element, messageId, index) {
    if (!element.id) {
      element.id = `${HEADING_ID_PREFIX}-${messageId}-${index + 1}`;
    }

    return element.id;
  }

  function buildHeadingItem(element, messageId, index, level, text) {
    const normalizedText = (text || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!normalizedText) {
      return null;
    }

    return {
      id: assignHeadingId(element, messageId, index),
      level,
      text: normalizedText,
      element,
      index
    };
  }

  // 提取 AI 回复内 h1-h6 标题并补齐稳定锚点。
  function extractHeadings(contentElement, messageId = "message") {
    if (!(contentElement instanceof HTMLElement)) {
      return [];
    }

    return Array.from(contentElement.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .map((element, index) => {
        return buildHeadingItem(
          element,
          messageId,
          index,
          Number(element.tagName.slice(1)),
          element.textContent
        );
      })
      .filter(Boolean);
  }

  function isScrollable(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const overflowY = style.overflowY;
    return /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight + 24;
  }

  function findScrollContainer(element) {
    let current = element?.parentElement || null;

    while (current && current !== document.body) {
      if (isScrollable(current)) {
        return current;
      }

      current = current.parentElement;
    }

    const fallback = document.scrollingElement;
    return fallback instanceof HTMLElement ? fallback : null;
  }

  function getScrollContainer() {
    const root = getConversationRoot();
    if (root instanceof HTMLElement) {
      const container = findScrollContainer(root);
      if (container) {
        return container;
      }
    }

    const firstQuestion = getQuestionItems()[0];
    if (firstQuestion?.element) {
      return findScrollContainer(firstQuestion.element);
    }

    const fallback = document.scrollingElement;
    return fallback instanceof HTMLElement ? fallback : null;
  }

  function getScrollMetrics() {
    const container = getScrollContainer();
    if (!container) {
      return { top: 0, maxTop: 0, clientHeight: 0 };
    }

    return {
      top: Number(container.scrollTop) || 0,
      maxTop: Math.max(container.scrollHeight - container.clientHeight, 0),
      clientHeight: Number(container.clientHeight) || 0
    };
  }

  function scrollByAmount(delta) {
    const container = getScrollContainer();
    if (!container) {
      return false;
    }

    const metrics = getScrollMetrics();
    const nextTop = Math.min(
      Math.max(metrics.top + (Number(delta) || 0), 0),
      metrics.maxTop
    );
    container.scrollTo({ top: nextTop, behavior: "auto" });
    return true;
  }

  function scrollToRatio(ratio) {
    const container = getScrollContainer();
    if (!container) {
      return false;
    }

    const safeRatio = Math.min(Math.max(Number(ratio) || 0, 0), 1);
    container.scrollTo({
      top: getScrollMetrics().maxTop * safeRatio,
      behavior: "auto"
    });
    return true;
  }

  function waitForMessageRender(options = {}) {
    const root = getConversationRoot() || document.body;
    const signal = options.signal;
    const timeoutMs = Math.max(Number(options.timeoutMs) || 250, 0);

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("消息定位已取消", "AbortError")
        );
        return;
      }

      let settled = false;
      let timeoutId = 0;
      const observer = new MutationObserver(() => finish("mutation"));
      const onAbort = () => {
        finish(
          "abort",
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException("消息定位已取消", "AbortError")
        );
      };

      function cleanup() {
        observer.disconnect();
        if (timeoutId) {
          global.clearTimeout(timeoutId);
        }
        signal?.removeEventListener("abort", onAbort);
      }

      function finish(reason, error) {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve(reason);
        }
      }

      observer.observe(root, { childList: true, subtree: true });
      signal?.addEventListener("abort", onAbort, { once: true });
      timeoutId = global.setTimeout(() => finish("timeout"), timeoutMs);
    });
  }

  function scrollElementWithOffset(target, options = {}) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const container = findScrollContainer(target);
    const topOffset = Number(options.topOffset) || 96;
    const behavior = options.behavior || "smooth";

    if (container && container !== document.body && container !== document.documentElement) {
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const targetTop = targetRect.top - containerRect.top + container.scrollTop - topOffset;

      container.scrollTo({
        top: Math.max(targetTop, 0),
        behavior
      });
      return true;
    }

    const targetTop = target.getBoundingClientRect().top + window.scrollY - topOffset;
    window.scrollTo({
      top: Math.max(targetTop, 0),
      behavior
    });
    return true;
  }

  function getTargetOffsetDelta(target, container, topOffset) {
    if (!(target instanceof HTMLElement)) {
      return 0;
    }

    if (container && container !== document.body && container !== document.documentElement) {
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      return targetRect.top - containerRect.top - topOffset;
    }

    return target.getBoundingClientRect().top - topOffset;
  }

  function correctScrollUntilSettled(target, options = {}) {
    const container = findScrollContainer(target);
    const topOffset = Number(options.topOffset) || 96;
    const delay = options.delay === undefined ? 420 : Number(options.delay);
    const duration = options.duration === undefined ? 1200 : Number(options.duration);
    let stableCount = 0;
    let startedAt = 0;

    function correct() {
      if (!(target instanceof HTMLElement)) {
        return;
      }

      const delta = getTargetOffsetDelta(target, container, topOffset);
      if (Math.abs(delta) <= 3) {
        stableCount += 1;
      } else {
        stableCount = 0;

        if (container && container !== document.body && container !== document.documentElement) {
          container.scrollTo({
            top: Math.max(container.scrollTop + delta, 0),
            behavior: "auto"
          });
        } else {
          window.scrollTo({
            top: Math.max(window.scrollY + delta, 0),
            behavior: "auto"
          });
        }
      }

      if (stableCount >= 3 || Date.now() - startedAt > duration) {
        return;
      }

      window.requestAnimationFrame(correct);
    }

    const startCorrection = () => {
      startedAt = Date.now();
      window.requestAnimationFrame(correct);
    };

    if (delay <= 0) {
      startCorrection();
    } else {
      window.setTimeout(startCorrection, delay);
    }
  }

  function scrollToQuestion(id) {
    const target = document.querySelector(
      `[data-chatgpt-helper-question-id='${CSS.escape(id)}']`
    );

    if (!target) {
      return false;
    }

    const scrolled = scrollElementWithOffset(target, { behavior: "auto" });
    correctScrollUntilSettled(target, { delay: 0 });
    return scrolled;
  }

  function scrollToMessageElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const scrolled = scrollElementWithOffset(element, { behavior: "auto" });
    correctScrollUntilSettled(element, { delay: 0 });
    return scrolled;
  }

  // 平滑滚动到指定标题位置。
  function scrollToHeading(id) {
    const target = document.getElementById(id);
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return scrollElementWithOffset(target);
  }

  function observeQuestions(onChange) {
    const root = getConversationRoot() || document.body;
    if (!root || typeof onChange !== "function") {
      return () => {};
    }

    let frameId = 0;
    function getSignature(questionItems) {
      const questionSignature = questionItems
        .map((item) => `${item.id}:${item.title}`)
        .join("|");
      const messageSignature = getRenderedMessageEntries()
        .map((entry) => entry.messageId)
        .join("|");
      return `${questionSignature}::${messageSignature}`;
    }

    let lastSignature = getSignature(getQuestionItems());

    const observer = new MutationObserver(() => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }

      frameId = requestAnimationFrame(() => {
        frameId = 0;
        const nextItems = getQuestionItems();
        const nextSignature = getSignature(nextItems);

        if (nextSignature === lastSignature) {
          return;
        }

        lastSignature = nextSignature;
        onChange(nextItems);
      });
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });

    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }

      observer.disconnect();
    };
  }

  // 生成 AI 回复标题签名，用于判断是否需要刷新大纲。
  function getAssistantHeadingSignature() {
    return getAssistantMessages()
      .map((message) => {
        const headings = extractHeadings(message.contentElement, message.id);
        return `${message.id}:${headings
          .map((heading) => `${heading.id}:${heading.level}:${heading.text}`)
          .join(",")}`;
      })
      .join("|");
  }

  // 监听 AI 回复内容变化，支持流式输出时刷新大纲。
  function observeAssistantMessages(onChange) {
    const root = getConversationRoot() || document.body;
    if (!root || typeof onChange !== "function") {
      return () => {};
    }

    let frameId = 0;
    let lastSignature = getAssistantHeadingSignature();

    const observer = new MutationObserver(() => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }

      frameId = requestAnimationFrame(() => {
        frameId = 0;
        const nextSignature = getAssistantHeadingSignature();

        if (nextSignature === lastSignature) {
          return;
        }

        lastSignature = nextSignature;
        onChange();
      });
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true
    });

    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }

      observer.disconnect();
    };
  }

  global[NAMESPACE] = global[NAMESPACE] || {};
  global[NAMESPACE].domAdapter = {
    extractHeadings,
    findMessageElement,
    getAssistantMessages,
    getDomQuestionItems,
    getQuestionItems,
    getRenderedMessageEntries,
    getScrollContainer,
    getScrollMetrics,
    observeAssistantMessages,
    observeQuestions,
    scrollByAmount,
    scrollToMessageElement,
    scrollToHeading,
    scrollToQuestion,
    scrollToRatio,
    waitForMessageRender,
    isConversationRoute
  };
})(globalThis);
