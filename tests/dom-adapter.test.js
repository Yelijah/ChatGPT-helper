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

test("根据消息 ID 查找完整轮次并排除扩展节点", () => {
  const context = installDom();
  try {
    assert.equal(
      context.adapter.findMessageElement("message-user-1").tagName,
      "ARTICLE"
    );
    assert.deepEqual(
      context.adapter.getRenderedMessageEntries().map((entry) => entry.messageId),
      ["message-user-1"]
    );
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
