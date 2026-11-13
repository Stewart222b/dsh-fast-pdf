// Probes owned by hunt-c (find / lifecycle / aria / Escape order / menu / sheet).
// Add a key per probe: the key is the `?scenario=` value. Every probe measures
// the pane in the browser and reports through `note`; a `note` key named in an
// assertion is the one that has to change when its bug is fixed.
//
// Probe → the bug it guards (each one measured red on the old code, green after
// the fix; `—` marks a probe that guards behaviour nobody has broken yet):
//   c-find-count      C4  命中数没有 live region（role / aria-live 都是 null）
//                     —   顺带守住「全文档命中数」与已画 `.hl` 的账
//   c-find-step       C5  同一帧两下 Enter / 两下「下一个」只走一格
//                     C6  同一帧连点两次「区分大小写」/「整个词」只翻一次
//   c-find-esc        C1  一次 Escape 收两层（菜单 + 查找栏一起关）
//                     C2  焦点在页面上时 Escape 收不掉查找栏
//   c-find-jump       —   跳到命中必有且只有一个 `.hl.current`
//   c-aria            C3  查找框没有可访问名（`unnamedTabbables` 里唯一一只）
//                     C4  命中数的 role / aria-live
//   c-pw              C7  密码框没有可访问名
//                     C10 密码卡没有身份也没有名字（role / aria-label 都是 null）
//                     C11 输错的提示不播报（提示行不是 live region）
//   c-pw-cancel       —   取消密码后有出口，重试能把密码卡叫回来
//   c-live            —   换文档 / reload / 34 MB 途中切走之后收尾干净
//   c-find-index      C8  索引还没建完就说「没有找到」（假否定）
//   c-find-typing     C9  每次键入后 `FIND_DEBOUNCE_MS` 窗口里计数的中间态
//   c-find-index-late C8  决定性度量：打开后立刻查只存在于最后一页的词
//   c-narrow          —   260 宽：Tab 顺序对视觉顺序、⋯ 之后不跳出窗格、查找栏不切不叠
//   c-stack           C12 密码框里一次 Escape 掀两层（取消密码 + 关菜单），直落失败片
//   c-stack2          —   属性卡 + 查找栏同开时的层叠与「一次只收一层」
//   hunt-c-switchcache —  换文档/切回同一份：每次切换都重读整份文件，画布重建，页码不恢复
//   hunt-c-fonts      —   pane 与宿主的字体族/字号逐项读数（真机上族相同、mock 里缺 --dsw-font）
//
// 每条要喂哪份样本（`-Sample`）—— **喂错不会红，只会静静量空气**，这最坑：
//   绝大多数    outline.pdf   查的是 `Page` / `page` / `zzzz`，两份样本都有或都没有
//   c-find-count  plain.pdf   写死查 `Page 2 of`（全文档唯一一处）、`Page 3 of`
//   c-find-typing plain.pdf   同上，比的是 debounce 窗口里的中间态
//   c-find-index-late big.pdf 写死查 `Page 199 of`，要 200 页那份；喂 12 页的
//                             outline.pdf 会得到 `lateTypingSawFalseNegative=true`
//                             —— 那是「这份文档里真的没有」，不是 C8 复发
//   c-pw / c-pw-cancel / c-stack   pw-aes.pdf   加密样本，口令 secret
//   hunt-c-switchcache            outline.pdf  （自己再取 big.pdf 当「另一份文档」）
export default {
  /**
   * Find: the three hit counts, and whether "hits in the document" and
   * "highlights actually painted" can both be true at once.
   *
   * Watches: 全文档命中数与 `.hl` 个数对不上（惰性装饰何时变成谎报）; 正则特殊
   * 字符查询不能抛（`.*` `(` `[` `\` `a|b` 都要当字面量）; 命中数有没有 live
   * region 让读屏听见（`role` / `aria-live` 都是 null 就是红的那条）。
   */
  "c-find-count": async ({ note, until, settle, click, type, all, text, DICT }) => {
    const countText = () => (text("#host .fp-find-count") ?? "-").trim();
    const field = () => document.querySelector("#host .fp-find-input");
    const marks = () => all("#host .hl").length;

    click(DICT.find);
    note("barOpened", await until(() => field() !== null, 5000));

    // 0 命中: 说「没有找到」，不留高亮。
    type(field(), "zzzz");
    note("zeroHitReached", await until(() => countText() === DICT.findNone, 15000));
    note("zeroHitText", countText());
    note("zeroHitMarks", marks());

    // 1 命中: plain.pdf 第 2 页的「Page 2 of」，全文档只有一处。
    // 读数落了以后要量两个时刻：`until` 只保证计数文本对，框可能还在下一帧 ——
    // 之前就是 600 ms 读到 0 个框（当时判成 bug，后来逐页追查是采样太早）。
    type(field(), "Page 2 of");
    note("oneHitReached", await until(() => /^1 \/ 1$/u.test(countText()), 15000));
    note("oneHitText", countText());
    await settle(600);
    note("oneHitMarks", marks());
    await settle(1800);
    note("oneHitMarksLater", marks());
    note("oneHitMarkPage", all("#host .hl")[0]?.closest(".page")?.dataset.pageNumber ?? "-");
    // 再从 0 命中切回来一次：0 → 1 的排序最容易漏刷新。
    type(field(), "zzzz");
    await until(() => countText() === DICT.findNone, 15000);
    type(field(), "Page 3 of");
    note("secondCycleReached", await until(() => /^1 \/ 1$/u.test(countText()), 15000));
    await settle(600);
    note("secondCycleMarks", marks());
    await settle(1800);
    note("secondCycleMarksLater", marks());

    // 4 页全部渲染完毕的文档上，命中数必须等于画出的 `.hl` 数。
    type(field(), "Page");
    note("allHitReached", await until(() => /^1 \/ 4$/u.test(countText()), 15000));
    await settle(900);
    const textSpanPages = all("#host .fp-pages .page")
      .filter((page) => page.querySelector(".textLayer span") !== null).length;
    note("allHitText", countText());
    note("allHitMarks", marks());
    note("allHitMarkPages", new Set(all("#host .hl")
      .map((el) => el.closest(".page")?.dataset.pageNumber ?? "?" )).size);
    // 「画过的页」= 上了位图的页（`data-rendered-zoom`），这才是高亮会去装饰的集合。
    note("paintedPages", all("#host .fp-pages .page[data-rendered-zoom]")
      .map((page) => page.dataset.pageNumber).join(","));
    note("textSpanPages", textSpanPages);
    note("pageCount", all("#host .fp-pages .page").length);
    note("hlLayers", all("#host .hlLayer").length);
    note("hlLayerEmpty", all("#host .hlLayer").filter((layer) => layer.childElementCount === 0).length);
    // 当前命中有且只有一个（`.hl.current`），否则「下一个」按了也看不出走到哪。
    note("currentMarks", all("#host .hl.current").length);

    // 正则特殊字符: 查询串一律按字面量处理，不能抛 RegExp 语法错。
    const special = [];
    for (const query of [".*", "(", "[", "\\", "a|b"]) {
      type(field(), query);
      await settle(800);
      special.push(`${query}→${countText()}${marks() > 0 ? `+hl${marks()}` : ""}`);
    }
    note("specialQueries", special.join(" | "));
    note("specialNoThrow", document.querySelector("#host .fp-status[data-failed]") === null);

    // 读屏能不能听见结果数：`.fp-find-count` 的 role / aria-live。
    const countEl = document.querySelector("#host .fp-find-count");
    note("countRole", countEl?.getAttribute("role"));
    note("countAriaLive", countEl?.getAttribute("aria-live"));
    note("findbarRole", document.querySelector("#host .fp-findbar")?.getAttribute("role"));

    field().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(500);
    note("barClosedByEscape", document.querySelector("#host .fp-findbar") === null);
    note("marksAfterClose", marks());
  },

  /**
   * Find stepping: two presses in one frame.
   *
   * Watches: 「同一帧里两次 Enter / 两次「下一个」只前进一格」——`stepFind` 读
   * 的是 `find.index` 这个 state 闭包值，跟上一轮页码「翻页跳数」是同一族。
   * 断言: 4 个命中、停在 1 时，两个 Enter 之后计数必须是 `3 / 4`。
   */
  "c-find-step": async ({ note, until, settle, click, type, all, text, DICT }) => {
    const countText = () => (text("#host .fp-find-count") ?? "-").trim();
    const field = () => document.querySelector("#host .fp-find-input");
    const press = (el, key) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

    click(DICT.find);
    note("barOpened", await until(() => field() !== null, 5000));
    type(field(), "Page");
    note("reached", await until(() => /^1 \/ 4$/u.test(countText()), 15000));
    await settle(500);
    note("stepStart", countText());

    // 同一帧内两下 Enter。
    press(field(), "Enter");
    press(field(), "Enter");
    await settle(900);
    note("afterTwoEnter", countText());

    // 同一帧内两下「下一个」。
    const nextButton = () => all("#host button").find((b) => b.getAttribute("aria-label") === DICT.findNext);
    const before = countText();
    nextButton().click();
    nextButton().click();
    await settle(900);
    note("beforeTwoNext", before);
    note("afterTwoNext", countText());
    note("frameAfterTwoNext", Math.round(document.querySelector("#host .fp-frame")?.scrollTop ?? -1));

    // 同一帧内连切两次「区分大小写」：应当按回原位（pressed=false、命中还在）。
    type(field(), "page");
    await until(() => /^1 \/ 4$/u.test(countText()), 15000);
    const caseButton = () => all("#host button").find((b) => b.getAttribute("aria-label") === DICT.matchCase);
    note("caseBefore", caseButton()?.getAttribute("aria-pressed"));
    note("caseCountBefore", countText());
    caseButton().click();
    caseButton().click();
    await settle(1000);
    note("caseAfterTwoClicks", caseButton()?.getAttribute("aria-pressed"));
    note("caseCountAfter", countText());

    // 同一帧内连切两次「整个词」。
    const wordButton = () => all("#host button").find((b) => b.getAttribute("aria-label") === DICT.wholeWord);
    type(field(), "page");
    await settle(900);
    note("wordBefore", wordButton()?.getAttribute("aria-pressed"));
    wordButton().click();
    wordButton().click();
    await settle(1000);
    note("wordAfterTwoClicks", wordButton()?.getAttribute("aria-pressed"));
    note("wordCountAfter", countText());
  },

  /**
   * Escape order: one press, one layer.
   *
   * Watches: ①查找框里一次 Escape 把菜单也一起收掉（一次收两层，优先级失效）；
   * ②焦点不在输入框时 Escape 收不掉查找栏（`onRootKeyDown` 里没有查找分支）。
   * 断言: ①只关菜单、查找栏还在；②焦点在页面上按 Escape 后 `.fp-findbar` 应当消失。
   */
  "c-find-esc": async ({ note, until, settle, click, type, all, text, DICT, openMore }) => {
    const bar = () => document.querySelector("#host .fp-findbar");
    const field = () => document.querySelector("#host .fp-find-input");
    const menu = () => document.querySelector("#host .fp-menu");
    const press = (el, key) => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));

    click(DICT.find);
    note("barOpened", await until(() => field() !== null, 5000));
    type(field(), "Page");
    await until(() => /\d+ \/ \d+/u.test((text("#host .fp-find-count") ?? "")), 15000);
    note("menuOpened", await openMore());
    note("bothOpen", bar() !== null && menu() !== null);

    // 焦点留在输入框里（Toolbar 的 onMouseDown 会 preventDefault，点按钮不掉焦点）。
    field().focus();
    note("focusInField", document.activeElement === field());
    press(field(), "Escape");
    await settle(450);
    // 一层一层收：菜单走了，查找栏还留着；再按一次才轮到查找栏。
    note("escMenuGone", menu() === null);
    note("escBarGone", bar() === null);
    note("escOneLayerOnly", menu() === null && bar() !== null);
    press(field(), "Escape");
    await settle(450);
    note("escSecondPressBarGone", bar() === null);
    note("escSecondPressMenuStayed", menu() === null);
    // 关掉之后焦点落在哪：键盘用户不该被扔回 body（从输入框里按 Escape 是最常见的
    // 关栏姿势，焦点丢了就等于得从头 Tab 一遍）。
    note("focusAfterBarClosed", (() => {
      const at = document.activeElement;
      if (at === null || at === document.body) return "body";
      return `${at.tagName.toLowerCase()}.${(at.className || "-").toString().split(" ")[0]}`;
    })());

    // 焦点不在输入框：先在页面上按一下（frame 是 tabIndex=-1，点一下就聚焦）。
    if (bar() === null) click(DICT.find);
    await until(() => field() !== null, 5000);
    type(field(), "Page");
    await until(() => /\d+ \/ \d+/u.test((text("#host .fp-find-count") ?? "")), 15000);
    const frame = document.querySelector("#host .fp-frame");
    frame.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    frame.focus();
    note("focusOnFrame", document.activeElement === frame);
    note("barOpenBeforeFrameEsc", bar() !== null);
    press(frame, "Escape");
    await settle(450);
    note("barClosedFromFrame", bar() === null);
    note("selectedTogglesAfterFrameEsc", all("#host button")
      .filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.getAttribute("aria-label")).join(","));

    // 属性卡 + 查找栏同开时，Escape 只收属性卡（顺序：菜单 → 属性卡 → 气泡 → 查找栏）。
    if (bar() === null) {
      click(DICT.find);
      await until(() => field() !== null, 5000);
    }
    note("barOpenBeforeSheet", bar() !== null);
    await openMore();
    all("#host .fp-menu-row").find((el) => el.textContent.trim() === DICT.properties)?.click();
    note("sheetOpened", await until(() => document.querySelector("#host .fp-panel") !== null, 6000));
    note("sheetLayerCount", all("#host .fp-panel").length);
    press(document.querySelector("#host .fp-panel"), "Escape");
    await settle(400);
    note("sheetGoneAfterEscape", document.querySelector("#host .fp-panel") === null);
    note("barStillOpenAfterSheetEsc", bar() !== null);
  },

  /**
   * Where the highlight lands when find jumps to a hit.
   *
   * Watches: 「跳到的那一处没有框」——命中数说 N / M、页码也跳到那一页，可那一页的
   * `.hlLayer` 里一个 `.hl` 都没有。逐页量，每页量三次（0 / 400 / 1500 ms）以排除
   * 「只是我先读了」。
   *
   * 查询词**从文档自己的文字里取**，不写死 `Page N of`：写死的话换一份样本（比如
   * `outline.pdf`）就一条也搜不到，四次 20 s 超时叠起来会把驱动的 90 s 预算烧穿，
   * 于是看起来像「探针里抛了个没接住的错、连一条 `probeStage` 都没有」。
   */
  "c-find-jump": async ({ note, until, settle, click, type, all, text, DICT, pagesLabel }) => {
    const startedAt = Date.now();
    const countText = () => (text("#host .fp-find-count") ?? "-").trim();
    const marks = () => all("#host .hl").length;
    const currentMarks = () => all("#host .hl.current").length;
    const markPages = () => new Set(all("#host .hl")
      .map((el) => el.closest(".page")?.dataset.pageNumber ?? "?")).size;
    const painted = () => all("#host .fp-pages .page[data-rendered-zoom]")
      .map((page) => page.dataset.pageNumber).join(",");
    const currentOn = () => (all("#host .hl.current")[0]?.closest(".page")?.dataset.pageNumber ?? "-");
    const countPattern = /^\d+\s*\/\s*\d+$/u;
    const hasHits = () => countPattern.test(countText())
      && Number.parseInt(countText().split("/")[0], 10) > 0;
    // 页眉页脚上的词每页都一样（`Page`），拿它当查询只会得到 47 个命中，
    // 所以优先取这一页**靠后**的词：正文词比页眉更可能是这一页独有的。
    const tokensOn = (pageNumber) => {
      const page = all("#host .fp-pages .page").find((el) => el.dataset.pageNumber === pageNumber);
      if (page === undefined) return [];
      const words = [];
      for (const span of page.querySelectorAll(".textLayer span")) {
        const body = (span.textContent ?? "").trim();
        for (const word of body.match(/[A-Za-z]{4,}/gu) ?? []) words.push(word);
        if (words.length === 0) {
          const cjk = body.match(/[\u4e00-\u9fa5]{2,4}/u);
          if (cjk !== null) words.push(cjk[0]);
        }
      }
      return words;
    };

    click(DICT.find);
    note("barOpened", await until(() => document.querySelector("#host .fp-find-input") !== null, 5000));
    const field = () => document.querySelector("#host .fp-find-input");
    note("paintedBefore", painted());

    const total = Math.min(Number.parseInt((text("#host .fp-pages-count") ?? "0").trim(), 10) || 4, 4);
    const rows = [];
    const used = new Set();
    let queries = 0;
    for (let page = 1; page <= total; page += 1) {
      // 驱动给整条探针 90 s：自己留出余量，别把预算烧在一条搜不到的查询上。
      if (Date.now() - startedAt > 55000) { rows.push(`stop:budget@p${page}`); break; }
      const words = tokensOn(String(page));
      const token = words.findLast((word) => !used.has(word)) ?? null;
      if (token === null) { rows.push(`p${page}:skip=${words.length === 0 ? "no-text" : "all-used"}`); continue; }
      used.add(token);
      // 先清空再输入：不然「上一次查询的计数」会让这一次的读数看起来已经就绪
      // （两次查询都可能停在 `1 / 12`，光比字符串分不出是新的还是旧的）。
      type(field(), "");
      await settle(400);
      type(field(), token);
      queries += 1;
      // 要量的是**落点**：有命中，且当前命中框恰好一个。清空重来之后这条才算数。
      const found = await until(() => hasHits() && currentMarks() === 1, 8000);
      const at0 = marks();
      await settle(400);
      const at400 = marks();
      await settle(1500);
      const at1900 = marks();
      rows.push(`p${page}:q=${token}:found=${found}:self=${countText().replace(/\s+/gu, "")}`
        + `:label=${(pagesLabel() ?? "-").replace(/\s+/gu, "")}`
        + `:marks=${at0}/${at400}/${at1900}:current=${currentMarks()}@${currentOn()}`
        + `:markPages=${markPages()}:painted=${painted()}`);
    }
    note("queryPicks", `queries=${queries} total=${total} elapsedMs=${Date.now() - startedAt}`);
    note("perPageJump", rows.join(" | "));

    // 对照：同一页再查一次（那一页早就在渲染集合里，命中框应当立刻有）。
    const repeat = rows.find((row) => row.includes(":q="))?.match(/:q=([^:]+)/u)?.[1] ?? null;
    if (repeat !== null) {
      type(field(), repeat);
      await until(() => hasHits(), 8000);
      await settle(600);
      note("repeatOnSamePage", `q=${repeat} marks=${marks()} current=${currentMarks()}@${currentOn()}`);
    } else {
      note("repeatOnSamePage", "skipped:no-token");
    }
  },

  /**
   * Accessible names and states, button by button.
   *
   * Watches: 查找框/密码框没有可访问名（只有 placeholder，`aria-label` 为 null、
   * 没有 `label[for]`、没有 `title`）; 空 `role=""` / `aria-*=""`; tabbable 但
   * 没有名字的元素; 每个开关的 `aria-pressed` 真假。
   */
  "c-aria": async ({ note, until, settle, click, type, all, text, DICT, openMore }) => {
    const nameOf = (el) => {
      const aria = el.getAttribute("aria-label");
      if (aria !== null && aria.trim() !== "") return `aria-label:${aria.trim()}`;
      const by = el.getAttribute("aria-labelledby");
      if (by !== null && by.trim() !== "") return `aria-labelledby:${by.trim()}`;
      const ownText = (el.textContent ?? "").trim();
      if (ownText !== "") return `text:${ownText.slice(0, 16)}`;
      const title = el.getAttribute("title");
      if (title !== null && title.trim() !== "") return `title:${title.trim()}`;
      if (el.id !== "") {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label !== null) return `label-for:${(label.textContent ?? "").trim().slice(0, 16)}`;
      }
      if (el.closest("label") !== null) return `label-wrap:${(el.closest("label").textContent ?? "").trim().slice(0, 16)}`;
      return "NONE";
    };
    const visible = (el) => el.getClientRects().length > 0;
    const tabbable = (el) => el.matches("button, a[href], input, select, textarea, [tabindex]")
      && el.tabIndex >= 0 && !el.disabled && visible(el);
    const inputTriple = (el) => {
      if (el === null) return "missing";
      const id = el.id;
      const labelFor = id === "" ? 0 : document.querySelectorAll(`label[for="${id}"]`).length;
      return [
        `aria-label=${el.getAttribute("aria-label")}`,
        `title=${el.getAttribute("title")}`,
        `label[for]=${labelFor}`,
        `placeholder=${el.getAttribute("placeholder")}`,
        `role=${el.getAttribute("role")}`,
      ].join(" ");
    };

    // 工具栏（未开任何浮层）。
    const toolbar = all("#host button").map((b) => `${b.getAttribute("aria-label") ?? "(无名)"}`
      + `[text=${(b.textContent ?? "").trim() === "" ? "-" : (b.textContent ?? "").trim()}:`
      + `pressed=${b.getAttribute("aria-pressed")}:disabled=${b.disabled ? "1" : "0"}:${nameOf(b)}]`);
    note("toolbarButtons", toolbar.join(" "));
    const more = all("#host button").find((b) => b.getAttribute("aria-label") === DICT.more);
    note("morePressedClosed", more?.getAttribute("aria-pressed"));
    note("moreHaspopup", more?.getAttribute("aria-haspopup"));
    note("moreExpanded", more?.getAttribute("aria-expanded"));
    note("frameTabIndex", document.querySelector("#host .fp-frame")?.getAttribute("tabindex"));

    // 页码框。
    note("pageInput", inputTriple(document.querySelector("#host .fp-page-input")));

    // 查找栏：输入框 + 两个开关的 pressed 真假。
    click(DICT.find);
    note("findBar", await until(() => document.querySelector("#host .fp-find-input") !== null, 5000));
    note("findInput", inputTriple(document.querySelector("#host .fp-find-input")));
    const caseButton = all("#host button").find((b) => b.getAttribute("aria-label") === DICT.matchCase);
    const wordButton = all("#host button").find((b) => b.getAttribute("aria-label") === DICT.wholeWord);
    note("caseToggle", `${caseButton?.getAttribute("aria-pressed")}:disabled=${caseButton?.disabled ? "1" : "0"}`);
    note("wordToggle", `${wordButton?.getAttribute("aria-pressed")}:disabled=${wordButton?.disabled ? "1" : "0"}`);
    note("findPrevDisabledEmpty", all("#host button").find((b) => b.getAttribute("aria-label") === DICT.findPrevious)?.disabled);
    caseButton?.click();
    await settle(350);
    note("caseToggleAfterClick", all("#host button")
      .find((b) => b.getAttribute("aria-label") === DICT.matchCase)?.getAttribute("aria-pressed"));
    note("findCountAria", (() => {
      const el = document.querySelector("#host .fp-find-count");
      return `role=${el?.getAttribute("role")} live=${el?.getAttribute("aria-live")}`;
    })());

    // 菜单打开：按钮的 pressed 才是开口的唯一读法。
    note("menuOpened", await openMore());
    note("morePressedOpen", all("#host button")
      .find((b) => b.getAttribute("aria-label") === DICT.more)?.getAttribute("aria-pressed"));
    note("menuRole", document.querySelector("#host .fp-menu")?.getAttribute("role"));
    note("menuRowNames", all("#host .fp-menu-row").map((el) => nameOf(el)).join(" | "));

    // 空 role / 空 aria-*：写了空串等于没写。
    const empties = [];
    for (const el of all("#host *")) {
      for (const attribute of el.attributes) {
        if (attribute.name !== "role" && !attribute.name.startsWith("aria-")) continue;
        if (attribute.value !== "") continue;
        empties.push(`${el.tagName.toLowerCase()}.${(el.className || "-").toString().split(" ")[0]}[${attribute.name}]`);
      }
    }
    note("emptyAriaAttributes", empties.join(" ") || "none");

    // tabbable 但没有名字的元素。
    const unnamed = all("#host *").filter((el) => tabbable(el) && nameOf(el) === "NONE")
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "-").toString().split(" ")[0]}`);
    note("unnamedTabbables", unnamed.join(" ") || "none");
    note("tabbableCount", all("#host *").filter(tabbable).length);

    // 属性卡：dialog 有没有名字，关闭按钮怎么说。
    all("#host .fp-menu-row").find((el) => el.textContent.trim() === DICT.properties)?.click();
    note("sheetOpened", await until(() => document.querySelector("#host .fp-panel") !== null, 6000));
    note("sheetRole", `${document.querySelector("#host .fp-panel")?.getAttribute("role")}`
      + `/${document.querySelector("#host .fp-panel")?.getAttribute("aria-label")}`
      + `/modal=${document.querySelector("#host .fp-panel")?.getAttribute("aria-modal")}`);
    note("sheetCloseName", inputTripleLike(document.querySelector("#host .fp-panel .fp-pick-close")));
    function inputTripleLike(el) {
      if (el === null || el === undefined) return "missing";
      return `aria-label=${el.getAttribute("aria-label")} title=${el.getAttribute("title")} text=${(el.textContent ?? "").trim() || "-"}`;
    }
  },

  /**
   * Password: the three names of the prompt, and 错了再输对.
   *
   * Watches: 密码框没有可访问名; 密码输错之后卡片是否给回一个能直接重输的空框、
   * 提示行是否变成「密码不对」; 输对之后画布是否出现且没有留在失败态。
   */
  "c-pw": async ({ note, until, settle, type, all, text, DICT, click }) => {
    note("promptShown", await until(() => document.querySelector("#host .fp-password-input") !== null, 20000));
    const passwordInput = () => document.querySelector("#host .fp-password-input");
    note("pwPrompt", (() => {
      const el = passwordInput();
      if (el === null) return "missing";
      return `aria-label=${el.getAttribute("aria-label")} title=${el.getAttribute("title")}`
        + ` label[for]=${el.id === "" ? 0 : document.querySelectorAll(`label[for="${el.id}"]`).length}`
        + ` placeholder=${el.getAttribute("placeholder")} role=${el.getAttribute("role")}`;
    })());
    note("pwCardRole", `${document.querySelector("#host .fp-password")?.getAttribute("role")}`
      + `/live=${document.querySelector("#host .fp-password")?.getAttribute("aria-live")}`);
    note("pwTitleText", text("#host .fp-password-title"));
    note("pwAutofocused", document.activeElement === passwordInput());
    // 提示行是不是 live region、输入框有没有把它当说明连带（aria-describedby）。
    const hintAttrs = () => {
      const hint = document.querySelector("#host .fp-password-hint");
      const el = passwordInput();
      return `hintRole=${hint?.getAttribute("role")} hintLive=${hint?.getAttribute("aria-live")}`
        + ` describedby=${el?.getAttribute("aria-describedby")}`;
    };
    note("pwHintAttrs", hintAttrs());

    // 先输错的。
    type(passwordInput(), "wrong-one");
    await settle(250);
    click(DICT.passwordOpen);
    note("wrongHint", await until(() => document.querySelector("#host .fp-password-hint[data-wrong]") !== null, 20000));
    note("wrongHintText", text("#host .fp-password-hint"));
    note("pwWrongHintAttrs", hintAttrs());
    note("wrongDraft", passwordInput()?.value ?? "gone");
    note("wrongRefocused", document.activeElement === passwordInput());
    note("wrongSubmitDisabled", document.querySelector("#host .fp-password-submit")?.disabled);

    // 再输对的。
    if (passwordInput() !== null) type(passwordInput(), "secret");
    await settle(250);
    click(DICT.passwordOpen);
    note("openedAfterRight", await until(() => all("#host .fp-pages canvas").length > 0, 25000));
    note("canvasesAfterRight", all("#host .fp-pages canvas").length);
    note("promptGoneAfterRight", document.querySelector("#host .fp-password") === null);
    note("failedStatusAfterRight", document.querySelector("#host .fp-status[data-failed]") !== null);
    note("pagesAfterRight", (document.querySelector("#host .fp-page-input")?.value ?? "-")
      + " / " + (text("#host .fp-pages-total") ?? "-"));
  },

  /**
   * Lifecycle on one pane: another document, the same document again, and a
   * 34 MB open abandoned halfway.
   *
   * Watches: 换文档后查找栏是否还报上一个文档的命中数; 同一份文件重新挂载是否
   * 留下第二份画布; 打开大文件的途中切走会不会停在失败态; 「打开→第一张位图」
   * 的实际耗时（`[data-rendered-zoom]` 落地那一刻）。
   */
  "c-live": async ({ note, until, settle, click, type, all, text, pagesLabel,
    root, Body, h, tabSignal, DICT, t }) => {
    const props = (data, address) => ({
      content: { kind: "bytes", data },
      resourceAddress: address,
      t,
      sessionId: "sess-46",
      useTabInfo: () => ({ tab: { id: "tab-body", signal: tabSignal, contentId: "content-1" } }),
      useStore: () => null,
      actions: { forget: () => {} },
      renderSlot: () => null,
    });
    // `show()` 在 `&disk=` 下会把地址钉回同一个样本文​件，所以换文档走
    // `kind: "bytes"`（宿主真实存在的另一条路径），这里如实记下来。
    const swap = (data, address) => root.render(h(Body, props(data, address)));
    const fetchBytes = async (path) => new Uint8Array(await (await fetch(path)).arrayBuffer());
    const countText = () => (text("#host .fp-find-count") ?? "-").trim();
    const canvases = () => all("#host .fp-pages canvas").length;
    note("switchVia", "content.kind=bytes");

    const plain = await fetchBytes("./samples/plain.pdf");
    note("fromPages", pagesLabel());

    // ① 查找开着、有结果的时候换文档。
    click(DICT.find);
    await until(() => document.querySelector("#host .fp-find-input") !== null, 5000);
    type(document.querySelector("#host .fp-find-input"), "Page");
    await until(() => /\d+ \/ \d+/u.test(countText()), 20000);
    note("findBeforeSwitch", countText());
    note("hlBeforeSwitch", all("#host .hl").length);

    swap(plain, "file:///C:/docs/samples/plain.pdf");
    note("switchedTo4", await until(() => (pagesLabel() ?? "").endsWith("/ 4"), 25000));
    const timeline = [];
    for (let tick = 0; tick < 10; tick += 1) {
      await settle(200);
      timeline.push(countText().replace(/\s+/gu, ""));
    }
    note("findAfterSwitch", countText());
    note("findTimelineAfterSwitch", timeline.join(">"));
    note("hlAfterSwitch", all("#host .hl").length);
    note("pagesAfterSwitch", pagesLabel());
    note("canvasesAfterSwitch", canvases());

    // ② 同一份文件再挂一次（相当于 content.reload()）：画布不能翻倍。
    const beforeReload = canvases();
    swap(plain.slice(), "file:///C:/docs/samples/plain.pdf");
    await settle(400);
    note("reloadSettled", await until(() => (pagesLabel() ?? "").endsWith("/ 4"), 25000));
    await settle(600);
    note("canvasesBeforeReload", beforeReload);
    note("canvasesAfterReload", canvases());
    note("reloadNoDoubleCanvas", canvases() === 4);
    note("reloadFailed", document.querySelector("#host .fp-status[data-failed]") !== null);

    // ③ 打开→第一张位图。`root.render()` 回来时 DOM 还是上一份文档的，直接读
    // 会读到 0 ms 的假数字（第一版就是这么读到 `openToFirstBitmapMs=0` 的），
    // 所以先等这一棵旧 DOM 真的被换掉，再等位图标记。
    const staleRoot = document.querySelector("#host .fp-pages .page");
    const t0 = performance.now();
    swap(plain.slice(), "file:///C:/docs/samples/plain.pdf");
    const swapped = await until(() => document.querySelector("#host .fp-pages .page") !== staleRoot, 30000, 16);
    const domSwapMs = Math.round(performance.now() - t0);
    const painted = await until(() => document.querySelector("#host .fp-pages .page[data-rendered-zoom]") !== null, 30000, 16);
    note("reRenderDomSwap", swapped);
    note("domSwapMs", domSwapMs);
    note("openToFirstBitmap", painted);
    note("openToFirstBitmapMs", Math.round(performance.now() - t0));
    await settle(400);

    // ④ 34 MB 打开途中切走：最后必须停在小文档上，且没有失败态。
    const huge = await fetchBytes("./samples/huge.pdf");
    note("hugeBytes", huge.length);
    swap(huge, "file:///C:/docs/samples/huge.pdf");
    await settle(120);
    note("midAt120Pages", pagesLabel());
    note("midAt120Status", document.querySelector("#host .fp-status") !== null);
    await settle(180);
    note("midAt300Pages", pagesLabel());
    note("midAt300Status", document.querySelector("#host .fp-status") !== null);
    swap(plain, "file:///C:/docs/samples/plain.pdf");
    note("backToSmall", await until(() => (pagesLabel() ?? "").endsWith("/ 4"), 30000));
    await settle(800);
    note("pagesAfterAbandon", pagesLabel());
    note("canvasesAfterAbandon", canvases());
    note("failedAfterAbandon", document.querySelector("#host .fp-status[data-failed]") !== null);
    note("statusAfterAbandon", document.querySelector("#host .fp-status") === null);
  },

  /**
   * Typing into the find bar while the index is still being built.
   *
   * Watches: 索引没建完就输入时读数怎么走（「正在建立索引…」→ 逐步长大的计数），
   * 以及最后「全文档命中数」和已渲染页上的框数是否自洽。这条现在**没有已知
   * bug**，是留给回归的基线（等 lead 修完查找相关的东西再跑一遍）。
   */
  "c-find-index": async ({ note, until, settle, click, type, all, text, DICT }) => {
    const countText = () => (text("#host .fp-find-count") ?? "-").trim();
    click(DICT.find);
    note("barOpened", await until(() => document.querySelector("#host .fp-find-input") !== null, 5000));
    // 索引是随打开并行建的：此刻键入就是在它还没建完的时候查。
    type(document.querySelector("#host .fp-find-input"), "Page 5");
    const timeline = [];
    for (let tick = 0; tick < 50; tick += 1) {
      await settle(150);
      const now = countText();
      if (timeline.at(-1) !== now) timeline.push(now);
    }
    note("countTimeline", timeline.join(">"));
    note("finalCount", countText());
    note("marks", all("#host .hl").length);
    note("markPages", new Set(all("#host .hl")
      .map((el) => el.closest(".page")?.dataset.pageNumber ?? "?")).size);
    note("paintedPages", all("#host .fp-pages .page[data-rendered-zoom]")
      .map((page) => page.dataset.pageNumber).join(","));
    note("currentMarks", all("#host .hl.current").length);
    note("pageLabel", text("#host .fp-page-input"));

    // 索引建完以后：存在的词必须落成数字，不存在的词必须落成「没有找到」——
    // 永远停在「正在建立索引…」就是 busy 泄漏的样子（lead 担心的那条）。
    note("afterIndexPresent", countText());
    type(document.querySelector("#host .fp-find-input"), "zzzzqqq");
    await settle(1400);
    note("afterIndexAbsent", countText());
    note("afterIndexAbsentNotIndexing", countText() !== DICT.findIndexing);

    // 索引还没建完就把查找栏关掉再打开：busy 会不会留着、读数还能不能更新。
    // 重新开一次窗口：先在「建索引中」键入，再立刻关栏。
    const reopenField = () => document.querySelector("#host .fp-find-input");
    click(DICT.find); // 杀掉这一轮的索引窗口前先关栏
    await settle(250);
    note("barClosed", reopenField() === null);
    click(DICT.find);
    note("barReopened", await until(() => reopenField() !== null, 5000));
    type(reopenField(), "Page 5");
    const reopenedTimeline = [];
    for (let tick = 0; tick < 20; tick += 1) {
      await settle(150);
      const now = countText();
      if (reopenedTimeline.at(-1) !== now) reopenedTimeline.push(now);
    }
    note("countTimelineAfterReopen", reopenedTimeline.join(">"));
    note("finalCountAfterReopen", countText());
    // 再按一次「下一个」：索引长大了以后步进还得动。
    const nextButton = all("#host button").find((b) => b.getAttribute("aria-label") === DICT.findNext);
    const before = countText();
    nextButton?.click();
    await settle(900);
    note("stepAfterIndex", `${before} → ${countText()}`);
  },

  /**
   * Password: declining the prompt, then retrying it.
   *
   * Watches: 点「取消」之后面板是不是停在能救回来的状态（有提示、有重试、点重试
   * 能把密码卡再叫回来），而不是一个没有出口的空白。
   */
  "c-pw-cancel": async ({ note, until, settle, click, all, text, DICT }) => {
    note("promptShown", await until(() => document.querySelector("#host .fp-password-input") !== null, 20000));
    click(DICT.passwordCancel);
    await settle(1200);
    note("tileAfterCancel", document.querySelector("#host .fp-status") !== null);
    note("failTextAfterCancel", text("#host .fp-status") ?? "-");
    note("promptGoneAfterCancel", document.querySelector("#host .fp-password") === null);
    const retry = all("#host .fp-status button")[0];
    note("retryButton", retry === undefined ? "none" : (retry.textContent ?? "").trim() || retry.getAttribute("aria-label"));
    retry?.click();
    note("promptBackAfterRetry", await until(() => document.querySelector("#host .fp-password-input") !== null, 20000));
    note("failTextAfterRetry", text("#host .fp-status") ?? "-");
    note("canvasesAfterRetry", all("#host .fp-pages canvas").length);
  },

  /**
   * What the count reads during the debounce window, keystroke by keystroke.
   *
   * Watches: 每打一个字，`FIND_DEBOUNCE_MS = 350` 那个窗口里计数显示的是**上一次
   * 查询的结论** —— 第一次输入就是「没有找到」，在已有结果的查询上再打字就挂着旧
   * 的「1 / 4」。40 ms 采样一次、只记变化点，能看出这个窗口有多长。
   */
  "c-find-typing": async ({ note, until, settle, click, type, text, DICT }) => {
    const countText = () => (text("#host .fp-find-count") ?? "-").trim();
    const watch = async (ms) => {
      const t0 = performance.now();
      const seen = [];
      let last = countText();
      seen.push(`0:${last === "" ? "(空)" : last}`);
      while (performance.now() - t0 < ms) {
        await settle(40);
        const now = countText();
        if (now !== last) {
          seen.push(`${Math.round(performance.now() - t0)}:${now === "" ? "(空)" : now}`);
          last = now;
        }
      }
      return seen.join(" ");
    };
    click(DICT.find);
    note("barOpened", await until(() => document.querySelector("#host .fp-find-input") !== null, 5000));
    const field = () => document.querySelector("#host .fp-find-input");
    note("countOnOpen", countText() === "" ? "(空)" : countText());

    // ① 第一条查询（不存在 → 结论是「没有找到」）。
    type(field(), "zzzz");
    note("firstQueryTimeline", await watch(1500));
    // ② 第二条查询（存在）：此刻的窗口里应当看到「正在建立索引…」，不是「没有找到」。
    type(field(), "Page 2 of");
    note("presentQueryTimeline", await watch(1500));
    note("presentQueryFinal", countText());
    // ③ 已有结果的查询上再打一个字：防抖窗口里是不是还挂着上一次的数字。
    note("countBeforeEdit", countText() === "" ? "(空)" : countText());
    type(field(), "Page 2 of zzz");
    note("editedQueryTimeline", await watch(1500));
    note("editedQueryFinal", countText());
    // ④ 决定性的一条：这个词只在**很后面**的页上（200 页文档的第 199 页）。索引
    // 还没走到那儿的时候按下去，显示的是「正在建立索引…」还是「没有找到」？
    note("lateCountBefore", countText() === "" ? "(空)" : countText());
    type(field(), "Page 199 of");
    note("lateQueryTimeline", await watch(2500));
    note("lateQueryFinal", countText());
  },

  /**
   * The one decisive measurement for 「索引没建完就说没有找到」.
   *
   * 打开后**立刻**键入一个只存在于最后一页的词（big.pdf 200 页），40 ms 采一次、
   * 带时间戳：如果中途出现「没有找到」，那这个否定结论就是假的（索引还在走）；
   * 如果走的是「正在建立索引…」，说明 `busy` 由渲染器进度驱动的那版是对的。
   */
  "c-find-index-late": async ({ note, until, settle, click, type, text, DICT }) => {
    const countText = () => (text("#host .fp-find-count") ?? "-").trim();
    click(DICT.find);
    note("barOpened", await until(() => document.querySelector("#host .fp-find-input") !== null, 5000));
    type(document.querySelector("#host .fp-find-input"), "Page 199 of");
    const t0 = performance.now();
    const seen = [];
    let last = "";
    while (performance.now() - t0 < 6000) {
      const now = countText();
      if (now !== last) {
        seen.push(`${Math.round(performance.now() - t0)}:${now === "" ? "(空)" : now}`);
        last = now;
      }
      await settle(40);
    }
    note("lateTypingTimeline", seen.join(" "));
    note("lateTypingSawFalseNegative", seen.some((step) => step.endsWith(DICT.findNone)));
    note("lateTypingFinal", countText());
  },

  /**
   * Narrow pane (`&pane=260`): Tab order against the visual order, and the
   * find bar once it has to wrap.
   *
   * Watches: 工具栏换行之后 Tab 顺序还是不是视觉顺序（DOM 顺序 = Tab 顺序，所以
   * 只要相邻两件出现「后面的更靠上」，键盘就是跳着走的）；从 ⋯ 再按一次 Tab 会不会
   * 直接跳出窗格；260 宽时查找栏换行后上一页/下一个有没有被切掉或叠在一起。
   */
  "c-narrow": async ({ note, until, settle, click, type, all, text, DICT }) => {
    // Tab 顺序 = DOM 顺序（没有 tabindex>0 的东西），所以「可 Tab」这一集合按 DOM
    // 顺序排出来，就是键盘实际走的路线。
    const tabbable = (el) => el.matches("button, a[href], input, select, textarea, [tabindex]")
      && el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0;
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    };
    const nameOf = (el) => el.getAttribute("aria-label")
      ?? ((el.textContent ?? "").trim().slice(0, 8) || `(${el.tagName.toLowerCase()})`);

    const items = all("#host *").filter((el) => tabbable(el)).map((el, at) => ({
      at,
      tag: `${el.tagName.toLowerCase()}.${(el.className || "-").toString().split(" ")[0]}`,
      name: nameOf(el),
      ...box(el),
    }));
    note("tabbableTrace", items.map((it) => `${it.at}:${it.tag}[${it.name}]@${it.top},${it.left}-${it.right}`).join(" "));
    const breaks = [];
    for (let i = 1; i < items.length; i += 1) {
      const previous = items[i - 1];
      const current = items[i];
      if (current.top < previous.top - 2) breaks.push(`${previous.name}→${current.name}(上)`);
      else if (Math.abs(current.top - previous.top) <= 2 && current.left < previous.left - 2) {
        breaks.push(`${previous.name}→${current.name}(左)`);
      }
    }
    note("tabOrderBreaks", breaks.join(" ") || "none");
    const moreAt = items.findIndex((it) => it.name === DICT.more);
    note("moreTabIndex", `${moreAt}/${items.length}`);
    note("nextAfterMore", items[moreAt + 1] === undefined ? "none(跳出窗格)" : `${items[moreAt + 1].tag}[${items[moreAt + 1].name}]`);
    note("toolbarBox", (() => {
      const el = document.querySelector("#host .fp-toolbar");
      const r = el === null ? null : box(el);
      return r === null ? "missing" : `${r.left},${r.top}-${r.right},${r.bottom} rows=${new Set(all("#host .fp-toolbar > *").map((c) => box(c).top)).size}`;
    })());

    // 查找栏在 260 宽下换行：输入框、两个开关、计数、上一页/下一个的相对位置。
    click(DICT.find);
    note("barOpened", await until(() => document.querySelector("#host .fp-findbar") !== null, 5000));
    type(document.querySelector("#host .fp-find-input"), "Page");
    await until(() => /\d+ \/ \d+/u.test((text("#host .fp-find-count") ?? "")), 15000);
    await settle(400);
    const barEl = document.querySelector("#host .fp-findbar");
    const barBox = box(barEl);
    const kids = [...barEl.children].map((el) => ({
      tag: `${el.tagName.toLowerCase()}.${(el.className || "-").toString().split(" ")[0]}`,
      name: nameOf(el),
      ...box(el),
    }));
    note("findbarBox", `${barBox.left},${barBox.top}-${barBox.right},${barBox.bottom}`);
    note("findbarHeight", barBox.bottom - barBox.top);
    note("findInputWidth", (() => {
      const el = document.querySelector("#host .fp-find-input");
      const r = el === null ? null : box(el);
      return r === null ? "missing" : r.right - r.left;
    })());
    note("findbarRows", (() => {
      const tops = [...new Set(kids.map((kid) => kid.top))].sort((a, b) => a - b);
      // 行 = 相邻 top 差距超过一个行的行距就算换行（同行的 ±8px 抖动不算）。
      return 1 + tops.filter((top, at) => at > 0 && top - tops[at - 1] > 24).length;
    })());
    note("findbarTopSpread", [...new Set(kids.map((kid) => kid.top))].sort((a, b) => a - b).join(","));
    note("findbarKids", kids.map((kid) => `${kid.name}@${kid.top},${kid.left}-${kid.right}`).join(" "));
    note("findbarClipped", kids.filter((kid) => kid.right > barBox.right + 1 || kid.left < barBox.left - 1)
      .map((kid) => kid.name).join(",") || "none");
    note("findbarOverlaps", (() => {
      const found = [];
      for (let i = 0; i < kids.length; i += 1) {
        for (let j = i + 1; j < kids.length; j += 1) {
          const a = kids[i];
          const b = kids[j];
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > 1 && overlapY > 1) found.push(`${a.name}×${b.name}`);
        }
      }
      return found.join(" ") || "none";
    })());
    note("paneHScroll", (() => {
      const frame = document.querySelector("#host .fp-frame");
      return frame === null ? "missing" : `${frame.scrollWidth - frame.clientWidth}/${frame.scrollHeight - frame.clientHeight}`;
    })());

    // 查找栏在场（而且换行成两行）之后，Tab 顺序还跟不跟视觉走：栏里的按钮现在
    // 落在第二行，若 DOM 顺序把它们排在工具栏之前/之后，键盘就会跳行。
    const withBar = all("#host *").filter((el) => tabbable(el)).map((el, at) => ({
      at,
      tag: `${el.tagName.toLowerCase()}.${(el.className || "-").toString().split(" ")[0]}`,
      name: nameOf(el),
      ...box(el),
    }));
    note("tabbableTraceWithBar", withBar.map((it) => `${it.at}:${it.tag}[${it.name}]@${it.top},${it.left}-${it.right}`).join(" "));
    const barBreaks = [];
    // 只比「工具栏 + 查找栏」这一圈 chrome：页面文字层是滚动内容，top 会跑到负值，
    // 拿它跟栏里的按钮比会把「页面滚上去了」误判成「Tab 顺序跳行」。
    const chrome = withBar.filter((it) => it.tag.includes(".fp-"));
    for (let i = 1; i < chrome.length; i += 1) {
      const previous = chrome[i - 1];
      const current = chrome[i];
      if (current.top < previous.top - 2) barBreaks.push(`${previous.name}→${current.name}(上)`);
      else if (Math.abs(current.top - previous.top) <= 2 && current.left < previous.left - 2) {
        barBreaks.push(`${previous.name}→${current.name}(左)`);
      }
    }
    note("tabOrderBreaksWithBar", barBreaks.join(" ") || "none");
    // 栏自己贡献了几个 Tab 停点：从输入框到第一个文字层之间那一串。
    const barFrom = withBar.findIndex((it) => it.tag.includes(".fp-find-input"));
    const barTo = withBar.findIndex((it) => it.tag.includes(".textLayer"));
    note("barTabbables", withBar.slice(barFrom, barTo).map((it) => it.name).join(",") || "none");
    note("barBeforePage", barFrom >= 0 && barTo > barFrom);
  },

  /**
   * 密码卡 + 菜单同开，然后一次 Escape。
   *
   * 三件套同开（属性卡 + 目录 + 密码卡）是**做不到**的：文档还没打开时 `文档属性`
   * 这一行就是禁用的（实测 `sheetOpened=false`，按钮表里 `文档属性(off)`），
   * pw-aes.pdf 也没有目录可开。能同开的只有「密码卡 + 菜单」。
   *
   * Watches: 密码卡是不是被菜单压住（`elementFromPoint` 落在哪一层）; 以及焦点在
   * 密码框里按一次 Escape，会不会**既取消密码（不可撤销、直接落到失败片）又关掉
   * 菜单** —— 和 C1 同一类「一次收两层」，但代价大得多。
   */
  "c-stack": async ({ note, until, settle, click, all, text, DICT }) => {
    note("promptShown", await until(() => document.querySelector("#host .fp-password-input") !== null, 20000));
    note("menuOpened", await openMore());
    all("#host .fp-menu-row").find((el) => el.textContent.trim() === DICT.properties)?.click();
    await settle(600);
    note("sheetOpenedWhilePrompting", document.querySelector("#host .fp-panel") !== null);
    note("propertiesRowState", (() => {
      const row = all("#host .fp-menu-row").find((el) => el.textContent.trim() === DICT.properties);
      return row === undefined ? "gone" : `aria-disabled=${row.getAttribute("aria-disabled")} disabled=${row.disabled ?? "-"}`;
    })());

    const layers = [["password", ".fp-password"], ["menu", ".fp-menu"], ["sheet", ".fp-panel"]];
    const ownerAt = (selector) => {
      const el = document.querySelector(`#host ${selector}`);
      if (el === null) return "absent";
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (hit === null) return "null";
      for (const [name, own] of layers.slice().reverse()) {
        if (hit.closest(`#host ${own}`) !== null) return name;
      }
      return "other";
    };
    note("layerOrder", layers.map(([name, selector]) => `${name}:top=${ownerAt(selector)}`).join(" "));
    note("layerZ", layers.map(([name, selector]) => {
      const el = document.querySelector(`#host ${selector}`);
      return el === null ? `${name}:absent` : `${name}:z=${getComputedStyle(el).zIndex}`;
    }).join(" "));

    // 密码卡 + 菜单同开时按一次 Escape（焦点在密码框里，和真人一样）。
    note("bothOpenBeforeEsc", `${document.querySelector("#host .fp-password") !== null}/${document.querySelector("#host .fp-menu") !== null}`);
    const field = document.querySelector("#host .fp-password-input");
    field?.focus();
    note("focusInPassword", document.activeElement === field);
    field?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle(700);
    note("afterEscPasswordGone", document.querySelector("#host .fp-password") === null);
    note("afterEscMenuGone", document.querySelector("#host .fp-menu") === null);
    note("afterEscFailed", document.querySelector("#host .fp-status[data-failed]") !== null);
    note("afterEscFailText", text("#host .fp-status") ?? "-");
  },

  /**
   * Layers that really can be open together (`&paneH=300`, outline.pdf): outline
   * + properties sheet + find bar, and the Escape order among them.
   *
   * Watches: 谁在最上面；以及文件里那条顺序（菜单 → 属性卡 → 气泡 → 查找栏）在
   * 「属性卡和查找栏同时在」时是不是仍然一次只收一层。
   */
  "c-stack2": async ({ note, until, settle, click, all, text, DICT }) => {
    click(DICT.outline);
    await settle(700);
    note("outlineOpened", document.querySelector("#host .fp-outline") !== null);
    note("outlineRows", all("#host .fp-outline-row").length);
    click(DICT.find);
    note("barOpened", await until(() => document.querySelector("#host .fp-findbar") !== null, 5000));
    note("menuOpened", await openMore());
    all("#host .fp-menu-row").find((el) => el.textContent.trim() === DICT.properties)?.click();
    note("sheetOpened", await until(() => document.querySelector("#host .fp-panel") !== null, 6000));

    const layers = [["sheet", ".fp-panel"], ["menu", ".fp-menu"], ["outline", ".fp-outline"], ["findbar", ".fp-findbar"]];
    const ownerAt = (selector) => {
      const el = document.querySelector(`#host ${selector}`);
      if (el === null) return "absent";
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      if (hit === null) return "null";
      for (const [name, own] of layers.slice().reverse()) {
        if (hit.closest(`#host ${own}`) !== null) return name;
      }
      return "other";
    };
    note("layerOrder", layers.map(([name, selector]) => `${name}:top=${ownerAt(selector)}`).join(" "));

    const frame = document.querySelector("#host .fp-frame");
    frame?.focus();
    note("focusOnFrame", document.activeElement === frame);
    const state = () => `sheet=${document.querySelector("#host .fp-panel") !== null}`
      + ` bar=${document.querySelector("#host .fp-findbar") !== null}`
      + ` outline=${document.querySelector("#host .fp-outline") !== null}`;
    for (const round of [1, 2, 3]) {
      frame?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await settle(450);
      note(`esc${round}`, state());
    }
    note("hostStillThere", document.querySelector("#host .fp-frame") !== null);
  },

  /**
   * 同一个标签页里换 PDF：每次都要把文件重新读一遍，还是能在会话里留住？
   *
   * ta 的原话：「每一次在顶部栏切换 pdf 都要重新加载，我以为同一个标签页加载一次
   * 就够了？后续切换不都是秒切换的吗」。为了把「有没有再读一次」变成能数出来的数，
   * 这里不走 harness 的 `show()`，而是自己 render 一遍 `Body`（同一套 props），只把
   * `readBytes` 换成套了计数器的版本：读了几次、共多少字节、从点下去到页码签对上
   * 多少毫秒、到第一张**新**画布多少毫秒、画布 DOM 节点是不是同一个。
   */
  "hunt-c-switchcache": async ({
    note, until, settle, click, all, text, pagesLabel, root, Body, bytes, t, retainTab, tabSignal, React, DICT,
  }) => {
    const fetchBytes = async (path) => new Uint8Array(await (await fetch(path)).arrayBuffer());
    const addressOf = (path) => `file:///C:/docs/${path.replace(/^\.\//u, "")}`;

    const reads = [];
    let served = bytes;
    // 只记账，不改造：一次「读」= 一次 readBytes 调用 + 它交回去的字节数。
    const countingRead = async (address) => {
      reads.push({ address, size: served.length });
      return { bytes: served, version: 1 };
    };
    const mailbox = { loaded: 0, failed: 0 };
    let revision = 0;
    const showDoc = (data, address) => {
      served = data;
      revision += 1;
      root.render(React.createElement(Body, {
        content: {
          kind: "renderer",
          revision,
          reload: () => showDoc(data, address),
          loaded: () => { mailbox.loaded += 1; },
          failed: () => { mailbox.failed += 1; },
        },
        resourceAddress: address,
        readBytes: countingRead,
        t,
        sessionId: "sess-46",
        retainTab,
        useTabInfo: () => ({ tab: { id: "tab-body", signal: tabSignal, contentId: "content-1" } }),
        useStore: () => null,
        actions: { forget: () => {} },
      }));
    };
    const open = async (path, data, expected, key) => {
      const staleCanvas = document.querySelector("#host .fp-pages canvas");
      const from = reads.length;
      const loadedFrom = mailbox.loaded;
      const started = performance.now();
      showDoc(data, addressOf(path));
      const fresh = await until(() => {
        const canvas = document.querySelector("#host .fp-pages canvas");
        return canvas !== null && canvas !== staleCanvas;
      }, 15000);
      const freshMs = fresh ? Math.round(performance.now() - started) : -1;
      const labelOk = await until(() => (pagesLabel() ?? "").endsWith(expected), 30000);
      const labelMs = Math.round(performance.now() - started);
      const slice = reads.slice(from);
      note(`readCalls_${key}`, slice.length);
      note(`bytes_${key}`, slice.reduce((sum, item) => sum + item.size, 0));
      note(`openMs_${key}`, labelMs);
      note(`freshCanvasMs_${key}`, freshMs);
      note(`labelOk_${key}`, labelOk);
      note(`loadedEvents_${key}`, mailbox.loaded - loadedFrom);
      return document.querySelector("#host .fp-pages canvas");
    };

    note("sampleBytes", bytes.length);
    note("bigBytes", "fetching");
    const big = await fetchBytes("./samples/big.pdf");
    note("bigBytes", big.length);

    // ① 第一次打开：从「什么都没挂」开始，和真人第一次点开这个文件一样。
    root.render(null);
    await settle(500);
    note("rootGoneAfterUnmount", document.querySelector("#host .fp-root") === null);
    const firstCanvas = await open("./samples/outline.pdf", bytes, "/ 12", "first");
    note("styledAfterRemount", (() => {
      const el = document.querySelector("#host .fp-frame");
      const style = el === null ? null : getComputedStyle(el);
      return `${el === null ? "missing" : style.overflowY}/${style === null ? "-" : style.position}`;
    })());
    note("canvases_first", all("#host .fp-pages canvas").length);

    // ② 同一份文档再来一次（新 revision、地址不变）：这一步就是「切走再切回同一个
    // PDF」在标签页里的形状，答案应当是不再读文件。
    const sameCanvas = await open("./samples/outline.pdf", bytes, "/ 12", "sameDoc");
    note("canvasNodeReusedSameDoc", sameCanvas === firstCanvas);
    note("canvases_sameDoc", all("#host .fp-pages canvas").length);

    // ③ 卸载再装（真正的「切到别的标签页再回来」）：这一次连组件都是新的。
    root.render(null);
    await settle(500);
    const remountCanvas = await open("./samples/outline.pdf", bytes, "/ 12", "afterRemount");
    note("canvasNodeReusedAfterRemount", remountCanvas === firstCanvas);
    note("canvases_afterRemount", all("#host .fp-pages canvas").length);

    // ④ 先翻到第 3 页，把滚动条按到**第 3 页自己的页顶**，再记基线。
    //
    // 这里原来写的是「读标签 3 → 把 scrollTop 硬设成 260」。260 落在第 1 页
    // （这个 pane 的页距 576，第 3 页顶在 1152），而滚动会触发 onScroll 把
    // `currentPage` 改成 1 —— 于是「离开时是第 3 页 @ 260」这句基线本身就是
    // 两个互相矛盾的状态，后来量到「回来是 1 / 260」自然是答案正确、基线错误。
    // 现在滚动目标取第 3 页在 DOM 里的真实位置：标签与滚动一致，基线才是一句话。
    click(DICT.next);
    await settle(400);
    click(DICT.next);
    await settle(700);
    note("zoomBeforeLeave", text("#host .fp-zoom-count"));
    const frame = () => document.querySelector("#host .fp-frame");
    const pageTop = (number) => {
      const page = all("#host .fp-pages .page").find((el) => el.dataset.pageNumber === number);
      const box = frame();
      if (page === undefined || box === null) return null;
      return Math.round(page.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop);
    };
    const leavingTop = pageTop("3");
    frame().scrollTop = leavingTop ?? 640;
    await settle(500);
    const leaveLabel = pagesLabel();
    note("pageBeforeLeave", leaveLabel);
    note("scrollBeforeLeave", Math.round(frame()?.scrollTop ?? -1));
    note("pageTopBeforeLeave", leavingTop ?? "unknown");

    await open("./samples/big.pdf", big, "/ 200", "other");
    note("canvases_other", all("#host .fp-pages canvas").length);

    // 切走之前记下容器本身：页码/滚动能不能恢复，先得知道「回来的是不是同一个壳」。
    const pagesBeforeLeave = document.querySelector("#host .fp-pages");
    const backCanvas = await open("./samples/outline.pdf", bytes, "/ 12", "backAfterOther");
    note("canvasNodeReusedBack", backCanvas === remountCanvas);
    note("pagesNodeReusedBack", document.querySelector("#host .fp-pages") === pagesBeforeLeave);
    note("canvases_backAfterOther", all("#host .fp-pages canvas").length);
    // 读数给一条时间线：恢复也许是「等页数报出来之后再补一次」，单点采样分不出
    // 「没恢复」和「我读早了」——这个坑本文件里踩过（oneHitMarks）。
    const restored = [];
    const restoreClock = Date.now();
    for (const mark of [0, 600, 1500, 3000]) {
      const left = mark - (Date.now() - restoreClock);
      if (left > 0) await settle(left);
      restored.push(`${Date.now() - restoreClock}ms:${(pagesLabel() ?? "-").replace(/\s+/gu, "")}`
        + `@${Math.round(frame()?.scrollTop ?? -1)}`);
    }
    note("restoredTimeline", restored.join(" | "));
    note("restoredPage", pagesLabel());
    note("restoredZoom", text("#host .fp-zoom-count"));
    note("restoredScrollTop", Math.round(frame()?.scrollTop ?? -1));
    // 一句话的判据：进去和出来是不是同一个位置（标签同、滚动差 2 px 以内）。
    const backTop = Math.round(frame()?.scrollTop ?? -1);
    const leaveTop = Math.round(leavingTop ?? -1);
    note("backMatchesLeave", (pagesLabel() ?? "") === leaveLabel && Math.abs(backTop - leaveTop) <= 2);
    note("backDelta", `${pagesLabel() ?? "-"} vs ${leaveLabel} ; scroll ${backTop} vs ${leaveTop}`);

    // ⑤ 词汇表：上面每个 key 的「读了几次」分行看，最后给一条总账。
    note("readsTotal", `${reads.length} 次 / ${reads.reduce((sum, item) => sum + item.size, 0)} 字节`);
    note("readsAddressed", [...new Set(reads.map((item) => item.address))].join(" | "));
    note("failedEvents", mailbox.failed);
  },

  /**
   * 字体与 DSH 真实规格对不对得上 —— 基线不再用 harness 的 mock。
   *
   * 基线全部从只读的 app.asar 里抄出来（`src.*` 几条记出处），三列输出：
   *   `dsh.<元素>`     DSH 自己那一档是什么（档位 token 或组件类的原文）
   *   `plugin.<元素>`  插件实测（family/size/weight/lh/smoothing/spacing 六项）
   *   `diff.<元素>`    差在哪（none / 字号… / 行高… / 字重…）
   * 另外单独回答两件事：
   *   `probe.bareButton`     这个文档里一个裸 `<button>` 最终解析出的字体（= DSH 的
   *                          共享 Button 因为没有 font-family 而拿到的值）
   *   `varchain.*`           临时把 `--dsw-font-family` 钉成 DSH 那一串，看 `.fp-root`
   *                          是不是就跳到 DSH 正文族（钉完立刻撤销）
   */
  "hunt-c-fonts": async ({ note, until, settle, click, all, text, selectSpan, spans, openMore, DICT }) => {
    await settle(400);

    // ── DSH 真实规格（原文出处见下面 src.* 几条）──────────────────────────────
    // ui-theme/src/styles/base.css：`:root{--dsh-font-family-text-default:<这一串>}`，
    // `body{--dsw-font-family:var(--dsh-font-family-text,var(--dsh-font-family-text-default)), …}`。
    // 整包没有 `--dsw-font:` 定义，所以 `.fp-root` 的
    // `var(--dsw-font, var(--dsw-font-family, <回退链>))` 在真机上落到 `--dsw-font-family`。
    const DSH_TEXT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif';
    const DSH = {
      pane: { size: "14px", lh: "24px", weight: "400", ref: "--dsh-content-font-size:14px / --dsw-font-markdown-base 14px/24px" },
      toolbar: { size: "12px", lh: "18px", weight: "400", ref: "--dsw-font-xxs-12 = 12px/18px" },
      toolbarButton: { size: "12px", lh: "18px", weight: "400", family: "ua", ref: "._button_1rv3m_2（14px/22px）+ ._sm_1rv3m_28（height:28px;font-size:12px;line-height:18px;padding:0 10px）= 宿主 sm 按钮" },
      pager: { size: "12px", lh: "18px", weight: "400", ref: "--dsw-font-xxs-12 / ._menuItem_6nhg2_561=12px" },
      outlineRow: { size: "12px", lh: "18px", weight: "400", family: "ua", ref: "目录行也是宿主 sm 按钮（._sm_1rv3m_28）" },
      "find.input": { size: "12px", lh: "18px", weight: "400", ref: "--dsw-font-xxs-12 = 12px/18px（面板里的输入行）" },
      "find.count": { size: "12px", lh: "18px", weight: "400", ref: "--dsw-font-xxs-12" },
      "find.button": { size: "12px", lh: "18px", weight: "400", family: "ua", ref: "宿主 sm 按钮（._sm_1rv3m_28）" },
      "sheet.key": { size: "12px", lh: "18px", weight: "400", ref: "--dsw-font-xxs-12 / 菜单项 12px" },
      "sheet.value": { size: "12px", lh: "18px", weight: "400", ref: "--dsw-font-xxs-12" },
      "card.title": { size: "12px", lh: "18px", weight: "400", ref: "--dsw-font-xxs-12" },
      "card.text": { size: "13px", lh: "20.15px", weight: "400", ref: ".Wsg8iW_cardDesc{font-size:13px;line-height:1.55}" },
      "card.source": { size: "11px", lh: "14px", weight: "400", ref: "--dsw-font-xxxs-11 = 11px/14px" },
      "card.foot": { size: "12px", lh: "18px", weight: "400", ref: "--dsw-font-xxs-12" },
    };
    note("src.fontFamily", "asar ui-theme/src/styles/base.css :root{--dsh-font-family-text-default:…} + body{--dsw-font-family:var(--dsh-font-family-text,var(--dsh-font-family-text-default)),…}；整包无 --dsw-font: 定义");
    note("src.scale", "asar --dsw-font-xxxs-11=11px/14px  xxs-12=12px/18px  xs-13=13px/20px  s-14=14px/22px  base-16=16px/24px  m-18=500 16px/28px  l-20=500 20px/28px  xl-24=600 24px/32px（都带 var(--dsw-font-family)）");
    note("src.button", "asar ._button_1rv3m_2{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px} —— 没有 font-family，ui-theme 的 9 个 css 区域里也没有 button 重置");
    note("src.menuItem", "asar ._menuItem_6nhg2_561{padding:4px 7px;color:var(--dsw-alias-label-primary);font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);text-align:left;background:transparent;border:none;border-radius:var(--dsw-radius-md);cursor:pointer} = 12px，无 font-family、无 line-height");
    note("src.bodyContainer", "asar 宿主文档容器 {font-family:var(--dsw-font-mono,ui-monospace, SFMono-Regular, Menlo, monospace);white-space:pre;tab-size:2;…}；--dsw-font-mono 未定义 → 实际是 monospace");
    note("src.contentSize", "asar --dsh-content-font-size 默认 14px；--dsh-content-font-size-secondary = min(14-1, max(13, 14-2)) = 13px");

    const FIELDS = [
      ["font-family", "fontFamily"],
      ["font-size", "fontSize"],
      ["font-weight", "fontWeight"],
      ["line-height", "lineHeight"],
      ["font-smoothing", "webkitFontSmoothing"],
      ["letter-spacing", "letterSpacing"],
    ];
    const measure = (el) => {
      if (el === null || el === undefined) return null;
      const style = getComputedStyle(el);
      const values = {};
      for (const [suffix, property] of FIELDS) values[suffix] = String(style[property] ?? "-");
      return values;
    };
    const describe = (v) => `family=${v["font-family"]} size=${v["font-size"]} weight=${v["font-weight"]}`
      + ` lh=${v["line-height"]} smoothing=${v["font-smoothing"]} spacing=${v["letter-spacing"]}`;
    const emit = (label, el) => {
      const measured = measure(el);
      const dsh = DSH[label];
      note(`dsh.${label}`, `${dsh.size}/${dsh.lh} weight=${dsh.weight} ← ${dsh.ref}`);
      if (measured === null) {
        note(`plugin.${label}`, "missing");
        note(`diff.${label}`, "元素不存在");
        return null;
      }
      note(`plugin.${label}`, describe(measured));
      const diffs = [];
      if (measured["font-size"] !== dsh.size) diffs.push(`字号 ${measured["font-size"]} vs ${dsh.size}`);
      if (measured["line-height"] !== dsh.lh) diffs.push(`行高 ${measured["line-height"]} vs ${dsh.lh}`);
      if (measured["font-weight"] !== dsh.weight) diffs.push(`字重 ${measured["font-weight"]} vs ${dsh.weight}`);
      const isButton = label === "toolbarButton" || label === "outlineRow";
      // 按钮类的期望族不是正文族：DSH 的 Button 类不写 font-family，落到 UA 的按钮默认族，
      // 所以拿本文档里裸 button 的实测值当按钮的期望（`probe.bareButton`）。
      const expectedFamily = dsh.family === "ua" ? bareFamily : DSH_TEXT_FAMILY;
      if (measured["font-family"] !== expectedFamily) {
        diffs.push(`字体族 ${measured["font-family"]} vs ${isButton ? `UA 按钮默认（${expectedFamily}）` : "DSH 正文族"}`);
      }
      note(`diff.${label}`, diffs.length === 0 ? "none" : diffs.join("；"));
      note(`familyMatchesDsh.${label}`, measured["font-family"] === expectedFamily);
      return measured;
    };

    // 这一文档里一个裸 button 的最终字体 —— DSH 的共享 Button 就是这种处境（类里没写 family，
    // 主题也没有 button 重置，因此落到 UA 的按钮默认族上，不会继承正文族）。
    const bare = document.createElement("button");
    bare.textContent = "probe";
    document.body.append(bare);
    const bareStyle = getComputedStyle(bare);
    // 取成字符串再摘掉节点：`getComputedStyle` 是活的，节点一离开文档就全变空串。
    const bareFamily = bareStyle.fontFamily;
    note("probe.bareButton", `family=${bareFamily} size=${bareStyle.fontSize} lh=${bareStyle.lineHeight} weight=${bareStyle.fontWeight}`);
    note("probe.bareButtonIsDshFamily", bareFamily === DSH_TEXT_FAMILY);
    bare.remove();

    note("html.font-size", document.documentElement.style.fontSize || "(未内联)");
    note("html.computed-font-size", getComputedStyle(document.documentElement).fontSize);
    note("var.--dsw-font", getComputedStyle(document.body).getPropertyValue("--dsw-font").trim() || "(未定义)");
    note("var.--dsw-font-family", getComputedStyle(document.body).getPropertyValue("--dsw-font-family").trim() || "(未定义)");
    note("var.--dsh-font-family-text-default", getComputedStyle(document.body).getPropertyValue("--dsh-font-family-text-default").trim() || "(未定义)");

    const pane = emit("pane", document.querySelector("#host .fp-root"));
    const toolbar = emit("toolbar", document.querySelector("#host .fp-zoom-count"));
    const toolbarBtn = emit("toolbarButton", document.querySelector("#host .fp-toolbar .fp-host-btn"));
    const pager = emit("pager", document.querySelector("#host .fp-page-input"));

    // 查找栏（`.fp-find-*`）：`.fp-findbar{font-size:12px;line-height:1}`，输入框 `font:inherit`。
    click(DICT.find);
    await until(() => document.querySelector("#host .fp-find-input") !== null, 5000);
    emit("find.input", document.querySelector("#host .fp-find-input"));
    emit("find.count", document.querySelector("#host .fp-find-count"));
    emit("find.button", document.querySelector("#host .fp-findbar button"));
    document.querySelector("#host .fp-frame")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => document.querySelector("#host .fp-find-input") === null, 4000);
    note("find.closed", document.querySelector("#host .fp-find-input") === null);

    click(DICT.outline);
    await settle(700);
    const outlineRow = emit("outlineRow", document.querySelector("#host .fp-outline button"));
    click(DICT.outline);
    await settle(400);

    await openMore();
    all("#host .fp-menu-row").find((el) => el.textContent.trim() === DICT.properties)?.click();
    await until(() => document.querySelector("#host .fp-panel") !== null, 6000);
    emit("sheet.key", document.querySelector("#host .fp-prop-key"));
    emit("sheet.value", document.querySelector("#host .fp-prop-value"));
    document.querySelector("#host .fp-panel .fp-pick-close")?.click();
    await settle(350);
    if (document.querySelector("#host .fp-panel") !== null) {
      // 面板没被关掉时用 Escape 收（C2 那条路），否则后面的选区会被遮罩吞掉。
      document.querySelector("#host .fp-frame")
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await settle(400);
    }
    note("panelClosedBeforeCard", document.querySelector("#host .fp-panel") === null);

    // 翻译卡：选一段字，弹气泡，点「翻译」。
    // 面板开关会让文字层重渲染，`spans()[0]` 可能已经是脱离文档的旧节点（在它上面选区等于没选），
    // 所以挑一个 isConnected 且有文字的 span。
    const firstSpan = spans().find((el) => el.isConnected && (el.firstChild?.textContent ?? "").length > 6);
    note("cardSpan", firstSpan === undefined ? "none" : `${String(firstSpan.textContent).slice(0, 16)} connected=${firstSpan.isConnected}`);
    if (firstSpan !== undefined) selectSpan(firstSpan);
    note("cardSelected", String(window.getSelection()?.toString() ?? "").slice(0, 16) || "empty");
    const chipped = await until(() => document.querySelector("#host .fp-chip") !== null, 6000);
    note("cardChipped", chipped);
    if (!chipped) {
      note("cardSkipped", `气泡没弹出来：panel=${document.querySelector("#host .fp-panel") !== null}`
        + ` mask=${document.querySelector("#host .fp-panel-mask") !== null}`
        + ` selected=${String(window.getSelection()?.toString() ?? "").slice(0, 12) || "empty"}`);
      note("diff.card.title", "未测（气泡没弹）");
    } else {
      click("翻译");
      await until(() => (text("#host .fp-pick-text") ?? "").length > 0, 20000);
      await settle(300);
      emit("card.title", document.querySelector("#host .fp-pick-title"));
      emit("card.text", document.querySelector("#host .fp-pick-text"));
      emit("card.source", document.querySelector("#host .fp-pick-source"));
      emit("card.foot", document.querySelector("#host .fp-pick-foot"));
    }

    // 变量链证明：把 `--dsw-font-family` 钉成 DSH 那一串，`.fp-root` 应当整串跳过去。
    const paneNow = () => getComputedStyle(document.querySelector("#host .fp-root")).fontFamily;
    note("varchain.before", paneNow());
    // 回退链与 DSH 的 token 是同一串字面量，所以「钉成 DSH 值」看不出变化；
    // 先用一个显眼的值证明 `.fp-root` 真的读这个变量，再换回 DSH 值比对。
    document.documentElement.style.setProperty("--dsw-font-family", "\"ProbeMarker\", monospace");
    await settle(150);
    note("varchain.followsVar", paneNow().includes("ProbeMarker"));
    document.documentElement.style.setProperty("--dsw-font-family", DSH_TEXT_FAMILY);
    await settle(150);
    note("varchain.afterOverride", paneNow());
    note("varchain.matchesDshFamily", paneNow() === DSH_TEXT_FAMILY);
    document.documentElement.style.removeProperty("--dsw-font-family");
    await settle(150);
    note("varchain.restored", paneNow() === (pane === null ? paneNow() : pane["font-family"]));

    // 两条给结论用的对比，不用翻上面：
    note("answer.buttonFamily", `裸 button=${bareFamily}；pane 内按钮=${toolbarBtn === null ? "missing" : toolbarBtn["font-family"]}；DSH 正文族=${DSH_TEXT_FAMILY}`);
    note("answer.paneVsDsh", `pane=${pane === null ? "missing" : pane["font-family"]}（13px/18.2px 是 harness body 给的；DSH 正文档是 14px/24px）`);
  },
};
