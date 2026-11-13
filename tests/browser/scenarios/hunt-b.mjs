// Probes owned by hunt-b (selection → 翻译 bubble → card → pin → reuse).
// Add a key per probe: the key is the `?scenario=` value.
//
// Every probe here is red against the code it was written for, or is a
// baseline measurement a fix has to keep. The comment above each key says which
// bug it watches.

const q = (selector) => document.querySelector(`#host ${selector}`);
const qa = (selector) => [...document.querySelectorAll(`#host ${selector}`)];
const boxOf = (node) => (node === null || node === undefined ? null : node.getBoundingClientRect());
const rect = (r) => (r === null ? "none" : [r.left, r.top, r.width, r.height].map(Math.round).join(","));
const paneBox = () => boxOf(q(".fp-root"));
const frameEl = () => document.querySelector("#host .fp-frame");
const cardBox = () => boxOf(q(".fp-pick-card"));
const chipBox = () => boxOf(q(".fp-chip"));
const pinButton = () => q(".fp-pick .fp-pin");
const pinLabel = () => pinButton()?.getAttribute("aria-label") ?? "none";
const pinnedNow = () => q(".fp-pick")?.hasAttribute("data-pinned") === true;
const statusNow = () => q(".fp-pick")?.getAttribute("data-status") ?? "none";
const pageOf = (node) => Number(node?.closest?.(".page")?.dataset.pageNumber ?? 0);

/** A press on the page, which is what makes the next drag a real gesture. */
async function pressPage(S) {
  frameEl().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 5 }));
  await S.settle(120);
}

/** Press, drag over `node`, let go; answers whether the pill showed up. */
async function pickSpan(S, node, from = 0, to = 8) {
  await pressPage(S);
  const length = node?.firstChild?.length ?? 0;
  S.selectSpan(node, from, Math.max(from + 1, Math.min(to, length)));
  return S.until(() => q(".fp-chip") !== null, 4000);
}

/** Press 翻译 and wait for the card to hold text. */
async function translateNow(S) {
  S.click(S.DICT.translate);
  return S.until(() => (q(".fp-pick-text")?.textContent ?? "").length > 0, 15000);
}

/** How far the card sticks out of the pane, one number per edge (positive = outside). */
function overhangs() {
  const pane = paneBox();
  const card = cardBox();
  if (pane === null || card === null) return { left: "none", top: "none", right: "none", bottom: "none", inside: "none" };
  return {
    left: Math.round(pane.left - card.left),
    top: Math.round(pane.top - card.top),
    right: Math.round(card.right - pane.right),
    bottom: Math.round(card.bottom - pane.bottom),
    inside: card.left >= pane.left - 1 && card.right <= pane.right + 1
      && card.top >= pane.top - 1 && card.bottom <= pane.bottom + 1,
  };
}

/** Put a translation stub in place; answers a restore function. */
function stubTranslation(body) {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => (String(input).includes("/fast-pdf/translate")
    ? new Response(JSON.stringify({
      ok: true,
      text: typeof body === "function" ? body() : body,
      target: "Chinese",
      provider: "hunt-b",
      model: "stub",
    }), { status: 200, headers: { "content-type": "application/json" } })
    : real(input, init));
  return () => { window.fetch = real; };
}

export default {
  // (a) 译文里的极端内容：60 字符不换行 token、200 字符 URL、长代码行、宽表格、
  // 20 段长文。盯的是「卡片被内容顶宽/顶出面板」和「卡片高度在 placement 与
  // max-height 之间来回抖」。BUG B1 的红灯在这条上（贴上方时卡片压住工具栏，
  // 根因 anchorOf 拿 .fp-root 当放置视口，lead 已改成 frame）——现在是 B1 的守卫。
  "b-overflow": async (S) => {
    const { note, until, settle, params } = S;
    const token = "A".repeat(60);
    const url = `https://example.test/${"b".repeat(180)}`;
    const answer = [
      "## 小节标题",
      "",
      `第一段：${token} 在这句里，后面还有很长的链接 ${url} 。`,
      "",
      "```js",
      `const value = "${"c".repeat(90)}";`,
      "```",
      "",
      "| 列一 | 列二 | 列三 |",
      "| --- | --- | --- |",
      `| ${"表".repeat(40)} | ${token} | 正常 |`,
      "",
      ...Array.from({ length: 16 }, (_, i) => `第 ${i + 1} 段：${"译文内容用于撑高卡片。".repeat(5)}`),
    ].join("\n");
    const restore = stubTranslation(answer);
    note("paneWidth", params.get("pane") ?? "460");

    await until(() => S.spans().length > 0, 15000);
    note("chipShown", await pickSpan(S, S.spans()[0], 0, 8));
    note("textLanded", await translateNow(S));
    await settle(700);

    const body = q(".fp-pick-text");
    const pre = body?.querySelector("pre") ?? null;
    const table = body?.querySelector("table") ?? null;
    const card = cardBox();
    const pane = paneBox();
    const cardEl = q(".fp-pick-card");
    note("cardRect", rect(card));
    note("cardSize", `${Math.round(card.width)}x${Math.round(card.height)}`);
    note("paneRect", rect(pane));
    // 四边越界量：正数就是出了面板
    note("overLeft", Math.round(pane.left - card.left));
    note("overRight", Math.round(card.right - pane.right));
    note("overTop", Math.round(pane.top - card.top));
    note("overBottom", Math.round(card.bottom - pane.bottom));
    note("cardInsidePane", overhangs().inside);

    // 内容有没有横向溢出：这三个数是断言的来源
    note("textScrollOver", body === null ? "none" : body.scrollWidth - body.clientWidth);
    note("textClientW", body === null ? "none" : body.clientWidth);
    note("cardScrollOver", cardEl === null ? "none" : cardEl.scrollWidth - cardEl.clientWidth);
    note("preScrollOver", pre === null ? "none" : pre.scrollWidth - pre.clientWidth);
    note("tableW", table === null ? "none" : Math.round(table.getBoundingClientRect().width));
    note("tableOverBody", table === null || body === null
      ? "none"
      : Math.round(table.getBoundingClientRect().right - body.getBoundingClientRect().right));
    note("paneScrollW", `${q(".fp-root").scrollWidth}/${q(".fp-root").clientWidth}`);
    note("docScrollW", `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`);

    // 卡片高度会不会在「测量→重排→再测量」之间抖：20 帧里出现几种几何
    const frames = [];
    for (let tick = 0; tick < 20; tick += 1) {
      const held = cardBox();
      frames.push(`${Math.round(held.top)}:${Math.round(held.height)}`);
      await settle(120);
    }
    note("cardFrames", frames.join(" "));
    note("cardGeometries", new Set(frames).size);

    // 贴顶的一次：先滚到中间，让选区落在面板中部，再翻到上方去
    const frame = frameEl();
    const paneTop = pane.top;
    frame.scrollTop = Math.round((frame.scrollHeight - frame.clientHeight) * 0.5);
    await settle(900);
    const mid = S.spans().find((span) => {
      const r = span.getBoundingClientRect();
      return r.top > paneTop + 300 && r.bottom < paneTop + 520;
    }) ?? null;
    note("midSpan", mid === null ? "none" : mid.textContent.slice(0, 12));
    if (mid !== null) {
      note("midChip", await pickSpan(S, mid, 0, 6));
      note("midLanded", await translateNow(S));
      await settle(700);
      const midCard = cardBox();
      const toolbar = boxOf(q(".fp-toolbar"));
      note("midCardRect", rect(midCard));
      note("midOverTop", Math.round(pane.top - midCard.top));
      note("midPlacedAbove", midCard.top < mid.getBoundingClientRect().top);
      note("toolbarRect", rect(toolbar));
      note("cardOverToolbar", Math.round(toolbar.bottom - midCard.top));
      const hit = document.elementFromPoint(
        Math.round(toolbar.left + toolbar.width / 2),
        Math.round(toolbar.top + toolbar.height / 2),
      );
      note("toolbarPointHit", hit === null ? "none"
        : String(hit.className?.baseVal ?? hit.className ?? hit.tagName).slice(0, 40));
      note("toolbarCovered", hit !== null && hit.closest(".fp-toolbar") === null);
      note("midInsidePane", overhangs().inside);
    }
    restore();
  },

  // (b) 复制按钮连点两次：数 writeClipboard 的调用次数，看文案是否永久停在
  // 「已复制」（有没有复位计时器），以及第二次点击是否还有反应。
  "b-copy2": async (S) => {
    const { note, until, settle } = S;
    const writes = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value) => { writes.push(String(value)); return Promise.resolve(); },
        readText: () => Promise.resolve(""),
      },
    });
    await until(() => S.spans().length > 0, 15000);
    note("chipShown", await pickSpan(S, S.spans()[0], 0, 8));
    note("textLanded", await translateNow(S));
    await settle(500);
    // The foot's copy button is a glyph now (`.fp-foot-copy`, two sheets → a
    // tick), so `textContent` is "" and the name lives on `aria-label`. Read the
    // name, and keep the raw attributes once so the reading explains itself.
    const footButton = () => q(".fp-pick-foot .fp-foot-copy") ?? q(".fp-pick-foot button");
    const footLabel = () => {
      const button = footButton();
      if (button === null) return "none";
      return button.getAttribute("aria-label") ?? button.getAttribute("title")
        ?? button.textContent.trim() ?? "";
    };
    const footAttrs = () => {
      const button = footButton();
      return button === null ? "none"
        : `aria=${JSON.stringify(button.getAttribute("aria-label"))}`
        + ` title=${JSON.stringify(button.getAttribute("title"))}`
        + ` text=${JSON.stringify(button.textContent.trim())}`;
    };
    note("footAttrs", footAttrs());
    note("buttonBefore", footLabel());
    note("writesBefore", writes.length);

    footButton()?.click();
    await settle(400);
    const labelAfterOne = footLabel();
    note("labelAfterOne", labelAfterOne);
    note("writesAfterOne", writes.length);
    note("writeChars", writes.map((text) => text.length).join(","));
    note("writeHead", JSON.stringify(String(writes[0] ?? "")).slice(0, 60));

    await settle(2200);
    const labelAfterHold = footLabel();
    note("labelAfterTwoSeconds", labelAfterHold);
    footButton()?.click();
    await settle(400);
    const labelAfterTwo = footLabel();
    note("labelAfterTwo", labelAfterTwo);
    note("writesAfterTwo", writes.length);
    note("buttonDisabled", footButton()?.disabled ?? "gone");
    // There is no `data-copied` on the card — `client.js` sets `data-status`,
    // `data-mode` and `data-pinned` on `.fp-pick` and nothing else — so the copy
    // state is only visible on the button's accessible name. Read what the card
    // actually carries instead of an attribute that never existed.
    note("cardAttrs", (() => {
      const card = q(".fp-pick");
      return card === null ? "none"
        : `status=${card.getAttribute("data-status")}`
        + ` mode=${card.getAttribute("data-mode")}`
        + ` pinned=${card.hasAttribute("data-pinned")}`;
    })());
    note("footButtons", qa(".fp-pick-foot button").length);

    // 同一张卡换内容后，文案必须回到「复制」；否则上一段译文的已复制状态会跟着新译文。
    await pressPage(S);
    await pickSpan(S, S.spans()[1] ?? S.spans()[0], 0, 8);
    await translateNow(S);
    await settle(400);
    const labelAfterNewText = footLabel();
    note("labelAfterNewText", labelAfterNewText);

    // 图标按钮没有文字，能证明「复位计时器还在」的只有可访问名：按下 → 已复制，
    // 1.5 s 后自己回到 复制（这条以前读数一直是 已复制，量到的是没复位）。
    const verdict = (name, ok, measured) => note(`assert_${name}`, `${ok ? "ok" : "FAIL"} (${measured})`);
    verdict("copyLabelSwitchesToCopied", labelAfterOne === S.DICT.copied, JSON.stringify(labelAfterOne));
    verdict("copyLabelResetsAfterHold", labelAfterHold === S.DICT.copy, JSON.stringify(labelAfterHold));
    verdict("copyLabelBackAfterSecondClick", labelAfterTwo === S.DICT.copied, JSON.stringify(labelAfterTwo));
    verdict("copyLabelResetsOnNewText", labelAfterNewText === S.DICT.copy, JSON.stringify(labelAfterNewText));
    verdict("copyWritesEachPress", writes.length === 2, `writes=${writes.length}`);
  },

  // (c) 跨页选区（第 1 页选到第 2 页）：气泡必须挂在 focus 端（第 2 页），
  // 不是选区包围盒；卡片仍在面板内。样本 b-short.pdf：两页都整页同屏可见。
  "b-crosspage": async (S) => {
    const { note, until, settle, focusEndBox } = S;
    await until(() => S.spans().length > 0, 15000);
    const frame = frameEl();
    const pane = paneBox();
    note("paneRect", rect(pane));
    note("spanPages", [...new Set(S.spans().map((span) => pageOf(span)))].join(","));
    const firstPage = S.spans().filter((span) => pageOf(span) === 1);
    const secondPage = S.spans().filter((span) => pageOf(span) === 2);
    note("spansP1", firstPage.length);
    note("spansP2", secondPage.length);
    if (firstPage.length === 0 || secondPage.length === 0) {
      note("crossPagePicked", "no-spans");
      return;
    }
    await pressPage(S);
    const start = firstPage.at(-1);
    const end = secondPage[0];
    note("startSpan", `${pageOf(start)}:${start.textContent.slice(0, 14)}`);
    note("endSpan", `${pageOf(end)}:${end.textContent.slice(0, 14)}`);
    const range = document.createRange();
    range.setStart(start.firstChild, 0);
    range.setEnd(end.firstChild, Math.min(10, end.firstChild.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    frame.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    note("chipShown", await until(() => q(".fp-chip") !== null, 4000));
    await settle(250);
    const focus = focusEndBox(window.getSelection());
    const chip = chipBox();
    const union = range.getBoundingClientRect();
    note("focusPage", pageOf(selection.focusNode?.parentElement ?? null));
    note("anchorPage", pageOf(selection.anchorNode?.parentElement ?? null));
    note("selectionChars", selection.toString().length);
    note("focusRect", rect(focus));
    note("unionRect", rect(union));
    note("chipRect", rect(chip));
    note("chipBelowFocus", focus === null ? "none" : Math.round(chip.top - focus.bottom));
    note("chipBelowUnion", Math.round(chip.top - union.bottom));
    note("chipInsidePane", chip.left >= pane.left - 1 && chip.right <= pane.right + 1
      && chip.top >= pane.top - 1 && chip.bottom <= pane.bottom + 1);
    note("textLanded", await translateNow(S));
    await settle(500);
    const card = cardBox();
    const over = overhangs();
    note("cardRect", rect(card));
    note("cardOverLeft", over.left);
    note("cardOverRight", over.right);
    note("cardOverTop", over.top);
    note("cardOverBottom", over.bottom);
    note("cardInsidePane", over.inside);
  },

  // (d) 超长选区（> SELECTION_LIMIT 6000 字符）：出 error 卡、没有重试按钮、
  // 图钉和关闭还在，而且卡片不许挂在面板外。样本 b-dense.pdf：80 行 × 80 字符。
  // BUG B3 在这条上：改前 `titleRealOver=24` —— 提示文案被 .fp-pick-title 的 nowrap
  // 加省略号切掉，而卡里正文区是空的（bodyEmpty=true）。lead 已给 error 态的标题
  // 放开换行（viewer.css:676），这条现在是守卫：`titleRealOver` 必须 ≤ 0。
  "b-toolong": async (S) => {
    const { note, until, settle } = S;
    await until(() => S.spans().length > 0, 15000);
    // 先滚到底再回顶，逼两页的 textLayer 都建出来
    const frame = frameEl();
    frame.scrollTop = frame.scrollHeight;
    await settle(900);
    frame.scrollTop = 0;
    await settle(700);
    const spans = S.spans();
    const total = spans.reduce((sum, span) => sum + (span.textContent ?? "").length, 0);
    note("spanCount", spans.length);
    note("spanTextChars", total);
    note("spanPages", [...new Set(spans.map((span) => pageOf(span)))].join(","));
    await pressPage(S);
    const first = spans[0];
    const last = spans.at(-1);
    const range = document.createRange();
    range.setStart(first.firstChild, 0);
    range.setEnd(last.firstChild, (last.firstChild?.length ?? 0));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    note("rawChars", selection.toString().length);
    frame.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    note("errorCard", await until(() => statusNow() === "error", 6000));
    await settle(500);
    note("chipShown", q(".fp-chip") !== null);
    note("status", statusNow());
    note("title", S.text("#host .fp-pick-title"));
    note("footButtons", qa(".fp-pick-foot button").length);
    note("retryShown", qa(".fp-pick-foot button").some((b) => b.textContent.trim() === S.DICT.retry));
    note("pinButton", pinButton() === null ? "none" : pinLabel());
    note("closeButton", qa(".fp-pick .fp-pick-close").length);
    note("sourceShown", q(".fp-pick-source") !== null);
    note("pickTextShown", q(".fp-pick-text") !== null);
    // 提示读不全的量化：标题是一行 nowrap + 省略号。测试页的 DICT 缺
    // selectionTooLong / translateTimeout（所以上面 title=selectionTooLong），
    // 真实文案取自 client.js:160，注入进去只为量这张卡的布局容量。
    const titleEl = q(".fp-pick-title");
    const realMessage = "选中的内容太多了，一次最多翻译 6000 个字符";
    note("titleBoxW", titleEl === null ? "none" : Math.round(titleEl.getBoundingClientRect().width));
    note("titleHarnessOver", titleEl === null ? "none" : titleEl.scrollWidth - titleEl.clientWidth);
    if (titleEl !== null) {
      titleEl.textContent = realMessage;
      note("titleRealOver", titleEl.scrollWidth - titleEl.clientWidth);
      note("titleNeedsW", titleEl.scrollWidth);
      note("titleWhiteSpace", getComputedStyle(titleEl).whiteSpace);
      note("titleTextOverflow", getComputedStyle(titleEl).textOverflow);
    }
    note("bodyEmpty", q(".fp-pick-text") === null);
    const over = overhangs();
    note("cardRect", rect(cardBox()));
    note("cardOverTop", over.top);
    note("cardOverBottom", over.bottom);
    note("cardOverRight", over.right);
    note("cardInsidePane", over.inside);
    // 这张卡不该能发起请求
    note("requestedChars", typeof window.__translateBody === "string"
      ? String(JSON.parse(window.__translateBody).text ?? "").length
      : "none");
    frame.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 5, clientY: 5 }));
    await settle(300);
    note("cardGoneOnPress", q(".fp-pick") === null);
  },

  // (e) 空选区与单字符：松手不起气泡、不出卡（< 2 字符那条门槛）。
  "b-empty": async (S) => {
    const { note, until, settle } = S;
    await until(() => S.spans().length > 0, 15000);
    const frame = frameEl();
    const span = S.spans()[0];
    const textNode = span.firstChild;
    note("spanText", JSON.stringify(textNode.textContent).slice(0, 24));

    // 0 字符：把光标放在词中间
    await pressPage(S);
    const zero = document.createRange();
    zero.setStart(textNode, Math.min(2, textNode.length));
    zero.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(zero);
    frame.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await settle(700);
    note("emptyChip", q(".fp-chip") !== null);
    note("emptyCard", q(".fp-pick") !== null);
    note("emptySelection", selection.toString().length);

    // 1 字符
    await pressPage(S);
    S.selectSpan(span, 0, 1);
    await settle(700);
    note("oneCharSelection", selection.toString().length);
    note("oneCharChip", q(".fp-chip") !== null);
    note("oneCharCard", q(".fp-pick") !== null);

    // 2 字符：门槛另一侧，必须有气泡
    await pickSpan(S, span, 0, 2);
    note("twoCharChip", await until(() => q(".fp-chip") !== null, 3000));
    note("twoCharSelection", window.getSelection().toString().length);
  },

  // (f) 260px 面板下的四向边界：贴左、贴右、贴下、贴上，卡片和气泡的四边
  // 都要在 .fp-root 内。
  "b-edges": async (S) => {
    const { note, until, settle, params } = S;
    note("paneParam", params.get("pane") ?? "460");
    await until(() => S.spans().length > 0, 15000);
    const frame = frameEl();
    const pane = paneBox();
    note("paneRect", rect(pane));
    note("frameRect", rect(boxOf(frame)));

    const chipReport = (tag) => {
      const chip = chipBox();
      note(`${tag}Chip`, rect(chip));
      note(`${tag}ChipIn`, chip === null ? "none"
        : chip.left >= pane.left - 1 && chip.right <= pane.right + 1
          && chip.top >= pane.top - 1 && chip.bottom <= pane.bottom + 1);
      note(`${tag}ChipOverRight`, chip === null ? "none" : Math.round(chip.right - pane.right));
      note(`${tag}ChipOverBottom`, chip === null ? "none" : Math.round(chip.bottom - pane.bottom));
    };
    const cardReport = (tag) => {
      const card = cardBox();
      const wrapper = q(".fp-pick");
      const over = overhangs();
      const toolbar = boxOf(q(".fp-toolbar"));
      note(`${tag}Card`, rect(card));
      note(`${tag}OverLeft`, over.left);
      note(`${tag}OverRight`, over.right);
      note(`${tag}OverTop`, over.top);
      note(`${tag}OverBottom`, over.bottom);
      note(`${tag}CardIn`, over.inside);
      note(`${tag}CardWidth`, card === null ? "none" : Math.round(card.width));
      note(`${tag}CardVar`, wrapper === null
        ? "none"
        : getComputedStyle(wrapper).getPropertyValue("--fp-card-width").trim());
      note(`${tag}CardOverToolbar`, card === null || toolbar === null ? "none" : Math.round(toolbar.bottom - card.top));
    };

    // 贴右：可见行里最靠右的那条
    const rightmost = S.spans()
      .filter((span) => {
        const r = span.getBoundingClientRect();
        return r.top > pane.top + 60 && r.bottom < pane.bottom - 60;
      })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] ?? null;
    if (rightmost === null) {
      note("rightmost", "none");
    } else {
      const r = rightmost.getBoundingClientRect();
      note("rightmostSpan", `${Math.round(r.left)},${Math.round(r.right)}`);
      note("rightChipShown", await pickSpan(S, rightmost, 0, 6));
      await settle(250);
      note("rightPin", rect(boxOf(rightmost)));
      chipReport("right");
      await translateNow(S);
      await settle(400);
      cardReport("rightCard");
    }

    // 贴下：滚到底，取可见范围里最靠下的一条
    frame.scrollTop = frame.scrollHeight;
    await settle(900);
    const lowest = S.spans()
      .filter((span) => {
        const r = span.getBoundingClientRect();
        return r.top > pane.top + 20 && r.bottom < pane.bottom - 4;
      })
      .sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0] ?? null;
    if (lowest === null) {
      note("lowest", "none");
    } else {
      note("lowestSpan", rect(boxOf(lowest)));
      note("bottomChipShown", await pickSpan(S, lowest, 0, 6));
      await settle(250);
      chipReport("bottom");
      await translateNow(S);
      await settle(400);
      cardReport("bottomCard");
    }

    // 贴上：滚到顶，取最上面的一条
    frame.scrollTop = 0;
    await settle(900);
    const highest = S.spans()[0];
    note("highestSpan", rect(boxOf(highest)));
    note("topChipShown", await pickSpan(S, highest, 0, 6));
    await settle(250);
    chipReport("top");
    await translateNow(S);
    await settle(400);
    cardReport("topCard");
    note("pagesLabel", S.pagesLabel());
  },

  // 钉住修复的副作用验证：**未钉住**时按气泡复用，卡片必须跟着新选区走
  // （tab 之外的第二条：pinned 为空 → 不 carry moved/anchor）。
  // 键盘选区（只有 keyup，没有 mousedown）才会留下上一张未钉住的卡。
  "b-reuse": async (S) => {
    const { note, until, settle, focusEndBox } = S;
    await until(() => S.spans().length >= 3, 15000);
    const spans = S.spans();
    note("chipShown", await pickSpan(S, spans[0], 0, 8));
    note("textLanded", await translateNow(S));
    await settle(600);
    const firstCard = cardBox();
    const firstFocus = focusEndBox(window.getSelection());
    note("firstCard", rect(firstCard));
    note("firstFocus", rect(firstFocus));
    note("firstPinned", pinnedNow());
    note("firstBelow", firstFocus === null ? "none" : Math.round(firstCard.top - firstFocus.bottom));

    // 第二条选区只走 keyup：不按页面，所以上一张卡还在
    const target = spans[3] ?? spans[2];
    const range = document.createRange();
    const textNode = target.firstChild;
    range.setStart(textNode, 0);
    range.setEnd(textNode, Math.min(8, textNode.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    frameEl().dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    note("secondChip", await until(() => q(".fp-chip") !== null, 4000));
    note("cardKeptWhileChip", q(".fp-pick") !== null);
    await settle(250);
    const secondFocus = focusEndBox(window.getSelection());
    const chip = chipBox();
    note("secondFocus", rect(secondFocus));
    note("secondChipRect", rect(chip));
    note("textLanded2", await translateNow(S));
    await settle(600);
    const secondCard = cardBox();
    note("secondCardRect", rect(secondCard));
    note("cardMovedToNewSelection", secondFocus === null ? "none" : Math.round(secondCard.top - secondFocus.bottom));
    note("cardStayedOnOldAnchor", firstFocus === null ? "none" : Math.round(secondCard.top - firstFocus.top));
    note("secondPinned", pinnedNow());
    note("cardsOnScreen", qa(".fp-pick").length);
    note("secondInsidePane", overhangs().inside);

    // 钉住之后同一个手势要原地换内容：位置不许变
    pinButton()?.click();
    await settle(350);
    note("pinnedAfterClick", pinnedNow());
    const pinnedRect = cardBox();
    note("pinnedRect", rect(pinnedRect));
    const third = spans[5] ?? spans[2];
    await pressPage(S);
    S.selectSpan(third, 0, Math.min(8, third.firstChild?.length ?? 8));
    note("thirdChip", await until(() => q(".fp-chip") !== null, 4000));
    await translateNow(S);
    await settle(600);
    note("reusedPinned", pinnedNow());
    note("reusedRect", rect(cardBox()));
    note("reusedStayedPut", Math.round(cardBox().left) === Math.round(pinnedRect.left)
      && Math.round(cardBox().top) === Math.round(pinnedRect.top));
    note("cardsOnScreenPinned", qa(".fp-pick").length);
  },

  // 钉住的卡在「滚动 / 翻页 / 双击放大」三种重排下还在不在、位置动不动。
  // 盯的是 pin 的持久性：这三件事都会让 React 重渲染，pin 丢了就没人看得见。
  "b-pinstay": async (S) => {
    const { note, until, settle } = S;
    await until(() => S.spans().length >= 3, 15000);
    note("chipShown", await pickSpan(S, S.spans()[0], 0, 8));
    note("textLanded", await translateNow(S));
    await settle(500);
    pinButton()?.click();
    await settle(350);
    const before = cardBox();
    note("pinnedRect", rect(before));
    note("pinnedNow", pinnedNow());

    // 1) 滚动：卡片是 .fp-root 里的绝对定位，滚动不该带走它
    const frame = frameEl();
    frame.scrollTop += 260;
    await settle(700);
    note("afterScrollCard", rect(cardBox()));
    note("afterScrollPinned", pinnedNow());
    note("afterScrollMoved", Math.round(cardBox()?.top ?? -1) === Math.round(before.top));

    // 2) 翻页：内容整页换掉，卡还是那张卡
    S.click(S.DICT.next);
    await settle(1200);
    note("pageAfterTurn", S.pagesLabel());
    note("afterTurnCard", rect(cardBox()));
    note("afterTurnPinned", pinnedNow());
    note("afterTurnStayedPut", Math.round(cardBox()?.top ?? -1) === Math.round(before.top));

    // 3) 双击放大：选区被清、气泡被清，但钉住的卡按注释要留下
    const pagesEl = q(".fp-pages");
    const pageOne = qa(".fp-pages .page")[0] ?? null;
    const pageWBefore = pageOne === null ? 0 : Math.round(pageOne.getBoundingClientRect().width);
    const box = boxOf(pagesEl);
    const at = { clientX: Math.round(box.left + box.width / 2), clientY: Math.round(box.top + box.height / 2) };
    pagesEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, ...at }));
    await settle(1600);
    const pageWAfter = pageOne === null ? 0 : Math.round(pageOne.getBoundingClientRect().width);
    note("pageWBefore", pageWBefore);
    note("pageWAfter", pageWAfter);
    note("zoomed", pageWAfter !== pageWBefore);
    note("afterZoomCard", rect(cardBox()));
    note("afterZoomPinned", pinnedNow());
    note("afterZoomChip", q(".fp-chip") !== null);

    // 4) 取消固定：状态要真的松手，再按页面就该消失
    pinButton()?.click();
    await settle(350);
    note("unpinnedNow", pinnedNow());
    note("unpinLabel", pinLabel());
    await pressPage(S);
    await settle(350);
    note("cardGoneAfterUnpinPress", q(".fp-pick") === null);
  },

  // 超时 / 打断的状态机，以及「同一段文字先后发两次请求」时旧响应会不会落到
  // 新卡上。BUG B2：守卫比的是 text 相等而不是请求身份，旧响应把新卡从 done
  // 改成 error/translateTimeout；lead 已改成 `held.request === controller` ——
  // 这条现在守它：`textAfterStale` 必须是第二次的译文。
  "b-timeout": async (S) => {
    const { note, until, settle } = S;
    await until(() => S.spans().length >= 3, 15000);
    // 请求全由场景放行：挂住、答、或按中止失败
    const real = window.fetch.bind(window);
    const pending = [];
    window.fetch = async (input, init) => {
      if (!String(input).includes("/fast-pdf/translate")) return real(input, init);
      const asked = JSON.parse(String(init?.body ?? "{}"));
      return new Promise((resolve, reject) => {
        pending.push({
          text: String(asked.text ?? ""),
          answer: (text) => resolve(new Response(JSON.stringify({
            ok: true, text, target: "Chinese", provider: "hunt-b", model: "stub", ms: 1,
          }), { status: 200, headers: { "content-type": "application/json" } })),
          // 60 s 超时走的是同一条 catch：AbortError
          abort: () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        });
      });
    };
    const headButton = (label) => qa(".fp-pick-head button").find((b) => S.labelOf(b) === label) ?? null;
    const shown = () => (q(".fp-pick-text")?.textContent ?? "").trim().slice(0, 10);

    const span = S.spans()[0];
    note("chipShown", await pickSpan(S, span, 0, 10));
    S.click(S.DICT.translate);
    await settle(400);
    note("pendingCount", pending.length);
    note("busyStatus", statusNow());
    note("busyTitle", S.text("#host .fp-pick-title"));
    note("busyStopShown", headButton(S.DICT.stop) !== null);
    note("busyPinShown", pinButton() !== null);
    note("busySpinner", q(".fp-pick-spinner") !== null);
    await settle(1200);
    note("stillBusyAfter1_2s", statusNow());
    // 停止：卡片该消失，放弃的请求晚到也不许把卡拉回来
    headButton(S.DICT.stop)?.click();
    await settle(400);
    note("cardAfterStop", q(".fp-pick") !== null);
    pending[0].answer("停止之后才回来的译文");
    await settle(700);
    note("cardAfterLateAbandoned", q(".fp-pick") !== null);

    // 同一个 text 连发两次：第二次先答，第一次后答
    note("reChip", await pickSpan(S, span, 0, 10));
    S.click(S.DICT.translate);
    await settle(350);
    const older = pending.length - 1;
    headButton(S.DICT.close)?.click();
    await settle(350);
    note("cardAfterClose", q(".fp-pick") !== null);
    note("reChip2", await pickSpan(S, span, 0, 10));
    S.click(S.DICT.translate);
    await settle(350);
    const newer = pending.length - 1;
    note("pendingNow", pending.length);
    note("sameText", pending[older].text === pending[newer].text);
    pending[newer].answer("第二次请求的译文");
    await settle(700);
    note("textAfterNewer", shown());
    pending[older].answer("第一次请求的译文");
    await settle(700);
    note("textAfterStale", shown());

    // 旧请求以超时形态晚到：已经 done 的卡会不会被翻成 error
    note("reChip3", await pickSpan(S, span, 0, 10));
    S.click(S.DICT.translate);
    await settle(350);
    const stale = pending.length - 1;
    headButton(S.DICT.close)?.click();
    await settle(350);
    note("reChip4", await pickSpan(S, span, 0, 10));
    S.click(S.DICT.translate);
    await settle(350);
    const fresh = pending.length - 1;
    pending[fresh].answer("最新一次请求的译文");
    await settle(700);
    note("statusAfterFresh", statusNow());
    pending[stale].abort();
    await settle(800);
    note("statusAfterStaleAbort", statusNow());
    note("titleAfterStaleAbort", S.text("#host .fp-pick-title"));
    window.fetch = real;
  },

  // 靠页底选词：卡片必须挂在锚点下方、整张留在面板里，译文要真的落地。
  // （基线 `select` 场景报过 tailText=-，这条把它钉成可复现的断言：
  //  `status=done writtenChars=29 bodyShown=true cardAboveChip=581`。）
  "b-bottom": async (S) => {
    const { note, until, settle, focusEndBox } = S;
    await until(() => S.spans().length > 0, 15000);
    const frame = frameEl();
    const pane = paneBox();
    frame.scrollTop = frame.scrollHeight;
    await settle(1000);
    const tail = S.spans().at(-1);
    if (tail === undefined) {
      note("tail", "none");
      return;
    }
    tail.scrollIntoView({ block: "end" });
    await settle(500);
    note("tailText", JSON.stringify(tail.textContent ?? "").slice(0, 22));
    note("tailBox", rect(boxOf(tail)));
    note("tailChars", tail.firstChild?.length ?? 0);
    note("tailPage", pageOf(tail));
    note("tailPicked", await pickSpan(S, tail, 0, 12));
    if (q(".fp-chip") === null) {
      note("chip", "none");
      return;
    }
    note("chipShown", true);
    await settle(250);
    const focus = focusEndBox(window.getSelection());
    note("tailFocus", rect(focus));
    note("chipRect", rect(chipBox()));
    note("chipBelowFocus", focus === null ? "none" : Math.round((chipBox()?.top ?? 0) - focus.bottom));
    note("textLanded", await translateNow(S));
    await settle(600);
    note("status", statusNow());
    note("writtenChars", (q(".fp-pick-text")?.textContent ?? "").length);
    note("bodyShown", q(".fp-pick-text") !== null);
    note("titleText", S.text("#host .fp-pick-title"));
    const over = overhangs();
    note("cardRect", rect(cardBox()));
    note("cardOverTop", over.top);
    note("cardOverBottom", over.bottom);
    note("cardInsidePane", over.inside);
    note("cardAboveChip", Math.round((cardBox()?.top ?? 0) - (chipBox()?.top ?? 0)));
    note("requestedChars", typeof window.__translateBody === "string"
      ? String(JSON.parse(window.__translateBody).text ?? "").length
      : "none");
  },

  // `select` 场景里 tailText=- 的定性：判据按 lead 的要求 —— 等 data-status=done
  // 之后才读 body，并读 pickModel。结论是**采样太早**，不是响应没落地：
  // `status=done textLen=29 childNodes=1 model=swzc-tech / DeepSeek-V4.1-Flash-1017`，
  // 且 `ticks=done/29` 连读 2 秒不变。B4 落地后这里不再复用旧卡（滚到页底会先清掉
  // 未钉住的卡：`cardKeptBeforeClick=false`），所以这张是新起的卡，结论不变。
  "b-tail": async (S) => {
    const { note, until, settle } = S;
    await until(() => S.spans().length > 0, 15000);
    const frame = frameEl();
    // 1) 先做出一张 done 卡（这一张在 select 场景里是好的）
    note("firstPicked", await pickSpan(S, S.spans()[0], 0, 8));
    note("firstLanded", await translateNow(S));
    await settle(500);
    note("firstStatus", statusNow());
    note("firstCard", rect(cardBox()));

    // 2) 滚到底、把最后一条 span 挪进视野，然后**不按页面**地选它
    frame.scrollTop = frame.scrollHeight;
    await settle(1000);
    const tail = S.spans().at(-1);
    tail.scrollIntoView({ block: "end" });
    await settle(400);
    note("tailBox", rect(boxOf(tail)));
    S.selectSpan(tail, 0, Math.min(12, tail.firstChild?.length ?? 0));
    frame.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    note("tailChip", await until(() => q(".fp-chip") !== null, 4000));
    note("cardKeptBeforeClick", q(".fp-pick") !== null);
    note("statusBeforeClick", statusNow());
    S.click(S.DICT.translate);

    // 3) 等 done（不是等 body 有字），再读
    const done = await until(() => statusNow() === "done", 8000);
    await settle(600);
    note("doneReached", done);
    note("status", statusNow());
    note("title", S.text("#host .fp-pick-title"));
    note("textLen", (q(".fp-pick-text")?.textContent ?? "").length);
    note("textHead", (q(".fp-pick-text")?.textContent ?? "").slice(0, 16));
    note("childNodes", q(".fp-pick-text")?.childNodes.length ?? "none");
    note("model", S.text("#host .fp-pick-model"));
    note("footButtons", S.buttons().join("|"));
    note("requestedChars", typeof window.__translateBody === "string"
      ? String(JSON.parse(window.__translateBody).text ?? "").length
      : "none");
    // 每 200 ms 采一次，看 body 是「一直空」还是「晚一点才填上」
    const ticks = [];
    for (let tick = 0; tick < 10; tick += 1) {
      ticks.push(`${statusNow()}/${(q(".fp-pick-text")?.textContent ?? "").length}`);
      await settle(200);
    }
    note("ticks", ticks.join(" "));
    const over = overhangs();
    note("cardRect", rect(cardBox()));
    note("cardOverTop", over.top);
    note("cardOverBottom", over.bottom);
    note("cardInsidePane", over.inside);
  },

  // (f) 260 宽 + 目录打开：frame 被目录挤窄，视口钳制用的是 frame 的右边界，
  // 这组合最可能把卡片挤出右边。四边差各记一个数（负数=在里面）。
  "b-outline260": async (S) => {
    const { note, until, settle, params } = S;
    await until(() => S.spans().length > 0, 15000);
    note("paneWidth", params.get("pane") ?? "460");
    const pane = () => boxOf(q(".fp-root"));
    const frame = () => boxOf(q(".fp-frame"));
    const outlineOpen = () => q(".fp-outline") !== null;
    const find = (label) => S.all("#host button").find((b) => S.labelOf(b) === label) ?? null;
    note("paneRectBefore", rect(pane()));
    note("frameRectBefore", rect(frame()));
    // 目录按钮可能被收进「更多」
    let opened = false;
    if (find(S.DICT.outline) !== null) {
      find(S.DICT.outline).click();
      opened = await until(outlineOpen, 3000);
    } else {
      note("moreOpened", await S.openMore());
      const inner = find(S.DICT.outline);
      note("outlineInMenu", inner !== null);
      inner?.click();
      opened = await until(outlineOpen, 3000);
    }
    await settle(700);
    note("outlineOpen", opened);
    note("paneRectAfter", rect(pane()));
    note("frameRectAfter", rect(frame()));
    note("frameNarrowed", Math.round(frame().width) < Math.round(pane().width));
    if (!opened) return;

    // 目录开着时选最靠右的一条 span
    const inFrame = S.spans().filter((span) => {
      const r = span.getBoundingClientRect();
      const f = frame();
      return r.top > f.top + 40 && r.bottom < f.bottom - 40;
    });
    const rightmost = inFrame.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0]
      ?? S.spans()[0];
    note("rightmostSpan", rect(boxOf(rightmost)));
    note("rightChipShown", await pickSpan(S, rightmost, 0, 8));
    await settle(300);
    const chip = chipBox();
    const p1 = pane();
    note("chipRect", rect(chip));
    note("chipOverLeft", Math.round(p1.left - (chip?.left ?? 0)));
    note("chipOverRight", Math.round((chip?.right ?? 0) - p1.right));
    note("chipOverBottom", Math.round((chip?.bottom ?? 0) - p1.bottom));
    note("chipInsidePane", chip !== null && chip.left >= p1.left - 1 && chip.right <= p1.right + 1
      && chip.bottom <= p1.bottom + 1);
    note("textLanded", await translateNow(S));
    await settle(600);
    const card = cardBox();
    const wrapper = q(".fp-pick");
    const p2 = pane();
    const f2 = frame();
    note("cardRect", rect(card));
    note("overLeft", Math.round(p2.left - (card?.left ?? 0)));
    note("overRight", Math.round((card?.right ?? 0) - p2.right));
    note("overTop", Math.round(p2.top - (card?.top ?? 0)));
    note("overBottom", Math.round((card?.bottom ?? 0) - p2.bottom));
    note("cardInsidePane", overhangs().inside);
    note("cardWidth", card === null ? "none" : Math.round(card.width));
    note("cardVar", wrapper === null ? "none"
      : getComputedStyle(wrapper).getPropertyValue("--fp-card-width").trim());
    note("cardMaxVar", wrapper === null ? "none"
      : getComputedStyle(wrapper).getPropertyValue("--fp-card-max-height").trim());
    note("cardOverFrameRight", Math.round((card?.right ?? 0) - f2.right));
    note("cardOverFrameBottom", Math.round((card?.bottom ?? 0) - f2.bottom));
    note("paneScrollW", `${q(".fp-root").scrollWidth}/${q(".fp-root").clientWidth}`);
    note("docScrollW", `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`);

    // 目录是 .fp-body 里的绝对定位覆盖层（viewer.css:307 的注释就是这么写的），
    // 所以它不挤 frame，但可能盖住卡片：用 elementFromPoint 判谁在最上面
    note("outlineRect", rect(boxOf(q(".fp-outline"))));
    note("outlineZ", q(".fp-outline") === null ? "none" : getComputedStyle(q(".fp-outline")).zIndex);
    note("pickZ", q(".fp-pick") === null ? "none" : getComputedStyle(q(".fp-pick")).zIndex);
    {
      const c = cardBox();
      const hit = c === null ? null
        : document.elementFromPoint(Math.round(c.left + c.width / 2), Math.round(c.top + 24));
      note("cardHit", hit === null ? "none" : String(hit.className?.baseVal ?? hit.className ?? hit.tagName).slice(0, 40));
      note("cardHitInPick", hit?.closest?.(".fp-pick") !== null && hit?.closest?.(".fp-pick") !== undefined);
      note("cardHitInOutline", hit?.closest?.(".fp-outline") !== null && hit?.closest?.(".fp-outline") !== undefined);
    }

    // 目录关掉以后再量一次：卡片是不是跟着视口变宽/挪位
    const closeOutline = find(S.DICT.outline) ?? qa(".fp-outline button")[0] ?? null;
    closeOutline?.click();
    await settle(900);
    note("outlineClosed", !outlineOpen());
    note("cardAfterClose", rect(cardBox()));
    note("cardWidthAfterClose", cardBox() === null ? "none" : Math.round(cardBox().width));
    note("insideAfterClose", overhangs().inside);
  },

  // `select` 场景 tailText=- 的**逐步复刻**：先按页面选第一段 → 翻译 → 复制 →
  // 滚到底 → 整条选最后一段 → 再翻译。关键是 ticker：按芯片后**第一个同步采样**
  // 读到的还是上一张卡的 DOM（`done/29/chip`），一 microtask 之后 React 才把卡刷成
  // busy（那时 .fp-pick-text 不渲染）——`select` 的 until 被上一张卡的 body 骗到、
  // 紧接着读成 null，就是这么来的。末尾按硬判据读：`tailStatus=done tailBodyLen=29`。
  "b-tail2": async (S) => {
    const { note, until, settle } = S;
    await until(() => S.spans().length > 0, 15000);
    const dump = (tag) => {
      const pick = q(".fp-pick");
      const body = q(".fp-pick-text");
      note(`${tag}Status`, statusNow());
      note(`${tag}Titled`, S.text("#host .fp-pick-title"));
      note(`${tag}Card`, rect(cardBox()));
      note(`${tag}BodyPresent`, body !== null);
      note(`${tag}BodyLen`, (body?.textContent ?? "").length);
      note(`${tag}InnerText`, JSON.stringify((pick?.innerText ?? "").replace(/\s+/gu, " ").slice(0, 46)));
      note(`${tag}SourceOpen`, q(".fp-pick-source")?.hasAttribute("data-open") ?? "none");
      note(`${tag}Chip`, q(".fp-chip") !== null);
      note(`${tag}CardHeight`, Math.round(cardBox()?.height ?? 0));
    };
    const span = S.spans()[0];
    await pressPage(S);
    S.selectSpan(span, 0, (span.firstChild?.length ?? 8));
    note("chip1", await until(() => q(".fp-chip") !== null, 4000));
    S.click(S.DICT.translate);
    note("firstDone", await until(() => statusNow() === "done", 8000));
    await settle(400);
    dump("first");
    // 复制（select 场景这一下之后才去滚页）
    S.click(S.DICT.copy);
    await settle(500);
    // Foot buttons are glyphs now: the name is the readout, not `textContent`
    // (`.fp-foot-copy` carries `aria-label`; it used to be a word).
    note("copiedLabel", (() => {
      const button = q(".fp-pick-foot .fp-foot-copy") ?? q(".fp-pick-foot button");
      return button === null ? "none"
        : button.getAttribute("aria-label") ?? button.getAttribute("title") ?? button.textContent.trim();
    })());
    dump("copied");

    // 滚到底，整条选最后一段（不按页面：只有 mouseup）
    const frame = frameEl();
    frame.scrollTop = frame.scrollHeight;
    await settle(1000);
    const tail = S.spans().at(-1);
    tail.scrollIntoView({ block: "end" });
    await settle(400);
    note("tailSpan", rect(boxOf(tail)));
    note("tailLen", tail.firstChild?.length ?? 0);
    S.selectSpan(tail, 0, (tail.firstChild?.length ?? 12));
    note("chip2", await until(() => q(".fp-chip") !== null, 4000));
    note("beforeSecondClick", `${statusNow()}/${(q(".fp-pick-text")?.textContent ?? "").length}`);
    S.click(S.DICT.translate);
    const ticker = [];
    for (let tick = 0; tick < 16; tick += 1) {
      ticker.push(`${statusNow()}/${(q(".fp-pick-text")?.textContent ?? "").length}/${q(".fp-chip") !== null ? "chip" : "-"}`);
      await settle(300);
    }
    note("ticker", ticker.join(" "));
    note("doneReached", await until(() => statusNow() === "done", 6000));
    await settle(500);
    dump("tail");
    note("requestedChars", typeof window.__translateBody === "string"
      ? String(JSON.parse(window.__translateBody).text ?? "").length
      : "none");
    note("requestedTail", typeof window.__translateBody === "string"
      ? JSON.stringify(String(JSON.parse(window.__translateBody).text ?? "").slice(0, 20))
      : "none");
    note("footButtons", S.buttons().filter((b) => ["复制", "已复制", "重试", "关闭", "停止"].includes(b)).join("|"));
  },

  // BUG B4：页面在气泡下面移动之后气泡不作废 —— 翻页（frame 自己滚了 576px）与
  // 滚动（选中行上移 300px、气泡不动、gap 变 318）都不清气泡，按下去发给模型的
  // 还是旧页文字；根因是 frame 上只登记了 5 个监听、没有 scroll。改后这里必须
  // `chipAfterTurn=false` / `chipStillAfterScroll=false`。
  "b-stale-bubble": async (S) => {
    const { note, until, settle, focusEndBox } = S;
    await until(() => S.spans().length >= 3, 15000);
    const anchorGap = (span) => {
      const chip = chipBox();
      const box = boxOf(span);
      return chip === null || box === null ? "none" : Math.round(chip.top - box.top);
    };

    // 1) 翻页：气泡挂在第 1 页的选区上，按下一页之后它还在
    const span = S.spans()[1] ?? S.spans()[0];
    note("chip1", await pickSpan(S, span, 0, 10));
    await settle(300);
    const chipBefore = chipBox();
    const focusBefore = focusEndBox(window.getSelection());
    note("pageBefore", S.pagesLabel());
    note("chipBefore", rect(chipBefore));
    note("chipGapBefore", anchorGap(span));
    note("frameScrollBeforeTurn", Math.round(frameEl().scrollTop));
    const turnBoxBefore = boxOf(span);
    S.click(S.DICT.next);
    await settle(1400);
    note("pageAfter", S.pagesLabel());
    note("frameScrollAfterTurn", Math.round(frameEl().scrollTop));
    note("spanMovedByTurn", turnBoxBefore === null ? "none"
      : Math.round((boxOf(span)?.top ?? 0) - turnBoxBefore.top));
    note("chipAfterTurn", q(".fp-chip") !== null);
    note("chipRectAfterTurn", rect(chipBox()));
    note("chipUnmovedByTurn", chipBox() === null ? "none"
      : Math.round(chipBox().top) === Math.round(chipBefore.top));
    note("selectionAfterTurn", window.getSelection().toString().length);
    // 按它：请求里装的是哪一页的文字
    if (q(".fp-chip") !== null) {
      S.click(S.DICT.translate);
      await settle(900);
      note("statusAfterStalePress", statusNow());
      note("sentText", typeof window.__translateBody === "string"
        ? JSON.stringify(String(JSON.parse(window.__translateBody).text ?? "").slice(0, 24))
        : "none");
      note("sourceShownText", JSON.stringify((q(".fp-pick-source")?.textContent ?? "").slice(0, 24)));
      note("cardsOnScreen", qa(".fp-pick").length);
      note("cardRectOnNewPage", rect(cardBox()));
      note("cardInsidePane", overhangs().inside);
    }

    // 2) 滚动：选中的行往上走了 300px，气泡原地不动
    note("cardGoneBeforeScroll", (() => {
      const close = qa(".fp-pick-head button").at(-1);
      close?.click();
      return true;
    })());
    await settle(300);
    const frame = frameEl();
    frame.scrollTop = 0;
    await settle(600);
    const span2 = S.spans()[1] ?? S.spans()[0];
    note("chip2", await pickSpan(S, span2, 0, 10));
    await settle(300);
    const boxBefore = boxOf(span2);
    const chipTopBefore = chipBox()?.top ?? 0;
    note("scrollChipBefore", rect(chipBox()));
    note("scrollSpanBefore", rect(boxBefore));
    note("scrollGapBefore", anchorGap(span2));
    frame.scrollTop += 300;
    await settle(800);
    const boxAfter = boxOf(span2);
    note("scrollSpanAfter", rect(boxAfter));
    note("scrollChipAfter", rect(chipBox()));
    note("scrollChipMoved", chipBox() === null ? "none"
      : Math.round(chipBox().top) - Math.round(chipTopBefore));
    note("textMoved", boxAfter === null || boxBefore === null ? "none" : Math.round(boxAfter.top - boxBefore.top));
    note("scrollGapAfter", anchorGap(span2));
    note("chipStillAfterScroll", q(".fp-chip") !== null);
    note("selectionAfterScroll", window.getSelection().toString().length);
  },

  // ⑩ 文档缓存（openDocuments）：同一个 tab 里 A→B→A，切回来必须是「复挂」而不是
  // 「重开」—— 不重新读文件、不弹 loading、页面容器还是同一个节点、页/缩放/滚动、
  // 搜索命中、目录都接得回来，来回多趟 DOM 里也不许越堆越多。
  //
  // 切文档走 index.html:489 的 `show(data, address, diskPath)`（带 &disk 时第二个
  // 参数按 served.disk 重算地址，第三个参数换目标文件）。工具箱里没有 show，所以
  // 这里按同一份实现复刻；lead 把 show 加进 1671-1677 之后本场景会自动改用真的。
  // 两份样本：A = 命令行样本（outline.pdf，12 页、有目录和文本层），B = big.pdf
  // （200 页）；run-scenario.ps1 自己就带 &disk，读的都是真实 /fast-pdf/file。
  "hunt-b-switchcache": async (S) => {
    const {
      note, until, settle, click, all, text, type, params, h, root, Body, readBytes, handle, tabSignal, t, pagesLabel,
    } = S;
    const frame = document.querySelector("#host .fp-frame");
    const pagesTotal = () => (text("#host .fp-pages-total") ?? "").trim();
    const zoomLabel = () => (text("#host .fp-zoom-count") ?? "").trim();
    const pagesInHost = () => all("#host .fp-pages").length;
    const pagesInDoc = () => all(".fp-pages").length;
    const canvasCount = () => all("#host .fp-pages canvas").length;
    const loadingNow = () => document.querySelector("#host .fp-loading") !== null;
    const marks = () => all("#host .fp-pages .hl").length;
    const markCurrent = () => all("#host .fp-pages .hl.current").length;
    const findCount = () => (text("#host .fp-find-count") ?? "").trim();
    const hitsOf = (value) => Number(String(value).split("/")[1]) || 0;
    const markNow = () => document.querySelector("#host .fp-pages")?.dataset.parkMark ?? "";

    /** 8ms 粒度：复挂可能只有几毫秒，60ms 的 until 会把两边的差别抹平。 */
    const fine = async (test, ms = 60000, step = 8) => {
      const deadline = performance.now() + ms;
      while (performance.now() < deadline) {
        if (test()) return true;
        await new Promise((done) => setTimeout(done, step));
      }
      return false;
    };

    // 读数 1：真实文件读取次数。页面在 &disk 非空时给每次读打一条 readerRoute
    // note（index.html:467），而这条 note 后面一定跟着一次 POST /fast-pdf/file ——
    // 两个计数分开记，互为对照。
    const routeNotes = [];
    const nativePush = Array.prototype.push;
    Array.prototype.push = function countReaderRoutes(...args) {
      for (const value of args) {
        if (typeof value === "string" && value.startsWith("readerRoute=")) nativePush.call(routeNotes, value);
      }
      return nativePush.apply(this, args);
    };
    const filePosts = [];
    const pageFetch = window.fetch;
    window.fetch = async (input, init) => {
      if (String(input).includes("/fast-pdf/file")) nativePush.call(filePosts, Math.round(performance.now()));
      return pageFetch(input, init);
    };

    // 读数 3：loading 遮罩。8ms 采样说明「肉眼看得见多久」，MutationObserver 才抓
    // 得到插入一帧就撤掉的那种。
    let loadTicks = 0;
    let loadFirstAt = 0;
    let loadLastAt = 0;
    let loadInserts = 0;
    const loadSampler = setInterval(() => {
      if (!loadingNow()) return;
      loadTicks += 1;
      if (loadFirstAt === 0) loadFirstAt = performance.now();
      loadLastAt = performance.now();
    }, 8);
    const loadObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains("fp-loading") === true
            || node.querySelector?.(".fp-loading") !== null) loadInserts += 1;
        }
      }
    });
    loadObserver.observe(document.getElementById("host"), { childList: true, subtree: true });
    const loadReset = () => {
      loadTicks = 0;
      loadFirstAt = 0;
      loadLastAt = 0;
      loadInserts = 0;
    };

    // 切文档：index.html:489 那份 show 的同一个做法
    const diskNow = params.get("disk");
    const diskDir = diskNow === null ? "" : String(diskNow).replace(/[^\\/]*$/u, "");
    const addressOf = (path) => `dsh-resource://file/session/sess-46/${
      encodeURIComponent(String(path)).replaceAll("%2F", "/").replaceAll("%5C", "/")}`;
    const useToolboxShow = typeof S.show === "function";
    const switchTo = (file) => {
      const targetDisk = `${diskDir}${file}`;
      const address = addressOf(targetDisk);
      if (useToolboxShow) {
        S.show(S.bytes, address, targetDisk);
        return address;
      }
      // 复刻 show()：revision 递增，同一棵 React 树换 props（不换 key，组件实例
      // 还在，缓存复挂才有机会发生）。
      handle.revision += 1;
      root.render(h(Body, {
        content: {
          kind: "renderer",
          revision: handle.revision,
          reload: () => switchTo(file),
          loaded: (version) => handle.loaded.push(version),
          failed: () => { handle.failed += 1; },
        },
        resourceAddress: address,
        readBytes,
        t,
        sessionId: "sess-46",
        useTabInfo: () => ({ tab: { id: "tab-body", signal: tabSignal, contentId: "content-1" } }),
        useStore: () => null,
        actions: { forget: () => {} },
        renderSlot: () => null,
      }));
      return address;
    };

    /** 换一次文档，量到「目标文档 ready」为止。 */
    const switchRound = async (file, readyTest) => {
      loadReset();
      const notesBefore = routeNotes.length;
      const postsBefore = filePosts.length;
      const started = performance.now();
      switchTo(file);
      const reached = await fine(readyTest);
      const ms = Math.round(performance.now() - started);
      return {
        file,
        ms,
        reached,
        loadInserted: loadInserts > 0,
        loadInserts,
        loadTicks,
        loadMs: loadTicks > 1 ? Math.round(loadLastAt - loadFirstAt) : 0,
        reads: routeNotes.length - notesBefore,
        posts: filePosts.length - postsBefore,
        label: pagesLabel(),
        pagesInHost: pagesInHost(),
        pagesInDoc: pagesInDoc(),
        canvases: canvasCount(),
        mark: markNow(),
        zoom: zoomLabel(),
        scroll: Math.round(frame.scrollTop),
        count: findCount(),
        marks: marks(),
        markCurrent: markCurrent(),
        outlineRows: qa(".fp-outline-row").length,
        renderedZoom: qa(".fp-pages .page").slice(0, 2).map((page) => page.dataset.renderedZoom ?? "-").join("|"),
        pageWidth: Math.round(q(".fp-pages .page")?.getBoundingClientRect().width ?? 0),
      };
    };
    const brief = (row) => `${row.file}:${row.ms}ms/ready=${row.reached}/load=${row.loadInserted}`
      + `(inserts=${row.loadInserts},ticks=${row.loadTicks},ms=${row.loadMs})`
      + `/reads=${row.reads}/posts=${row.posts}/label=${row.label}/pages=${row.pagesInHost}/${row.pagesInDoc}`
      + `/canvas=${row.canvases}/mark=${row.mark || "-"}/zoom=${row.zoom}/rz=${row.renderedZoom}/pw=${row.pageWidth}`
      + `/scroll=${row.scroll}`
      + `/count=${row.count}/hl=${row.marks}/${row.markCurrent}/rows=${row.outlineRows}`;

    // 0) 起点：A 是页面自己的 show() 打开的（场景跑之前）。它在这里没法被冷开 ——
    //    卸载不清缓存（只有 LRU 淘汰和失败 retry 会），所以可比的冷开基线只有 B
    //    的第一次打开（200 页，从没读过）。
    note("openEntry", useToolboxShow ? "toolbox-show" : "replicated-show");
    note("diskDirTail", String(diskDir).slice(-40));
    note("readyAtStart", await fine(() => q(".fp-pages .page") !== null && !loadingNow(), 30000));
    note("labelAtStart", pagesLabel());
    note("totalAtStart", pagesTotal());
    note("routeNotesAtStart", routeNotes.length);
    note("filePostsAtStart", filePosts.length);

    // 6) 搜索：先查，切回来命中数必须一样、标记还得画着
    click(t("find"));
    await until(() => q(".fp-find-input") !== null, 4000);
    const findInput = q(".fp-find-input");
    findInput.focus();
    type(findInput, "Revision");
    note("findAnswered", await fine(() => findCount() !== "", 15000));
    await settle(500);
    const countBefore = findCount();
    note("findCountBefore", countBefore);
    note("hitsBefore", hitsOf(countBefore));
    note("marksBefore", marks());
    note("markCurrentBefore", markCurrent());

    // 5) 阅读位置：第 5 页 + 150%，都走真的工具栏控件
    const pageBox = q(".fp-page-input");
    pageBox.focus();
    type(pageBox, "5");
    pageBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle(900);
    note("pageSetTo5", pagesLabel());
    const zoomSteps = [];
    for (let step = 0; step < 14 && !zoomLabel().startsWith("150"); step += 1) {
      zoomSteps.push(zoomLabel());
      click(t("zoomIn"));
      await settle(260);
    }
    await settle(900);
    note("zoomSteps", zoomSteps.join(">"));
    const pageAtSwitch = pagesLabel();
    const zoomAtSwitch = zoomLabel();
    const scrollAtSwitch = Math.round(frame.scrollTop);
    note("pageBeforeSwitch", pageAtSwitch);
    note("zoomBeforeSwitch", zoomAtSwitch);
    note("scrollBeforeSwitch", scrollAtSwitch);
    document.querySelector("#host .fp-pages").dataset.parkMark = "a";
    note("pagesInHostBeforeSwitch", pagesInHost());

    // ---- 往返：A→B→A→B→A
    const readyB = () => (pagesLabel() ?? "").endsWith("/ 200") && q(".fp-pages .page") !== null && !loadingNow();
    const readyA = () => (pagesLabel() ?? "").endsWith("/ 12") && q(".fp-pages .page") !== null && !loadingNow();
    const rows = [];
    const pushRow = (tag, row) => {
      rows.push(row);
      note(tag, brief(row));
      return row;
    };

    const openB = pushRow("round1_AtoB", await switchRound("big.pdf", readyB));
    note("openMsBFresh", openB.ms);
    note("pagesInHostAfterOpenB", pagesInHost());
    note("pagesInDocAfterOpenB", pagesInDoc());
    note("canvasAfterOpenB", canvasCount());
    note("markGoneWhileB", markNow() === "a");

    const backA = pushRow("round2_BtoA", await switchRound("outline.pdf", readyA));
    note("switchBackMs", backA.ms);
    note("readCount", backA.reads);
    note("routePostsOnSwitchBack", backA.posts);
    note("loadingDuringSwitchBack", backA.loadInserted);
    note("loadingInsertsOnSwitchBack", backA.loadInserts);
    note("loadingMsOnSwitchBack", backA.loadMs);
    note("pagesNodeIdentity", backA.mark === "a");
    note("pagesCountInHost", backA.pagesInHost);
    note("pagesCountInDoc", backA.pagesInDoc);
    note("pageAfterBack", backA.label);
    note("zoomAfterBack", backA.zoom);
    note("scrollTopAfterBack", backA.scroll);
    note("countAfterBack", backA.count);
    note("hitsAfterBack", hitsOf(backA.count));
    note("marksAfterBack", backA.marks);
    note("markCurrentAfterBack", backA.markCurrent);
    note("findBarAfterBack", q(".fp-find-input") !== null);
    // 标记只画在已经渲染出来的页上，命中在第 1 页而回来时停在第 5 页 —— 所以先等
    // 一会儿，再点「下一处」逼它跳到命中页，才知道标记是「没画」还是「不在这一页」。
    const markWaitStarted = performance.now();
    const markLanded = await fine(() => marks() > 0, 4000);
    const marksAtWait = marks();
    note("marksLandedWaiting", markLanded);
    note("marksWaitMs", Math.round(performance.now() - markWaitStarted));
    note("marksAfterWait", marksAtWait);
    note("markCurrentAfterWait", markCurrent());
    const pageBeforeNextHit = pagesLabel();
    click(t("findNext"));
    await settle(1400);
    note("pageAfterNextHit", pagesLabel());
    note("nextHitMoved", pagesLabel() !== pageBeforeNextHit);
    note("marksAfterNextHit", marks());
    note("markCurrentAfterNextHit", markCurrent());
    note("countAfterNextHit", findCount());

    // 7) 回来之后滚动还有反应：page 读数要跟着动
    const pageBeforeScroll = pagesLabel();
    frame.scrollTop += 1200;
    await settle(1200);
    const pageAfterScroll = pagesLabel();
    note("pageAfterScroll", pageAfterScroll);
    note("pageBeforeScroll", pageBeforeScroll);
    note("pageAfterScrollChanged", pageAfterScroll !== pageBeforeScroll);
    note("scrollAfterScroll", Math.round(frame.scrollTop));
    note("chipAfterScrollOnBack", q(".fp-chip") !== null);

    // 8) 目录：复挂之后目录树要立刻在，点第 2 行要跳到那一章
    click(t("outline"));
    note("outlineShown", await fine(() => qa(".fp-outline-row").length > 0, 8000));
    const rowsAfterBack = qa(".fp-outline-row").length;
    note("rowsAfterBack", rowsAfterBack);
    note("outlineTitles", qa(".fp-outline-row").slice(0, 3).map((row) => row.getAttribute("title")).join("|"));
    const pageBeforeOutline = pagesLabel();
    if (rowsAfterBack > 1) qa(".fp-outline-row")[1].click();
    await settle(1600);
    const outlineJumpPage = pagesLabel();
    note("outlineJumpPage", outlineJumpPage);
    note("outlineJumped", outlineJumpPage !== pageBeforeOutline);
    click(t("outline"));
    await settle(400);

    // 9) 再两趟：B→A 之外还要 A→B→A 一共三趟往返（A→B, B→A, A→B, B→A）
    const againB = pushRow("round3_AtoB", await switchRound("big.pdf", readyB));
    const againA = pushRow("round4_BtoA", await switchRound("outline.pdf", readyA));
    note("thirdTrip_PagesInHost", againB.pagesInHost);
    note("fourthTrip_PagesInHost", againA.pagesInHost);
    note("pagesInHostEveryRound", rows.map((row) => row.pagesInHost).join(","));
    note("canvasEveryRound", rows.map((row) => row.canvases).join(","));
    note("canvasGrewEachRound", rows.every((row, at) => at === 0 || row.canvases > rows[at - 1].canvases));
    note("readsEveryRound", rows.map((row) => row.reads).join(","));
    note("loadEveryRound", rows.map((row) => row.loadInserted).join(","));
    note("msEveryRound", rows.map((row) => row.ms).join(","));
    note("pageAfterFourSwitches", pagesLabel());
    note("zoomAfterFourSwitches", zoomLabel());
    note("marksAfterFourSwitches", marks());
    note("countAfterFourSwitches", findCount());
    note("rowsAfterFourSwitches", qa(".fp-outline-row").length);
    note("routeNotesTotal", routeNotes.length);
    note("filePostsTotal", filePosts.length);

    // 附带一条：从没开过的第三份文档（plain.pdf，4 页）是「冷开」，它应该从第 1 页
    // 开始 —— 量它接手时 .fp-frame 的 scrollTop，看上一份文档的滚动位置是不是被带
    // 过去了（A→B 那一趟也量到 B 直接落在 5 / 200、scroll=5168）。
    const scrollBeforeThird = Math.round(frame.scrollTop);
    const freshThird = await switchRound("plain.pdf", () => (pagesLabel() ?? "").endsWith("/ 4")
      && q(".fp-pages .page") !== null && !loadingNow());
    note("thirdDoc", brief(freshThird));
    note("scrollBeforeThirdDoc", scrollBeforeThird);
    note("scrollOnFreshThirdDoc", freshThird.scroll);
    note("labelOnFreshThirdDoc", freshThird.label);
    note("zoomOnFreshThirdDoc", freshThird.zoom);
    note("scrollInheritedOnFreshOpen", freshThird.scroll === scrollBeforeThird);

    // ---- 断言：一条读数一个 verdict（ok / FAIL）。以后谁动 openDocuments 或 places 的
    // 代码，红绿直接在这里看得见，不用再读一遍上面那堆读数。
    const verdict = (name, ok, measured) => note(`assert_${name}`, `${ok ? "ok" : "FAIL"} (${measured})`);
    verdict("cachedSwitchReadsNothing", backA.reads === 0 && backA.posts === 0,
      `reads=${backA.reads}/posts=${backA.posts}`);
    verdict("cachedSwitchReattachesSameNode", backA.mark === "a", `mark=${backA.mark || "-"}`);
    verdict("onePagesContainerEveryRound", rows.every((row) => row.pagesInHost === 1) && backA.pagesInDoc === 1,
      `host=${rows.map((row) => row.pagesInHost).join(",")}/doc=${backA.pagesInDoc}`);
    verdict("cachedSwitchNoLoadingOverlay", backA.loadInserted === false,
      `inserts=${backA.loadInserts}/ticks=${backA.loadTicks}`);
    verdict("cachedSwitchRestoresPlace", backA.label === pageAtSwitch && backA.zoom === zoomAtSwitch
      && backA.scroll === scrollAtSwitch,
      `${backA.label}@${backA.zoom}@${backA.scroll} 应为 ${pageAtSwitch}@${zoomAtSwitch}@${scrollAtSwitch}`);
    verdict("cachedSwitchKeepsFindHits", hitsOf(backA.count) === hitsOf(countBefore) && hitsOf(backA.count) > 0,
      `${backA.count} 应为 ${countBefore}`);
    verdict("cachedSwitchRepaintsMarks", markLanded === true, `hl=${marksAtWait}/waited=${markLanded}`);
    verdict("scrollStillLiveAfterBack", pageAfterScroll !== pageBeforeScroll, `${pageBeforeScroll} -> ${pageAfterScroll}`);
    verdict("outlineStillLiveAfterBack", rowsAfterBack > 0 && outlineJumpPage !== pageBeforeOutline,
      `rows=${rowsAfterBack}/${pageBeforeOutline} -> ${outlineJumpPage}`);
    // 画布数跟着当前文档走（A=12、B=200），所以判据是「同一份文档两次进来一样多」，
    // 不是「逐趟单调不减」—— 换文档当然会掉下去。
    verdict("fourSwitchesDoNotGrow", rows.length === 4 && rows[1].canvases === rows[3].canvases
      && rows[0].canvases === rows[2].canvases && againA.mark === "a" && againA.pagesInHost === 1,
      `A=${rows[1].canvases}/${rows[3].canvases} B=${rows[0].canvases}/${rows[2].canvases}`);
    verdict("freshDocumentStartsAtPageOne", freshThird.label.startsWith("1 /") && freshThird.scroll === 0,
      `${freshThird.label}@${freshThird.scroll}/zoom=${freshThird.zoom}`);

    clearInterval(loadSampler);
    loadObserver.disconnect();
    window.fetch = pageFetch;
    Array.prototype.push = nativePush;
  },
};
