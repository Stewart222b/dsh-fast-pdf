// Probes owned by hunt-a (toolbar / pager / zoom / keyboard / width matrix).
// Add a key per probe: the key is the `?scenario=` value.
//
// Every probe is written to be run before and after a fix with the same
// parameters (a different port is fine), and every fact it reports is a number,
// a box, a computed style or a string read off the pane — never an opinion.
//
// Samples used: outline.pdf (12 pages, two-level outline), big.pdf (200 pages),
// a-deep.pdf (24 pages, three-level outline, 60 rows, one absurd title).

/**
 * Read the page box, the page readout and the frame's scroll offset together.
 *
 * Three numbers rather than one, because "the field says 7" and "the reader is
 * on page 7" are different facts: the box renders a draft while it is focused.
 * @param note - the harness note sink.
 * @param tag - prefix for the three keys.
 * @param frameTop - the harness helper reading the frame's scrollTop.
 */
function readPager(note, tag, frameTop) {
  const field = document.querySelector("#host .fp-page-input");
  note(`${tag}Box`, field === null ? "none" : field.value);
  note(`${tag}Label`, (() => {
    const box = document.querySelector("#host .fp-pageno");
    if (box === null) return "none";
    const total = (box.querySelector(".fp-pages-total")?.textContent ?? "").trim().replace(/^\/\s*/u, "");
    return `${field?.value ?? ""} / ${total}`;
  })());
  note(`${tag}Top`, frameTop());
}

/** The page the frame is actually showing, read off the page boxes. */
function visiblePage() {
  const frame = document.querySelector("#host .fp-frame");
  if (frame === null) return 0;
  const limit = frame.scrollTop + 80;
  let found = 0;
  for (const el of document.querySelectorAll("#host .fp-pages .page")) {
    if (el.offsetTop <= limit) found = Number(el.dataset.pageNumber);
    else break;
  }
  return found;
}

/** The controls a Tab press can land on, in the order the browser walks them. */
function tabbables() {
  return [...document.querySelectorAll("#host button, #host input, #host [tabindex]")].filter((el) => {
    if (el.disabled === true) return false;
    // A folded outline branch is `inert`, and so is everything under it.
    if (el.closest("[inert]") !== null) return false;
    const declared = el.getAttribute("tabindex");
    if (declared !== null && Number(declared) < 0) return false;
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

/** A short name for a focusable, for building a readable order. */
function nameOf(el) {
  if (el === null || el === undefined) return "null";
  const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent?.trim() ?? "";
  return `${el.tagName.toLowerCase()}:${label.replace(/\s+/gu, " ").slice(0, 12)}`;
}

/** A short name for whatever currently has focus. */
function activeName() {
  const el = document.activeElement;
  if (el === null || el === document.body) return "body";
  return nameOf(el);
}

/** Press a key on one element, the way React's synthetic handlers see it. */
function key(el, name) {
  return el.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

/**
 * The toolbar button under one label, wherever that label lives.
 *
 * The Host's Button renders its `label` as a `title`, and the fit control is a
 * single toggle whose title is 整页显示 in 适应宽度 mode and the other way round —
 * so it has to be resolved through the element, not through one fixed string.
 * @param label - the title or the aria-label to look for.
 */
function buttonBy(label) {
  return [...document.querySelectorAll("#host button")].find((el) => (
    (el.getAttribute("title") ?? "") === label || (el.getAttribute("aria-label") ?? "") === label
  )) ?? null;
}

/**
 * Press the fit toggle, whichever way round it currently reads.
 * @returns the title it carried, or null when there is no toggle.
 */
function clickFit(DICT) {
  const toggle = buttonBy(DICT.fitPage) ?? buttonBy(DICT.fitWidth);
  if (toggle === null) return null;
  const title = toggle.getAttribute("title") ?? toggle.getAttribute("aria-label");
  toggle.click();
  return title;
}

export default {
  // Wiring smoke test: proves the registry is reachable and the toolbox arrives.
  "a-wiring": async ({ note, all }) => {
    note("toolbox", typeof note === "function");
    note("hostButtons", all("#host button").length);
  },

  /**
   * BUG A1 (blank page box) + rapid typing into it.
   *
   * "1" → "12" → "123" inside one task is what a fast typist does; then the
   * three ways out of the box (Enter, Tab/blur, a press on the page) and whether
   * the box, the readout and the frame agree afterwards.
   */
  "a-pager-rapid": async ({ note, type, settle, frameTop, DICT, click }) => {
    const field = () => document.querySelector("#host .fp-page-input");
    readPager(note, "start", frameTop);
    note("startVisiblePage", visiblePage());

    // Three keystrokes, no settle between them, then Enter in the same task.
    const input = field();
    input.focus();
    type(input, "1");
    type(input, "12");
    type(input, "123");
    note("draftAfter3", input.value);
    key(input, "Enter");
    await settle(900);
    readPager(note, "afterRapidEnter", frameTop);
    note("afterRapidVisiblePage", visiblePage());
    note("rapidBoxMatchesView", field()?.value === String(visiblePage()));

    // The same three keys with a frame between them, which is the slow typist.
    const slow = field();
    slow.focus();
    type(slow, "1");
    await settle(60);
    type(slow, "1");
    await settle(60);
    type(slow, "2");
    note("slowDraft", slow.value);
    slow.blur();
    await settle(900);
    readPager(note, "afterSlowBlur", frameTop);
    note("slowVisiblePage", visiblePage());

    // Tab away instead of Enter: the same decision has to be taken.
    const away = field();
    away.focus();
    type(away, "3");
    await settle(120);
    away.blur();
    await settle(800);
    readPager(note, "afterTabAway", frameTop);
    note("tabAwayVisiblePage", visiblePage());

    // A press on the page is the third way out of the box.
    const onPage = field();
    onPage.focus();
    type(onPage, "5");
    await settle(120);
    document.querySelector("#host .fp-frame").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    onPage.blur();
    await settle(800);
    readPager(note, "afterPagePress", frameTop);
    note("pagePressVisiblePage", visiblePage());
    note("boxMatchesViewAtEnd", field()?.value === String(visiblePage()));
    note("nextEnabledAt5", nextButton()?.disabled === false);
    note("prevEnabledAt5", previousButton()?.disabled === false);
    note("toolbarLabels", [...document.querySelectorAll("#host .fp-toolbar button")]
      .map((b) => b.getAttribute("aria-label") ?? b.textContent.trim()).join(" "));
    function nextButton() {
      return document.querySelector("#host button[aria-label='下一页']");
    }
    function previousButton() {
      return document.querySelector("#host button[aria-label='上一页']");
    }
    note("doubleClickUntouched", click === click);
  },

  /**
   * BUG: the two ends of the document, from the box, one press at a time.
   *
   * ↓ decrements the page number and ↑ increments it, so page 1 must hold still
   * under ↓ and the last page must hold still under ↑. Watched: the readout, the
   * frame offset, and whether the chevron at the end says disabled.
   */
  "a-pager-ends": async ({ note, settle, frameTop, type }) => {
    const field = () => document.querySelector("#host .fp-page-input");
    const count = Number((document.querySelector("#host .fp-pages-total")?.textContent ?? "0").replace(/[^\d]/gu, ""));
    note("total", count);

    // Page 1, five ↓ presses, each one a task of its own (a held key repeats
    // like this, not like five events in one tick).
    const input = field();
    input.focus();
    await settle(150);
    const topAtStart = frameTop();
    for (let step = 0; step < 5; step += 1) {
      key(input, "ArrowDown");
      await settle(180);
    }
    await settle(500);
    readPager(note, "after5DownAtTop", frameTop);
    note("downAtTopGrew", frameTop() - topAtStart);
    note("downAtTopBox", field()?.value);
    note("downAtTopPrevDisabled", document.querySelector("#host button[aria-label='上一页']")?.disabled ?? null);
    input.blur();
    await settle(500);
    readPager(note, "afterTopBlur", frameTop);

    // The far end: type the last page, then five ↑ presses.
    const tail = field();
    tail.focus();
    type(tail, String(count));
    await settle(150);
    key(tail, "Enter");
    await settle(900);
    readPager(note, "atLast", frameTop);
    note("atLastVisiblePage", visiblePage());
    const topAtLast = frameTop();
    const last = field();
    last.focus();
    for (let step = 0; step < 5; step += 1) {
      key(last, "ArrowUp");
      await settle(180);
    }
    await settle(500);
    readPager(note, "after5UpAtEnd", frameTop);
    note("upAtEndGrew", frameTop() - topAtLast);
    note("upAtEndBox", field()?.value);
    note("upAtEndNextDisabled", document.querySelector("#host button[aria-label='下一页']")?.disabled ?? null);
    last.blur();
    await settle(500);
    readPager(note, "afterEndBlur", frameTop);
    note("frameAtBottom", (() => {
      if (stepLimit < 7) { note("stoppedAt", 6); return; }
    const frame = document.querySelector("#host .fp-frame");
      return Math.round(frame.scrollHeight - frame.clientHeight - frame.scrollTop);
    })());
  },

  /**
   * BUG A1: what the box shows after input it cannot use.
   *
   * `0`, letters, Chinese, only spaces, an empty string, a leading-zero number
   * and one past the end, each committed by leaving the box. Three readouts per
   * case, plus one extra: after the box goes blank, does an unrelated re-render
   * (scrolling far enough to change the page) bring it back? A readout that
   * stays blank until the reader happens to scroll is the failure watched here.
   */
  "a-pager-bad": async ({ note, settle, type, frameTop }) => {
    const field = () => document.querySelector("#host .fp-page-input");
    const commit = async (tag, text) => {
      const input = field();
      input.focus();
      await settle(100);
      type(input, text);
      await settle(150);
      note(`${tag}Draft`, input.value);
      input.blur();
      await settle(700);
      readPager(note, tag, frameTop);
    };
    readPager(note, "start", frameTop);
    await commit("zero", "0");
    await commit("letters", "abc");
    await commit("chinese", "中文");
    await commit("blank", "");
    await commit("spaces", "   ");
    await commit("leadingZero", "007");
    await commit("tooBig", "999");
    await commit("negative", "-3");

    // Recovery: the box was left blank by the case above. Move the view without
    // touching the field and see whether the readout comes back by itself.
    if (stepLimit < 7) { note("stoppedAt", 6); return; }
    const frame = document.querySelector("#host .fp-frame");
    note("blankBeforeScroll", field()?.value);
    frame.scrollTop = frame.scrollTop + 2000;
    frame.dispatchEvent(new Event("scroll", { bubbles: true }));
    await settle(700);
    note("blankAfterScroll", field()?.value);

    // A page beyond the end typed one digit at a time, committed by Enter.
    const input = field();
    input.focus();
    type(input, "4");
    await settle(80);
    type(input, "44");
    await settle(80);
    note("growDraft", input.value);
    key(input, "Enter");
    await settle(900);
    readPager(note, "grow", frameTop);
    note("growBoxMatchesPage", field()?.value === String(visiblePage()));

    // Escape is the cancellation: it must leave the page alone and put the
    // current page back in the box.
    const escape = field();
    escape.focus();
    type(escape, "9");
    await settle(150);
    key(escape, "Escape");
    await settle(500);
    readPager(note, "afterEscape", frameTop);
    note("escapeKeptPage", field()?.value === String(visiblePage()));
  },

  /**
   * BUG: the keyboard path through the toolbar, and the page text layers.
   *
   * Measured: the tab order (DOM order, skipping disabled/inert/zero-box
   * controls), the ring each control paints when focused from the keyboard, and
   * — separately — every rendered page's text layer, which pdf.js marks
   * `tabIndex = 0` and which therefore joins that order.
   */
  "a-focus": async ({ note, settle, all, click, DICT, until }) => {
    const controls = tabbables();
    note("tabCount", controls.length);
    note("tabOrder", controls.map(nameOf).join(" > "));
    note("pageFieldInOrder", controls.some((el) => el.classList.contains("fp-page-input")));
    note("frameInOrder", controls.some((el) => el.classList.contains("fp-frame")));
    const pageStops = controls.filter((el) => el.classList.contains("textLayer"));
    note("pageStopsTab", pageStops.length);
    note("pageStopsTabIndex", pageStops[0]?.getAttribute("tabindex") ?? null);
    note("pageStopsRendered", all("#host .fp-pages .page .textLayer").length);

    const ringOf = (el) => {
      let saysFocusVisible = false;
      el.focus({ focusVisible: true });
      saysFocusVisible = el.matches(":focus-visible");
      const style = getComputedStyle(el);
      return `${saysFocusVisible ? "fv" : "no-fv"}:${style.outlineStyle}/${style.outlineWidth}`;
    };
    const rings = [];
    for (const el of controls) {
      const before = activeName();
      const ring = ringOf(el);
      const landed = document.activeElement === el ? "self" : activeName();
      rings.push(`${before}→${landed}→${ring}`);
      await settle(20);
    }
    note("rings", rings.join(" | "));
    note("ringsNoOutline", rings.filter((line) => /:(none|auto)\/\d+px$/u.test(line) === false || /:none\//u.test(line)).length);
    note("noFocusVisible", rings.filter((line) => line.includes("no-fv")).length);
    // A page stop paints a ring around the whole page: how big is that box?
    if (pageStops.length > 0) {
      pageStops[0].focus({ focusVisible: true });
      const box = pageStops[0].getBoundingClientRect();
      const style = getComputedStyle(pageStops[0]);
      note("pageStopBox", `${Math.round(box.width)}x${Math.round(box.height)}`);
      note("pageStopRing", `${style.outlineStyle}/${style.outlineWidth}/${style.outlineColor}`);
      note("pageStopFocusVisible", pageStops[0].matches(":focus-visible"));
      note("pageFrameBox", (() => {
        const f = document.querySelector("#host .fp-frame").getBoundingClientRect();
        return `${Math.round(f.width)}x${Math.round(f.height)}`;
      })());
    }

    // The outline column is the densest keyboard surface: open it and walk it.
    const hasOutline = await until(() => all("#host button").some((b) => b.getAttribute("aria-label") === DICT.outline), 12000);
    note("hasOutline", hasOutline);
    if (hasOutline) {
      click(DICT.outline);
      await until(() => all("#host .fp-outline-row").length > 0, 4000);
      const open = tabbables();
      note("openCaretsTab", open.filter((el) => el.classList.contains("fp-outline-caret")).length);
      note("openRowsTab", open.filter((el) => el.classList.contains("fp-outline-row")).length);
      click(DICT.collapseAll);
      await settle(500);
      const folded = tabbables();
      note("foldedCaretsTab", folded.filter((el) => el.classList.contains("fp-outline-caret")).length);
      note("foldedRowsTab", folded.filter((el) => el.classList.contains("fp-outline-row")).length);
      note("foldedHiddenRows", all("#host .fp-outline-kids[data-folded] .fp-outline-row").length);
      note("foldedHiddenInOrder", folded.filter((el) => el.closest(".fp-outline-kids[data-folded]") !== null).length);
      click(DICT.expandAll);
      await settle(500);
      note("headButtons", all("#host .fp-outline-head button").length);
    }
  },

  /**
   * BUG: 整页显示 in a pane that is both narrow and short.
   *
   * `computeZoom` floors the scale at 25%, so at some pane sizes "fit page" can
   * only fit one axis. Measured: the frame's own scroll ranges, the first page's
   * box against the frame's, and whether a scrollbar appears on either axis —
   * once in the opening 适应宽度 and once after pressing 整页显示.
   */
  "a-fit": async ({ note, settle, click, text, DICT, frameTop }) => {
    const report = (tag) => {
      const f = document.querySelector("#host .fp-frame");
      const page = document.querySelector("#host .fp-pages .page");
      const fr = f.getBoundingClientRect();
      const pr = page.getBoundingClientRect();
      note(`${tag}Zoom`, text("#host .fp-zoom-count"));
      note(`${tag}Frame`, `${Math.round(fr.width)}x${Math.round(fr.height)}`);
      note(`${tag}Scroll`, `${f.scrollWidth}/${f.clientWidth} x ${f.scrollHeight}/${f.clientHeight}`);
      note(`${tag}HScroll`, f.scrollWidth > f.clientWidth + 1);
      note(`${tag}VScroll`, f.scrollHeight > f.clientHeight + 1);
      note(`${tag}PageBox`, [pr.left, pr.top, pr.width, pr.height].map(Math.round).join(","));
      note(`${tag}PageInsideX`, pr.left >= fr.left - 1 && pr.right <= fr.right + 1);
      note(`${tag}PageInsideY`, pr.top >= fr.top - 1 && pr.bottom <= fr.bottom + 1);
      note(`${tag}OverflowY`, Math.round(pr.bottom - fr.bottom));
      note(`${tag}OverflowX`, Math.round(pr.right - fr.right));
      note(`${tag}Toolbar`, (() => {
        const box = document.querySelector("#host .fp-toolbar").getBoundingClientRect();
        return `${Math.round(box.width)}x${Math.round(box.height)}`;
      })());
    };
    const hostBox = document.querySelector("#host").getBoundingClientRect();
    note("pane", `${Math.round(hostBox.width)}x${Math.round(hostBox.height)}`);
    report("width");
    // One toggle, two readings: in 适应宽度 mode it offers 整页显示 and back.
    note("toggleSaid", clickFit(DICT));
    await settle(900);
    report("fit");
    note("fitFrameTop", frameTop());
    // And back, so the same probe can be run in the other direction.
    note("toggleSaidBack", clickFit(DICT));
    await settle(900);
    report("widthAgain");
  },

  /**
   * BUG A4 (a jump to the last page reads one page short) + the pager group under
   * a three-digit page count.
   *
   * `.fp-pageno` shrinks (`flex: 0 1 auto`, `min-inline-size: 5.6em`), so a
   * 200-page document in a 260 px pane is where the digits get squeezed. Read:
   * the input's own box against its content, whether the digits are clipped, and
   * whether 上一页 / 页码 / 下一页 are still on one line.
   *
   * The last page is measured separately and twice, 1.2 s and 3.8 s after the
   * Enter, because "reads 199" and "has not finished scrolling" look identical at
   * one second: `lastPageAtBottom` proves the frame is at `scrollHeight -
   * clientHeight`, so a readout of 199 there is the +80 px detection rule failing
   * at the end of the scroll range rather than a scroll still in flight.
   */
  "a-pager-wide": async ({ note, settle, type, text, frameTop }) => {
    const field = () => document.querySelector("#host .fp-page-input");
    const report = (tag) => {
      const input = field();
      const group = document.querySelector("#host .fp-pageno");
      const total = document.querySelector("#host .fp-pages-total");
      const box = (el) => (el === null ? null : el.getBoundingClientRect());
      const ib = box(input);
      const tb = box(total);
      const pb = box(document.querySelector("#host button[aria-label='上一页']"));
      const nb = box(document.querySelector("#host button[aria-label='下一页']"));
      note(`${tag}Value`, input?.value);
      note(`${tag}Total`, (total?.textContent ?? "").trim());
      // A text field clips its digits when its client width is below its scroll
      // width — the readout then says "2…" for page 200.
      note(`${tag}InputScroll`, `${input?.scrollWidth}/${input?.clientWidth}`);
      note(`${tag}InputClipped`, input !== null && input.scrollWidth > input.clientWidth + 1);
      note(`${tag}SameRow`, ib === null || tb === null ? null
        : Math.abs((ib.top + ib.height / 2) - (tb.top + tb.height / 2)) < 4);
      note(`${tag}StepperSameRow`, pb === null || nb === null ? null
        : Math.abs((pb.top + pb.height / 2) - (nb.top + nb.height / 2)) < 4);
      note(`${tag}GroupOverflow`, group === null ? null : Math.round(group.scrollWidth - group.getBoundingClientRect().width));
      note(`${tag}ToolbarH`, Math.round(document.querySelector("#host .fp-toolbar").getBoundingClientRect().height));
      note(`${tag}ZoomVisible`, (() => {
        const z = document.querySelector("#host .fp-zoom").getBoundingClientRect();
        const root = document.querySelector("#host .fp-root").getBoundingClientRect();
        return z.right <= root.right + 1 && z.left >= root.left - 1;
      })());
    };
    report("start");
    // Walk to the middle so the field holds three digits and the page is not
    // the first one (page 1 and page 100 differ in width).
    const input = field();
    input.focus();
    type(input, "100");
    await settle(150);
    key(input, "Enter");
    await settle(1200);
    report("midPage");
    note("frameTop", frameTop());
    note("label", text("#host .fp-pageno"));

    // The far end of a 200-page document: a long smooth scroll plus a pending
    // "I am going to page N" marker. Watched twice — right after the key and
    // three seconds later — because "lands on the page before the last one" and
    // "has not finished scrolling yet" look identical at one second.
    const count = Number((document.querySelector("#host .fp-pages-total")?.textContent ?? "0").replace(/[^\d]/gu, ""));
    note("total", count);
    const tail = field();
    tail.focus();
    type(tail, String(count));
    await settle(150);
    key(tail, "Enter");
    await settle(1200);
    report("lastPage");
    note("lastPageVisible", visiblePage());
    note("lastPageTop", frameTop());
    await settle(2600);
    report("lastPageSettled");
    note("lastPageVisibleSettled", visiblePage());
    note("lastPageTopSettled", frameTop());
    note("lastPageAtBottom", (() => {
      if (stepLimit < 7) { note("stoppedAt", 6); return; }
    const frame = document.querySelector("#host .fp-frame");
      return Math.round(frame.scrollHeight - frame.clientHeight - frame.scrollTop);
    })());
    note("lastFieldEqualsTotal", Number(field()?.value) === count);
  },

  /**
   * BUG: zoom has no floor or ceiling anyone can see.
   *
   * 缩小 pressed eight times and 放大 fourteen times, with nothing else touched.
   * Watched: the percentage after each press, how many presses changed nothing,
   * whether the button says disabled once it cannot go further, and whether a
   * horizontal scrollbar appears once the page is wider than the frame.
   */
  "a-zoom": async ({ note, settle, click, text, DICT, frameTop }) => {
    const zoom = () => Number((text("#host .fp-zoom-count") ?? "").replace(/[^\d]/gu, ""));
    const frame = () => document.querySelector("#host .fp-frame");
    const hscroll = () => {
      const f = frame();
      return f.scrollWidth > f.clientWidth + 1;
    };
    note("startZoom", zoom());
    note("startHScroll", hscroll());
    const down = [];
    for (let step = 0; step < 8; step += 1) {
      click(DICT.zoomOut);
      await settle(240);
      down.push(zoom());
    }
    note("zoomOutSteps", down.join(","));
    note("zoomOutDead", down.filter((value, at) => at > 0 && value === down[at - 1]).length);
    note("zoomOutDisabled", buttonBy(DICT.zoomOut)?.disabled ?? null);
    note("minHScroll", hscroll());
    const up = [];
    for (let step = 0; step < 14; step += 1) {
      click(DICT.zoomIn);
      await settle(240);
      up.push(zoom());
    }
    note("zoomInSteps", up.join(","));
    note("zoomInDead", up.filter((value, at) => at > 0 && value === up[at - 1]).length);
    note("zoomInDisabled", buttonBy(DICT.zoomIn)?.disabled ?? null);
    note("maxHScroll", hscroll());
    note("maxFrameScroll", `${frame().scrollWidth}/${frame().clientWidth}`);

    // Ctrl+wheel is the browser's own gesture for this, and it has to cancel the
    // page scroll while it does it.
    const topBefore = frameTop();
    const notCancelled = frame().dispatchEvent(new WheelEvent("wheel", {
      deltaY: 120, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await settle(400);
    note("wheelZoom", zoom());
    note("wheelCancelled", notCancelled === false);
    note("wheelScrollMoved", frameTop() - topBefore);
    // A wheel without the modifier must be left to the browser entirely.
    const before = zoom();
    const plainCancelled = frame().dispatchEvent(new WheelEvent("wheel", {
      deltaY: 120, deltaMode: 0, bubbles: true, cancelable: true,
    }));
    await settle(300);
    note("plainWheelKeptZoom", zoom() === before);
    note("plainWheelCancelled", plainCancelled === false);
    // And the fit toggle still works from a percentage.
    note("fitFromPercentSaid", clickFit(DICT));
    await settle(700);
    note("fitFromPercent", zoom());
    note("fitFromPercentHScroll", hscroll());
  },

  /**
   * BUG A2: Escape in the page box must cancel, not jump.
   *
   * Type a page far from the current one, press Escape, and watch the frame: a
   * cancelled jump leaves `frameTop` exactly where it was and puts the current
   * page back in the box. The same jump by Enter is measured right after, so the
   * two keys can be compared rather than described.
   */
  "a-escape": async ({ note, settle, type, frameTop }) => {
    const field = () => document.querySelector("#host .fp-page-input");
    readPager(note, "start", frameTop);
    const topAtStart = frameTop();

    const input = field();
    input.focus();
    type(input, "9");
    await settle(200);
    note("typedBox", input.value);
    key(input, "Escape");
    await settle(900);
    readPager(note, "afterEscape", frameTop);
    note("escapeMoved", frameTop() - topAtStart);
    note("escapeLeftField", document.activeElement === field());

    // The same jump, committed the other way: this one has to move.
    const again = field();
    again.focus();
    type(again, "9");
    await settle(200);
    key(again, "Enter");
    await settle(900);
    readPager(note, "afterEnter", frameTop);
    note("enterMoved", frameTop() - topAtStart);
  },

  /**
   * The width walk with named keys: each number below is a specific control, so a
   * regression reads as "the pager left its row" rather than "signature changed".
   * Kept next to `a-matrix` (the delivery table) because it is the one that says
   * *which* box moved; `a-matrix` only says *that* something did.
   */
  "a-matrix-loose": async ({ note, settle, click, all, text, DICT, openMore, until }) => {
    const root = () => document.querySelector("#host .fp-root");
    const inside = (el) => {
      if (el === null || el === undefined) return null;
      const r = root().getBoundingClientRect();
      const b = el.getBoundingClientRect();
      return b.left >= r.left - 1 && b.right <= r.right + 1;
    };
    const rowOf = (el) => (el === null || el === undefined ? null : Math.round(el.getBoundingClientRect().top));
    const hostBox = document.querySelector("#host").getBoundingClientRect();
    note("pane", `${Math.round(hostBox.width)}x${Math.round(hostBox.height)}`);
    note("rootHScroll", root().scrollWidth > root().clientWidth + 1);
    note("rootScroll", `${root().scrollWidth}/${root().clientWidth}`);
    note("docHScroll", document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    note("rootH", Math.round(root().getBoundingClientRect().height));

    // Which row every toolbar control ended up on, and whether any of them is
    // cut by the pane's right edge.
    const rows = new Map();
    for (const b of all("#host .fp-toolbar button")) {
      const top = Math.round(b.getBoundingClientRect().top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
    }
    note("toolbarRows", [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([top, n]) => `${top}:${n}`).join(" "));
    note("toolbarH", Math.round(document.querySelector("#host .fp-toolbar").getBoundingClientRect().height));
    const rootRight = root().getBoundingClientRect().right;
    note("toolbarCut", all("#host .fp-toolbar button").filter((b) => b.getBoundingClientRect().right > rootRight + 0.5).length);
    note("buttonsVisible", all("#host .fp-toolbar button").filter((b) => inside(b) === true).length);
    note("buttonsTotal", all("#host .fp-toolbar button").length);

    const field = document.querySelector("#host .fp-page-input");
    const total = document.querySelector("#host .fp-pages-total");
    const prevBtn = document.querySelector("#host button[aria-label='上一页']");
    const nextBtn = document.querySelector("#host button[aria-label='下一页']");
    note("pagerRows", [rowOf(prevBtn), rowOf(field), rowOf(total), rowOf(nextBtn)].join(","));
    note("pagerOneRow", new Set([rowOf(prevBtn), rowOf(field), rowOf(total), rowOf(nextBtn)]).size === 1);
    note("fieldClipped", field !== null && field.scrollWidth > field.clientWidth + 1);
    note("zoomInside", inside(document.querySelector("#host .fp-zoom")));
    note("moreInside", inside(all("#host button").find((b) => b.getAttribute("aria-label") === DICT.more)));

    // The ⋯ menu is a popover: at 260 px the row inside it must still fit.
    const opened = await openMore();
    note("menuOpened", opened);
    const menu = document.querySelector("#host .fp-menu");
    if (menu !== null) {
      const mb = menu.getBoundingClientRect();
      note("menuBox", `${Math.round(mb.left)},${Math.round(mb.top)} ${Math.round(mb.width)}x${Math.round(mb.height)}`);
      note("menuInside", inside(menu));
      note("menuRowClipped", [...menu.querySelectorAll(".fp-menu-row")].some((el) => el.scrollWidth > el.clientWidth + 1));
      // The properties sheet, from the same menu.
      menu.querySelector(".fp-menu-row")?.click();
      note("sheetOpened", await until(() => document.querySelector("#host .fp-panel") !== null, 6000));
      const sheet = document.querySelector("#host .fp-panel");
      if (sheet !== null) {
        const sb = sheet.getBoundingClientRect();
        note("sheetBox", `${Math.round(sb.left)},${Math.round(sb.top)} ${Math.round(sb.width)}x${Math.round(sb.height)}`);
        note("sheetInside", inside(sheet));
        note("sheetScroll", `${sheet.scrollHeight}/${sheet.clientHeight}`);
        note("sheetHScroll", sheet.scrollWidth > sheet.clientWidth + 1);
        key(sheet, "Escape");
        await settle(250);
      }
      note("sheetClosed", document.querySelector("#host .fp-panel") === null);
    }

    // The outline floats over the page; it must not reach past the pane either.
    const hasOutline = all("#host button").some((b) => b.getAttribute("aria-label") === DICT.outline);
    note("hasOutline", hasOutline);
    if (hasOutline) {
      click(DICT.outline);
      await until(() => document.querySelector("#host .fp-outline") !== null, 4000);
      await settle(250);
      const nav = document.querySelector("#host .fp-outline");
      const nb = nav.getBoundingClientRect();
      const list = nav.querySelector(".fp-outline-list");
      note("outlineBox", `${Math.round(nb.left)},${Math.round(nb.top)} ${Math.round(nb.width)}x${Math.round(nb.height)}`);
      note("outlineInside", inside(nav));
      note("outlineListScroll", `${list.scrollHeight}/${list.clientHeight}`);
      note("outlineHScroll", list.scrollWidth > list.clientWidth + 1);
      note("outlineHeadHeight", Math.round(nav.querySelector(".fp-outline-head").getBoundingClientRect().height));
      note("label", text("#host .fp-pageno"));
      click(DICT.outline);
      await settle(200);
    }
  },

  /**
   * BUG: a three-level outline, sixty rows, one title no column can hold.
   *
   * Folded all the way down: where is the chapter being read? Jumped to a
   * third-level entry, then 折叠全部 — the highlight is still in the model, but
   * is it on screen? Plus: the list scrolls under a fixed head, a deep row's
   * indent, a long title's ellipsis, and whether Escape or a press on the page
   * puts the panel away.
   */
  "a-outline3": async ({ note, settle, click, all, text, DICT, until, params, frameTop, pagesLabel }) => {
    const stepLimit = Number(params.get("step") ?? "99");
    await until(() => all("#host .fp-outline-row").length > 0, 15000);
    // The rows live in state as soon as the document has an outline, but the list
    // is only rendered while the panel is open (client.js:3103), so nothing of it
    // is in the DOM until 目录 is pressed. Every read below is guarded: one timing
    // slip must not take the whole probe down with a null dereference.
    const rows = () => all("#host .fp-outline .fp-outline-row");
    const shown = () => rows().filter((el) => el.closest(".fp-outline-kids[data-folded]") === null).length;
    const list = () => document.querySelector("#host .fp-outline-list");
    const head = () => document.querySelector("#host .fp-outline-head");
    const nav = () => document.querySelector("#host .fp-outline");
    const box = (el) => (el === null || el === undefined ? null : el.getBoundingClientRect());
    note("panelOpenAtStart", list() !== null);
    if (list() === null) {
      click(DICT.outline);
      await until(() => list() !== null, 5000);
    }
    note("panelOpen", list() !== null);
    note("rowsTotal", rows().length);
    note("rowsShown", shown());
    note("listScroll", (() => {
      const el = list();
      return el === null ? null : `${el.scrollHeight}/${el.clientHeight}`;
    })());
    note("listOverflow", (() => {
      const el = list();
      return el === null ? null : el.scrollHeight > el.clientHeight + 1;
    })());
    note("headBox", (() => {
      const b = box(head());
      return b === null ? null : `${Math.round(b.top)},${Math.round(b.height)}`;
    })());

    if (stepLimit < 2) { note("stoppedAt", 1); return; }
    // The deepest row: how far in is it? The highlight starts where the row does.
    const deepest = rows().at(-1) ?? null;
    note("deepIndent", deepest === null ? null : getComputedStyle(deepest).paddingInlineStart);
    note("deepIndentVar", deepest === null
      ? null
      : (deepest.closest(".fp-outline-item")?.style.getPropertyValue("--fp-indent") ?? null));
    note("deepTitle", deepest === null ? null : deepest.textContent.trim().slice(0, 24));

    // One absurd title: ellipsized inside the row, and the row does not widen
    // the panel.
    const longRow = rows().find((el) => el.textContent.includes("exceptionally long")) ?? null;
    note("longFound", longRow !== null);
    if (longRow !== null) {
      note("longRowScroll", `${longRow.scrollWidth}/${longRow.clientWidth}`);
      note("longRowEllipsis", getComputedStyle(longRow).textOverflow);
      note("longRowClip", longRow.scrollWidth > longRow.clientWidth + 1);
      note("longPanelOverflow", (() => {
        const panel = nav();
        return panel === null ? null : `${panel.scrollWidth}/${panel.clientWidth}`;
      })());
    }

    if (stepLimit < 3) { note("stoppedAt", 2); return; }
    // Scroll the tree to its end: the head must not travel with it.
    const headTop = box(head())?.top ?? null;
    const listEl = list();
    if (listEl !== null) {
      listEl.scrollTop = listEl.scrollHeight;
      await settle(250);
      const afterTop = box(head())?.top ?? headTop;
      note("headMoved", headTop === null || afterTop === null ? null : Math.round(afterTop - headTop));
      note("listScrolled", Math.round(listEl.scrollTop));
      listEl.scrollTop = 0;
      await settle(150);
    } else {
      note("headMoved", null);
      note("listScrolled", null);
    }

    if (stepLimit < 4) { note("stoppedAt", 3); return; }
    // Fold one third-level branch away: only its two rows may disappear.
    const carets = all("#host .fp-outline .fp-outline-caret").filter((el) => el.tagName === "BUTTON");
    note("carets", carets.length);
    const before = shown();
    const lastCaret = carets.at(-1) ?? null;
    if (lastCaret === null) {
      note("afterDeepFold", null);
      note("afterDeepUnfold", null);
    } else {
      lastCaret.click();
      await settle(450);
      note("afterDeepFold", shown() - before);
      lastCaret.click();
      await settle(450);
      note("afterDeepUnfold", shown() - before);
    }

    if (stepLimit < 5) { note("stoppedAt", 4); return; }
    // Jump into the third level, then collapse everything: is the chapter the
    // reader is in still on screen?
    const target = rows().find((el) => el.textContent.includes("2.2.1")) ?? null;
    note("jumpTarget", target === null ? null : target.textContent.trim());
    note("labelBeforeJump", pagesLabel());
    note("scrollBeforeJump", frameTop());
    note("activeBeforeJump", document.querySelector("#host .fp-outline-item[data-active] .fp-outline-row")?.textContent?.trim() ?? null);
    target?.click();
    await settle(900);
    note("afterJumpLabel", pagesLabel());
    note("scrollAfterJump", frameTop());
    note("activeAfterJump", document.querySelector("#host .fp-outline-item[data-active] .fp-outline-row")?.textContent?.trim() ?? null);
    click(DICT.collapseAll);
    await settle(500);
    note("afterCollapseShown", shown());
    const active = document.querySelector("#host .fp-outline-item[data-active] .fp-outline-row");
    note("activeAfterCollapse", active?.textContent?.trim() ?? null);
    note("activeBoxAfterCollapse", (() => {
      const b = box(active);
      return b === null ? null : `${Math.round(b.width)}x${Math.round(b.height)}`;
    })());
    // Still in the DOM is not the same as on screen: the folded branch is clipped,
    // so compare the row's box with the list's own box.
    note("activeInListView", (() => {
      const panel = box(list());
      const b = box(active);
      if (panel === null || b === null) return null;
      return b.top >= panel.top - 1 && b.bottom <= panel.bottom + 1;
    })());
    note("activeHitAtCenter", (() => {
      const b = box(active);
      if (b === null) return null;
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return hit === null ? "nothing" : active.contains(hit) || hit.contains(active);
    })());
    click(DICT.expandAll);
    await settle(500);
    note("afterExpandShown", shown());

    if (stepLimit < 6) { note("stoppedAt", 5); return; }
    // Escape, and a press on the page, with the panel open. 「关掉了」 is read three
    // ways because the column can stay mounted while the list inside it goes.
    const panePressed = () => {
      const button = buttonBy(DICT.outline);
      return button === null ? null : button.getAttribute("aria-pressed");
    };
    note("openBeforeEscape", list() !== null);
    note("pressedBeforeEscape", panePressed());
    key(document.querySelector("#host .fp-root"), "Escape");
    await settle(250);
    note("escapeClosed", list() === null);
    note("escapeColumnGone", document.querySelector("#host .fp-outline") === null);
    note("escapePressed", panePressed());
    if (list() === null) {
      click(DICT.outline);
      await until(() => list() !== null, 5000);
      note("reopened", list() !== null);
    }
    if (stepLimit < 7) { note("stoppedAt", 6); return; }
    // The column closes on `pointerdown` (client.js:2513). A `mousedown` here
    // measured 「没关」 for a handler that was simply never asked.
    const frame = document.querySelector("#host .fp-frame");
    if (frame !== null) {
      const press = (type) => frame.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0,
      }));
      press("pointerdown");
      press("pointerup");
      await settle(250);
    }
    note("pagePressClosed", list() === null);
    note("pagePressColumnGone", document.querySelector("#host .fp-outline") === null);
    note("pagePressPressed", panePressed());
  },

  /**
   * The delivery table: one row of numbers per pane size, same keys every run.
   *
   * Run it once per `&pane=` (× `&paneH=` × `&dark=1` × `&primitives=0`); the
   * keys are meant to be pasted side by side, so nothing here is a verdict — a
   * row either matches the others or it does not. `signature` is every geometry
   * number in one string, which is what a light/dark comparison is: does the
   * string change when only the theme changes.
   */
  "a-matrix": async ({ note, settle, click, all, text, DICT, openMore, until }) => {
    const rect = (el) => (el === null || el === undefined ? null : (() => {
      const b = el.getBoundingClientRect();
      return `${Math.round(b.width)}x${Math.round(b.height)}`;
    })());
    const full = (el) => (el === null || el === undefined ? null : (() => {
      const b = el.getBoundingClientRect();
      return `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`;
    })());
    const midY = (el) => (el === null || el === undefined ? null : (() => {
      const b = el.getBoundingClientRect();
      return b.top + b.height / 2;
    })());
    const root = document.querySelector("#host .fp-root");
    const rootBox = root.getBoundingClientRect();
    if (stepLimit < 7) { note("stoppedAt", 6); return; }
    const frame = document.querySelector("#host .fp-frame");
    const toolbar = document.querySelector("#host .fp-toolbar");
    const pageno = document.querySelector("#host .fp-pageno");
    const field = document.querySelector("#host .fp-page-input");
    const total = document.querySelector("#host .fp-pages-total");
    const zoom = document.querySelector("#host .fp-zoom");

    // What pane this run actually got, and whether the theme actually flipped.
    const hostBox = document.querySelector("#host").getBoundingClientRect();
    note("paneBox", `${Math.round(hostBox.width)}x${Math.round(hostBox.height)}`);
    note("rootBox", rect(root));
    note("themeBg", getComputedStyle(document.body).backgroundColor);
    note("pageBg", getComputedStyle(document.querySelector("#host .fp-pages .page") ?? root).backgroundColor);

    // The toolbar: one row or two, and whether it has to scroll to show them.
    note("toolbarBox", rect(toolbar));
    note("toolbarRows", toolbar.getBoundingClientRect().height > 50 ? 2 : 1);
    note("toolbarScrollOver", toolbar.scrollWidth - toolbar.clientWidth);
    note("toolbarTops", [...new Set(all("#host .fp-toolbar button").map((el) => Math.round(el.getBoundingClientRect().top)))].join(","));

    // The pager group, and whether the zoom readout sits on the same line.
    note("pagerBox", rect(pageno));
    note("pagerFull", full(pageno));
    note("pagerOneRow", midY(field) !== null && midY(total) !== null && Math.abs(midY(field) - midY(total)) < 4);
    note("zoomSameRowAsPager", midY(zoom) !== null && midY(pageno) !== null && Math.abs(midY(zoom) - midY(pageno)) < 4);

    // The two scrollbars anyone would call a bug if they appeared.
    note("docScrollWidth", document.documentElement.scrollWidth);
    note("documentClientWidth", document.documentElement.clientWidth);
    note("docHScrollOver", document.documentElement.scrollWidth - document.documentElement.clientWidth);
    note("frameScrollW", frame.scrollWidth);
    note("frameClientW", frame.clientWidth);
    note("rootScrollOver", root.scrollWidth - root.clientWidth);

    // Primitives: with `&primitives=0` the Host draws no icons, so a toolbar that
    // quietly kept a hard-coded svg would show up here as a non-zero count.
    // The 目录 button only exists once the renderer has read the outline, so this
    // waits for it: on a fast pane the first pass can still be in flight and the
    // toolbar is then photographed with nine buttons instead of ten.
    await until(() => buttonBy(DICT.outline) !== null, 12000);
    const buttons = all("#host .fp-toolbar button");
    note("buttonCount", buttons.length);
    note("svgIconsAll", all("#host .fp-toolbar svg").length);
    note("buttonAriaLabels", buttons.map((b) => b.getAttribute("aria-label") ?? "-").join("|"));
    note("ariaLabelsMissing", buttons.filter((b) => (b.getAttribute("aria-label") ?? "") === "").length);

    // The outline floats over the page: opening it must not resize the article.
    const frameWClosed = frame.clientWidth;
    const hasOutline = buttonBy(DICT.outline) !== null;
    note("hasOutline", hasOutline);
    if (hasOutline) {
      click(DICT.outline);
      await until(() => document.querySelector("#host .fp-outline") !== null, 4000);
      await settle(300);
      const nav = document.querySelector("#host .fp-outline");
      note("outlineFull", full(nav));
      note("outlineInside", (() => {
        if (nav === null) return null;
        const b = nav.getBoundingClientRect();
        return b.left >= rootBox.left - 1 && b.right <= rootBox.right + 1 && b.bottom <= rootBox.bottom + 1;
      })());
      note("outlineOpenFrameW", frame.clientWidth);
      note("frameWidthDelta", frame.clientWidth - frameWClosed);
      note("outlineListScrollOver", (() => {
        const list = nav.querySelector(".fp-outline-list");
        return list === null ? null : list.scrollWidth - list.clientWidth;
      })());
      click(DICT.outline);
      await settle(250);
    }

    // The ⋯ menu and the properties card behind it: the two things a short pane
    // is most likely to cut in half.
    note("menuOpened", await openMore());
    const menu = document.querySelector("#host .fp-menu");
    note("menuRect", full(menu));
    note("menuInside", (() => {
      if (menu === null) return null;
      const b = menu.getBoundingClientRect();
      return b.left >= rootBox.left - 1 && b.right <= rootBox.right + 1
        && b.top >= rootBox.top - 1 && b.bottom <= rootBox.bottom + 1;
    })());
    note("menuScrollOver", menu === null ? null : menu.scrollWidth - menu.clientWidth);
    if (menu !== null) {
      menu.querySelector(".fp-menu-row")?.click();
      note("sheetOpened", await until(() => document.querySelector("#host .fp-panel") !== null, 6000));
      const sheet = document.querySelector("#host .fp-panel");
      note("sheetRect", full(sheet));
      note("sheetInside", (() => {
        if (sheet === null) return null;
        const b = sheet.getBoundingClientRect();
        return b.left >= rootBox.left - 1 && b.right <= rootBox.right + 1
          && b.top >= rootBox.top - 1 && b.bottom <= rootBox.bottom + 1;
      })());
      note("sheetScrollOver", sheet === null ? null : sheet.scrollWidth - sheet.clientWidth);
      note("sheetBottomOver", sheet === null ? null : Math.round(sheet.getBoundingClientRect().bottom - rootBox.bottom));
      if (sheet !== null) {
        key(sheet, "Escape");
        await settle(250);
      }
      note("sheetClosed", document.querySelector("#host .fp-panel") === null);
    }

    // One string to compare light against dark with.
    note("signature", [
      rect(toolbar),
      toolbar.scrollWidth - toolbar.clientWidth,
      rect(pageno),
      full(pageno),
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      frame.clientWidth,
      frame.scrollWidth,
      Math.round(zoom.getBoundingClientRect().top),
      text("#host .fp-pageno"),
    ].join("|"));
  },

  /**
   * BUG A3: the ⋯ menu is anchored to the 更多 button's wrapper, not to the pane.
   *
   * When the toolbar wraps, 更多 is the last control of the second row and the
   * row is not right-aligned, so the button sits mid-pane; the popover is
   * `inset-inline-end: 0` against that wrapper and therefore hangs off the left
   * edge, where `.fp-root { overflow-x: clip }` cuts it. This probe lists where
   * every toolbar control actually is, and where `.fp-more` is, so the -21 px in
   * `a-matrix`'s `menuRect` has a cause rather than a description.
   */
  "a-toolbar-row": async ({ note, settle, all, click, DICT, openMore }) => {
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`;
    };
    const root = document.querySelector("#host .fp-root");
    note("rootBox", box(root));
    note("rootOverflowX", getComputedStyle(root).overflowX);
    note("toolbarPosition", getComputedStyle(document.querySelector("#host .fp-toolbar")).position);
    note("morePosition", getComputedStyle(document.querySelector("#host .fp-more")).position);
    note("spacerBox", all("#host .fp-spacer").map(box).join(" "));
    note("childrenBoxes", [...document.querySelector("#host .fp-toolbar").children].map((el) => (
      `${el.className || el.tagName.toLowerCase()}:${box(el)}`
    )).join(" | "));
    note("buttonBoxes", all("#host .fp-toolbar button").map((el) => (
      `${(el.getAttribute("aria-label") ?? el.textContent.trim()).slice(0, 6)}:${box(el)}`
    )).join(" | "));
    note("moreBox", box(document.querySelector("#host .fp-more")));
    // Which Button the toolbar got: the Host's primitive or the plugin's own
    // fallback. This is the only way to prove `&primitives=0` actually took
    // effect — `run-scenario.ps1` writes `primitives=1` first, and
    // `URLSearchParams.get` returns the FIRST value, so `-Extra '&primitives=0'`
    // is silently ignored.
    const first = all("#host .fp-toolbar button")[0] ?? null;
    note("firstButtonClass", first?.className ?? null);
    note("firstButtonSvg", first?.querySelectorAll("svg").length ?? null);
    note("hostTipWrappers", all("#host .fp-toolbar .fp-host-tip").length);
    note("firstButtonHtmlHead", first?.outerHTML.slice(0, 120) ?? null);
    note("menuOpened", await openMore());
    const menu = document.querySelector("#host .fp-menu");
    note("menuBox", menu === null ? null : box(menu));
    note("menuClippedLeft", menu === null ? null : Math.round(root.getBoundingClientRect().left - menu.getBoundingClientRect().left));
    await settle(200);
    if (menu !== null) {
      key(menu, "Escape");
      await settle(200);
    }
  },
  /**
   * UNSURE: Tab walks through four page-level text overlays between the toolbar
   * and the pager, which is pdf.js's own doing (`pdf_viewer.mjs:6201-6203` sets
   * `div.tabIndex = 0` so a screen reader can read the page). Measured here so the
   * delivery can say what a keyboard user actually walks through — and whether the
   * stop is visible at all: `viewer.css:869-872` removes the ring from
   * `.fp-frame:focus-visible` and nothing styles `.textLayer:focus`.
   *
   * No CDP hook in this harness can press a real Tab (the toolbox's `key()`
   * dispatches a synthetic KeyboardEvent, which never moves focus), so the order
   * below is the browser's tab order — tabindex >= 0 in tree order — with every
   * entry proved focusable by calling `.focus()` and reading focus back.
   */
  "a-tabstops": async ({ note, settle, all }) => {
    await settle(300);
    const list = tabbables();
    const buttons = all("#host .fp-toolbar button");
    const last = buttons[buttons.length - 1] ?? null;
    note("tabbablesTotal", list.length);
    note("lastToolbarButton", nameOf(last));
    const start = list.indexOf(last);
    note("lastToolbarButtonIndex", start);
    note("tabStopsAfterLastButton", list.length - start - 1);
    const tail = list.slice(start + 1, start + 7).map((el) => {
      // The box is read BEFORE focus(): `.focus()` scrolls its target into view,
      // and the first version of this probe reported three layers at one spot
      // because of it.
      const box = el.getBoundingClientRect();
      const page = el.closest(".page")?.dataset.pageNumber ?? "?";
      el.focus();
      const landed = document.activeElement === el;
      const cls = (el.getAttribute("class") ?? "").trim().split(/\s+/)[0] ?? "";
      const inText = el.closest(".textLayer") !== null;
      return `${el.tagName.toLowerCase()}${cls === "" ? "" : `.${cls}`}${inText ? "[textLayer]" : ""}`
        + ` p${page} ${landed ? "focusable" : "noFocus"} ${Math.round(box.width)}x${Math.round(box.height)}`
        + ` at ${Math.round(box.left)},${Math.round(box.top)}`;
    });
    note("tabSequenceOfFirst6", tail.join(" | "));

    const layers = all("#host .textLayer");
    note("textLayerCount", layers.length);
    note("focusableTextLayers", layers.filter((el) => el.hasAttribute("tabindex")).length);
    note("textLayerTabIndexValue", layers.length === 0 ? null : layers[0].getAttribute("tabindex"));
    note("tabbablesInTextLayer", list.filter((el) => el.closest(".textLayer") !== null).length);
    note("textLayerSpansTotal", all("#host .textLayer span").length);
    note("focusableSpans", all("#host .textLayer span[tabindex]").length);
    note("frameHasTabIndex", document.querySelector("#host .fp-frame")?.getAttribute("tabindex") ?? null);
    note("pagesHasTabIndex", document.querySelector("#host .fp-pages")?.getAttribute("tabindex") ?? null);

    const firstLayer = layers[0] ?? null;
    if (firstLayer !== null) {
      firstLayer.focus();
      const cs = getComputedStyle(firstLayer);
      note("textLayerFocusedIsLayer", document.activeElement === firstLayer);
      note("textLayerOutlineWhileFocused", `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`);
      note("textLayerOutlineOffset", cs.outlineOffset);
      note("textLayerConnectedName", activeName());
    }
    // And the frame itself: does it hold a stop of its own?
    if (stepLimit < 7) { note("stoppedAt", 6); return; }
    const frame = document.querySelector("#host .fp-frame");
    if (frame !== null) {
      frame.focus();
      const cs = getComputedStyle(frame);
      note("frameTakesFocus", document.activeElement === frame);
      note("frameOutlineWhileFocused", `${cs.outlineStyle} ${cs.outlineWidth}`);
    }
  },

  /**
   * A3 follow-up: the ⋯ menu is above the outline now — is it really on top, and
   * does the properties row still work while the outline is open? `z-index` 8 vs
   * 4 says yes; `elementFromPoint` and a real click say whether it is true.
   */
  "a-overlay": async ({ note, settle, until, click, all, DICT, openMore }) => {
    const rect = (el) => {
      const b = el.getBoundingClientRect();
      return {
        l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom),
        w: Math.round(b.width), h: Math.round(b.height),
      };
    };
    const fmt = (o) => (o === null ? null : `${o.l},${o.t} ${o.w}x${o.h}`);
    const root = document.querySelector("#host .fp-root");
    const rootBox = rect(root);
    if (stepLimit < 7) { note("stoppedAt", 6); return; }
    const frame = document.querySelector("#host .fp-frame");
    const frameWClosed = frame.clientWidth;

    note("outlineButton", buttonBy(DICT.outline) !== null);
    click(DICT.outline);
    note("outlineOpened", await until(() => document.querySelector("#host .fp-outline") !== null, 6000));
    await settle(300);
    const nav = document.querySelector("#host .fp-outline");
    const navBox = nav === null ? null : rect(nav);
    note("outlineFull", fmt(navBox));
    note("outlineZ", nav === null ? null : getComputedStyle(nav).zIndex);
    note("outlineOpenFrameW", frame.clientWidth);
    note("outlineDidNotShrinkFrame", frame.clientWidth === frameWClosed);

    note("menuOpened", await openMore());
    await settle(260);
    const menu = document.querySelector("#host .fp-menu");
    const menuBox = menu === null ? null : rect(menu);
    note("menuRect", fmt(menuBox));
    note("menuZ", menu === null ? null : getComputedStyle(menu).zIndex);
    note("menuInsidePanel", menuBox === null ? null : (
      menuBox.l >= rootBox.l && menuBox.r <= rootBox.r && menuBox.t >= rootBox.t && menuBox.b <= rootBox.b
    ));
    note("menuRightMinusPane", menuBox === null ? null : menuBox.r - rootBox.r);
    note("outlineStillOpen", document.querySelector("#host .fp-outline") !== null);
    note("outlineOverlapArea", menuBox === null || navBox === null ? null : Math.max(0, Math.min(menuBox.r, navBox.r) - Math.max(menuBox.l, navBox.l))
      * Math.max(0, Math.min(menuBox.b, navBox.b) - Math.max(menuBox.t, navBox.t)));
    note("menuOverlapsOutline", menuBox === null || navBox === null ? null : !(
      menuBox.r <= navBox.l || menuBox.l >= navBox.r || menuBox.b <= navBox.t || menuBox.t >= navBox.b
    ));
    if (menuBox !== null) {
      const cx = Math.round((menuBox.l + menuBox.r) / 2);
      const cy = Math.round((menuBox.t + menuBox.b) / 2);
      const hit = document.elementFromPoint(cx, cy);
      note("hitPoint", `${cx},${cy}`);
      note("hitAtMenuCentre", hit === null ? null : `${hit.tagName.toLowerCase()}.${(hit.getAttribute("class") ?? "").trim().split(/\s+/)[0] ?? ""}`);
      note("hitInsideMenu", hit !== null && menu.contains(hit));
      note("hitInsideOutline", hit !== null && nav !== null && nav.contains(hit));
      // The row under the outline still works: this is a real click on 文档属性.
      const row = all("#host .fp-menu-row").find((el) => (el.textContent ?? "").includes(DICT.properties)) ?? null;
      note("propertiesRowFound", row !== null);
      if (row !== null) {
        row.click();
        note("sheetOpenedOverOutline", await until(() => document.querySelector("#host .fp-panel") !== null, 6000));
        const sheet = document.querySelector("#host .fp-panel");
        const sheetBox = sheet === null ? null : rect(sheet);
        note("sheetRect", fmt(sheetBox));
        note("sheetZ", sheet === null ? null : getComputedStyle(sheet).zIndex);
        note("sheetInside", sheetBox === null ? null : (
          sheetBox.l >= rootBox.l && sheetBox.r <= rootBox.r && sheetBox.t >= rootBox.t && sheetBox.b <= rootBox.b
        ));
        if (sheet !== null) {
          const sx = Math.round((sheetBox.l + sheetBox.r) / 2);
          const sy = Math.round((sheetBox.t + sheetBox.b) / 2);
          const sh = document.elementFromPoint(sx, sy);
          note("sheetHitInsideSheet", sh !== null && sheet.contains(sh));
          key(sheet, "Escape");
          await settle(300);
        }
        note("sheetClosed", document.querySelector("#host .fp-panel") === null);
      }
    }
    note("outlineSurvivedAll", document.querySelector("#host .fp-outline") !== null);
  },

  /**
   * ⑥ The find bar's 上一个 / 下一个 buttons, measured rather than described.
   *
   * Six presses at 250 ms, three presses in one task, both wrap directions, the
   * disabled state while the index is still being built (collected as a timeline
   * by a MutationObserver, because "正在建立索引…" can be over in one frame), and
   * Enter against the button. Nothing here decides whether it feels bad — it
   * records what the bar says and where the blue `.hl.current` mark actually is
   * after each press.
   */
  "hunt-a-findstep": async ({ note, settle, until, click, type, all, text, DICT }) => {
    const count = () => text("#host .fp-find-count") ?? "";
    const barButton = (label) => all("#host .fp-findbar button")
      .find((el) => (el.getAttribute("title") ?? el.getAttribute("aria-label")) === label) ?? null;
    const nextButton = () => barButton(DICT.findNext);
    const prevButton = () => barButton(DICT.findPrevious);
    const frameEl = () => document.querySelector("#host .fp-frame");
    /** Where the blue current mark is, and whether the frame can see all of it. */
    const mark = () => {
      const cur = document.querySelector("#host .hl.current");
      if (cur === null) return { page: "-", top: null, visible: false, marks: all("#host .hl.current").length };
      const box = cur.getBoundingClientRect();
      const frameBox = frameEl().getBoundingClientRect();
      return {
        page: cur.closest(".page")?.dataset.pageNumber ?? "?",
        top: Math.round(box.top - frameBox.top),
        visible: box.top >= frameBox.top - 1 && box.bottom <= frameBox.bottom + 1
          && box.left >= frameBox.left - 1 && box.right <= frameBox.right + 1,
        marks: all("#host .hl.current").length,
      };
    };
    const indexNow = () => Number((count().match(/^(\d+)/u) ?? [])[1] ?? NaN);

    // The index can go from "正在建立索引…" to "1 / N" between two frames, so the
    // count is recorded by watching it instead of sampling it.
    click(DICT.find);
    await until(() => document.querySelector("#host .fp-find-input") !== null, 6000);
    const countEl = document.querySelector("#host .fp-find-count");
    const timeline = [];
    const observer = new MutationObserver(() => {
      const state = `${count()}|next=${nextButton()?.disabled}|prev=${prevButton()?.disabled}`;
      if (timeline[timeline.length - 1] !== state) timeline.push(state);
    });
    if (countEl !== null) observer.observe(countEl, { childList: true, characterData: true, subtree: true });
    // State of the two buttons before any query: no hits, so the source says
    // `disabled: find.hits.length === 0`.
    const countAtOpen = count();
    note("countAtOpen", countAtOpen === "" ? "(empty)" : countAtOpen);
    note("nextDisabledAtOpen", nextButton()?.disabled ?? null);
    note("prevDisabledAtOpen", prevButton()?.disabled ?? null);
    // Time from typing to the first number the reader can see: the bar is silent
    // in between (empty text, not 「正在建立索引…」), and that silence is what
    // "用起来很糟" would feel like.
    // What one instant of the bar looks like: the count text, both buttons'
    // `disabled`, and any class on them that could be drawing a disabled state.
    const sample = () => {
      const next = nextButton();
      const prev = prevButton();
      const flags = (el) => (el === null ? "-" : ([...el.classList].filter((name) => /dis|off|inert|busy|wait|load/u.test(name)).join(".") || "-"));
      return `${count() === "" ? "(empty)" : count()}|next=${next?.disabled ?? "?"}|prev=${prev?.disabled ?? "?"}|nextCls=${flags(next)}|prevCls=${flags(prev)}`;
    };
    const typedAt = performance.now();
    type(document.querySelector("#host .fp-find-input"), "Page");
    note("countRightAfterType", sample());
    // Ten samples, 100 ms apart: the whole first second of the walk, in order.
    const probes = [];
    for (let probe = 0; probe < 10; probe += 1) {
      probes.push(sample());
      await settle(100);
    }
    probes.forEach((line, at) => note(`probe${at}`, line));
    const firstNumber = probes.findIndex((line) => !line.startsWith("(empty)"));
    note("firstNumberProbe", firstNumber);
    note("msToFirstNumber", firstNumber < 0 ? -1 : firstNumber * 100);

    // A press at about the one-second mark, while the count is still moving.
    const pressBefore = count();
    nextButton()?.click();
    await settle(300);
    const pressAfter = count();
    note("pressWhileIndexingBefore", pressBefore === "" ? "(empty)" : pressBefore);
    note("pressWhileIndexingAfter", pressAfter === "" ? "(empty)" : pressAfter);
    note("pressWhileIndexingMoved", pressBefore !== pressAfter);
    note("nextDisabledAfterPress", nextButton()?.disabled ?? null);

    // Wait until the answer stops changing: the index grows in the background and
    // every growth re-runs the query, so "done" is "the count held still".
    const quietStart = performance.now();
    let lastCount = count();
    let lastChangeAt = performance.now();
    let indexSettled = false;
    while (performance.now() - quietStart < 40000) {
      await settle(200);
      const now = count();
      if (now !== lastCount) {
        lastCount = now;
        lastChangeAt = performance.now();
      } else if (/\d+ \/ \d+/u.test(now) && performance.now() - lastChangeAt > 1200) {
        indexSettled = true;
        break;
      }
    }
    note("indexSettled", indexSettled);
    note("indexSettledCount", lastCount);
    note("indexSettledMs", Math.round(performance.now() - typedAt));
    observer.disconnect();
    note("countTimeline", timeline.join(" ; "));
    const indexing = timeline.find((entry) => entry.includes("正在建立索引")) ?? null;
    note("indexingText", indexing);
    note("nextDisabledWhileIndexing", indexing === null ? null : indexing.includes("next=true"));
    note("prevDisabledWhileIndexing", indexing === null ? null : indexing.includes("prev=true"));
    note("findCount", count());
    note("marksAtStart", all("#host .hl").length);

    // 3) three presses once the index has stopped moving the count.
    const afterIndex = [];
    for (let press = 0; press < 3; press += 1) {
      nextButton()?.click();
      await settle(300);
      afterIndex.push(count());
    }
    note("afterIndexSeq", afterIndex.join(" ; "));

    // 1) six presses, 250 ms apart.
    for (let step = 1; step <= 6; step += 1) {
      nextButton()?.click();
      await settle(250);
      const at = mark();
      note(`step${step}`, count());
      note(`stepVisible${step}`, at.visible);
      note(`stepPage${step}`, `${at.page}@${at.top}px/${at.marks}`);
    }

    // 2) three presses with no wait between them: the whole task, one batch.
    const rapidBeforeCount = count();
    note("rapidBefore", rapidBeforeCount);
    const rapid = nextButton();
    rapid?.click();
    rapid?.click();
    rapid?.click();
    note("rapidImmediate", count());
    await settle(900);
    note("rapidAfter", count());
    note("rapidAdvanced", indexNow() - Number((rapidBeforeCount.match(/^(\d+)/u) ?? [])[1]));

    // 3) both wraps, reached from the current position.
    const total = Number((count().match(/\/ (\d+)/u) ?? [])[1] ?? NaN);
    note("total", total);
    // Put the cursor back on the first hit by re-running the query (a fresh
    // search starts at index 0) instead of pressing Prev N times, which on a
    // document with hundreds of hits costs minutes. The field is cleared first:
    // React's value tracker drops an `input` event whose value did not change, so
    // typing the same query over itself starts no new search at all.
    note("beforeReset", count());
    const findField = document.querySelector("#host .fp-find-input");
    type(findField, "");
    await settle(400);
    type(findField, "Page");
    await until(() => count().startsWith("1 / "), 30000);
    await settle(600);
    note("atFirst", count());
    prevButton()?.click();
    await settle(400);
    note("wrapToLast", count());
    note("wrapToLastMark", `${mark().page}@${mark().top}px visible=${mark().visible}`);
    nextButton()?.click();
    await settle(400);
    note("wrapToFirst", count());
    note("wrapToFirstMark", `${mark().page}@${mark().top}px visible=${mark().visible}`);

    // 5) Enter against the button, from the same index.
    const input = document.querySelector("#host .fp-find-input");
    const beforeEnter = count();
    key(input, "Enter");
    await settle(400);
    const afterEnter = count();
    const enterAdvances = Number((afterEnter.match(/^(\d+)/u) ?? [])[1]) - Number((beforeEnter.match(/^(\d+)/u) ?? [])[1]);
    note("enterFrom", beforeEnter);
    note("enterTo", afterEnter);
    note("enterAdvances", enterAdvances);
    // A second Enter, still from the same starting index, 400 ms apart: if the
    // field and the button disagree, this is where it shows.
    key(input, "Enter");
    await settle(400);
    note("enterTwiceFrom", beforeEnter);
    note("enterTwiceTo", count());
    const beforeButton = count();
    nextButton()?.click();
    await settle(400);
    const afterButton = count();
    const buttonAdvances = Number((afterButton.match(/^(\d+)/u) ?? [])[1]) - Number((beforeButton.match(/^(\d+)/u) ?? [])[1]);
    note("buttonFrom", beforeButton);
    note("buttonTo", afterButton);
    note("buttonAdvances", buttonAdvances);
    note("enterSameAsButton", enterAdvances === buttonAdvances);
    key(input, "Escape");
    await settle(300);
    note("barClosed", document.querySelector("#host .fp-findbar") === null);
  },

  /**
   * ⑨ ctrl+wheel: how long the percentage and the page take to catch up.
   *
   * Ten wheels in one task, then one on its own. Both lags are measured from
   * "the last event has been dispatched" with a rAF loop, so they are real
   * frames-to-change rather than a sleep that hides the answer.
   */
  "hunt-a-wheelzoom": async ({ note, settle, text, all }) => {
    const frameEl = () => document.querySelector("#host .fp-frame");
    const zoomText = () => text("#host .fp-zoom-count") ?? "";
    const firstPage = () => document.querySelector("#host .fp-pages .page");
    const pageWidth = () => {
      const el = firstPage();
      return el === null ? -1 : Math.round(el.getBoundingClientRect().width * 100) / 100;
    };
    const canvasWidth = () => {
      const canvas = firstPage()?.querySelector("canvas") ?? null;
      return canvas === null ? -1 : canvas.width;
    };
    const percent = () => Number((zoomText().match(/(\d+)/u) ?? [])[1] ?? NaN);
    const wheel = () => frameEl().dispatchEvent(new WheelEvent("wheel", {
      deltaY: -100, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true,
    }));
    const waitChange = (read, from) => new Promise((resolve) => {
      const started = performance.now();
      const tick = () => {
        const value = read();
        if (value !== from) {
          resolve({ ms: Math.round(performance.now() - started), value });
          return;
        }
        if (performance.now() - started > 12000) {
          resolve({ ms: -1, value });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    // "When it stops moving": the page box and the canvas pixel width have to
    // hold still for three frames in a row. The first change has to have happened
    // first, or an untouched page would count as settled after three frames.
    const quiet = (read, frames = 3, timeoutMs = 12000) => new Promise((resolve) => {
      const started = performance.now();
      let last = `${read()}`;
      let stable = 0;
      let changes = 0;
      const tick = () => {
        const value = `${read()}`;
        if (value === last) stable += 1;
        else {
          stable = 0;
          changes += 1;
          last = value;
        }
        if (changes > 0 && stable >= frames) {
          resolve({ ms: Math.round(performance.now() - started), changes, value });
          return;
        }
        if (performance.now() - started > timeoutMs) {
          resolve({ ms: -1, changes, value });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await settle(500);
    note("zoomAtStart", zoomText());
    note("pageWidthAtStart", pageWidth());
    note("canvasWidthAtStart", canvasWidth());
    note("pageNodes", all("#host .fp-pages .page").length);
    note("canvasesInDomAtStart", all("#host .fp-pages canvas").length);

    // Every canvas that changes during the burst, by element identity: a repaint
    // rewrites `width`/`height`/`style`, a re-render replaces the element.
    const touched = new Set();
    let canvasMutations = 0;
    const countCanvas = (node) => {
      if (node?.nodeType !== 1) return;
      if (node.tagName === "CANVAS") touched.add(node);
      if (typeof node.querySelectorAll === "function") {
        node.querySelectorAll("canvas").forEach((el) => touched.add(el));
      }
    };
    const canvasObserver = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          canvasMutations += 1;
          if (record.target.tagName === "CANVAS") touched.add(record.target);
          continue;
        }
        record.addedNodes.forEach(countCanvas);
        record.removedNodes.forEach(countCanvas);
      }
    });
    const pagesEl = document.querySelector("#host .fp-pages");
    if (pagesEl !== null) {
      canvasObserver.observe(pagesEl, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["width", "height", "style"],
      });
    }

    // Ten wheels, one task, nothing awaited in between.
    const zoomBefore = zoomText();
    const widthBefore = pageWidth();
    const canvasBefore = canvasWidth();
    const dispatchStart = performance.now();
    const cancelled = [];
    for (let i = 0; i < 10; i += 1) cancelled.push(wheel() === false);
    note("burstDispatchMs", Math.round(performance.now() - dispatchStart));
    note("burstCount", 10);
    note("burstCancelled", cancelled.every(Boolean));
    note("zoomBefore", zoomBefore);
    // All four watches start from the same instant: run them together, or the
    // later ones would start counting after an earlier one already finished and
    // report a lag of zero for a change that happened a frame before.
    const [readout, layout, pixels, still] = await Promise.all([
      waitChange(zoomText, zoomBefore),
      waitChange(pageWidth, widthBefore),
      waitChange(canvasWidth, canvasBefore),
      quiet(() => `${pageWidth()}|${canvasWidth()}`),
    ]);
    note("readoutLagMs", readout.ms);
    note("readoutValue", readout.value);
    note("renderLagMs", layout.ms);
    note("renderValue", layout.value);
    note("canvasLagMs", pixels.ms);
    note("canvasValue", pixels.value);
    note("settleMs", still.ms);
    note("settleChanges", still.changes);
    note("zoomAfter", zoomText());
    note("pageWidthAfter", pageWidth());
    note("canvasWidthAfter", canvasWidth());
    canvasObserver.disconnect();
    note("canvasesTouched", touched.size);
    note("canvasMutations", canvasMutations);
    note("pageNodesAfter", all("#host .fp-pages .page").length);
    note("canvasesInDomAfter", all("#host .fp-pages canvas").length);
    note("burstScaleDelta", percent() - Number((zoomBefore.match(/(\d+)/u) ?? [])[1]));

    // One wheel on its own, 400 ms after the burst has gone quiet.
    await settle(400);
    const zoomOne = zoomText();
    const widthOne = pageWidth();
    const canvasOne = canvasWidth();
    note("singleCancelled", wheel() === false);
    const [singleReadout, singleLayout, singlePixels, singleStill] = await Promise.all([
      waitChange(zoomText, zoomOne),
      waitChange(pageWidth, widthOne),
      waitChange(canvasWidth, canvasOne),
      quiet(() => `${pageWidth()}|${canvasWidth()}`),
    ]);
    note("singleReadoutLagMs", singleReadout.ms);
    note("singleReadoutValue", singleReadout.value);
    note("singleRenderLagMs", singleLayout.ms);
    note("singleCanvasLagMs", singlePixels.ms);
    note("singleSettleMs", singleStill.ms);
    note("singleSettleChanges", singleStill.changes);
    await settle(300);
    note("zoomAfterSingle", zoomText());
    note("singleScaleDelta", percent() - Number((zoomOne.match(/(\d+)/u) ?? [])[1]));
  },

  /**
   * ⑤ The staged opening line, measured frame by frame on a second open.
   *
   * The harness opens the sample before any probe runs, so the first opening
   * line is already gone; this probe tears the pane down with `root.render(null)`
   * and mounts the same body again (exactly what `show()` does) with its own
   * frame-by-frame watcher on `.fp-loading`. `&mem=1` swaps the reader for the
   * harness's in-memory one, because run-scenario.ps1 always appends `&disk=...`
   * and a "no disk" run is otherwise unreachable.
   */
  "hunt-a-loading": async ({ note, settle, text, params, root, Body, bytes, readBytes, t, h, handle, tabSignal }) => {
    const memory = params.get("mem") === "1";
    // The opening-line strings as the product writes them (client.js:199-203).
    // `props.t` wins over the pane's own dictionary (client.js:978), and the
    // harness mirror (index.html:191-194) predates these keys, so the default run
    // measures the mirror's wording; `&prod=1` measures the product's.
    const prod = params.get("prod") === "1";
    const productStrings = {
      loadingWaiting: "正在读取文件…",
      loadingReceived: "已读取 {loaded}",
      loadingBytes: "已读取 {loaded} / {total}（{percent}%）",
      loadingPrepare: "正在解析版面…",
      loadingPreparePages: "正在排版 {loaded} / {total} 页",
    };
    const dictT = (key, vars) => {
      const template = productStrings[key] ?? t(key, vars);
      const text = template === undefined ? key : template;
      if (vars === undefined || typeof text !== "string") return text;
      return text.replace(/\{(\w+)\}/gu, (whole, name) => (vars[name] === undefined ? whole : String(vars[name])));
    };
    const diskPath = params.get("disk");
    const addressOf = (target) => `dsh-resource://file/session/sess-46/${encodeURIComponent(target).replaceAll("%2F", "/").replaceAll("%5C", "/")}`;
    // The pane keeps one open document per *address* (client.js:346
    // `openDocuments`) and the harness already opened this file before the probe
    // ran, so the same address is a cache hit and the opening line lives ~40 ms.
    // A `.` segment before the file name is the same file on disk — the route
    // resolves it — with a different address. The in-memory reader never looks
    // at the address, so a query nonce is enough there.
    const pdfRelative = String(params.get("pdf") ?? "").replace(/^\.\//u, "");
    const address = memory
      ? `file:///C:/docs/${pdfRelative}?cold=1`
      : addressOf(String(diskPath ?? `C:/docs/${pdfRelative}`).replace(/([\\/])([^\\/]+)$/u, "$1./$2"));
    // The harness's own in-memory reader: same 1 MiB chunks, same single
    // `onProgress(1)` at the end, no route involved.
    const readFromMemory = async (target, signal, onProgress) => {
      const source = bytes ?? new Uint8Array(0);
      const stream = new ReadableStream({
        start(controller) {
          for (let at = 0; at < source.length; at += 1024 * 1024) controller.enqueue(source.slice(at, at + 1024 * 1024));
          controller.close();
        },
      });
      const buffer = await new Response(new Response(stream, {
        status: 200,
        headers: { "content-length": String(source.length) },
      }).body).arrayBuffer();
      if (typeof onProgress === "function") onProgress(1);
      return { bytes: new Uint8Array(buffer), version: 1 };
    };
    note("readerMode", memory ? "in-memory-bytes" : "plugin-route");
    note("address", address);
    note("bytesInMemory", bytes === undefined ? null : bytes.length);
    note("pagesBefore", text("#host .fp-pages-total") ?? "-");
    note("loadedBefore", handle.loaded.length);

    root.render(null);
    await settle(150);
    note("unmounted", document.querySelector("#host .fp-pages") === null);

    const textTimeline = [];
    const modeTimeline = [];
    const percentSeq = [];
    let firstBarAt = null;
    let lastBarAt = null;
    let first100At = null;
    let last100At = null;
    let sawDeterminate = false;
    let sawIndeterminate = false;
    let indeterminateSamples = 0;
    let indeterminateWithValuenow = 0;
    let textHasPageCount = false;
    let readyAt = null;
    let frames = 0;
    const openedAt = performance.now();
    const stamp = () => Math.round(performance.now() - openedAt);

    const sample = () => {
      frames += 1;
      const bar = document.querySelector("#host .fp-loading");
      const line = document.querySelector("#host .fp-loading-text");
      const track = document.querySelector("#host .fp-loading-track");
      if (bar !== null) {
        const at = stamp();
        if (firstBarAt === null) firstBarAt = at;
        lastBarAt = at;
      }
      if (line !== null) {
        const shown = String(line.textContent ?? "").trim();
        if (textTimeline[textTimeline.length - 1]?.line !== shown) textTimeline.push({ at: stamp(), line: shown });
        if (/\d+\s*\/\s*\d+\s*页/u.test(shown) || /\d+ of \d+ pages/u.test(shown)) textHasPageCount = true;
      }
      if (track !== null) {
        const mode = track.dataset.mode ?? "(none)";
        const value = track.getAttribute("aria-valuenow");
        const key = `${mode}|${value === null ? "null" : value}`;
        if (modeTimeline[modeTimeline.length - 1]?.key !== key) modeTimeline.push({ at: stamp(), key });
        const shown = value === null ? "null" : value;
        if (percentSeq[percentSeq.length - 1] !== shown) percentSeq.push(shown);
        if (mode === "determinate") sawDeterminate = true;
        if (mode === "indeterminate") {
          sawIndeterminate = true;
          indeterminateSamples += 1;
          if (value !== null) indeterminateWithValuenow += 1;
        } else if (value === "100") {
          const at = stamp();
          if (first100At === null) first100At = at;
          last100At = at;
        }
      }
      if (readyAt === null && bar === null && document.querySelector("#host .fp-pages .page") !== null) readyAt = stamp();
    };

    // Every DOM write of the opening line, not one sample per frame: the 排版
    // phase can overwrite a value inside a single frame, and a frame-rate sampler
    // would then report "one jump to 100" for a bar that did count.
    let observerSamples = 0;
    const loadingObserver = new MutationObserver(() => {
      observerSamples += 1;
      sample();
    });
    loadingObserver.observe(document.querySelector("#host"), {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-mode", "aria-valuenow", "class"],
    });

    handle.revision += 1;
    root.render(h(Body, {
      content: {
        kind: "renderer",
        revision: handle.revision,
        reload: () => {},
        loaded: (version) => handle.loaded.push(version),
        failed: () => { handle.failed += 1; },
      },
      resourceAddress: address,
      readBytes: memory ? readFromMemory : readBytes,
      // `props.t` is the Host's dictionary (client.js:978 `props.t ?? ((key) => key)`).
      // The harness page passes its own mirror of that dictionary
      // (index.html:191-194), which does not have the new keys — so `&prod=1`
      // hands the body the five opening-line strings exactly as `client.js:199-203`
      // writes them, to see the sentence a reader gets in the app.
      t: prod ? dictT : t,
      sessionId: "sess-46",
      retainTab: () => () => {},
      useTabInfo: () => ({ tab: { id: "tab-body", signal: tabSignal, contentId: "content-1" } }),
      useStore: () => null,
      actions: { forget: () => {} },
      renderSlot: () => null,
    }));

    const frameTick = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const deadline = performance.now() + 120000;
    while (performance.now() < deadline) {
      sample();
      if (readyAt !== null && performance.now() - openedAt - readyAt > 1200) break;
      if (readyAt === null && document.querySelector("#host .fp-status[data-failed]") !== null) break;
      await frameTick();
    }

    loadingObserver.disconnect();
    note("observerSamples", observerSamples);
    note("frames", frames);
    note("textTimeline", textTimeline.map((entry) => `${entry.at}ms:${entry.line}`).join(" ; ") || "none");
    note("textChanges", textTimeline.length);
    note("modeTimeline", modeTimeline.map((entry) => `${entry.at}ms:${entry.key}`).join(" ; ") || "none");
    note("modeChanges", modeTimeline.length);
    note("percentSeq", percentSeq.join(" → ") || "none");
    note("sawDeterminate", sawDeterminate);
    note("sawIndeterminate", sawIndeterminate);
    note("sawPercent100", first100At !== null);
    note("holdAt100Ms", first100At === null ? null : (last100At ?? lastBarAt ?? readyAt ?? 0) - first100At);
    note("openMs", readyAt);
    note("barVisibleMs", firstBarAt === null ? 0 : (lastBarAt ?? readyAt ?? 0) - firstBarAt);
    note("barFirstSeenMs", firstBarAt);
    note("ariaValuenowAbsentWhenIndeterminate", indeterminateSamples === 0 ? null : indeterminateWithValuenow === 0);
    note("indeterminateSamples", indeterminateSamples);
    note("indeterminateWithValuenow", indeterminateWithValuenow);
    note("textHasPageCount", textHasPageCount);
    const finalTrack = document.querySelector("#host .fp-loading-track");
    note("finalText", (text("#host .fp-loading-text") ?? "(gone)"));
    note("finalMode", finalTrack === null ? "(gone)" : (finalTrack.dataset.mode ?? "(none)"));
    note("finalPercent", finalTrack === null ? "(gone)" : finalTrack.getAttribute("aria-valuenow"));
    note("pagesAfter", text("#host .fp-pages-total") ?? "-");
    note("canvasesAfter", document.querySelectorAll("#host .fp-pages canvas").length);
    note("loadedAfter", handle.loaded.join(",") || "-");
    note("failedAfter", handle.failed);
  },
};
