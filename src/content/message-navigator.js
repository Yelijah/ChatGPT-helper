(function initMessageNavigator(global) {
  const NAMESPACE = "__CHATGPT_HELPER__";

  function createAbortError(signal) {
    if (signal?.reason instanceof Error) {
      return signal.reason;
    }
    return new DOMException("消息定位已取消", "AbortError");
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) {
      throw createAbortError(signal);
    }
  }

  function chooseNearestAnchor(branch, target, renderedEntries) {
    if (!Array.isArray(branch) || !Number.isFinite(target?.branchIndex)) {
      return null;
    }

    const branchByMessageId = new Map(
      branch
        .filter((entry) => entry?.messageId && Number.isFinite(entry.branchIndex))
        .map((entry) => [entry.messageId, entry])
    );
    let nearest = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    (Array.isArray(renderedEntries) ? renderedEntries : []).forEach((rendered) => {
      const branchEntry = branchByMessageId.get(rendered?.messageId);
      if (!branchEntry) {
        return;
      }

      const distance = Math.abs(branchEntry.branchIndex - target.branchIndex);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = {
          ...rendered,
          branchIndex: branchEntry.branchIndex
        };
      }
    });

    return nearest;
  }

  async function navigateToMessage(options = {}) {
    const branch = Array.isArray(options.branch) ? options.branch : [];
    const target = options.target || null;
    const adapter = options.adapter;
    const signal = options.signal;
    const timeoutMs = Math.max(Number(options.timeoutMs) || 10000, 1);
    const settleMs = Math.max(Number(options.settleMs) || 250, 1);
    const now = typeof options.now === "function" ? options.now : Date.now;

    if (!adapter || !target) {
      return { status: "not-rendered" };
    }

    throwIfAborted(signal);
    const directElement =
      target.element ||
      (target.messageId
        ? adapter.findMessageElement(target.messageId)
        : null);

    if (directElement) {
      adapter.scrollToMessageElement(directElement);
      return { status: "found", element: directElement };
    }

    if (!target.messageId || !Number.isFinite(target.branchIndex)) {
      return { status: "not-rendered" };
    }

    const deadline = now() + timeoutMs;
    let boundaryCount = 0;
    let lastTop = null;
    let usedInitialRatio = false;

    while (now() < deadline) {
      throwIfAborted(signal);
      const renderedEntries = adapter.getRenderedMessageEntries();
      const anchor = chooseNearestAnchor(branch, target, renderedEntries);
      const before = adapter.getScrollMetrics();

      if (anchor) {
        const direction = target.branchIndex < anchor.branchIndex ? -1 : 1;
        const delta =
          direction * Math.max((Number(before.clientHeight) || 0) * 0.8, 160);
        adapter.scrollByAmount(delta);
      } else if (!usedInitialRatio) {
        const denominator = Math.max(branch.length - 1, 1);
        adapter.scrollToRatio(target.branchIndex / denominator);
        usedInitialRatio = true;
      }

      throwIfAborted(signal);
      const remaining = Math.max(deadline - now(), 1);
      await adapter.waitForMessageRender({
        signal,
        timeoutMs: Math.min(settleMs, remaining)
      });
      throwIfAborted(signal);

      const element = adapter.findMessageElement(target.messageId);
      if (element) {
        adapter.scrollToMessageElement(element);
        return { status: "found", element };
      }

      const after = adapter.getScrollMetrics();
      const atBoundary = after.top <= 0 || after.top >= after.maxTop;
      const unchanged =
        Math.abs(after.top - before.top) < 1 ||
        (lastTop !== null && Math.abs(after.top - lastTop) < 1);
      boundaryCount = atBoundary && unchanged ? boundaryCount + 1 : 0;
      lastTop = after.top;

      if (boundaryCount >= 3) {
        return { status: "not-rendered" };
      }
    }

    return { status: "not-rendered" };
  }

  global[NAMESPACE] = global[NAMESPACE] || {};
  global[NAMESPACE].messageNavigator = {
    chooseNearestAnchor,
    navigateToMessage
  };
})(globalThis);
