const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { loadScript, resetHelper } = require("./helpers/load-script");

const GLOBAL_KEYS = [
  "window",
  "document",
  "HTMLElement",
  "history",
  "location",
  "requestAnimationFrame",
  "cancelAnimationFrame"
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeResult(messageId) {
  const question = {
    id: `question-${messageId}`,
    messageId,
    nodeId: `node-${messageId}`,
    title: `问题 ${messageId}`,
    fullText: `问题 ${messageId}`,
    branchIndex: 0,
    element: null,
    source: "api"
  };
  return {
    branch: [{ messageId, branchIndex: 0, role: "user" }],
    questions: [question]
  };
}

function makeTextResult(messageId, text) {
  const result = makeResult(messageId);
  result.questions[0].title = text;
  result.questions[0].fullText = text;
  return result;
}

function installApp(options = {}) {
  const previous = new Map(GLOBAL_KEYS.map((key) => [key, globalThis[key]]));
  const dom = new JSDOM(`<!doctype html><body>
    <main><article id="dom-question"></article></main>
  </body>`, { url: options.url || "https://chatgpt.com/c/old-conversation" });
  const element = dom.window.document.getElementById("dom-question");
  element.getBoundingClientRect = () => ({
    top: 160,
    bottom: 260,
    left: 100,
    right: 700,
    width: 600,
    height: 100
  });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.history = dom.window.history;
  globalThis.location = dom.window.location;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;

  resetHelper();
  const realConversationApi = loadScript(
    "src/content/conversation-api.js"
  ).conversationApi;

  const domItems = options.domItems || [
    {
      id: "question-dom-message",
      messageId: "dom-message",
      title: "页面问题",
      fullText: "页面问题",
      branchIndex: null,
      element,
      source: "dom"
    }
  ];
  const renderCalls = [];
  const outlineCalls = [];
  const loadCalls = [];
  const navigationCalls = [];
  let sidebarOptions = null;
  let questionObserver = null;
  let refreshTriggerObserver = null;

  const conversationApi = {
    ...realConversationApi,
    async loadConversation(conversationId, requestOptions) {
      loadCalls.push({ conversationId, requestOptions });
      return options.loadConversation
        ? options.loadConversation(conversationId, requestOptions, loadCalls.length)
        : makeResult(conversationId);
    }
  };

  const domAdapter = {
    getDomQuestionItems: () => domItems.map((item) => ({ ...item })),
    getQuestionItems: () => domItems.map((item) => ({ ...item })),
    isConversationRoute: () => true,
    getScrollContainer: () => null,
    observeQuestions(callback) {
      questionObserver = callback;
      return () => {
        questionObserver = null;
      };
    },
    observeConversationRefreshTriggers(callback) {
      refreshTriggerObserver = callback;
      return () => {
        refreshTriggerObserver = null;
      };
    },
    observeAssistantMessages: () => () => {},
    getAssistantMessages: () => [],
    extractHeadings: () => [],
    scrollToHeading: () => true,
    findMessageElement: () => null,
    getRenderedMessageEntries: () =>
      options.renderedEntriesFactory?.({ dom, element }) || [],
    getScrollMetrics: () => ({ top: 0, maxTop: 0, clientHeight: 500 }),
    waitForMessageRender: async () => "timeout",
    scrollByAmount: () => true,
    scrollToRatio: () => true,
    scrollToMessageElement: () => true
  };

  const sidebarApi = {
    mount(_container, mountOptions) {
      sidebarOptions = mountOptions;
      return {
        render(items, activeId, status) {
          renderCalls.push({
            items: items.map((item) => ({ ...item })),
            activeId,
            status: { ...status }
          });
        },
        setActive() {}
      };
    }
  };

  const messageOutlineApi = {
    mount() {
      outlineCalls.push("mount");
      return {
        render() {
          outlineCalls.push("render");
        },
        destroy() {
          outlineCalls.push("destroy");
        }
      };
    }
  };

  const messageNavigator = {
    async navigateToMessage(navigationOptions) {
      navigationCalls.push(navigationOptions);
      return options.navigateToMessage
        ? options.navigateToMessage(navigationOptions)
        : { status: "found", element: navigationOptions.target.element };
    }
  };

  globalThis.__CHATGPT_HELPER__ = {
    conversationApi,
    domAdapter,
    sidebar: sidebarApi,
    messageOutline: messageOutlineApi,
    messageNavigator
  };
  const helper = loadScript("src/content/index.js");

  function cleanup() {
    helper.app?.destroy();
    resetHelper();
    dom.window.close();
    previous.forEach((value, key) => {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    });
  }

  return {
    app: helper.app,
    dom,
    loadCalls,
    navigationCalls,
    outlineCalls,
    renderCalls,
    getSidebarOptions: () => sidebarOptions,
    emitQuestions: (items) => questionObserver?.(items),
    emitRefreshTrigger: () => refreshTriggerObserver?.(),
    setDomItems(nextItems) {
      domItems.splice(0, domItems.length, ...nextItems);
    },
    cleanup
  };
}

test("首次先显示 DOM 问题，接口成功后替换为完整目录", async () => {
  const context = installApp();
  try {
    assert.equal(context.renderCalls[0].items[0].messageId, "dom-message");
    await flush();
    assert.equal(
      context.renderCalls.at(-1).items[0].messageId,
      "old-conversation"
    );
    assert.equal(context.renderCalls.at(-1).status.kind, "ready");
    assert.equal(context.outlineCalls.includes("mount"), true);
  } finally {
    context.cleanup();
  }
});

test("旧会话响应后返回时不会覆盖新会话", async () => {
  const oldRequest = deferred();
  const newRequest = deferred();
  const context = installApp({
    loadConversation(_id, _options, callIndex) {
      return callIndex === 1 ? oldRequest.promise : newRequest.promise;
    }
  });

  try {
    context.dom.window.history.pushState({}, "", "/c/new-conversation");
    await new Promise((resolve) => setTimeout(resolve, 140));
    newRequest.resolve(makeResult("new-conversation-message"));
    await flush();
    oldRequest.resolve(makeResult("old-conversation-message"));
    await flush();

    assert.deepEqual(
      context.app.getState().items.map((item) => item.messageId),
      ["new-conversation-message"]
    );
    assert.equal(
      context.app.getState().items.some((item) => item.messageId === "dom-message"),
      false
    );
    assert.equal(context.loadCalls[0].requestOptions.signal.aborted, true);
    assert.equal(
      context.outlineCalls.filter((call) => call === "destroy").length >= 1,
      true
    );
    assert.equal(
      context.outlineCalls.filter((call) => call === "mount").length >= 2,
      true
    );
  } finally {
    context.cleanup();
  }
});

test("跨路由相同文本的新 DOM 节点仍可作为降级目录", async () => {
  let loadCount = 0;
  const context = installApp({
    domItems: [],
    async loadConversation() {
      loadCount += 1;
      if (loadCount === 1) {
        return makeResult("old-conversation");
      }
      throw new Error("模拟新会话接口失败");
    }
  });
  try {
    const oldElement = context.dom.window.document.createElement("article");
    const oldItem = {
      id: "chatgpt-helper-question-pending-1",
      messageId: null,
      title: "你好",
      fullText: "你好",
      branchIndex: null,
      element: oldElement,
      source: "dom"
    };
    context.setDomItems([oldItem]);
    context.emitQuestions([oldItem]);
    await flush();

    context.dom.window.history.pushState({}, "", "/c/new-conversation");
    const newElement = context.dom.window.document.createElement("article");
    const newItem = { ...oldItem, element: newElement };
    context.setDomItems([newItem]);
    await new Promise((resolve) => setTimeout(resolve, 140));
    context.emitQuestions([newItem]);
    await flush();

    const state = context.app.getState();
    assert.equal(state.status.kind, "degraded");
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].element, newElement);
  } finally {
    context.cleanup();
  }
});

test("接口失败时保留 DOM 目录并显示降级状态", async () => {
  const context = installApp({
    async loadConversation() {
      throw new TypeError("模拟网络不可用");
    }
  });
  try {
    await flush();
    const latest = context.renderCalls.at(-1);
    assert.equal(latest.status.kind, "degraded");
    assert.equal(latest.status.message, "完整目录同步失败（网络请求失败），当前显示页面内消息");
    assert.deepEqual(latest.items.map((item) => item.messageId), ["dom-message"]);
  } finally {
    context.cleanup();
  }
});

test("点击未渲染问题时显示定位状态并调用定位器", async () => {
  const navigation = deferred();
  const context = installApp({
    navigateToMessage() {
      return navigation.promise;
    }
  });
  try {
    await flush();
    const item = context.app.getState().items[0];
    context.getSidebarOptions().onSelect(item);
    assert.equal(context.renderCalls.at(-1).status.kind, "navigating");
    assert.equal(context.navigationCalls.length, 1);
    assert.equal(context.navigationCalls[0].timeoutMs, 30000);
    assert.equal(context.navigationCalls[0].minSettleMs, 120);
    assert.equal(context.navigationCalls[0].boundaryIdleMs, 3000);

    navigation.resolve({ status: "not-rendered" });
    await flush();
    assert.equal(context.renderCalls.at(-1).status.kind, "navigation-error");
    assert.equal(context.app.getState().activeLockId, null);
  } finally {
    context.cleanup();
  }
});

test("长 AI 回复覆盖阈值时高亮其前一条用户问题", async () => {
  const firstUser = {
    id: "question-user-before",
    messageId: "user-before",
    nodeId: "node-user-before",
    title: "前一条问题",
    fullText: "前一条问题",
    branchIndex: 0,
    element: null,
    source: "api"
  };
  const nextUser = {
    id: "question-user-after",
    messageId: "user-after",
    nodeId: "node-user-after",
    title: "后一条问题",
    fullText: "后一条问题",
    branchIndex: 2,
    element: null,
    source: "api"
  };
  const context = installApp({
    async loadConversation() {
      return {
        branch: [
          { nodeId: "n0", messageId: "user-before", role: "user", branchIndex: 0 },
          { nodeId: "n1", messageId: "assistant-long", role: "assistant", branchIndex: 1 },
          { nodeId: "n2", messageId: "user-after", role: "user", branchIndex: 2 }
        ],
        questions: [firstUser, nextUser]
      };
    },
    renderedEntriesFactory({ dom }) {
      const assistant = dom.window.document.createElement("article");
      assistant.getBoundingClientRect = () => ({ top: 20, bottom: 600 });
      const next = dom.window.document.createElement("article");
      next.getBoundingClientRect = () => ({ top: 650, bottom: 750 });
      return [
        { messageId: "assistant-long", element: assistant },
        { messageId: "user-after", element: next }
      ];
    }
  });
  try {
    await flush();
    assert.equal(context.app.getState().activeId, "question-user-before");
  } finally {
    context.cleanup();
  }
});

test("手动滚动会取消定位并立即释放活动锁", async () => {
  const navigation = deferred();
  const context = installApp({
    navigateToMessage() {
      return navigation.promise;
    }
  });
  try {
    await flush();
    context.getSidebarOptions().onSelect(context.app.getState().items[0]);
    const signal = context.navigationCalls[0].signal;
    context.dom.window.dispatchEvent(new context.dom.window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(signal.aborted, true);
    assert.equal(context.app.getState().activeLockId, null);
  } finally {
    context.cleanup();
  }
});

test("宿主延迟触发的程序化滚动事件不会误取消定位", async () => {
  const navigation = deferred();
  let navigationSignal = null;
  const context = installApp({
    navigateToMessage(options) {
      navigationSignal = options.signal;
      options.adapter.scrollByAmount(400);
      return navigation.promise;
    }
  });
  try {
    await flush();
    context.getSidebarOptions().onSelect(context.app.getState().items[0]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    context.dom.window.dispatchEvent(new context.dom.window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(navigationSignal.aborted, false);
    navigation.resolve({ status: "found", element: null });
    await flush();
  } finally {
    context.cleanup();
  }
});

test("权威活动分支变化会取消旧分支定位", async () => {
  const navigation = deferred();
  let loadCount = 0;
  const context = installApp({
    async loadConversation() {
      loadCount += 1;
      return makeResult(loadCount === 1 ? "branch-a" : "branch-b");
    },
    navigateToMessage() {
      return navigation.promise;
    }
  });
  try {
    await flush();
    context.getSidebarOptions().onSelect(context.app.getState().items[0]);
    const signal = context.navigationCalls[0].signal;
    await context.app.refreshConversation();
    assert.equal(signal.aborted, true);
    assert.equal(context.app.getState().activeLockId, null);
    assert.equal(context.app.getState().items[0].messageId, "branch-b");
  } finally {
    context.cleanup();
  }
});

test("会话内存缓存最多保留五项", async () => {
  const context = installApp();
  try {
    await flush();
    for (let index = 1; index <= 6; index += 1) {
      context.dom.window.history.pushState({}, "", `/c/cache-${index}`);
      await new Promise((resolve) => setTimeout(resolve, 140));
      await flush();
    }
    assert.equal(context.app.getState().cacheSize, 5);
  } finally {
    context.cleanup();
  }
});

test("普通问题 DOM 变化不会重复请求接口，显式交互信号会请求", async () => {
  const context = installApp();
  try {
    await flush();
    const firstLoadCount = context.loadCalls.length;
    context.emitQuestions([]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(context.loadCalls.length, firstLoadCount);

    context.emitRefreshTrigger();
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(context.loadCalls.length, firstLoadCount + 1);
  } finally {
    context.cleanup();
  }
});

test("返回缓存会话时无消息 ID 的 DOM 问题不会重复", async () => {
  const pendingRefresh = deferred();
  let loadCount = 0;
  const context = installApp({
    domItems: [],
    loadConversation(conversationId) {
      loadCount += 1;
      if (loadCount >= 3) {
        return pendingRefresh.promise;
      }
      return Promise.resolve(makeTextResult(conversationId, "你好"));
    }
  });
  try {
    await flush();
    const createDomItem = () => ({
      id: "chatgpt-helper-question-pending-1",
      messageId: null,
      title: "你好",
      fullText: "你好",
      branchIndex: null,
      element: context.dom.window.document.createElement("article"),
      source: "dom"
    });

    const otherItem = createDomItem();
    context.setDomItems([otherItem]);
    context.dom.window.history.pushState({}, "", "/c/other-conversation");
    await new Promise((resolve) => setTimeout(resolve, 140));
    await flush();

    const restoredItem = createDomItem();
    context.setDomItems([restoredItem]);
    context.dom.window.history.pushState({}, "", "/c/old-conversation");
    await new Promise((resolve) => setTimeout(resolve, 140));
    context.emitQuestions([restoredItem]);
    await flush();

    const state = context.app.getState();
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].messageId, "old-conversation");
    assert.equal(state.items[0].element, restoredItem.element);
    assert.equal("fullText" in state.items[0], false);
  } finally {
    pendingRefresh.reject(new Error("结束挂起请求"));
    context.cleanup();
  }
});
