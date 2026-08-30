# 基于接口的完整问题目录实施计划

> **供智能代理执行者使用：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项实施本计划。所有步骤使用复选框跟踪。

**目标：** 通过 ChatGPT 当前会话接口生成当前活动分支的完整用户问题目录，并能自动加载、定位尚未渲染的目标消息。

**架构：** `conversation-api.js` 负责同源请求、活动分支解析和目录数据合并；`message-navigator.js` 负责可取消的虚拟列表定位；`dom-adapter.js` 只处理宿主 DOM 绑定和滚动原语。`index.js` 负责生命周期编排，API 数据为权威来源，DOM 数据用于降级和补充尚未同步的新消息。

**技术栈：** Chrome Extension Manifest V3、原生 JavaScript IIFE、Fetch API、AbortController、MutationObserver、Node.js 22 内置测试运行器、jsdom 26.1.0（仅开发依赖）。

**设计文档：** `docs/superpowers/specs/2026-08-30-api-backed-question-directory-design.md`

## 全局约束

- 右侧目录只展示当前 `current_node` 父链上的非空用户消息。
- 左侧 AI 回复标题大纲行为保持不变。
- 不增加后台 Service Worker、持久化存储权限或第三方主机权限。
- 请求只访问 `chatgpt.com` 相对路径；访问令牌和会话正文不得持久化或记录到日志。
- Chrome 运行时代码保持零依赖，`jsdom` 只作为开发依赖。
- 不采用 Red/预期失败测试流程：先完成实现，再编写或更新测试，只运行预期通过的验证命令。
- 验证意外失败时，将其作为缺陷修复后重新运行，不以失败结果完成任何任务。
- 如果同源请求不能取得会话详情，停止实施并请用户重新确认架构，不擅自增加主执行环境注入或请求拦截。

---

## 任务 1：建立测试基础并实现活动分支解析

**文件：**

- 新建：`package.json`
- 新建：`package-lock.json`（由 npm 生成）
- 新建：`tests/helpers/load-script.js`
- 新建：`tests/conversation-api.test.js`
- 新建：`src/content/conversation-api.js`

**接口：**

- 输入：会话路由字符串、会话响应对象。
- 输出：`getConversationId(pathname)`、`normalizeQuestionTitle(text)`、`buildActiveBranch(payload)`、`buildQuestionItems(branch)`。
- 全局挂载：`globalThis.__CHATGPT_HELPER__.conversationApi`。

- [ ] **步骤 1：增加只用于开发的测试配置**

创建以下 `package.json`：

```json
{
  "name": "chatgpt-question-navigator",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "test": "node --test tests"
  },
  "devDependencies": {
    "jsdom": "26.1.0"
  }
}
```

运行：

```powershell
npm install
```

预期：生成 `package-lock.json`，安装过程退出码为 0。

- [ ] **步骤 2：实现会话 ID、文本规范化和活动分支解析**

在 `conversation-api.js` 中使用与现有脚本一致的 IIFE 命名空间形式，实现以下错误类型和公开函数：

```js
class ConversationResponseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConversationResponseError";
  }
}

function getConversationId(pathname = global.location?.pathname || "") {
  const match = String(pathname).match(/(?:^|\/)c\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeQuestionTitle(rawText) {
  const firstLine = String(rawText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => !/^(你说|您说|你问|用户|You said|You)\s*[:：]?$/i.test(line));

  return (firstLine || "")
    .replace(/^(你说|您说|你问|用户|You said|You)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
```

`buildActiveBranch(payload)` 必须：

1. 校验 `mapping`、`current_node` 和当前节点。
2. 用 `Set` 检测父链循环。
3. 缺失父节点时抛出 `ConversationResponseError`。
4. 反转父链并生成 `{ nodeId, messageId, role, branchIndex, message }`。
5. 消息 ID 缺失时使用 `nodeId`。

`buildQuestionItems(branch)` 必须按 `message.content.parts` 顺序组合文本，只保留 `role === "user"` 且规范化标题非空的项目，并生成：

```js
{
  id: `question-${messageId}`,
  messageId,
  nodeId,
  title,
  branchIndex,
  element: null,
  source: "api"
}
```

- [ ] **步骤 3：实现脚本加载辅助工具和解析测试**

`tests/helpers/load-script.js` 使用以下接口：

```js
const path = require("node:path");

function resetHelper() {
  delete globalThis.__CHATGPT_HELPER__;
}

function loadScript(relativePath) {
  const absolutePath = path.resolve(__dirname, "..", "..", relativePath);
  delete require.cache[require.resolve(absolutePath)];
  require(absolutePath);
  return globalThis.__CHATGPT_HELPER__;
}

module.exports = { loadScript, resetHelper };
```

`tests/conversation-api.test.js` 在实现完成后覆盖以下确定性场景：

```js
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

test("只沿 current_node 父链生成当前分支的用户问题", () => {
  const api = loadApi();
  const payload = {
    current_node: "assistant-b",
    mapping: {
      root: { parent: null, message: null },
      "user-a": { parent: "root", message: message("m-user-a", "user", ["第一个问题"]) },
      "assistant-a": { parent: "user-a", message: message("m-assistant-a", "assistant", ["回答 A"]) },
      "assistant-alt": { parent: "user-a", message: message("m-assistant-alt", "assistant", ["非活动回答"]) },
      "user-b": { parent: "assistant-a", message: message("m-user-b", "user", ["第二个问题"]) },
      "assistant-b": { parent: "user-b", message: message("m-assistant-b", "assistant", ["回答 B"]) }
    }
  };

  const branch = api.buildActiveBranch(payload);
  const questions = api.buildQuestionItems(branch);
  assert.deepEqual(questions.map((item) => item.messageId), ["m-user-a", "m-user-b"]);
  assert.equal(branch.some((item) => item.messageId === "m-assistant-alt"), false);
});
```

同一测试文件继续覆盖：普通 `/c/{id}`、项目路径中的 `/c/{id}`、空用户消息、混合媒体部分、缺失父节点、循环父链和缺少消息 ID 的后备键。

- [ ] **步骤 4：运行解析测试和语法检查**

运行：

```powershell
node --check src/content/conversation-api.js
npm test
```

预期：语法检查退出码为 0；全部测试通过，无跳过和未处理拒绝。

- [ ] **步骤 5：提交活动分支解析**

```powershell
git add package.json package-lock.json src/content/conversation-api.js tests/helpers/load-script.js tests/conversation-api.test.js
git commit -m "feat: parse active conversation branch"
```

---

## 任务 2：实现同源会话请求、认证重试和请求代次控制

**文件：**

- 修改：`src/content/conversation-api.js`
- 修改：`tests/conversation-api.test.js`

**接口：**

- 输入：`loadConversation(conversationId, { fetchImpl, signal, timeoutMs })`。
- 输出：解析后的 `{ branch, questions }`。
- 输出：`createRequestGate()`，用于中止旧请求并判断响应是否仍属于当前代次。

- [ ] **步骤 1：实现安全的同源请求**

新增常量及函数：

```js
const SESSION_ENDPOINT = "/api/auth/session";
const CONVERSATION_ENDPOINT_PREFIX = "/backend-api/conversation/";

class ConversationRequestError extends Error {
  constructor(status) {
    super(`会话请求失败（HTTP ${status}）`);
    this.name = "ConversationRequestError";
    this.status = status;
  }
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

async function fetchSession(fetchImpl, signal) {
  const response = await fetchImpl(SESSION_ENDPOINT, {
    credentials: "include",
    signal
  });
  if (!response.ok) return { accessToken: null };
  const payload = await response.json();
  return {
    accessToken: typeof payload?.accessToken === "string" ? payload.accessToken : null
  };
}

async function loadConversation(conversationId, options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch.bind(global);
  const timeoutMs = Number(options.timeoutMs) || 8000;
  const timeoutController = new AbortController();
  const timeoutId = global.setTimeout(() => timeoutController.abort(), timeoutMs);
  const linked = createLinkedAbortSignal(options.signal, timeoutController.signal);
  const signal = linked.signal;

  try {
    const path = `${CONVERSATION_ENDPOINT_PREFIX}${encodeURIComponent(conversationId)}`;
    let response = await fetchImpl(path, { credentials: "include", signal });

    if (response.status === 401 || response.status === 403) {
      const session = await fetchSession(fetchImpl, signal);
      response = await fetchImpl(path, {
        credentials: "include",
        signal,
        headers: session.accessToken
          ? { Authorization: `Bearer ${session.accessToken}` }
          : undefined
      });
    }

    if (!response.ok) {
      throw new ConversationRequestError(response.status);
    }

    const payload = await response.json();
    const branch = buildActiveBranch(payload);
    return { branch, questions: buildQuestionItems(branch) };
  } finally {
    global.clearTimeout(timeoutId);
    linked.cleanup();
  }
}
```

`createLinkedAbortSignal` 返回 `{ signal, cleanup }`：任一来源信号取消时取消内部控制器，`cleanup()` 负责移除全部外部监听器。错误对象只保存状态码，不保存响应正文、访问令牌或完整 URL 查询内容。

- [ ] **步骤 2：实现请求代次控制器**

实现并公开：

```js
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
```

- [ ] **步骤 3：在实现后增加请求生命周期测试**

使用内存中的 `fetchImpl` 模拟响应，至少断言：

```js
test("认证失败后获取会话令牌并只重试一次", async () => {
  const api = loadApi();
  const calls = [];
  const payload = {
    current_node: "u1",
    mapping: { u1: { parent: null, message: message("m1", "user", ["问题"]) } }
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response("", { status: 401 });
    if (url === "/api/auth/session") {
      return Response.json({ accessToken: "memory-only-token" });
    }
    return Response.json(payload);
  };

  const result = await api.loadConversation("conversation-id", { fetchImpl });
  assert.equal(result.questions.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].init.headers.Authorization, "Bearer memory-only-token");
});
```

继续覆盖首次成功、`404`、第二次仍为 `401`、外部取消、超时和 `createRequestGate()` 拒绝旧代次。断言异常文本不包含模拟令牌和响应正文。

- [ ] **步骤 4：运行请求测试**

```powershell
node --check src/content/conversation-api.js
npm test
```

预期：全部测试通过，请求模拟中不存在第三方 URL。

- [ ] **步骤 5：提交请求生命周期**

```powershell
git add src/content/conversation-api.js tests/conversation-api.test.js
git commit -m "feat: load complete conversation branch"
```

---

## 任务 3：实现权威问题与 DOM 待同步问题合并

**文件：**

- 修改：`src/content/conversation-api.js`
- 修改：`tests/conversation-api.test.js`

**接口：**

- 输入：`mergeQuestionItems(apiItems, domItems)`。
- 输出：保持接口顺序并追加真正待同步问题的目录数组。

- [ ] **步骤 1：实现无副作用合并函数**

实现并公开 `mergeQuestionItems`：

```js
function mergeQuestionItems(apiItems, domItems) {
  const canonical = Array.isArray(apiItems) ? apiItems.map((item) => ({ ...item })) : [];
  const rendered = Array.isArray(domItems) ? domItems : [];
  const byMessageId = new Map(canonical.map((item) => [item.messageId, item]));
  const matchedIds = new Set();

  rendered.forEach((domItem) => {
    const match = domItem.messageId ? byMessageId.get(domItem.messageId) : null;
    if (match) {
      match.element = domItem.element || null;
      matchedIds.add(match.id);
    }
  });

  const unmatchedTail = canonical.slice(Math.max(canonical.length - 4, 0));
  const pending = rendered.filter((domItem) => {
    if (domItem.messageId && byMessageId.has(domItem.messageId)) return false;
    const textMatch = unmatchedTail.find((item) => {
      return !matchedIds.has(item.id) && item.fullText && item.fullText === domItem.fullText;
    });
    if (textMatch) {
      textMatch.element = domItem.element || null;
      matchedIds.add(textMatch.id);
      return false;
    }
    return true;
  });

  return canonical.concat(pending);
}
```

同时让 API 问题项携带只存在于内存中的规范化 `fullText`，用于无消息 ID 时的末尾近邻匹配；侧栏只读取 `title`，不渲染 `fullText`。

- [ ] **步骤 2：在实现后增加合并测试**

覆盖消息 ID 绑定、末尾文本匹配、同标题但全文不同、相同标题的两个不同消息、DOM 待同步项追加顺序、输入数组不被修改。示例核心断言：

```js
const merged = api.mergeQuestionItems(
  [{ id: "question-m1", messageId: "m1", title: "问题", fullText: "问题全文", element: null }],
  [{ id: "dom-1", messageId: "m1", title: "问题", fullText: "问题全文", element }]
);
assert.equal(merged.length, 1);
assert.equal(merged[0].element, element);
```

- [ ] **步骤 3：运行合并测试**

```powershell
node --check src/content/conversation-api.js
npm test
```

预期：全部测试通过；相同标题不会造成错误去重。

- [ ] **步骤 4：提交合并逻辑**

```powershell
git add src/content/conversation-api.js tests/conversation-api.test.js
git commit -m "feat: merge canonical and pending questions"
```

---

## 任务 4：扩展 DOM 适配器的消息 ID 与虚拟滚动能力

**文件：**

- 修改：`src/content/dom-adapter.js:47-75`
- 修改：`src/content/dom-adapter.js:224-353`
- 修改：`src/content/dom-adapter.js:441-600`
- 修改：`src/content/dom-adapter.js:704-715`
- 新建：`tests/dom-adapter.test.js`

**接口：**

- 保留：`getQuestionItems()` 作为兼容别名。
- 新增：`getDomQuestionItems()`、`findMessageElement(messageId)`、`getRenderedMessageEntries()`、`getScrollMetrics()`、`scrollByAmount(delta)`、`scrollToRatio(ratio)`、`waitForMessageRender({ signal, timeoutMs })`、`scrollToMessageElement(element)`。

- [ ] **步骤 1：让 DOM 问题项携带宿主消息 ID**

增加统一 ID 提取：

```js
function getSourceMessageId(element) {
  if (!(element instanceof HTMLElement)) return null;
  return element.getAttribute("data-message-id") ||
    element.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
    null;
}
```

将 DOM 问题映射为：

```js
{
  id: messageId ? `question-${messageId}` : `${ITEM_ID_PREFIX}-pending-${index + 1}`,
  messageId,
  nodeId: null,
  title: normalizeTitle(fullText),
  fullText,
  branchIndex: null,
  element,
  source: "dom"
}
```

`getQuestionItems` 暂时调用 `getDomQuestionItems`，保证应用集成任务开始前现有功能不被破坏。

- [ ] **步骤 2：实现消息元素查找与滚动原语**

`findMessageElement(messageId)` 必须使用 `CSS.escape` 构造选择器，再经 `findTurnContainer` 返回完整轮次。`getRenderedMessageEntries()` 对所有 `[data-message-id]` 去重并返回 `{ messageId, element }`。

滚动接口统一使用当前 `getScrollContainer()`：

```js
function getScrollMetrics() {
  const container = getScrollContainer();
  if (!container) return { top: 0, maxTop: 0, clientHeight: 0 };
  return {
    top: container.scrollTop,
    maxTop: Math.max(container.scrollHeight - container.clientHeight, 0),
    clientHeight: container.clientHeight
  };
}

function scrollToRatio(ratio) {
  const container = getScrollContainer();
  if (!container) return false;
  const safeRatio = Math.min(Math.max(Number(ratio) || 0, 0), 1);
  container.scrollTo({ top: getScrollMetrics().maxTop * safeRatio, behavior: "auto" });
  return true;
}
```

`waitForMessageRender` 使用一次性 `MutationObserver` 和定时器竞争；取消、DOM 变化或超时后必须断开观察器并清理定时器。

- [ ] **步骤 3：在实现后增加 jsdom 测试**

在 `tests/dom-adapter.test.js` 中建立带 `main`、用户 `article`、`data-message-id` 和可滚动容器的 DOM。加载脚本前将 `window`、`document`、`HTMLElement`、`MutationObserver` 和 `CSS` 暂时映射到 `globalThis`，测试结束后恢复。

至少验证：

```js
assert.equal(adapter.getDomQuestionItems()[0].messageId, "message-user-1");
assert.equal(adapter.findMessageElement("message-user-1").tagName, "ARTICLE");
assert.deepEqual(
  adapter.getRenderedMessageEntries().map((entry) => entry.messageId),
  ["message-user-1"]
);
```

继续验证扩展自己的侧栏节点被排除、比例限制在 0 至 1、DOM 变化会结束等待、取消后观察器不再回调。

- [ ] **步骤 4：运行 DOM 适配器测试**

```powershell
node --check src/content/dom-adapter.js
npm test
```

预期：全部测试通过，现有 API 与新增 API 均可调用。

- [ ] **步骤 5：提交 DOM 适配能力**

```powershell
git add src/content/dom-adapter.js tests/dom-adapter.test.js
git commit -m "feat: expose message-aware DOM navigation"
```

---

## 任务 5：实现可取消的未渲染消息定位器

**文件：**

- 新建：`src/content/message-navigator.js`
- 新建：`tests/message-navigator.test.js`

**接口：**

- 输入：`navigateToMessage({ branch, target, adapter, signal, timeoutMs, settleMs })`。
- 输出：Promise，成功返回 `{ status: "found", element }`；受控失败返回 `{ status: "not-rendered" }`；取消时抛出 `AbortError`。
- 全局挂载：`globalThis.__CHATGPT_HELPER__.messageNavigator`。

- [ ] **步骤 1：实现直接定位和方向计算**

创建纯辅助函数 `chooseNearestAnchor(branch, target, renderedEntries)`，只接受消息 ID 和索引数据。`navigateToMessage` 首先使用待同步项已经携带的 `target.element`，否则再通过消息 ID 查询；存在时立即执行 `adapter.scrollToMessageElement(element)`：

```js
const directElement = target.element ||
  (target.messageId ? adapter.findMessageElement(target.messageId) : null);
if (directElement) {
  adapter.scrollToMessageElement(directElement);
  return { status: "found", element: directElement };
}
```

只有带有效 `branchIndex` 和 `messageId` 的权威目录项才进入未渲染消息加载循环；不具备这些字段且没有现成元素的待同步项直接返回 `not-rendered`。

锚点方向必须基于完整活动分支的 `branchIndex`，而不是只基于用户问题序号：

```js
const direction = target.branchIndex < anchor.branchIndex ? -1 : 1;
const delta = direction * Math.max(adapter.getScrollMetrics().clientHeight * 0.8, 160);
adapter.scrollByAmount(delta);
```

- [ ] **步骤 2：实现有界重试、比例定位和取消**

没有锚点时调用：

```js
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("定位已取消", "AbortError");
}

const denominator = Math.max(branch.length - 1, 1);
adapter.scrollToRatio(target.branchIndex / denominator);
```

每轮等待 `adapter.waitForMessageRender({ signal, timeoutMs: settleMs || 250 })` 后重新扫描。记录上轮 `top`；在 `top === 0` 或 `top === maxTop` 且连续三轮没有变化时返回 `not-rendered`。总时长默认 10 秒。每次循环开始及滚动之后都调用 `throwIfAborted(signal)`，防止路由切换后继续滚动。

- [ ] **步骤 3：在实现后增加定位器测试**

使用不依赖真实 DOM 的内存适配器：

```js
function createAdapter(renderedIds = []) {
  const state = { renderedIds: [...renderedIds], top: 500, maxTop: 2000, clientHeight: 500, calls: [] };
  return {
    state,
    findMessageElement(id) {
      return state.renderedIds.includes(id) ? { id } : null;
    },
    getRenderedMessageEntries() {
      return state.renderedIds.map((messageId) => ({ messageId, element: { id: messageId } }));
    },
    getScrollMetrics() {
      return { top: state.top, maxTop: state.maxTop, clientHeight: state.clientHeight };
    },
    scrollByAmount(delta) {
      state.calls.push(["scrollByAmount", delta]);
      state.top = Math.min(Math.max(state.top + delta, 0), state.maxTop);
    },
    scrollToRatio(ratio) {
      state.calls.push(["scrollToRatio", ratio]);
      state.top = state.maxTop * ratio;
    },
    async waitForMessageRender() {},
    scrollToMessageElement(element) {
      state.calls.push(["scrollToMessageElement", element.id]);
      return true;
    }
  };
}
```

测试直接命中、向上滚动、向下滚动、无锚点比例定位、等待后出现目标、连续边界停止、总时限停止和 AbortController 取消。所有测试使用短的显式 `timeoutMs`，但预期结果均为成功断言或受控 `not-rendered`，不依赖测试框架超时。

- [ ] **步骤 4：运行定位器测试**

```powershell
node --check src/content/message-navigator.js
npm test
```

预期：全部测试通过；测试进程结束后没有残留定时器。

- [ ] **步骤 5：提交消息定位器**

```powershell
git add src/content/message-navigator.js tests/message-navigator.test.js
git commit -m "feat: navigate to unrendered conversation messages"
```

---

## 任务 6：为右侧栏增加同步与定位状态

**文件：**

- 修改：`src/content/sidebar.js:5-214`
- 修改：`src/content/styles.css:1-149`
- 新建：`tests/sidebar.test.js`

**接口：**

- 修改：`render(items, activeId, status)`。
- 新增：`setStatus(status)`。
- 状态结构：`{ kind: "loading" | "ready" | "degraded" | "navigating" | "navigation-error", message: string }`。

- [ ] **步骤 1：实现非阻断式状态区域**

在侧栏卡片列表之前插入：

```js
const status = document.createElement("div");
status.className = "chatgpt-helper-sidebar__status";
status.hidden = true;
card.appendChild(status);
```

`setStatus` 只使用 `textContent`：

```js
setStatus(status) {
  this.status = status || { kind: "ready", message: "" };
  this.root.dataset.status = this.status.kind;
  this.statusElement.textContent = this.status.message || "";
  this.statusElement.hidden = !this.status.message;
}
```

`loading`、`degraded`、`navigating` 和 `navigation-error` 只改变展开卡片中的文本与轻量颜色，不禁用刻度条和问题按钮。

- [ ] **步骤 2：增加状态样式**

在右侧栏现有样式区域增加 `.chatgpt-helper-sidebar__status`，使用与卡片一致的 12px 字号和左右 16px 内边距。`degraded`、`navigation-error` 使用琥珀色文字；`loading`、`navigating` 使用中性灰色。不得使用遮罩、固定通知或动画旋转器。

- [ ] **步骤 3：在实现后增加侧栏测试**

在 jsdom 中挂载侧栏，依次传入每种状态，断言：

```js
view.render(items, items[0].id, { kind: "navigating", message: "正在定位…" });
assert.equal(root.dataset.status, "navigating");
assert.equal(root.querySelector(".chatgpt-helper-sidebar__status").textContent, "正在定位…");
assert.equal(root.querySelector("[data-question-id]").disabled, false);
```

继续验证状态消息以文本形式插入、`ready` 隐藏状态区域、没有项目时侧栏仍遵循原有不可见行为。

- [ ] **步骤 4：运行侧栏测试和样式静态检查**

```powershell
node --check src/content/sidebar.js
npm test
```

预期：全部测试通过；状态切换不改变现有点击处理器和活动项高亮。

- [ ] **步骤 5：提交侧栏状态**

```powershell
git add src/content/sidebar.js src/content/styles.css tests/sidebar.test.js
git commit -m "feat: show directory sync and navigation status"
```

---

## 任务 7：集成会话同步、缓存和消息定位生命周期

**文件：**

- 修改：`manifest.json:17-22`
- 修改：`src/content/index.js:1-339`
- 新建：`tests/app-integration.test.js`

**接口：**

- 消费：`conversationApi.loadConversation`、`conversationApi.mergeQuestionItems`、`conversationApi.createRequestGate`。
- 消费：`messageNavigator.navigateToMessage`。
- 消费：任务 4 的 DOM 适配器接口和任务 6 的侧栏状态接口。
- 保留：现有 `messageOutline` 生命周期。

- [ ] **步骤 1：更新内容脚本加载顺序**

`manifest.json` 的脚本顺序改为：

```json
"js": [
  "src/content/conversation-api.js",
  "src/content/dom-adapter.js",
  "src/content/sidebar.js",
  "src/content/message-outline.js",
  "src/content/message-navigator.js",
  "src/content/index.js"
]
```

- [ ] **步骤 2：增加应用级同步状态**

在 `index.js` 初始化时校验五个依赖，并增加：

```js
const conversationApi = state.conversationApi;
const messageNavigator = state.messageNavigator;
const requestGate = conversationApi.createRequestGate();
const conversationCache = new Map();
let activeBranch = [];
let canonicalItems = [];
let domItems = [];
let syncStatus = { kind: "loading", message: "正在同步完整目录…" };
let syncTimer = 0;
let navigationController = null;
```

实现 `renderMergedQuestions()`：重新读取 DOM 问题，调用 `mergeQuestionItems`，按消息 ID 重新绑定 `element`，计算活动项后调用 `sidebar.render(items, activeId, syncStatus)`。

- [ ] **步骤 3：实现会话刷新、缓存和过期响应拒绝**

实现 `refreshConversation()`：

1. 用当前路径取得会话 ID；不存在时进入 DOM 模式。
2. 从内存缓存立即恢复 `{ branch, questions }`。
3. 调用 `requestGate.next()` 获取 `{ generation, signal }`。
4. 请求成功后先调用 `requestGate.isCurrent(generation)`。
5. 仅当前代次可以更新 `activeBranch`、`canonicalItems`、缓存和 `ready` 状态。
6. `404` 或其他受控失败更新为 `degraded`，但不清除仍可用的数据。

实现 `scheduleConversationRefresh()`，每次 DOM 问题签名发生变化时清除旧定时器，并在 500 毫秒后调用 `refreshConversation()`。路由变化时不防抖，立即取消并刷新。

- [ ] **步骤 4：将侧栏点击接入可取消定位器**

侧栏 `onSelect` 改为异步流程：

```js
async function navigateToQuestion(item) {
  navigationController?.abort();
  navigationController = new AbortController();
  lockActive(item.id, 10000);
  setActive(item.id);
  syncStatus = { kind: "navigating", message: "正在加载并定位消息…" };
  render();

  try {
    const result = await messageNavigator.navigateToMessage({
      branch: activeBranch,
      target: item,
      adapter: domAdapter,
      signal: navigationController.signal,
      timeoutMs: 10000,
      settleMs: 250
    });
    syncStatus = result.status === "found"
      ? { kind: "ready", message: "" }
      : { kind: "navigation-error", message: "ChatGPT 未能加载该消息" };
  } catch (error) {
    if (error?.name !== "AbortError") {
      syncStatus = { kind: "navigation-error", message: "消息定位失败" };
    }
  } finally {
    renderMergedQuestions();
    refreshMessageOutline();
  }
}
```

路由切换、新目录选择和应用销毁必须取消 `navigationController`。用户产生与扩展目标方向明显不一致的滚动时也取消定位；扩展内部滚动通过短期标志与手动滚动区分。

- [ ] **步骤 5：修正活动项选择以容忍未渲染项目**

`pickActiveQuestion()` 只对 `item.element instanceof HTMLElement` 的项目读取几何信息。若最近可见分支节点不是用户问题，则根据 `branchIndex` 选择它之前最近的用户目录项。没有任何已渲染问题时保留当前锁定项，否则保留现有活动项，不默认选择数组最后一个未渲染问题。

- [ ] **步骤 6：在实现后增加应用集成测试**

通过 jsdom 和命名空间桩件加载 `index.js`，用受控的 `setTimeout`、`setInterval` 和请求 Promise 验证：

- 首次先渲染 DOM 目录，接口成功后替换为完整目录。
- 旧会话 Promise 后返回时不会覆盖新会话。
- 接口失败时状态为 `degraded` 且 DOM 问题仍存在。
- 点击未渲染项调用定位器并显示 `navigating`。
- 路由切换取消请求和定位。
- `messageOutline` 的挂载、刷新与销毁调用仍与原行为一致。

核心过期响应断言：

```js
assert.deepEqual(
  sidebarRenderCalls.at(-1).items.map((item) => item.messageId),
  ["new-conversation-message"]
);
assert.equal(sidebarRenderCalls.at(-1).status.kind, "ready");
```

- [ ] **步骤 7：运行完整自动验证**

```powershell
node --check src/content/conversation-api.js
node --check src/content/dom-adapter.js
node --check src/content/sidebar.js
node --check src/content/message-outline.js
node --check src/content/message-navigator.js
node --check src/content/index.js
npm test
```

预期：全部语法检查和测试通过；Node 进程正常退出，无残留定时器。

- [ ] **步骤 8：提交应用集成**

```powershell
git add manifest.json src/content/index.js tests/app-integration.test.js
git commit -m "feat: use complete API-backed question directory"
```

---

## 任务 8：更新说明并完成 Chrome 手动验收

**文件：**

- 修改：`README.md:9-16`
- 修改：`README.md:46-58`
- 修改：`manifest.json:4-5`

**接口：** 无新增代码接口；交付用户可安装并验证的扩展。

- [ ] **步骤 1：更新版本与中文说明**

将清单版本从 `0.1.0` 更新为 `0.2.0`，描述改为明确说明“完整活动分支问题目录”。README 功能列表补充：

```markdown
- 通过当前 ChatGPT 会话数据展示活动分支中的完整用户问题目录
- 历史问题尚未渲染时，点击目录项会自动加载并定位
- 会话接口不可用时自动退回当前页面的 DOM 问题目录
```

README 同时说明内部接口可能随 ChatGPT 更新而变化，扩展不会把会话内容发送给第三方或写入持久化存储。

- [ ] **步骤 2：重新加载扩展并验证普通会话**

在 `chrome://extensions/` 重新加载已解压扩展，打开一个包含足够多历史消息的普通 `/c/{id}` 会话，确认：

1. 右侧目录数量等于当前分支的用户提问数量。
2. 非活动编辑分支的问题不出现。
3. 点击已渲染问题准确定位。
4. 点击未渲染问题显示定位状态，加载完成后准确定位。
5. 滚动时活动高亮与当前问题同步。

- [ ] **步骤 3：验证项目会话、分支切换和新消息**

在项目会话中切换分支，确认旧分支独有问题被移除、当前分支问题出现。发送一条新问题，确认它立即以 DOM 待同步项出现，接口刷新后不重复。确认左侧 AI 回复标题大纲仍能随当前回复变化。

- [ ] **步骤 4：验证降级、取消、超时和窄屏**

通过开发者工具临时阻止 `/backend-api/conversation/` 请求，确认目录进入降级状态且 DOM 问题仍可点击。恢复请求后重新进入会话，确认完整目录恢复。定位过程中切换会话，确认旧页面不再自动滚动。验证目标无法加载时 10 秒内结束。将视口缩小到 1100px 以下，确认左右侧栏仍按原样隐藏。

- [ ] **步骤 5：执行最终静态与自动验证**

```powershell
git diff --check
node --check src/content/conversation-api.js
node --check src/content/dom-adapter.js
node --check src/content/sidebar.js
node --check src/content/message-outline.js
node --check src/content/message-navigator.js
node --check src/content/index.js
npm test
git status --short
```

预期：差异检查、语法检查和全部测试通过；`git status --short` 只显示本任务预期的 README 与清单改动。

- [ ] **步骤 6：提交文档和版本更新**

```powershell
git add README.md manifest.json
git commit -m "docs: document complete question directory"
```

- [ ] **步骤 7：确认最终仓库状态**

```powershell
git status --short --branch
git log --oneline -8
```

预期：工作树干净，最近提交依次覆盖解析、请求、合并、DOM 适配、定位器、侧栏状态、应用集成和文档更新。
