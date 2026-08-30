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
    current_node: "u1",
    mapping: {
      u1: {
        parent: null,
        message: message("m1", "user", [text])
      }
    }
  };
}

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
    "/backend-api/conversation/conversation%2Fid"
  );
  assert.equal(calls[0].init.credentials, "include");
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
    "title"
  ]);
  assert.equal(JSON.stringify(cached).includes("完整敏感正文"), false);
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
