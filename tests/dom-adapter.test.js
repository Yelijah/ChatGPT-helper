const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { loadScript, resetHelper } = require("./helpers/load-script");

const GLOBAL_KEYS = [
  "window",
  "document",
  "HTMLElement",
  "MutationObserver",
  "CSS",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "location",
  "history"
];

function installDom() {
  const previous = new Map(GLOBAL_KEYS.map((key) => [key, globalThis[key]]));
  const dom = new JSDOM(`<!doctype html><body>
    <div id="scroll" style="overflow-y: auto">
      <main>
        <article data-message-id="message-user-1">
          <div data-message-author-role="user"><p>第一个问题</p></div>
        </article>
      </main>
    </div>
    <aside class="chatgpt-helper-sidebar">
      <div data-message-id="helper-message"></div>
    </aside>
  </body>`, {
    url: "https://chatgpt.com/c/conversation-1"
  });

  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MutationObserver = dom.window.MutationObserver;
  globalThis.CSS = dom.window.CSS || {};
  globalThis.CSS.escape ||= (value) => String(value).replace(/["'\\]/g, "\\$&");
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.cancelAnimationFrame = clearTimeout;
  globalThis.location = dom.window.location;
  globalThis.history = dom.window.history;

  const scroll = dom.window.document.getElementById("scroll");
  Object.defineProperties(scroll, {
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 2500 }
  });
  scroll.scrollTop = 400;
  scroll.scrollTo = ({ top }) => {
    scroll.scrollTop = top;
  };

  dom.window.document.querySelectorAll("article, main, #scroll").forEach((element) => {
    element.getBoundingClientRect = () => ({
      top: 100,
      bottom: 300,
      left: 100,
      right: 700,
      width: 600,
      height: 200
    });
  });

  resetHelper();
  loadScript("src/content/conversation-api.js");
  const adapter = loadScript("src/content/dom-adapter.js").domAdapter;

  function cleanup() {
    resetHelper();
    dom.window.close();
    previous.forEach((value, key) => {
      if (value === undefined) {
        delete globalThis[key];
      } else {
        globalThis[key] = value;
      }
    });
  }

  return { adapter, dom, scroll, cleanup };
}

test("DOM 问题携带宿主消息 ID 和规范化全文", () => {
  const context = installDom();
  try {
    const items = context.adapter.getDomQuestionItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].messageId, "message-user-1");
    assert.equal(items[0].id, "question-message-user-1");
    assert.equal(items[0].fullText, "第一个问题");
    assert.equal(items[0].source, "dom");
  } finally {
    context.cleanup();
  }
});

test("新版回复识别、23 个标题展示和点击跳转贯通", () => {
  const context = installDom();
  let outline;
  try {
    const main = context.dom.window.document.querySelector("main");
    const turn = context.dom.window.document.createElement("div");
    turn.innerHTML = `<h4 class="sr-only" data-conversation-role="assistant">ChatGPT 说：</h4>
      <div><div data-chatgpt-selection-message-id="reply-standard">
        <div data-markdown-text-style="assistant-message" class="MarkdownRoot-rZKhxa">
          <h4 class="sr-only">隐藏提示</h4>
          <h3 hidden>隐藏标题</h3>
          <div aria-hidden="true"><h3>隐藏副本</h3></div>
          ${Array.from({ length: 23 }, (_, index) => {
            const level = index % 3 + 2;
            return `<h${level}>章节 ${index + 1}</h${level}>`;
          }).join("")}
        </div>
      </div></div>`;
    main.appendChild(turn);

    const messages = context.adapter.getAssistantMessages();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, "chatgpt-helper-message-reply-standard");
    assert.equal(messages[0].element, turn.querySelector("[data-chatgpt-selection-message-id]"));
    assert.equal(messages[0].contentElement, turn.querySelector("[data-markdown-text-style]"));
    assert.equal(context.adapter.getDomQuestionItems().length, 1);
    const headings = context.adapter.extractHeadings(messages[0].contentElement, messages[0].id);
    assert.equal(headings.length, 23);
    assert.deepEqual(headings.slice(0, 3).map(({ level }) => level), [2, 3, 4]);
    assert.equal(headings.every(({ text }) => text.startsWith("章节 ")), true);

    outline = loadScript("src/content/message-outline.js").messageOutline.mount(
      context.dom.window.document.body,
      { onSelect: (heading) => context.adapter.scrollToHeading(heading.id) }
    );
    outline.render(messages[0], headings);
    assert.equal(outline.root.dataset.visible, "true");
    assert.equal(outline.list.children.length, 23);
    assert.equal(outline.rail.children.length > 0, true);
    headings[0].element.getBoundingClientRect = () => ({ top: 500, bottom: 540, height: 40 });
    outline.list.children[0].click();
    assert.equal(context.scroll.scrollTop, 704);
  } finally {
    outline?.destroy();
    context.cleanup();
  }
});

test("新版与旧版回复混用时每条回复只收录一次", () => {
  const context = installDom();
  try {
    context.dom.window.document.querySelector("main").innerHTML = `
      <article data-message-id="legacy">
        <div data-message-author-role="assistant"><div class="markdown"><h2>旧版标题</h2></div></div>
      </article>
      <div><h4 class="sr-only" data-conversation-role="assistant">ChatGPT 说：</h4>
        <div data-chatgpt-selection-message-id="modern">
          <div data-markdown-text-style="assistant-message"><h2>新版标题</h2></div>
        </div>
      </div>
      <article data-message-id="overlap">
        <div data-message-author-role="assistant" data-chatgpt-selection-message-id="overlap">
          <div class="markdown" data-markdown-text-style="assistant-message"><h2>双标记标题</h2></div>
        </div>
      </article>`;
    const messages = context.adapter.getAssistantMessages();
    assert.equal(messages.length, 3);
    assert.equal(new Set(messages.map(({ id }) => id)).size, 3);
    assert.deepEqual(messages.flatMap((message) =>
      context.adapter.extractHeadings(message.contentElement, message.id).map(({ text }) => text)
    ), ["旧版标题", "新版标题", "双标记标题"]);
  } finally {
    context.cleanup();
  }
});

test("新版正文无需消息包装节点，重挂载和节点复用仍使用宿主消息 ID", () => {
  const context = installDom();
  try {
    const main = context.dom.window.document.querySelector("main");
    main.innerHTML = `<div data-markdown-text-style="assistant-message"><h2>无包装标题</h2></div>`;
    const direct = context.adapter.getAssistantMessages()[0];
    assert.equal(direct.contentElement, main.firstElementChild);
    assert.equal(direct.element, direct.contentElement);

    const html = `<div data-chatgpt-selection-message-id="stable">
      <div data-markdown-text-style="assistant-message"><h2>稳定标题</h2></div>
    </div>`;
    main.innerHTML = html;
    const first = context.adapter.getAssistantMessages()[0];
    const firstHeading = context.adapter.extractHeadings(first.contentElement, first.id)[0];
    main.innerHTML = `<div data-markdown-text-style="assistant-message"><h2>前序回复</h2></div>${html}`;
    const remounted = context.adapter.getAssistantMessages()[1];
    assert.equal(remounted.id, first.id);
    assert.equal(context.adapter.extractHeadings(remounted.contentElement, remounted.id)[0].id, firstHeading.id);
    remounted.element.setAttribute("data-chatgpt-selection-message-id", "reused");
    assert.equal(context.adapter.getAssistantMessages()[1].id, "chatgpt-helper-message-reused");
  } finally {
    context.cleanup();
  }
});

test("新版回复流式添加标题会刷新大纲", async () => {
  const context = installDom();
  let stop;
  try {
    const main = context.dom.window.document.querySelector("main");
    main.innerHTML = `<div data-chatgpt-selection-message-id="streaming">
      <div data-markdown-text-style="assistant-message"></div>
    </div>`;
    const content = main.querySelector("[data-markdown-text-style]");
    const changed = new Promise((resolve) => {
      stop = context.adapter.observeAssistantMessages(resolve);
    });
    const heading = context.dom.window.document.createElement("h2");
    heading.textContent = "流式标题";
    content.appendChild(heading);
    await changed;
    const message = context.adapter.getAssistantMessages()[0];
    assert.deepEqual(context.adapter.extractHeadings(message.contentElement, message.id).map(({ text }) => text), ["流式标题"]);
  } finally {
    stop?.();
    context.cleanup();
  }
});

test("项目会话路径即使使用新版消息 DOM 也识别为会话", () => {
  const context = installDom();
  try {
    context.dom.window.history.replaceState(
      {},
      "",
      "/g/g-p-project-name/c/conversation-1"
    );
    context.dom.window.document.querySelector("main").replaceChildren();

    assert.equal(context.adapter.isConversationRoute(), true);
    assert.deepEqual(context.adapter.getDomQuestionItems(), []);
  } finally {
    context.cleanup();
  }
});

test("新版隐藏说话人标题可作为问题元素并支持全文定位", () => {
  const context = installDom();
  try {
    const main = context.dom.window.document.querySelector("main");
    main.replaceChildren();
    const turn = context.dom.window.document.createElement("div");
    const marker = context.dom.window.document.createElement("h4");
    marker.className = "sr-only";
    marker.textContent = "你说：";
    const text = context.dom.window.document.createElement("div");
    text.textContent = "历史问题全文";
    turn.append(marker, text);
    Object.defineProperty(turn, "innerText", {
      configurable: true,
      value: "你说：历史问题全文"
    });
    turn.getBoundingClientRect = () => ({
      top: 100,
      bottom: 260,
      left: 100,
      right: 700,
      width: 600,
      height: 160
    });
    main.appendChild(turn);

    const items = context.adapter.getDomQuestionItems();
    assert.equal(items.length, 1);
    assert.equal(items[0].fullText, "历史问题全文");
    assert.equal(
      context.adapter.findMessageElement("api-message", {
        fullText: "历史问题全文"
      }),
      turn
    );
    assert.equal(context.adapter.getRenderedMessageEntries().length, 1);
  } finally {
    context.cleanup();
  }
});

test("Codex 消息标题与 data-user-message-bubble 分离时只返回当前气泡", () => {
  const context = installDom();
  try {
    const main = context.dom.window.document.querySelector("main");
    main.replaceChildren();
    const marker = context.dom.window.document.createElement("h4");
    marker.className = "sr-only m-0 select-none";
    marker.textContent = "你说：";
    const bubble = context.dom.window.document.createElement("div");
    bubble.setAttribute("data-user-message-bubble", "true");
    Object.defineProperty(bubble, "innerText", {
      configurable: true,
      value: "多租户定时任务调度"
    });
    bubble.getBoundingClientRect = () => ({
      top: 100,
      bottom: 180,
      left: 100,
      right: 700,
      width: 600,
      height: 80
    });
    const marker2 = context.dom.window.document.createElement("h4");
    marker2.className = "sr-only m-0 select-none";
    marker2.textContent = "你说：";
    const bubble2 = context.dom.window.document.createElement("div");
    bubble2.setAttribute("data-user-message-bubble", "true");
    Object.defineProperty(bubble2, "innerText", {
      configurable: true,
      value: "第二个问题"
    });
    bubble2.getBoundingClientRect = bubble.getBoundingClientRect;
    const assistantMarker = context.dom.window.document.createElement("h4");
    assistantMarker.className = "sr-only m-0 select-none";
    assistantMarker.dataset.conversationRole = "assistant";
    assistantMarker.textContent = "ChatGPT said:";
    main.append(marker, bubble, assistantMarker, marker2, bubble2);

    const items = context.adapter.getDomQuestionItems();
    const item = items[0];
    assert.equal(item.element, bubble);
    assert.equal(item.fullText, "多租户定时任务调度");
    assert.equal(items[1].element, bubble2);
    assert.equal(
      context.adapter.findMessageElement("api-message", { fullText: item.fullText }),
      bubble
    );
  } finally {
    context.cleanup();
  }
});

test("新版无障碍标题嵌套在零高度包装节点时仍定位到消息块", () => {
  const context = installDom();
  try {
    const main = context.dom.window.document.querySelector("main");
    main.replaceChildren();
    const turn = context.dom.window.document.createElement("div");
    const wrapper = context.dom.window.document.createElement("div");
    const marker = context.dom.window.document.createElement("h4");
    marker.className = "sr-only";
    marker.textContent = "你说：";
    wrapper.appendChild(marker);
    turn.append(wrapper, context.dom.window.document.createTextNode("多租户定时任务调度"));
    Object.defineProperty(turn, "innerText", {
      configurable: true,
      value: "你说：多租户定时任务调度"
    });
    turn.getBoundingClientRect = () => ({
      top: 100,
      bottom: 260,
      left: 100,
      right: 700,
      width: 600,
      height: 160
    });
    main.appendChild(turn);

    const item = context.adapter.getDomQuestionItems()[0];
    assert.equal(item.element, turn);
    assert.equal(item.fullText, "多租户定时任务调度");
    assert.equal(
      context.adapter.findMessageElement(null, { fullText: item.fullText }),
      turn
    );
  } finally {
    context.cleanup();
  }
});

test("正文换行被新版 DOM 合并为空格时仍可按全文定位", () => {
  const context = installDom();
  try {
    const main = context.dom.window.document.querySelector("main");
    main.replaceChildren();
    const turn = context.dom.window.document.createElement("div");
    const marker = context.dom.window.document.createElement("h4");
    marker.className = "sr-only";
    marker.textContent = "你说：";
    turn.append(marker);
    Object.defineProperty(turn, "innerText", {
      configurable: true,
      value: "你说：第一行 第二行"
    });
    turn.getBoundingClientRect = () => ({
      top: 100,
      bottom: 260,
      left: 100,
      right: 700,
      width: 600,
      height: 160
    });
    main.appendChild(turn);

    assert.equal(
      context.adapter.findMessageElement(null, {
        fullText: "第一行\n第二行"
      }),
      turn
    );
  } finally {
    context.cleanup();
  }
});

test("新版无障碍标题位于带消息 ID 的轮次内时保留宿主消息 ID", () => {
  const context = installDom();
  try {
    const main = context.dom.window.document.querySelector("main");
    main.replaceChildren();
    const article = context.dom.window.document.createElement("article");
    article.setAttribute("data-message-id", "host-message");
    const marker = context.dom.window.document.createElement("h4");
    marker.className = "sr-only";
    marker.textContent = "你说：";
    const body = context.dom.window.document.createElement("div");
    body.textContent = "保留消息 ID";
    article.append(marker, body);
    Object.defineProperty(article, "innerText", {
      configurable: true,
      value: "你说：保留消息 ID"
    });
    article.getBoundingClientRect = () => ({
      top: 100,
      bottom: 260,
      left: 100,
      right: 700,
      width: 600,
      height: 160
    });
    main.appendChild(article);

    const item = context.adapter.getDomQuestionItems()[0];
    assert.equal(item.messageId, "host-message");
    assert.equal(item.element, article);
  } finally {
    context.cleanup();
  }
});

test("根据消息 ID 查找完整轮次并排除扩展节点", () => {
  const context = installDom();
  try {
    const outside = context.dom.window.document.createElement("article");
    outside.setAttribute("data-message-id", "outside-message");
    context.dom.window.document.body.appendChild(outside);
    const hidden = context.dom.window.document.createElement("article");
    hidden.setAttribute("data-message-id", "hidden-message");
    hidden.getBoundingClientRect = () => ({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
      width: 0,
      height: 0
    });
    context.dom.window.document.querySelector("main").appendChild(hidden);

    assert.equal(
      context.adapter.findMessageElement("message-user-1").tagName,
      "ARTICLE"
    );
    assert.equal(context.adapter.findMessageElement("outside-message"), null);
    assert.equal(
      context.adapter.findMessageElement("hidden-message"),
      hidden
    );
    assert.deepEqual(
      context.adapter.getRenderedMessageEntries().map((entry) => entry.messageId),
      ["message-user-1"]
    );
  } finally {
    context.cleanup();
  }
});

test("仅助手渲染窗口变化不会触发问题目录刷新", async () => {
  const context = installDom();
  try {
    let callbackCount = 0;
    const stop = context.adapter.observeQuestions(() => {
      callbackCount += 1;
    });
    const assistant = context.dom.window.document.createElement("article");
    assistant.setAttribute("data-message-id", "message-assistant-2");
    assistant.getBoundingClientRect = () => ({
      top: 300,
      bottom: 500,
      left: 100,
      right: 700,
      width: 600,
      height: 200
    });
    context.dom.window.document.querySelector("main").appendChild(assistant);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    assert.equal(callbackCount, 0);
  } finally {
    context.cleanup();
  }
});

test("分支按钮交互会触发会话接口刷新信号", () => {
  const context = installDom();
  try {
    let callbackCount = 0;
    const stop = context.adapter.observeConversationRefreshTriggers(() => {
      callbackCount += 1;
    });
    const button = context.dom.window.document.createElement("button");
    button.setAttribute("aria-label", "Next response");
    context.dom.window.document.body.appendChild(button);
    button.dispatchEvent(
      new context.dom.window.MouseEvent("click", { bubbles: true })
    );
    stop();
    assert.equal(callbackCount, 1);
  } finally {
    context.cleanup();
  }
});

test("滚动指标、增量滚动和比例滚动使用同一容器", () => {
  const context = installDom();
  try {
    assert.deepEqual(context.adapter.getScrollMetrics(), {
      top: 400,
      maxTop: 2000,
      clientHeight: 500
    });

    assert.equal(context.adapter.scrollByAmount(300), true);
    assert.equal(context.scroll.scrollTop, 700);
    context.adapter.scrollToRatio(2);
    assert.equal(context.scroll.scrollTop, 2000);
    context.adapter.scrollToRatio(-1);
    assert.equal(context.scroll.scrollTop, 0);
  } finally {
    context.cleanup();
  }
});

test("DOM 变化会结束一次性渲染等待", async () => {
  const context = installDom();
  try {
    const waiting = context.adapter.waitForMessageRender({ timeoutMs: 100 });
    const node = context.dom.window.document.createElement("div");
    context.dom.window.document.querySelector("main").appendChild(node);
    assert.equal(await waiting, "mutation");
  } finally {
    context.cleanup();
  }
});

test("目标等待忽略无关 DOM 变化并在目标消息挂载后结束", async () => {
  const context = installDom();
  try {
    const waiting = context.adapter.waitForMessageRender({
      targetMessageId: "message-target",
      previousMessageIds: ["message-user-1"],
      timeoutMs: 100
    });
    const unrelated = context.dom.window.document.createElement("div");
    context.dom.window.document.querySelector("main").appendChild(unrelated);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const target = context.dom.window.document.createElement("article");
    target.setAttribute("data-message-id", "message-target");
    context.dom.window.document.querySelector("main").appendChild(target);

    assert.equal(await waiting, "target");
  } finally {
    context.cleanup();
  }
});

test("消息变化后保留最短稳定窗口再结束等待", async () => {
  const context = installDom();
  try {
    const startedAt = Date.now();
    const waiting = context.adapter.waitForMessageRender({
      previousMessageIds: ["message-user-1"],
      minSettleMs: 30,
      timeoutMs: 100
    });
    const message = context.dom.window.document.createElement("article");
    message.setAttribute("data-message-id", "message-new");
    context.dom.window.document.querySelector("main").appendChild(message);

    assert.equal(await waiting, "messages");
    assert.equal(Date.now() - startedAt >= 20, true);
  } finally {
    context.cleanup();
  }
});

test("取消信号会终止渲染等待", async () => {
  const context = installDom();
  try {
    const controller = new AbortController();
    const waiting = context.adapter.waitForMessageRender({
      signal: controller.signal,
      timeoutMs: 100
    });
    controller.abort(new DOMException("取消", "AbortError"));
    await assert.rejects(waiting, { name: "AbortError" });
  } finally {
    context.cleanup();
  }
});
