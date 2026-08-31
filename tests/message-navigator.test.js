const test = require("node:test");
const assert = require("node:assert/strict");
const { loadScript, resetHelper } = require("./helpers/load-script");

function loadNavigator() {
  resetHelper();
  return loadScript("src/content/message-navigator.js").messageNavigator;
}

function createBranch() {
  return [
    { messageId: "m0", branchIndex: 0 },
    { messageId: "m1", branchIndex: 1 },
    { messageId: "m2", branchIndex: 2 },
    { messageId: "m3", branchIndex: 3 }
  ];
}

function createAdapter(renderedIds = []) {
  const state = {
    renderedIds: [...renderedIds],
    top: 500,
    maxTop: 2000,
    clientHeight: 500,
    calls: [],
    waitCount: 0,
    waitOptions: [],
    onWait: null
  };

  return {
    state,
    findMessageElement(id) {
      return state.renderedIds.includes(id) ? { id } : null;
    },
    getRenderedMessageEntries() {
      return state.renderedIds.map((messageId) => ({
        messageId,
        element: { id: messageId }
      }));
    },
    getScrollMetrics() {
      return {
        top: state.top,
        maxTop: state.maxTop,
        clientHeight: state.clientHeight
      };
    },
    scrollByAmount(delta) {
      state.calls.push(["scrollByAmount", delta]);
      state.top = Math.min(Math.max(state.top + delta, 0), state.maxTop);
    },
    scrollToRatio(ratio) {
      state.calls.push(["scrollToRatio", ratio]);
      state.top = state.maxTop * ratio;
    },
    async waitForMessageRender(options) {
      state.waitCount += 1;
      state.waitOptions.push(options);
      await state.onWait?.(state.waitCount, options);
    },
    scrollToMessageElement(element) {
      state.calls.push(["scrollToMessageElement", element.id]);
      return true;
    }
  };
}

test("目标已经渲染时直接定位", async () => {
  const navigator = loadNavigator();
  const adapter = createAdapter(["m1"]);
  const result = await navigator.navigateToMessage({
    branch: createBranch(),
    target: { messageId: "m1", branchIndex: 1 },
    adapter
  });

  assert.equal(result.status, "found");
  assert.deepEqual(adapter.state.calls, [["scrollToMessageElement", "m1"]]);
});

test("待同步项携带现成元素时无需消息 ID", async () => {
  const navigator = loadNavigator();
  const adapter = createAdapter();
  const element = { id: "pending-element" };
  const result = await navigator.navigateToMessage({
    branch: createBranch(),
    target: { messageId: null, branchIndex: null, element },
    adapter
  });

  assert.equal(result.status, "found");
  assert.deepEqual(adapter.state.calls, [
    ["scrollToMessageElement", "pending-element"]
  ]);
});

test("目标位于最近锚点之前时向上滚动", async () => {
  const navigator = loadNavigator();
  const adapter = createAdapter(["m2"]);
  adapter.state.onWait = () => {
    adapter.state.renderedIds.push("m0");
  };

  const result = await navigator.navigateToMessage({
    branch: createBranch(),
    target: { messageId: "m0", branchIndex: 0 },
    adapter
  });

  assert.equal(result.status, "found");
  assert.equal(adapter.state.calls[0][0], "scrollByAmount");
  assert.equal(adapter.state.calls[0][1] < 0, true);
});

test("目标位于最近锚点之后时向下滚动", async () => {
  const navigator = loadNavigator();
  const adapter = createAdapter(["m1"]);
  adapter.state.onWait = () => {
    adapter.state.renderedIds.push("m3");
  };

  const result = await navigator.navigateToMessage({
    branch: createBranch(),
    target: { messageId: "m3", branchIndex: 3 },
    adapter
  });

  assert.equal(result.status, "found");
  assert.equal(adapter.state.calls[0][1] > 0, true);
});

test("目标距离锚点较远时按距离增大滚动步长", async () => {
  const navigator = loadNavigator();
  const branch = Array.from({ length: 40 }, (_, index) => ({
    messageId: `m${index}`,
    branchIndex: index
  }));
  const adapter = createAdapter(["m39"]);
  adapter.state.onWait = () => {
    adapter.state.renderedIds.push("m0");
  };

  const result = await navigator.navigateToMessage({
    branch,
    target: { messageId: "m0", branchIndex: 0 },
    adapter
  });

  assert.equal(result.status, "found");
  assert.equal(adapter.state.calls[0][1], -1600);
});

test("等待宿主渲染时传递目标消息与当前消息集合", async () => {
  const navigator = loadNavigator();
  const adapter = createAdapter(["m1"]);
  adapter.state.onWait = (_count, options) => {
    if (
      options.targetMessageId === "m3" &&
      options.previousMessageIds.includes("m1")
    ) {
      adapter.state.renderedIds.push("m3");
    }
  };

  const result = await navigator.navigateToMessage({
    branch: createBranch(),
    target: { messageId: "m3", branchIndex: 3 },
    adapter
  });

  assert.equal(result.status, "found");
  assert.equal(adapter.state.waitOptions[0].minSettleMs, 120);
});

test("边界处连续加载多批消息时重置无进展计时并继续定位", async () => {
  const navigator = loadNavigator();
  const branch = Array.from({ length: 20 }, (_, index) => ({
    messageId: `m${index}`,
    branchIndex: index
  }));
  const adapter = createAdapter(["m19"]);
  adapter.state.top = 0;
  let clock = 0;
  adapter.state.onWait = (count) => {
    clock += 1000;
    adapter.state.renderedIds = [count < 4 ? `m${19 - count * 4}` : "m0"];
    return "messages";
  };

  const result = await navigator.navigateToMessage({
    branch,
    target: { messageId: "m0", branchIndex: 0 },
    adapter,
    timeoutMs: 10000,
    now: () => clock
  });

  assert.equal(result.status, "found");
  assert.equal(adapter.state.waitCount, 4);
});

test("没有已知锚点时按分支比例首次定位", async () => {
  const navigator = loadNavigator();
  const adapter = createAdapter();
  adapter.state.onWait = () => {
    adapter.state.renderedIds.push("m2");
  };

  const result = await navigator.navigateToMessage({
    branch: createBranch(),
    target: { messageId: "m2", branchIndex: 2 },
    adapter
  });

  assert.equal(result.status, "found");
  assert.deepEqual(adapter.state.calls[0], ["scrollToRatio", 2 / 3]);
});

test("滚动边界持续无加载进展后返回受控未渲染状态", async () => {
  const navigator = loadNavigator();
  const adapter = createAdapter(["m2"]);
  adapter.state.top = 0;
  const result = await navigator.navigateToMessage({
    branch: createBranch(),
    target: { messageId: "m0", branchIndex: 0 },
    adapter,
    timeoutMs: 100,
    boundaryIdleMs: 3,
    now: (() => {
      let value = 0;
      return () => (value += 1);
    })()
  });

  assert.equal(result.status, "not-rendered");
  assert.equal(adapter.state.waitCount, 1);
});

test("总时限到达后停止没有锚点的定位", async () => {
  const navigator = loadNavigator();
  const adapter = createAdapter();
  let now = 0;
  const result = await navigator.navigateToMessage({
    branch: createBranch(),
    target: { messageId: "m2", branchIndex: 2 },
    adapter,
    timeoutMs: 10,
    now: () => (now += 3)
  });

  assert.equal(result.status, "not-rendered");
  assert.equal(adapter.state.waitCount > 0, true);
});

test("取消信号会终止定位", async () => {
  const navigator = loadNavigator();
  const adapter = createAdapter(["m1"]);
  const controller = new AbortController();
  adapter.state.onWait = () => {
    controller.abort(new DOMException("取消", "AbortError"));
  };

  await assert.rejects(
    navigator.navigateToMessage({
      branch: createBranch(),
      target: { messageId: "m3", branchIndex: 3 },
      adapter,
      signal: controller.signal
    }),
    { name: "AbortError" }
  );
});
