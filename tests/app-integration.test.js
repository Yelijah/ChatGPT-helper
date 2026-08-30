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
