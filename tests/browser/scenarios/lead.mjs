// Probes owned by the Lead: integration-level checks that cut across owners, and
// the final regression assertions for the bugs fixed in this round.
// 划词之后气泡不一定立刻在：开页收尾时版面重建一次文本层，重建会把选区一起带走。
// 这是 harness 的时序，不是产品行为 —— 每次划完都等一下，最多重划三次。
const pickWord = async (selectSpan, spans, until, settle) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const span = spans()[0];
    if (span === undefined) {
      await settle(200);
      continue;
    }
    selectSpan(span);
    if (await until(() => document.querySelector("#host .fp-chip") !== null, 1500)) return true;
    await settle(300);
  }
  return false;
};
export default {
  // 卡片钉住之后再划词、按气泡复用同一张卡：钉住是读者的决定，复用一次不能
  // 把它悄悄取消掉，也不能把卡片挪到新选区那儿去（README 里那句「原地填成新内容」）。
  "lead-pin-reuse": async ({ note, until, settle, click, all, DICT, selectSpan, spans }) => {
    await until(() => spans().length > 0, 15000);
    const pin = () => document.querySelector("#host .fp-pick .fp-pin");
    const card = () => document.querySelector("#host .fp-pick");
    const box = () => {
      const rect = card()?.getBoundingClientRect();
      return rect === undefined ? "none" : [rect.left, rect.top, rect.width, rect.height].map(Math.round).join(",");
    };

    // 1. 一次正常的翻译，然后把卡片钉住。
    await pickWord(selectSpan, spans, until, settle);
    await until(() => document.querySelector("#host .fp-chip") !== null, 4000);
    click(DICT.translate);
    await until(() => (card()?.getAttribute("data-status") ?? "") === "done", 20000);
    const pinnedAnchor = box();
    pin().click();
    await settle(400);
    note("pinnedBefore", card()?.hasAttribute("data-pinned") === true);
    note("pinPressedBefore", pin()?.getAttribute("aria-pressed"));
    note("pinLabelBefore", pin()?.getAttribute("aria-label"));
    note("anchorWhenPinned", pinnedAnchor);

    // 2. 再划一次词：气泡照常出现，按它复用同一张卡。
    const target = spans()[spans().length - 1];
    selectSpan(target);
    await until(() => document.querySelector("#host .fp-chip") !== null, 4000);
    note("chipWhilePinned", document.querySelector("#host .fp-chip") !== null);
    click(DICT.translate);
    await until(() => (card()?.getAttribute("data-status") ?? "") === "done", 20000);
    await settle(300);

    // 3. 钉住是读者的决定：卡片数量、钉住标记、图钉状态、卡片位置都不该变。
    note("cardsAfterReuse", all("#host .fp-pick").length);
    note("pinnedAfterReuse", card()?.hasAttribute("data-pinned") === true);
    note("pinPressedAfterReuse", pin()?.getAttribute("aria-pressed"));
    note("pinLabelAfterReuse", pin()?.getAttribute("aria-label"));
    note("anchorAfterReuse", box());
    note("cardStayedPut", box() === pinnedAnchor);
  },

  // Escape 收起气泡之后，它不该自己回来。`onUp` 挂在 frame 的 mouseup **和** keyup
  // 上，而 Escape 是一次按键：keydown 收气泡，紧跟着的 keyup 又把同一段选区读一遍。
  "lead-escape-chip": async ({ note, until, settle, selectSpan, spans }) => {
    await until(() => spans().length > 0, 15000);
    const chip = () => document.querySelector("#host .fp-chip");
    const frame = () => document.querySelector("#host .fp-frame");
    const selected = () => {
      const selection = window.getSelection();
      return selection === null ? "none" : `${selection.isCollapsed ? "collapsed" : "range"}:${selection.toString().trim().length}`;
    };

    await pickWord(selectSpan, spans, until, settle);
    note("chipBefore", await until(() => chip() !== null, 4000));
    note("selectionBefore", selected());
    // 真实拖动会把焦点落到页面上（frame 是 `tabIndex={-1}`），面板自己的按键处理
    // 靠的正是这个焦点；合成选区不会移动焦点，所以这里补上这一步。
    frame().focus();
    note("focusBefore", document.activeElement?.className ?? "-");

    frame().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(300);
    note("chipAfterKeydown", chip() !== null);
    frame().dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(400);
    note("chipAfterFullPress", chip() !== null);
    note("selectionAfter", selected());
  },

  // 上一轮那条修复（复用卡片时把 pinned 带过去）的爆炸半径：没钉住的卡复用之后
  // 必须**还是**跟着新选区走，取消固定之后也必须重新跟着走，关闭之后新开的卡
  // 必须是未钉住的。少一格都可能把「钉住」变成一种关不掉的状态。
  "lead-pin-cycle": async ({ note, until, settle, click, DICT, selectSpan, spans }) => {
    await until(() => spans().length > 0, 15000);
    const pin = () => document.querySelector("#host .fp-pick .fp-pin");
    const card = () => document.querySelector("#host .fp-pick");
    const at = () => {
      const rect = card()?.getBoundingClientRect();
      return rect === undefined ? "none" : [Math.round(rect.left), Math.round(rect.top)].join(",");
    };
    const open = async (index) => {
      selectSpan(spans()[index]);
      await until(() => document.querySelector("#host .fp-chip") !== null, 4000);
      click(DICT.translate);
      await until(() => (card()?.getAttribute("data-status") ?? "") === "done", 20000);
      await settle(250);
    };

    // 第一张卡：不钉，复用一次，必须跟着新选区搬家。
    await open(0);
    const loose = at();
    await open(spans().length - 1);
    const looseAfter = at();
    note("looseCardMoved", loose !== looseAfter);
    note("looseStayedUnpinned", card()?.hasAttribute("data-pinned") !== true);

    // 钉住 → 取消固定 → 再复用一次，必须重新跟着走。
    pin().click();
    await settle(300);
    const pinned = at();
    pin().click();
    await settle(300);
    note("unpinnedPressed", pin()?.getAttribute("aria-pressed"));
    note("unpinnedCardStillThere", at() === pinned);
    await open(0);
    note("afterUnpinReuseMoved", at() !== pinned);

    // 关闭之后新开的卡：未钉住、图钉是「固定」那个字。
    const closeBtn = [...document.querySelectorAll("#host .fp-pick-head button")]
      .find((button) => button.getAttribute("aria-label") === DICT.close);
    closeBtn?.click();
    await settle(300);
    note("cardClosed", card() === null);
    await open(spans().length - 1);
    note("newCardUnpinned", card()?.hasAttribute("data-pinned") !== true);
    note("newCardPinLabel", pin()?.getAttribute("aria-label"));
    note("newCardPinPressed", pin()?.getAttribute("aria-pressed"));
  },

  // 卡片里那些「像按钮但不是按钮」的东西：只量，不改 —— 它们是不是缺陷要看
  // 读者是否真的需要用它，这条留给交付表里的 UNSURE。
  "lead-card-a11y": async ({ note, until, settle, click, DICT, selectSpan, spans }) => {
    await until(() => spans().length > 0, 15000);
    const find = (selector) => document.querySelector(`#host ${selector}`);
    await pickWord(selectSpan, spans, until, settle);
    await until(() => find(".fp-chip") !== null, 4000);
    click(DICT.translate);
    await until(() => (find(".fp-pick")?.getAttribute("data-status") ?? "") === "done", 20000);
    await settle(250);

    const source = find(".fp-pick-source");
    note("sourceTag", source?.tagName ?? "-");
    note("sourceTabIndex", source?.getAttribute("tabindex"));
    note("sourceRole", source?.getAttribute("role"));
    note("sourceTitle", source?.getAttribute("title"));
    const foot = [...document.querySelectorAll("#host .fp-pick-foot button")]
      .map((button) => `${button.textContent}|aria-label=${button.getAttribute("aria-label")}|title=${button.getAttribute("title")}`);
    note("footButtons", foot.join(" + "));
    const tabbables = [...document.querySelectorAll("#host .fp-pick button, #host .fp-pick [tabindex], #host .fp-pick a[href]")]
      .map((node) => node.getAttribute("aria-label") ?? node.textContent.trim().slice(0, 8));
    note("cardTabbables", tabbables.join(","));
    note("cardReachableCount", tabbables.length);
  },

  // 缩放下限/上限：到了地板还能按、按下去什么都不发生 —— 按钮该不该置灰。
  "lead-zoom-floor": async ({ note, until, settle, all, text, DICT }) => {
    await until(() => (text("#host .fp-zoom-count") ?? "") !== "", 15000);
    const button = (title) => all("#host button").find((b) => b.getAttribute("aria-label") === title);
    const readout = () => (text("#host .fp-zoom-count") ?? "").trim();
    const pressUntilStuck = async (title) => {
      let last = readout();
      for (let i = 0; i < 26; i += 1) {
        const node = button(title);
        if (node === undefined) return { stopped: "missing", seen: last };
        if (node.disabled === true) return { stopped: "disabled", seen: last };
        node.click();
        await settle(130);
        const now = readout();
        if (now === last) return { stopped: "stuck", seen: last, next: now };
        last = now;
      }
      return { stopped: "stillMoving", seen: last };
    };
    note("zoomAtOpen", readout());
    const down = await pressUntilStuck(DICT.zoomOut);
    note("zoomFloor", down.seen);
    note("zoomOutStoppedBy", down.stopped);
    note("zoomOutDisabledAtFloor", button(DICT.zoomOut)?.disabled === true);
    note("zoomOutAriaDisabledAtFloor", button(DICT.zoomOut)?.getAttribute("aria-disabled"));
    const up = await pressUntilStuck(DICT.zoomIn);
    note("zoomCeiling", up.seen);
    note("zoomInStoppedBy", up.stopped);
    note("zoomInDisabledAtCeiling", button(DICT.zoomIn)?.disabled === true);
  },

  // 窄面板下查找栏：输入框还剩多少能用 —— 挤到 36px 就等于打进去看不见。
  "lead-find-narrow": async ({ note, until, settle, click, text, DICT }) => {
    await until(() => document.querySelector("#host .fp-frame") !== null, 15000);
    await settle(300);
    click(DICT.find);
    await until(() => document.querySelector("#host .fp-find-input") !== null, 5000);
    await settle(250);
    const input = () => document.querySelector("#host .fp-find-input")?.getBoundingClientRect();
    const bar = () => document.querySelector("#host .fp-findbar")?.getBoundingClientRect();
    const box = (rect) => (rect === undefined ? "none" : `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    const kids = [...document.querySelectorAll("#host .fp-findbar > *")];
    const tops = [...new Set(kids.map((node) => Math.round(node.getBoundingClientRect().top)))];
    const barRect = bar();
    note("findbarBox", box(barRect));
    note("findInputBox", box(input()));
    note("findInputWidth", Math.round(input()?.width ?? 0));
    note("findbarRowTops", tops.join(","));
    note("findbarRows", tops.length);
    note("findbarClipped", kids.filter((node) => {
      const r = node.getBoundingClientRect();
      return barRect !== undefined && (r.right > barRect.right + 1 || r.left < barRect.left - 1 || r.bottom > barRect.bottom + 1);
    }).map((node) => (node.getAttribute("aria-label") ?? node.className)).join(",") || "none");
    const frame = document.querySelector("#host .fp-frame");
    note("frameScrollW", `${frame?.scrollWidth}/${frame?.clientWidth}`);
    const field = document.querySelector("#host .fp-find-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(field, "Page");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await settle(900);
    note("typedCount", text("#host .fp-find-count"));
    note("typedInputValue", field.value);
  },

  // 卡片上那两颗图标：图钉两态是不是同一张图（只差填充），以及左侧原文块
  // 收起来时是不是正好切在行边界上 —— 半行露头是「像 bug 的排版」。
  "lead-card-glyphs": async ({ note, until, settle, click, DICT, selectSpan, spans }) => {
    await until(() => spans().length > 0, 15000);
    const find = (selector) => document.querySelector(`#host ${selector}`);
    // A selection that spans several lines: a one-line selection cannot show
    // whether the collapsed source block cuts a line in half.
    const list = spans();
    const range = document.createRange();
    const firstNode = list[0].firstChild ?? list[0];
    const tail = list[Math.min(5, list.length - 1)];
    range.setStart(firstNode, 0);
    range.setEnd(tail.firstChild ?? tail, (tail.textContent ?? "").length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
        const box0 = list[0].getBoundingClientRect();
        document.querySelector("#host .fp-frame")?.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true,
          clientX: Math.round(box0.right - 2),
          clientY: Math.round(box0.top + box0.height / 2),
        }));
    await until(() => find(".fp-chip") !== null, 4000);
    click(DICT.translate);
    await until(() => (find(".fp-pick")?.getAttribute("data-status") ?? "") === "done", 20000);
    await settle(250);

    const headerGlyphs = () => [...document.querySelectorAll("#host .fp-pick-head button svg path")]
      .map((path) => `${path.getAttribute("fill")}|${path.getAttribute("d")}`);
    const pinButton = () => [...document.querySelectorAll("#host .fp-pick-head button")]
      .find((button) => (button.getAttribute("aria-label") ?? "") === DICT.pin
        || (button.getAttribute("aria-label") ?? "") === DICT.unpin);

    const glyphOf = (list) => {
      const first = list[0] ?? "|";
      return { fill: first.split("|")[0], d: first.split("|")[1] ?? "" };
    };
    const before = glyphOf(headerGlyphs());
    note("pinLabelBeforeClick", pinButton()?.getAttribute("aria-label"));
    note("pinPressedBefore", pinButton()?.getAttribute("aria-pressed"));
    note("pinFillBefore", before.fill);
    note("pinPathBefore", before.d);
    pinButton()?.click();
    await settle(300);
    const after = glyphOf(headerGlyphs());
    note("pinLabelAfterClick", pinButton()?.getAttribute("aria-label"));
    note("pinPressedAfter", pinButton()?.getAttribute("aria-pressed"));
    note("pinFillAfter", after.fill);
    note("pinPathAfter", after.d);
    // 两态必须是同一张图（只差填充），否则「钉住」前后换的是另一个意思的图标。
    note("pinOneSilhouette", before.d === after.d);
    note("pinOnlyFillChanges", before.d === after.d && before.fill !== after.fill);

    // 原文块：收起状态下一共露出几行、最后一行的下沿有没有被切。
    const source = find(".fp-pick-source");
    const style = source === null ? null : getComputedStyle(source);
    if (source !== null && style !== null) {
      const rect = source.getBoundingClientRect();
      const line = Number.parseFloat(style.lineHeight);
      const padTop = Number.parseFloat(style.paddingTop);
      const padBottom = Number.parseFloat(style.paddingBottom);
      const inner = rect.height - padTop - padBottom;
      note("sourceBoxH", Math.round(rect.height));
      note("sourceLineH", Math.round(line * 100) / 100);
      note("sourceInnerH", Math.round(inner * 100) / 100);
      note("sourceLinesShown", Math.round((inner / line) * 100) / 100);
      note("sourcePartialLine", Math.abs(inner / line - Math.round(inner / line)) > 0.02);
      note("sourceCutPx", Math.round((inner % line) * 100) / 100);
      note("sourceScrollOver", `${source.scrollHeight - source.clientHeight}`);
    }
  },
  // ①③④⑦⑧：卡片能拉多大、光标在哪、滚动与点击分别该不该关。
  "lead-card-drag": async ({ note, until, settle, click, spans }) => {
    await until(() => spans().length > 0, 15000);
    const find = (selector) => document.querySelector(`#host ${selector}`);
    const list = spans();
    const range = document.createRange();
    range.setStart(list[0].firstChild ?? list[0], 0);
    const tail = list[Math.min(5, list.length - 1)];
    range.setEnd(tail.firstChild ?? tail, (tail.textContent ?? "").length);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
        const box0 = list[0].getBoundingClientRect();
        document.querySelector("#host .fp-frame")?.dispatchEvent(new MouseEvent("mouseup", {
          bubbles: true,
          clientX: Math.round(box0.right - 2),
          clientY: Math.round(box0.top + box0.height / 2),
        }));
    await until(() => find(".fp-chip") !== null, 4000);
    click("翻译");
    await until(() => (find(".fp-pick")?.getAttribute("data-status") ?? "") === "done", 20000);
    await settle(300);

    const card = () => find(".fp-pick-card");
    const head = () => find(".fp-pick-head");
    const root = () => find(".fp-root");
    const box = (node) => {
      if (node === null) return "none";
      const r = node.getBoundingClientRect();
      return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    };
    const cursorOf = (node) => (node === null ? "none" : getComputedStyle(node).cursor);
    const pointer = (type, target, x, y) => target.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
    }));

    note("cardStart", box(card()));
    note("paneBox", box(root()));
    note("cursorHeadUnpinned", cursorOf(head()));

    const pinButton = [...document.querySelectorAll("#host .fp-pick-head button")]
      .find((button) => ["固定这个翻译", "取消固定"].includes(button.getAttribute("aria-label") ?? ""));
    pinButton?.click();
    await settle(250);
    note("pinnedAttr", find(".fp-pick")?.hasAttribute("data-pinned") === true);
    note("cursorHeadPinned", cursorOf(head()));

    // ③ hover: which cursor does each part wear
    const r0 = card().getBoundingClientRect();
    pointer("pointermove", card(), r0.right - 2, r0.top + r0.height / 2);
    await settle(60);
    note("cursorOnRightEdge", cursorOf(card()));
    note("cursorOnRightEdgeHead", cursorOf(head()));
    pointer("pointermove", card(), r0.right - 2, r0.bottom - 2);
    await settle(60);
    note("cursorOnCorner", cursorOf(card()));
    pointer("pointermove", card(), r0.left + r0.width / 2, r0.top + 20);
    await settle(60);
    note("cursorOnHead", cursorOf(head()));

    // ① growth: drag the bottom-right corner far past the pane
    pointer("pointerdown", card(), r0.right - 2, r0.bottom - 2);
    await settle(40);
    note("resizingAttr", root()?.hasAttribute("data-resizing") === true);
    note("edgeCursorVar", (getComputedStyle(root()).getPropertyValue("--fp-edge-cursor") ?? "").trim());
    pointer("pointermove", window, r0.right + 2000, r0.bottom + 2000);
    await settle(90);
    const grown = card().getBoundingClientRect();
    note("grownW", Math.round(grown.width));
    note("grownH", Math.round(grown.height));
    note("grownInsidePane", grown.right <= root().getBoundingClientRect().right + 1
      && grown.bottom <= root().getBoundingClientRect().bottom + 1);
    pointer("pointerup", window, r0.right + 2000, r0.bottom + 2000);
    await settle(90);
    note("resizingAttrAfter", root()?.hasAttribute("data-resizing") === true);

    // ① floor: drag the same corner back to the top-left
    const r1 = card().getBoundingClientRect();
    pointer("pointerdown", card(), r1.right - 2, r1.bottom - 2);
    pointer("pointermove", window, r1.left + 2, r1.top + 2);
    await settle(90);
    const shrunk = card().getBoundingClientRect();
    note("shrunkW", Math.round(shrunk.width));
    note("shrunkH", Math.round(shrunk.height));
    pointer("pointerup", window, r1.left + 2, r1.top + 2);
    await settle(90);
    const after = card().getBoundingClientRect();
    const pane = root().getBoundingClientRect();
    note("cardInsidePane", after.left >= pane.left - 1 && after.right <= pane.right + 1
      && after.top >= pane.top - 1 && after.bottom <= pane.bottom + 1);
    note("cardTopLeftStill", `${Math.round(after.left)},${Math.round(after.top)}`);

    // ⑦ a scroll keeps the card, a click on the page closes it — on the loose
    // card, which is the one the rule is about (a pinned card is dismissed by
    // its own 关闭 button, or by a page click once it is loose again).
    pinButton?.click();
    await settle(250);
    note("pinnedAfterUnpin", find(".fp-pick")?.hasAttribute("data-pinned") === true);
    const frame = find(".fp-frame");
    frame.scrollTo({ top: (frame.scrollTop ?? 0) + 260, behavior: "auto" });
    await settle(260);
    note("cardsAfterScroll", document.querySelectorAll("#host .fp-pick").length);
    const page = find(".fp-pages .page");
    page?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 240, clientY: 400 }));
    await settle(260);
    note("cardsAfterPageClick", document.querySelectorAll("#host .fp-pick").length);

    // ⑧ the outline column goes away on a click outside it
    const outlineButton = [...document.querySelectorAll("#host .fp-toolbar button")]
      .find((button) => (button.getAttribute("aria-label") ?? "") === "目录");
    outlineButton?.click();
    await settle(320);
    note("outlineOpen", find(".fp-outline") !== null);
    find(".fp-pages .page")?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 300, clientY: 500 }));
    await settle(320);
    note("outlineAfterBlankClick", find(".fp-outline") !== null);
    outlineButton?.click();
    await settle(320);
    note("outlineReopened", find(".fp-outline") !== null);
    find(".fp-outline-list button")?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    await settle(250);
    note("outlineAfterInsideClick", find(".fp-outline") !== null);
  },
  // ② 译文要「流式」出来：卡片一行一行自己长，而不是等整段答案回来才亮。
  // 服务端那侧的逐行答复由 harness 的 `&streamTranslate=1` 桩提供，这里量的是
  // 卡片真的在中途画出了不够长的文本、以及那个表示「还在来」的光标。
  "lead-stream": async ({ note, until, settle, click, DICT, selectSpan, spans }) => {
    await until(() => spans().length > 0, 15000);
    // 开页收尾时版面还会重建一次文本层，重建会把选区一起带走；等它定下来再划词，
    // 测的才是翻译那一段，而不是跟排版抢时间。
    await settle(600);
    const card = () => document.querySelector("#host .fp-pick");
    const body = () => document.querySelector("#host .fp-pick-text");
    const shown = () => (body()?.textContent ?? "").trim();

    selectSpan(spans()[0]);
    if (!(await until(() => document.querySelector("#host .fp-chip") !== null, 1500))) {
      selectSpan(spans()[0]);
      await until(() => document.querySelector("#host .fp-chip") !== null, 4000);
    }
    note("chipBeforeClick", document.querySelector("#host .fp-chip") === null ? "none" : "yes");
    const started = performance.now();
    click(DICT.translate);

    const lengths = [];
    let caretSeen = false;
    let firstPaintMs = -1;
    let doneMs = -1;
    // Sampled rather than awaited once: the point is what the card looked like
    // *while* the answer was arriving.
    while (performance.now() - started < 6000) {
      const length = shown().length;
      if (length > 0 && firstPaintMs < 0) firstPaintMs = Math.round(performance.now() - started);
      if (lengths.length === 0 || lengths[lengths.length - 1] !== length) lengths.push(length);
      if (body()?.querySelector(".translate-caret") != null) caretSeen = true;
      if ((card()?.getAttribute("data-status") ?? "") === "done") {
        doneMs = Math.round(performance.now() - started);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    let asked = null;
    try {
      asked = JSON.parse(window.__translateBody ?? "null");
    } catch {
      asked = "unparsed";
    }
    note("requestStream", asked?.stream === true);
    note("requestChars", typeof asked?.text === "string" ? asked.text.length : -1);
    note("statusAfter", card()?.getAttribute("data-status") ?? "-");
    note("firstPaintMs", firstPaintMs);
    note("doneMs", doneMs);
    note("steps", lengths.length);
    note("lengths", lengths.slice(0, 12).join(">"));
    // 中途至少要出现两档不同的长度，否则「流式」只是最后一次性塞进去。
    note("progressive", lengths.filter((length) => length > 0).length >= 2);
    note("caretDuringStream", caretSeen);
    note("caretAfterDone", body()?.querySelector(".translate-caret") != null);
    note("finalChars", shown().length);
    note("hasFoot", document.querySelector("#host .fp-pick-foot") !== null);
    note("tickCount", (window.__streamTicks ?? []).length);
    note("tickShown", (window.__streamTicks ?? []).map((tick) => tick.shown).join(","));
  },
  // ①：给「拉得有多大」留一张渲染图。
  //
  // 数值断言只说盒子在面板里，看不出卡片长成什么样；这条探针把卡片钉住、四条边
  // 一路拖到面板外，然后**停在那儿**，让驱动的收尾截图正好拍下最大的那张卡片。
  // 收尾之前再量一次盒子，读数和图对得上，谁也别单独说话。
  "lead-card-max": async ({ note, until, settle, click, spans, selectSpan }) => {
    await until(() => spans().length > 0, 15000);
    const find = (selector) => document.querySelector(`#host ${selector}`);
    await pickWord(selectSpan, spans, until, settle);
    click("翻译");
    await until(() => (find(".fp-pick")?.getAttribute("data-status") ?? "") === "done", 20000);
    await settle(250);
    const card = () => find(".fp-pick-card");
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), r: Math.round(r.right), b: Math.round(r.bottom) };
    };
    const pointer = (type, target, x, y) => target.dispatchEvent(new PointerEvent(type, {
      clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
    }));
    // 钉住，这样收尾截图时它不会被任何收尾动作关掉。
    [...document.querySelectorAll("#host .fp-pick-head button")]
      .find((button) => ["固定这个翻译", "取消固定"].includes(button.getAttribute("aria-label") ?? ""))
      ?.click();
    await settle(250);
    note("pinned", find(".fp-pick")?.hasAttribute("data-pinned") === true);

    const pane = box(find(".fp-root"));
    // 从右下角一路拖到面板外：一个远超面板的位移，看它停在哪。
    const start = box(card());
    note("start", `${start.w}x${start.h}`);
    pointer("pointerdown", card(), start.r - 2, start.b - 2);
    await settle(60);
    pointer("pointermove", window, start.r + 60, start.b + 60);
    await settle(80);
    pointer("pointermove", window, start.r + 900, start.b + 900);
    await settle(160);
    const huge = box(card());
    pointer("pointerup", window, start.r + 900, start.b + 900);
    await settle(160);
    const after = box(card());
    note("pane", `${pane.w}x${pane.h}`);
    note("grown", `${huge.w}x${huge.h}`);
    note("grownInsidePane", after.l >= pane.l - 1 && after.r <= pane.r + 1 && after.t >= pane.t - 1 && after.b <= pane.b + 1);
    note("maxWidthCap", huge.w <= 560);
    note("maxHeightCap", huge.h <= Math.round(pane.h * 0.85) + 1);
    note("closeButtonVisible", (() => {
      const shut = [...document.querySelectorAll("#host .fp-pick button")]
        .find((button) => (button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "").match(/关闭|close/i) !== null);
      if (!shut) return "missing";
      const b = box(shut);
      return b.l >= pane.l && b.r <= pane.r && b.t >= pane.t && b.b <= pane.b;
    })());

    // 脚部要贴在卡片底边，而不是跟着最后一行文字走。
    const foot = find(".fp-pick-foot");
    const footBox = foot === null ? null : box(foot);
    note("footGapToCardBottom", footBox === null ? "none" : after.b - footBox.b);
    note("footAtBottom", footBox !== null && after.b - footBox.b <= 12);
    // 复制是一个图标：名字在 aria-label 上，按一下换成勾。
    const copy = [...document.querySelectorAll("#host .fp-pick-foot button")]
      .find((button) => (button.getAttribute("aria-label") ?? "").match(/复制|Copied|copy/i) !== null);
    note("copyFound", copy !== undefined);
    note("copyLabel", copy?.getAttribute("aria-label") ?? "none");
    note("copyTextChars", (copy?.textContent ?? "").trim().length);
    note("copyHasGlyph", copy?.querySelector("svg") !== null);
    note("copyBox", copy === undefined ? "none" : `${Math.round(copy.getBoundingClientRect().width)}x${Math.round(copy.getBoundingClientRect().height)}`);
    copy?.click();
    await settle(300);
    note("copyLabelAfterClick", copy?.getAttribute("aria-label") ?? "none");
    note("copyTextAfterClick", (copy?.textContent ?? "").trim());
  },
  // ⑧：点目录条目之后高亮该落在谁身上，以及它什么时候交还给视口。
  "lead-outline-hold": async ({ note, until, settle, click }) => {
    await until(() => document.querySelector("#host .fp-canvas") !== null, 15000);
    click(DICT.outline);
    await until(() => document.querySelector("#host .fp-outline-list") !== null, 5000);
    await settle(250);
    const rows = () => [...document.querySelectorAll("#host .fp-outline-row")];
    const current = () => document.querySelector("#host .fp-outline-row[aria-current='location']")?.title ?? "none";
    const target = rows().find((row) => (row.title ?? "").startsWith("2.2.1"))
      ?? rows().find((row) => (row.title ?? "").startsWith("2.1.2"))
      ?? rows()[Math.min(3, rows().length - 1)];
    note("rows", rows().length);
    note("target", target?.title ?? "none");
    note("before", current());
    target.click();
    const samples = [];
    for (const wait of [0, 80, 200, 500, 1000]) {
      await settle(wait);
      samples.push(`${wait}:${current()}`);
    }
    note("samples", samples.join(" | "));
    note("labelAfterJump", pagesLabel());
    // 视口动到别的页之后，高亮要交还给规则本身。
    const frame = document.querySelector("#host .fp-frame");
    if (frame !== null) {
      frame.scrollTop = frame.scrollTop + frame.clientHeight * 1.5;
      frame.dispatchEvent(new Event("scroll"));
      await settle(700);
      note("afterScroll", current());
    }
  },
  // ⑩：切走再切回来，读到第几页。两个探针在这条上给出了相反的答案
  // （`hunt-b` 说 5 / 150% / 5168 全回来了，`hunt-c` 说回到 1 / 324），
  // 所以这里用**最小流**自己量一遍：只翻页、不缩放、只滚一次。
  "lead-cache-place": async ({ note, until, settle, params, readBytes, show }) => {
    await until(() => document.querySelector("#host .fp-canvas") !== null, 15000);
    await settle(600);
    const frame = () => document.querySelector("#host .fp-frame");
    const label = () => pagesLabel();
    const scrolled = () => Math.round(frame()?.scrollTop ?? -1);

    // 换文档：和 index.html 的 show() 同一个入口（同一棵 React 树换 props）。
    const diskNow = params.get("disk");
    const diskDir = diskNow === null ? "" : String(diskNow).replace(/[^\\/]*$/u, "");
    const addressOf = (path) => `dsh-resource://file/session/sess-46/${
      encodeURIComponent(String(path)).replaceAll("%2F", "/").replaceAll("%5C", "/")}`;
    const openFile = (file) => {
      const targetDisk = `${diskDir}${file}`;
      show(readBytes, addressOf(targetDisk), targetDisk);
    };

    note("labelStart", label());
    note("scrollStart", scrolled());

    // 只翻页：页码框输入 3 并回车。
    const input = document.querySelector("#host .fp-page-input");
    if (input !== null) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      input.focus();
      setter?.call(input, "3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await settle(500);
    }
    note("labelAfterPageJump", label());
    note("scrollAfterPageJump", scrolled());

    const box = frame();
    if (box !== null) {
      box.scrollTop = box.scrollTop + 400;
      box.dispatchEvent(new Event("scroll"));
      await settle(500);
    }
    note("labelBeforeLeave", label());
    note("scrollBeforeLeave", scrolled());
    note("zoomBeforeLeave", document.querySelector("#host .fp-zoom-label")?.textContent ?? "-");

    openFile("big.pdf");
    note("otherReady", await until(() => label().endsWith("/ 200"), 20000));
    await settle(400);
    note("labelOther", label());

    openFile("outline.pdf");
    const timeline = [];
    for (const wait of [0, 120, 400, 1200]) {
      await settle(wait);
      timeline.push(`${wait}ms:${label()}@${scrolled()}`);
    }
    note("restoredTimeline", timeline.join(" | "));
    note("labelAfterBack", label());
    note("scrollAfterBack", scrolled());
  },
};
