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
