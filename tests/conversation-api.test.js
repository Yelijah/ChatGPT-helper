const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript, resetHelper } = require("./helpers/load-script");

function loadApi() {
  resetHelper();
  return loadScript("src/content/conversation-api.js").conversationApi;
}

function message(id, role, parts) {
  return { id, author: { role }, content: { parts } };
}

function apiMessage(id, role, text) {
  return {
    id,
    author: { role, name: null, metadata: {} },
    create_time: null,
    update_time: null,
    content: { content_type: "text", parts: [text] },
    status: "finished_successfully",
    end_turn: role !== "assistant",
    weight: 1,
    metadata: {},
    recipient: "all",
    channel: null
  };
}

test("从普通和项目会话路径提取会话 ID", () => {
  const api = loadApi();
  assert.equal(api.getConversationId("/c/conversation-1"), "conversation-1");
  assert.equal(
    api.getConversationId("/projects/project-1/c/conversation-2"),
    "conversation-2"
  );
  assert.equal(api.getConversationId("/projects/project-1"), null);
  assert.equal(api.getConversationId("/c/%E0%A4%A"), null);
});

test("只沿 current_node 父链生成当前分支的用户问题", () => {
  const api = loadApi();
  const payload = {
    current_node: "assistant-b",
    mapping: {
      root: { parent: null, message: null },
      "user-a": {
        parent: "root",
        message: message("m-user-a", "user", ["第一个问题"])
      },
      "assistant-a": {
        parent: "user-a",
        message: message("m-assistant-a", "assistant", ["回答 A"])
      },
      "assistant-alt": {
        parent: "user-a",
        message: message("m-assistant-alt", "assistant", ["非活动回答"])
      },
      "user-b": {
        parent: "assistant-a",
        message: message("m-user-b", "user", ["第二个问题"])
      },
      "assistant-b": {
        parent: "user-b",
        message: message("m-assistant-b", "assistant", ["回答 B"])
      }
    }
  };

  const branch = api.buildActiveBranch(payload);
  const questions = api.buildQuestionItems(branch);
  assert.deepEqual(
    questions.map((item) => item.messageId),
    ["m-user-a", "m-user-b"]
  );
  assert.equal(
    branch.some((item) => item.messageId === "m-assistant-alt"),
    false
  );
  assert.deepEqual(
    branch.map((item) => item.branchIndex),
    [0, 1, 2, 3, 4]
  );
});

test("排除空用户消息并提取混合内容中的明确文本", () => {
  const api = loadApi();
  const branch = [
    {
      nodeId: "empty",
      messageId: "empty-message",
      role: "user",
      branchIndex: 0,
      message: message("empty-message", "user", [{ content_type: "image_asset_pointer" }])
    },
    {
      nodeId: "mixed",
      messageId: "mixed-message",
      role: "user",
      branchIndex: 1,
      message: message("mixed-message", "user", [
        { content_type: "image_asset_pointer" },
        { text: "  图片说明  " },
        "第二段"
      ])
    },
    {
      nodeId: "assistant",
      messageId: "assistant-message",
      role: "assistant",
      branchIndex: 2,
      message: message("assistant-message", "assistant", ["不应进入目录"])
    }
  ];

  const questions = api.buildQuestionItems(branch);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].title, "图片说明");
});

test("消息缺少 ID 时使用节点 ID", () => {
  const api = loadApi();
  const branch = api.buildActiveBranch({
    current_node: "node-only",
    mapping: {
      "node-only": {
        parent: null,
        message: { author: { role: "user" }, content: { parts: ["问题"] } }
      }
    }
  });

  assert.equal(branch[0].messageId, "node-only");
  assert.equal(api.buildQuestionItems(branch)[0].id, "question-node-only");
});

test("拒绝断裂的父节点引用", () => {
  const api = loadApi();
  assert.throws(
    () =>
      api.buildActiveBranch({
        current_node: "child",
        mapping: {
          child: { parent: "missing", message: message("m1", "user", ["问题"]) }
        }
      }),
    { name: "ConversationResponseError" }
  );
});

test("拒绝循环父链", () => {
  const api = loadApi();
  assert.throws(
    () =>
      api.buildActiveBranch({
        current_node: "a",
        mapping: {
          a: { parent: "b", message: message("m-a", "user", ["A"]) },
          b: { parent: "a", message: message("m-b", "assistant", ["B"]) }
        }
      }),
    { name: "ConversationResponseError" }
  );
});

test("标题规范化过滤说话者标签并按 Unicode 码点截断", () => {
  const api = loadApi();
  assert.equal(api.normalizeQuestionTitle("你说：  一个   问题\n后续"), "一个 问题");
  assert.equal(Array.from(api.normalizeQuestionTitle("问".repeat(140))).length, 120);
});

function conversationPayload(text = "问题") {
  return {
    messages: [apiMessage("m1", "user", text)],
    current_node: "m1",
    page_info: {
      start_cursor: null,
      end_cursor: null,
      has_previous_page: false,
      has_next_page: false
    },
    moderation_results: [],
    safe_urls: [],
    blocked_urls: []
  };
}

function bootstrapDocument(overrides = {}) {
  const payload = {
    authStatus: "logged_in",
    session: {
      accessToken: "bootstrap-access-token",
      account: { id: "account-id" },
      expires: "2099-01-01T00:00:00.000Z",
      sessionToken: "must-not-be-retained"
    },
    sessionId: "session-id",
    ...overrides
  };
  return {
    documentElement: {},
    querySelector() {
      return { textContent: JSON.stringify(payload) };
    }
  };
}

test("只从原生 client-bootstrap 提取请求所需认证字段", () => {
  const api = loadApi();
  const auth = api.readClientBootstrapAuth(bootstrapDocument());

  assert.deepEqual(auth, {
    accessToken: "bootstrap-access-token",
    accountId: "account-id",
    sessionId: "session-id"
  });
  assert.equal("sessionToken" in auth, false);
});

test("等待原生 client-bootstrap 出现后再返回认证字段", async () => {
  const api = loadApi();
  let script = null;
  let notifyMutation = null;
  let disconnected = false;
  const documentRef = {
    documentElement: {},
    querySelector() {
      return script;
    }
  };
  class FakeMutationObserver {
    constructor(callback) {
      notifyMutation = callback;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  }

  const waiting = api.waitForClientBootstrapAuth({
    documentRef,
    MutationObserverImpl: FakeMutationObserver,
    timeoutMs: 100
  });
  script = bootstrapDocument().querySelector();
  notifyMutation();

  assert.equal((await waiting).accessToken, "bootstrap-access-token");
  assert.equal(disconnected, true);
});

test("首次会话请求直接复用原生启动认证且不请求 session 接口", async () => {
  const api = loadApi();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json(conversationPayload());
  };

  await api.loadConversation("conversation-id", {
    fetchImpl,
    documentRef: bootstrapDocument()
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.includes("/api/auth/session"), false);
  assert.equal(calls[0].init.headers.Authorization, "Bearer bootstrap-access-token");
  assert.equal(calls[0].init.headers["chatgpt-account-id"], "account-id");
  assert.equal(calls[0].init.headers["oai-session-id"], "session-id");
});

test("同一页面后续会话请求复用内存中的原生认证", async () => {
  const api = loadApi();
  let bootstrapReads = 0;
  const documentRef = bootstrapDocument();
  const originalQuerySelector = documentRef.querySelector;
  documentRef.querySelector = (...args) => {
    bootstrapReads += 1;
    return originalQuerySelector(...args);
  };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json(conversationPayload());
  };

  await api.loadConversation("conversation-1", { fetchImpl, documentRef });
  await api.loadConversation("conversation-2", { fetchImpl, documentRef });

  assert.equal(bootstrapReads, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.init.headers.Authorization === "Bearer bootstrap-access-token"), true);
});

test("原生启动令牌失效时才调用 session 接口并重试一次", async () => {
  const api = loadApi();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response("", { status: 401 });
    }
    if (url === "/api/auth/session") {
      return Response.json({ accessToken: "refreshed-token" });
    }
    return Response.json(conversationPayload());
  };

  await api.loadConversation("conversation-id", {
    fetchImpl,
    documentRef: bootstrapDocument()
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.headers.Authorization, "Bearer bootstrap-access-token");
  assert.equal(calls[1].url, "/api/auth/session");
  assert.equal(calls[2].init.headers.Authorization, "Bearer refreshed-token");
  assert.equal(calls[2].init.headers["chatgpt-account-id"], undefined);
});

test("降级刷新成功后的令牌继续在当前页面内存中复用", async () => {
  const api = loadApi();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response("", { status: 401 });
    }
    if (url === "/api/auth/session") {
      return Response.json({ accessToken: "refreshed-token" });
    }
    return Response.json(conversationPayload());
  };

  await api.loadConversation("conversation-1", {
    fetchImpl,
    documentRef: bootstrapDocument()
  });
  await api.loadConversation("conversation-2", {
    fetchImpl,
    documentRef: bootstrapDocument()
  });

  assert.equal(calls.filter((call) => call.url === "/api/auth/session").length, 1);
  assert.equal(calls.at(-1).init.headers.Authorization, "Bearer refreshed-token");
});

test("使用同源凭据读取会话", async () => {
  const api = loadApi();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json(conversationPayload());
  };

  const result = await api.loadConversation("conversation/id", { fetchImpl });
  assert.equal(result.questions.length, 1);
  assert.deepEqual(Object.keys(result.branch[0]).sort(), [
    "branchIndex",
    "messageId",
    "nodeId",
    "role"
  ]);
  assert.equal(
    calls[0].url,
    "/backend-api/conversations/conversation%2Fid?include_has_versions=true&num_turns=100"
  );
  assert.equal(calls[0].init.credentials, "include");
});

test("按 page_info 向前分页并只保留当前消息列表中的用户提问", async () => {
  const api = loadApi();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return Response.json({
        messages: [apiMessage("m3", "user", "第三问"), apiMessage("m4", "assistant", "答复")],
        current_node: "m4",
        page_info: { start_cursor: "cursor-2", end_cursor: "cursor-4", has_previous_page: true, has_next_page: false },
        moderation_results: [], safe_urls: [], blocked_urls: []
      });
    }
    return Response.json({
      messages: [apiMessage("m1", "user", "第一问"), apiMessage("m2", "assistant", "答复 1"), apiMessage("m3", "user", "第三问")],
      page_info: { start_cursor: null, end_cursor: "cursor-2", has_previous_page: false, has_next_page: false },
      moderation_results: [], safe_urls: [], blocked_urls: []
    });
  };

  const result = await api.loadConversation("conversation/id", { fetchImpl });
  assert.deepEqual(result.branch.map((entry) => entry.messageId), ["m1", "m2", "m3", "m4"]);
  assert.deepEqual(result.questions.map((item) => item.messageId), ["m1", "m3"]);
  assert.deepEqual(result.branch.map((entry) => entry.branchIndex), [0, 1, 2, 3]);
  assert.equal(calls[1].url, "/backend-api/conversations/conversation%2Fid/messages?before=cursor-2&include_has_versions=true&num_turns=100");
});

test("重复分页游标被拒绝，避免请求死循环", async () => {
  const api = loadApi();
  let callCount = 0;
  const fetchImpl = async (url) => {
    callCount += 1;
    if (callCount === 1) return Response.json({
      messages: [apiMessage("m1", "user", "问题")], current_node: "m1",
      page_info: { start_cursor: "same", end_cursor: "same", has_previous_page: true, has_next_page: false }
    });
    return Response.json({
      messages: [], page_info: { start_cursor: "same", end_cursor: "same", has_previous_page: true, has_next_page: false }
    });
  };
  await assert.rejects(api.loadConversation("conversation-id", { fetchImpl }), { name: "ConversationResponseError" });
  assert.equal(callCount, 2);
});

test("缓存模型不保留完整问题正文或 DOM 引用", () => {
  const api = loadApi();
  const element = { privateDomReference: true };
  const cached = api.createConversationCacheEntry({
    branch: [
      {
        nodeId: "node-1",
        messageId: "message-1",
        role: "user",
        branchIndex: 0,
        message: { privatePayload: true }
      }
    ],
    questions: [
      {
        id: "question-message-1",
        messageId: "message-1",
        nodeId: "node-1",
        title: "规范化标题",
        fullText: "不应跨会话保留的完整敏感正文",
        branchIndex: 0,
        element,
        source: "api"
      }
    ]
  });

  assert.deepEqual(Object.keys(cached.branch[0]).sort(), [
    "branchIndex",
    "messageId",
    "nodeId",
    "role"
  ]);
  assert.deepEqual(Object.keys(cached.questions[0]).sort(), [
    "branchIndex",
    "id",
    "messageId",
    "nodeId",
    "source",
    "textFingerprint",
    "title"
  ]);
  assert.equal(JSON.stringify(cached).includes("完整敏感正文"), false);
});

test("最小化缓存仍可按指纹合并无消息 ID 的 DOM 问题", () => {
  const api = loadApi();
  const cached = api.createConversationCacheEntry({
    branch: [],
    questions: [
      {
        id: "question-m1",
        messageId: "m1",
        nodeId: "n1",
        title: "你好",
        fullText: "你好\n包含完整正文",
        branchIndex: 0,
        source: "api"
      }
    ]
  });
  const element = { marker: "rendered-without-message-id" };
  const merged = api.mergeQuestionItems(cached.questions, [
    {
      id: "chatgpt-helper-question-pending-1",
      messageId: null,
      title: "你好",
      fullText: "  你好  \n 包含完整正文 ",
      element,
      source: "dom"
    }
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "question-m1");
  assert.equal(merged[0].element, element);
  assert.equal("fullText" in cached.questions[0], false);
});

test("认证失败后获取会话令牌并只重试一次", async () => {
  const api = loadApi();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return new Response("", { status: 401 });
    }
    if (url === "/api/auth/session") {
      return Response.json({ accessToken: "memory-only-token" });
    }
    return Response.json(conversationPayload());
  };

  const result = await api.loadConversation("conversation-id", { fetchImpl });
  assert.equal(result.questions.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(
    calls[2].init.headers.Authorization,
    "Bearer memory-only-token"
  );
});

test("第二次请求仍失败时返回受控状态码且不泄漏正文", async () => {
  const api = loadApi();
  let callCount = 0;
  const fetchImpl = async (url) => {
    callCount += 1;
    if (url === "/api/auth/session") {
      return Response.json({ accessToken: "secret-test-token" });
    }
    return new Response("private-response-body", { status: 403 });
  };

  await assert.rejects(
    api.loadConversation("conversation-id", { fetchImpl }),
    (error) => {
      assert.equal(error.name, "ConversationRequestError");
      assert.equal(error.status, 403);
      assert.equal(error.message.includes("secret-test-token"), false);
      assert.equal(error.message.includes("private-response-body"), false);
      return true;
    }
  );
  assert.equal(callCount, 3);
});

test("404 响应保留明确状态码", async () => {
  const api = loadApi();
  await assert.rejects(
    api.loadConversation("missing", {
      fetchImpl: async () => new Response("", { status: 404 })
    }),
    (error) => error.name === "ConversationRequestError" && error.status === 404
  );
});

test("404 conversation_inaccessible 后刷新会话并重试一次", async () => {
  const api = loadApi();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) {
      return Response.json({ detail: { code: "conversation_inaccessible" } }, { status: 404 });
    }
    if (url === "/api/auth/session") return Response.json({ accessToken: "temporary-token" });
    return Response.json(conversationPayload());
  };
  const result = await api.loadConversation("conversation-id", { fetchImpl });
  assert.equal(result.questions.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.headers.Authorization, "Bearer temporary-token");
});

test("兼容顶层 conversation_inaccessible 错误码", async () => {
  const api = loadApi();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return Response.json({ code: "conversation_inaccessible" }, { status: 404 });
    if (url === "/api/auth/session") return Response.json({ accessToken: "temporary-token" });
    return Response.json(conversationPayload());
  };
  await api.loadConversation("conversation-id", { fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.headers.Authorization, "Bearer temporary-token");
});

test("外部取消信号会传递给请求", async () => {
  const api = loadApi();
  const controller = new AbortController();
  const fetchImpl = async (_url, init) => {
    controller.abort(new DOMException("用户取消", "AbortError"));
    await new Promise((resolve, reject) => {
      if (init.signal.aborted) {
        reject(init.signal.reason);
        return;
      }
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true
      });
    });
  };

  await assert.rejects(
    api.loadConversation("conversation-id", {
      fetchImpl,
      signal: controller.signal
    }),
    { name: "AbortError" }
  );
});

test("请求达到时限后被取消", async () => {
  const api = loadApi();
  const fetchImpl = async (_url, init) => {
    await new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true
      });
    });
  };

  await assert.rejects(
    api.loadConversation("conversation-id", {
      fetchImpl,
      timeoutMs: 20
    }),
    { name: "AbortError" }
  );
});

test("请求代次控制器中止旧请求并拒绝过期代次", () => {
  const api = loadApi();
  const gate = api.createRequestGate();
  const first = gate.next();
  const second = gate.next();

  assert.equal(first.signal.aborted, true);
  assert.equal(gate.isCurrent(first.generation), false);
  assert.equal(gate.isCurrent(second.generation), true);

  gate.abort();
  assert.equal(second.signal.aborted, true);
  assert.equal(gate.isCurrent(second.generation), false);
});

test("通过消息 ID 将 DOM 元素绑定到权威问题且不修改输入", () => {
  const api = loadApi();
  const element = { marker: "rendered" };
  const canonical = [
    {
      id: "question-m1",
      messageId: "m1",
      title: "问题",
      fullText: "问题全文",
      element: null
    }
  ];
  const domItems = [
    {
      id: "dom-1",
      messageId: "m1",
      title: "问题",
      fullText: "问题全文",
      element
    }
  ];

  const merged = api.mergeQuestionItems(canonical, domItems);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].element, element);
  assert.equal(canonical[0].element, null);
});

test("没有消息 ID 时只在末尾近邻中按规范化全文匹配", () => {
  const api = loadApi();
  const element = { marker: "pending-rendered" };
  const canonical = Array.from({ length: 6 }, (_, index) => ({
    id: `question-m${index}`,
    messageId: `m${index}`,
    title: `问题 ${index}`,
    fullText: index === 5 ? "问题全文\n第二行" : `内容 ${index}`,
    element: null
  }));
  const domItems = [
    {
      id: "dom-pending",
      messageId: null,
      title: "问题全文",
      fullText: "  问题全文  \n  第二行 ",
      element
    }
  ];

  const merged = api.mergeQuestionItems(canonical, domItems);
  assert.equal(merged.length, 6);
  assert.equal(merged[5].element, element);
});

test("相同标题但全文不同的问题保持独立", () => {
  const api = loadApi();
  const canonical = [
    {
      id: "question-m1",
      messageId: "m1",
      title: "同一标题",
      fullText: "同一标题\n第一条全文",
      element: null
    },
    {
      id: "question-m2",
      messageId: "m2",
      title: "同一标题",
      fullText: "同一标题\n第二条全文",
      element: null
    }
  ];
  const pending = {
    id: "dom-3",
    messageId: null,
    title: "同一标题",
    fullText: "同一标题\n第三条全文",
    element: { marker: "third" },
    source: "dom"
  };

  const merged = api.mergeQuestionItems(canonical, [pending]);
  assert.equal(merged.length, 3);
  assert.equal(merged[2].id, "dom-3");
});

test("待同步 DOM 问题按输入顺序追加", () => {
  const api = loadApi();
  const pending = [
    { id: "dom-1", messageId: null, fullText: "新问题 1" },
    { id: "dom-2", messageId: null, fullText: "新问题 2" }
  ];
  const merged = api.mergeQuestionItems([], pending);
  assert.deepEqual(merged.map((item) => item.id), ["dom-1", "dom-2"]);
  assert.notEqual(merged[0], pending[0]);
});
