const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { loadScript, resetHelper } = require("./helpers/load-script");

function installSidebar() {
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const dom = new JSDOM("<!doctype html><body></body>");
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  resetHelper();
  const api = loadScript("src/content/sidebar.js").sidebar;
  const view = api.mount(dom.window.document.body, { onSelect() {} });

  function cleanup() {
    resetHelper();
    dom.window.close();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }

  return { dom, view, cleanup };
}

function question(id = "question-1") {
  return { id, title: "第一个问题" };
}

test("侧栏显示定位状态且不禁用问题按钮", () => {
  const context = installSidebar();
  try {
    const item = question();
    context.view.render([item], item.id, {
      kind: "navigating",
      message: "正在定位…"
    });

    const root = context.dom.window.document.querySelector(
      ".chatgpt-helper-sidebar"
    );
    assert.equal(root.dataset.status, "navigating");
    assert.equal(
      root.querySelector(".chatgpt-helper-sidebar__status").textContent,
      "正在定位…"
    );
    assert.equal(root.querySelector("[data-question-id]").disabled, false);
  } finally {
    context.cleanup();
  }
});

test("ready 状态隐藏空状态区域", () => {
  const context = installSidebar();
  try {
    context.view.render([question()], null, { kind: "ready", message: "" });
    const status = context.dom.window.document.querySelector(
      ".chatgpt-helper-sidebar__status"
    );
    assert.equal(status.hidden, true);
  } finally {
    context.cleanup();
  }
});

test("状态消息以纯文本插入", () => {
  const context = installSidebar();
  try {
    const unsafeText = "<img src=x onerror=alert(1)>";
    context.view.render([question()], null, {
      kind: "degraded",
      message: unsafeText
    });
    const status = context.dom.window.document.querySelector(
      ".chatgpt-helper-sidebar__status"
    );
    assert.equal(status.textContent, unsafeText);
    assert.equal(status.querySelector("img"), null);
  } finally {
    context.cleanup();
  }
});

test("没有问题时保持原有隐藏行为", () => {
  const context = installSidebar();
  try {
    context.view.render([], null, {
      kind: "loading",
      message: "正在同步完整目录…"
    });
    const root = context.dom.window.document.querySelector(
      ".chatgpt-helper-sidebar"
    );
    assert.equal(root.dataset.visible, "false");
  } finally {
    context.cleanup();
  }
});
