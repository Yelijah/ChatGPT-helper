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
  let generation = 0;
  let activeController = null;

  const conversationApi = {
    getConversationId(pathname) {
      return String(pathname).match(/\/c\/([^/]+)/)?.[1] || null;
    },
    mergeQuestionItems(apiItems, currentDomItems) {
      if (!apiItems.length) return currentDomItems.map((item) => ({ ...item }));
      const domById = new Map(currentDomItems.map((item) => [item.messageId, item]));
      return apiItems.map((item) => ({
        ...item,
        element: domById.get(item.messageId)?.element || item.element || null
      }));
    },
    createRequestGate() {
      return {
        next() {
          activeController?.abort();
          activeController = new AbortController();
          generation += 1;
          return { generation, signal: activeController.signal };
        },
        isCurrent(value) {
          return value === generation && !activeController?.signal.aborted;
        },
        abort() {
          activeController?.abort();
          generation += 1;
        }
      };
    },
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
    observeAssistantMessages: () => () => {},
    getAssistantMessages: () => [],
    extractHeadings: () => [],
    scrollToHeading: () => true,
    findMessageElement: () => null,
    getRenderedMessageEntries: () => [],
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

  resetHelper();
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
    assert.equal(context.loadCalls[0].requestOptions.signal.aborted, true);
  } finally {
    context.cleanup();
  }
});

test("接口失败时保留 DOM 目录并显示降级状态", async () => {
  const context = installApp({
    async loadConversation() {
      throw new Error("模拟网络不可用");
    }
  });
  try {
    await flush();
    const latest = context.renderCalls.at(-1);
    assert.equal(latest.status.kind, "degraded");
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

    navigation.resolve({ status: "not-rendered" });
    await flush();
    assert.equal(context.renderCalls.at(-1).status.kind, "navigation-error");
  } finally {
    context.cleanup();
  }
});
