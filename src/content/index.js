(function initApp(global) {
  const NAMESPACE = "__CHATGPT_HELPER__";
  const state = (global[NAMESPACE] = global[NAMESPACE] || {});

  if (state.appInitialized) {
    return;
  }

  const conversationApi = state.conversationApi;
  const domAdapter = state.domAdapter;
  const sidebarApi = state.sidebar;
  const messageOutlineApi = state.messageOutline;
  const messageNavigator = state.messageNavigator;

  if (!conversationApi || !domAdapter || !sidebarApi || !messageNavigator) {
    return;
  }

  state.appInitialized = true;

  const requestGate = conversationApi.createRequestGate();
  const conversationCache = new Map();
  const MAX_CONVERSATION_CACHE_SIZE = 5;
  const NAVIGATION_TIMEOUT_MS = 30000;
  const historyOriginals = new Map();
  let sidebar = null;
  let messageOutline = null;
  let items = [];
  let domItems = [];
  let canonicalItems = [];
  let activeBranch = [];
  let activeBranchSignature = "";
  let activeId = null;
  let currentPath = window.location.pathname;
  let stopObserving = () => {};
  let stopObservingMessages = () => {};
  let stopObservingRefreshTriggers = () => {};
  let scrollTicking = false;
  let routeTimer = 0;
  let syncTimer = 0;
  let currentScrollContainer = null;
  let activeLockId = null;
  let activeLockDeadline = 0;
  let messageOutlineLockId = null;
  let messageOutlineLockDeadline = 0;
  let navigationController = null;
  let programmaticScrollDeadline = 0;
  let destroyed = false;
  const initialRefreshTimers = [];
  let directoryStatus = { kind: "ready", message: "" };
  let navigationStatus = null;
  let routeDomReady = true;
  let routeDomBaselineElements = new WeakSet();

  function getEffectiveStatus() {
    return navigationStatus || directoryStatus;
  }

  function getDirectorySyncErrorMessage(error, hasCachedItems) {
    let reason = "";
    if (error?.name === "ConversationRequestError" && Number.isFinite(error.status)) {
      reason = `（HTTP ${error.status}）`;
    } else if (error?.name === "ConversationResponseError") {
      reason = "（响应格式异常）";
    } else if (error instanceof TypeError) {
      reason = "（网络请求失败）";
    }
    return hasCachedItems
      ? `完整目录同步失败${reason}，正在显示上次同步目录`
      : `完整目录同步失败${reason}，当前显示页面内消息`;
  }

  function getBranchSignature(branch) {
    return (Array.isArray(branch) ? branch : [])
      .map((entry) => `${entry.nodeId}:${entry.messageId}:${entry.branchIndex}`)
      .join("|");
  }

  function getRouteConversationId(pathname) {
    return conversationApi.getConversationId(pathname) || null;
  }

  function cancelNavigation() {
    navigationController?.abort();
    navigationController = null;
    navigationStatus = null;
    releaseActiveLock();
  }

  function setActiveBranch(nextBranch) {
    const normalized = Array.isArray(nextBranch) ? nextBranch : [];
    const nextSignature = getBranchSignature(normalized);
    if (
      activeBranchSignature &&
      nextSignature !== activeBranchSignature &&
      navigationController
    ) {
      cancelNavigation();
    }
    activeBranch = normalized;
    activeBranchSignature = nextSignature;
  }

  function rememberConversation(conversationId, result) {
    const cacheEntry = conversationApi.createConversationCacheEntry(result);
    conversationCache.delete(conversationId);
    conversationCache.set(conversationId, cacheEntry);
    while (conversationCache.size > MAX_CONVERSATION_CACHE_SIZE) {
      const oldestKey = conversationCache.keys().next().value;
      conversationCache.delete(oldestKey);
    }
  }

  function ensureSidebar() {
    if (!sidebar) {
      sidebar = sidebarApi.mount(document.body, {
        onSelect(item) {
          navigateToQuestion(item);
        }
      });
    }

    return sidebar;
  }

  function ensureMessageOutline() {
    if (!messageOutline && messageOutlineApi?.mount) {
      messageOutline = messageOutlineApi.mount(document.body, {
        onSelect(heading) {
          lockMessageOutlineToHeading(heading);
          domAdapter.scrollToHeading?.(heading.id);
          window.setTimeout(() => refreshMessageOutline(), 260);
        }
      });
    }

    return messageOutline;
  }

  function pickActiveAssistantMessage() {
    const messages = domAdapter.getAssistantMessages?.() || [];
    if (!messages.length) {
      return null;
    }

    if (messageOutlineLockId && Date.now() < messageOutlineLockDeadline) {
      const lockedMessage = messages.find((message) => message.id === messageOutlineLockId);
      if (lockedMessage) {
        return lockedMessage;
      }
    }

    messageOutlineLockId = null;
    messageOutlineLockDeadline = 0;
    const viewportTop = 120;
    const viewportBottom = Math.max(window.innerHeight - 160, viewportTop + 120);
    let best = null;
    let bestVisibleHeight = 0;

    messages.forEach((message) => {
      const rect = message.element.getBoundingClientRect();
      const visibleTop = Math.max(rect.top, viewportTop);
      const visibleBottom = Math.min(rect.bottom, viewportBottom);
      const visibleHeight = Math.max(visibleBottom - visibleTop, 0);
      if (visibleHeight > bestVisibleHeight) {
        bestVisibleHeight = visibleHeight;
        best = message;
      }
    });

    if (best) {
      return best;
    }

    let fallback = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    messages.forEach((message) => {
      const rect = message.element.getBoundingClientRect();
      if (rect.bottom < viewportTop - 24) {
        return;
      }
      const distance = Math.abs(rect.top - viewportTop);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        fallback = message;
      }
    });

    return fallback || messages[messages.length - 1];
  }

  function refreshMessageOutline() {
    if (!domAdapter.isConversationRoute()) {
      messageOutline?.render(null, []);
      return;
    }

    const message = pickActiveAssistantMessage();
    const headings = message
      ? domAdapter.extractHeadings?.(message.contentElement, message.id) || []
      : [];
    ensureMessageOutline()?.render(message, headings);
  }

  function lockMessageOutlineToHeading(heading, duration = 1600) {
    const message = (domAdapter.getAssistantMessages?.() || []).find((item) => {
      return item.contentElement?.contains?.(heading.element);
    });
    messageOutlineLockId = message?.id || null;
    messageOutlineLockDeadline = messageOutlineLockId ? Date.now() + duration : 0;
  }

  function setActive(id) {
    activeId = id || null;
    sidebar?.setActive(activeId);
  }

  function getItemById(id) {
    return items.find((item) => item.id === id) || null;
  }

  function isLockedTargetSettled() {
    if (!activeLockId) {
      return true;
    }
    const targetItem = getItemById(activeLockId);
    if (!(targetItem?.element instanceof HTMLElement)) {
      return false;
    }
    const rect = targetItem.element.getBoundingClientRect();
    return Math.abs(rect.top - 160) <= 36;
  }

  function releaseActiveLock() {
    activeLockId = null;
    activeLockDeadline = 0;
  }

  function lockActive(id, duration = 2000) {
    activeLockId = id || null;
    activeLockDeadline = Date.now() + duration;
  }

  function pickActiveQuestion() {
    const branchByMessageId = new Map(
      activeBranch.map((entry) => [entry.messageId, entry])
    );
    const threshold = 160;
    let branchAnchor = null;
    let branchAnchorDistance = Number.POSITIVE_INFINITY;

    (domAdapter.getRenderedMessageEntries?.() || []).forEach((renderedEntry) => {
      const branchEntry = branchByMessageId.get(renderedEntry.messageId);
      if (!branchEntry || !(renderedEntry.element instanceof HTMLElement)) {
        return;
      }
      const rect = renderedEntry.element.getBoundingClientRect();
      const distance =
        threshold >= rect.top && threshold <= rect.bottom
          ? 0
          : Math.min(Math.abs(rect.top - threshold), Math.abs(rect.bottom - threshold));
      if (distance < branchAnchorDistance) {
        branchAnchorDistance = distance;
        branchAnchor = branchEntry;
      }
    });

    if (branchAnchor) {
      const precedingQuestion = items
        .filter((item) => {
          return (
            Number.isFinite(item.branchIndex) &&
            item.branchIndex <= branchAnchor.branchIndex
          );
        })
        .sort((first, second) => second.branchIndex - first.branchIndex)[0];
      if (precedingQuestion) {
        return precedingQuestion;
      }
    }

    const rendered = items.filter((item) => item.element instanceof HTMLElement);
    if (!rendered.length) {
      return getItemById(activeLockId) || getItemById(activeId);
    }

    let best = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    rendered.forEach((item) => {
      const rect = item.element.getBoundingClientRect();
      if (rect.bottom < threshold - 24) {
        return;
      }
      const distance = Math.abs(rect.top - threshold);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        best = item;
      }
    });

    return best || rendered[rendered.length - 1];
  }

  function render() {
    ensureSidebar().render(items, activeId, getEffectiveStatus());
  }

  function bindScrollContainer() {
    const nextContainer = domAdapter.getScrollContainer?.() || null;
    if (currentScrollContainer === nextContainer) {
      return;
    }
    currentScrollContainer?.removeEventListener("scroll", handleScroll);
    currentScrollContainer = nextContainer;
    currentScrollContainer?.addEventListener("scroll", handleScroll, { passive: true });
  }

  function refreshQuestions(nextDomItems) {
    domItems = Array.isArray(nextDomItems)
      ? nextDomItems
      : domAdapter.getDomQuestionItems?.() || domAdapter.getQuestionItems();
    let acceptedDomItems = domItems;
    if (!routeDomReady) {
      const hasBaselineElement = domItems.some((item) => {
        return (
          item.element instanceof HTMLElement &&
          routeDomBaselineElements.has(item.element)
        );
      });
      acceptedDomItems = domItems.filter((item) => {
        return (
          item.element instanceof HTMLElement &&
          !routeDomBaselineElements.has(item.element)
        );
      });
      if (!hasBaselineElement) {
        routeDomReady = true;
        routeDomBaselineElements = new WeakSet();
        acceptedDomItems = domItems;
      }
    }
    items = conversationApi.mergeQuestionItems(canonicalItems, acceptedDomItems);

    if (!domAdapter.isConversationRoute()) {
      items = [];
      messageOutline?.destroy();
      messageOutline = null;
    } else {
      refreshMessageOutline();
    }

    bindScrollContainer();
    if (activeLockId) {
      if (isLockedTargetSettled() || Date.now() >= activeLockDeadline) {
        releaseActiveLock();
      } else {
        setActive(activeLockId);
        render();
        return;
      }
    }

    const active = pickActiveQuestion();
    setActive(active?.id || null);
    render();
  }

  async function refreshConversation() {
    if (destroyed) {
      return;
    }

    const requestPath = window.location.pathname;
    const conversationId = getRouteConversationId(requestPath);
    if (!conversationId) {
      requestGate.abort();
      setActiveBranch([]);
      canonicalItems = [];
      directoryStatus = { kind: "ready", message: "" };
      refreshQuestions();
      return;
    }

    const cached = conversationCache.get(conversationId);
    if (cached) {
      setActiveBranch(cached.branch);
      canonicalItems = cached.questions;
      directoryStatus = { kind: "ready", message: "" };
    } else if (!canonicalItems.length) {
      directoryStatus = { kind: "loading", message: "正在同步完整目录…" };
    }
    refreshQuestions();

    const ticket = requestGate.next();
    try {
      const result = await conversationApi.loadConversation(conversationId, {
        signal: ticket.signal
      });
      if (
        destroyed ||
        !requestGate.isCurrent(ticket.generation) ||
        getRouteConversationId(window.location.pathname) !== conversationId
      ) {
        return;
      }

      setActiveBranch(result.branch);
      canonicalItems = result.questions;
      rememberConversation(conversationId, result);
      directoryStatus = { kind: "ready", message: "" };
      refreshQuestions();
    } catch (error) {
      if (error?.name === "AbortError" || !requestGate.isCurrent(ticket.generation)) {
        return;
      }
      directoryStatus = {
        kind: "degraded",
        message: getDirectorySyncErrorMessage(error, canonicalItems.length > 0)
      };
      refreshQuestions();
    }
  }

  function scheduleConversationRefresh() {
    window.clearTimeout(syncTimer);
    syncTimer = window.setTimeout(() => refreshConversation(), 500);
  }

  function createNavigationAdapter() {
    return {
      findMessageElement: (...args) => domAdapter.findMessageElement(...args),
      getRenderedMessageEntries: (...args) => domAdapter.getRenderedMessageEntries(...args),
      getScrollMetrics: (...args) => domAdapter.getScrollMetrics(...args),
      waitForMessageRender: (...args) => domAdapter.waitForMessageRender(...args),
      scrollByAmount(delta) {
        programmaticScrollDeadline = Date.now() + 750;
        return domAdapter.scrollByAmount(delta);
      },
      scrollToRatio(ratio) {
        programmaticScrollDeadline = Date.now() + 750;
        return domAdapter.scrollToRatio(ratio);
      },
      scrollToMessageElement(element) {
        programmaticScrollDeadline = Date.now() + 750;
        return domAdapter.scrollToMessageElement(element);
      }
    };
  }

  async function navigateToQuestion(item) {
    navigationController?.abort();
    const controller = new AbortController();
    navigationController = controller;
    lockActive(item.id, NAVIGATION_TIMEOUT_MS);
    setActive(item.id);
    navigationStatus = { kind: "navigating", message: "正在加载并定位消息…" };
    render();

    try {
      const result = await messageNavigator.navigateToMessage({
        branch: activeBranch,
        target: item,
        questions: items,
        adapter: createNavigationAdapter(),
        signal: controller.signal,
        timeoutMs: NAVIGATION_TIMEOUT_MS,
        settleMs: 250,
        minSettleMs: 120,
        boundaryIdleMs: 3000
      });
      if (navigationController !== controller) {
        return;
      }
      navigationStatus =
        result.status === "found"
          ? null
          : { kind: "navigation-error", message: "ChatGPT 未能加载该消息" };
      if (result.status !== "found") {
        releaseActiveLock();
      }
    } catch (error) {
      if (navigationController !== controller) {
        return;
      }
      navigationStatus =
        error?.name === "AbortError"
          ? null
          : { kind: "navigation-error", message: "消息定位失败" };
      releaseActiveLock();
    } finally {
      if (navigationController === controller) {
        navigationController = null;
        refreshQuestions();
        refreshMessageOutline();
      }
    }
  }

  function handleScroll() {
    if (scrollTicking) {
      return;
    }
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      if (navigationController && Date.now() > programmaticScrollDeadline) {
        cancelNavigation();
      }
      if (activeLockId) {
        if (isLockedTargetSettled() || Date.now() >= activeLockDeadline) {
          releaseActiveLock();
        } else {
          setActive(activeLockId);
          refreshMessageOutline();
          render();
          return;
        }
      }
      const active = pickActiveQuestion();
      setActive(active?.id || null);
      refreshMessageOutline();
      render();
    });
  }

  function restartObserver() {
    stopObserving();
    stopObservingMessages();
    stopObservingRefreshTriggers();
    stopObserving = domAdapter.observeQuestions((nextItems) => {
      refreshQuestions(nextItems);
    });
    stopObservingMessages =
      domAdapter.observeAssistantMessages?.(() => {
        if (domAdapter.isConversationRoute()) {
          refreshMessageOutline();
        }
      }) || (() => {});
    stopObservingRefreshTriggers =
      domAdapter.observeConversationRefreshTriggers?.(() => {
        scheduleConversationRefresh();
      }) || (() => {});
  }

  function handleRouteChange() {
    const nextPath = window.location.pathname;
    if (nextPath === currentPath || destroyed) {
      return;
    }

    const previousConversationId = getRouteConversationId(currentPath);
    const nextConversationId = getRouteConversationId(nextPath);
    currentPath = window.location.pathname;

    // ChatGPT 项目页会在初始化期间改写 /g/<slug>/c/<id> 的 slug。
    // 这不是会话切换；如果中止当前请求，会在 Network 中留下
    // net::ERR_ABORTED，并清空本来已经可用的目录。
    if (
      previousConversationId &&
      nextConversationId &&
      previousConversationId === nextConversationId
    ) {
      return;
    }

    routeDomBaselineElements = new WeakSet(
      domItems
        .map((item) => item.element)
        .filter((element) => element instanceof HTMLElement)
    );
    routeDomReady = false;
    requestGate.abort();
    cancelNavigation();
    activeBranch = [];
    activeBranchSignature = "";
    canonicalItems = [];
    window.clearTimeout(syncTimer);
    window.clearTimeout(routeTimer);
    messageOutline?.destroy();
    messageOutline = null;
    directoryStatus = nextConversationId
      ? { kind: "loading", message: "正在同步完整目录…" }
      : { kind: "ready", message: "" };
    refreshQuestions();
    routeTimer = window.setTimeout(() => {
      restartObserver();
      refreshQuestions();
      refreshConversation();
    }, 120);
  }

  function patchHistory() {
    ["pushState", "replaceState"].forEach((method) => {
      const original = history[method];
      if (typeof original !== "function") {
        return;
      }
      historyOriginals.set(method, original);
      history[method] = function patchedHistoryState() {
        const result = original.apply(this, arguments);
        handleRouteChange();
        return result;
      };
    });
  }

  function destroy() {
    if (destroyed) {
      return;
    }
    destroyed = true;
    requestGate.abort();
    navigationController?.abort();
    stopObserving();
    stopObservingMessages();
    stopObservingRefreshTriggers();
    window.clearTimeout(routeTimer);
    window.clearTimeout(syncTimer);
    initialRefreshTimers.splice(0).forEach((timer) => window.clearTimeout(timer));
    window.clearInterval(routeIntervalId);
    currentScrollContainer?.removeEventListener("scroll", handleScroll);
    window.removeEventListener("scroll", handleScroll);
    window.removeEventListener("resize", handleScroll);
    window.removeEventListener("popstate", handleRouteChange);
    historyOriginals.forEach((original, method) => {
      history[method] = original;
    });
    messageOutline?.destroy();
  }

  patchHistory();
  restartObserver();
  refreshQuestions();
  refreshConversation();
  initialRefreshTimers.push(window.setTimeout(() => refreshQuestions(), 600));
  initialRefreshTimers.push(window.setTimeout(() => refreshQuestions(), 1800));

  window.addEventListener("scroll", handleScroll, { passive: true });
  window.addEventListener("resize", handleScroll, { passive: true });
  window.addEventListener("popstate", handleRouteChange);
  const routeIntervalId = window.setInterval(handleRouteChange, 1000);

  state.app = {
    destroy,
    handleRouteChange,
    refreshConversation,
    getState() {
      return {
        activeBranch: activeBranch.slice(),
        activeId,
        activeLockId,
        cacheSize: conversationCache.size,
        items: items.slice(),
        status: getEffectiveStatus()
      };
    }
  };
})(globalThis);
