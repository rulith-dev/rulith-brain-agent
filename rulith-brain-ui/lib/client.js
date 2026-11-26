// Rulith Brain Agent, browser half (a plain script for dsh's module loader: no build step). It puts the product's brand
// on dsh's web page - the sidebar's mark and name, the conversation's hero mark, the tab's title and icon - and keeps
// the credit "Based on DeepSeek Harness (MIT)" at the sidebar's foot. And it gives the page its way to Rulith Brain:
// an entry at the sidebar's foot that opens the agent's own Brain page (whether Brain runs, the switch "Learn from
// research", what the last answer drew on) over the page, shown once by itself to a newcomer - without it nothing on
// dsh's page says that this agent works on Brain's memory. It reads nothing from dsh's server and sends nothing.
window.__ModuleLoader__.load({
  id: "rulith-brain-ui",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;
    const NAME = "Rulith Brain Agent";
    const CREDIT = "Based on DeepSeek Harness (MIT)";
    const UPSTREAM = "DeepSeek Harness";
    // the agent's mark (its app icon): a blue brain on a white tile - Rulith Brain's icon turned round. A 64-unit
    // box, the shapes of the app's icon generator; the blue runs light top left to dark bottom right over the tile
    const LIGHT = "#3B82F6", DARK = "#1E3A8A", EDGE = "#C9D3E2";
    const AT = "translate(3.5 5.4) scale(0.9)";
    const LOBES = [[13, 29, 9], [19, 20, 9], [30, 15.5, 9], [42, 16.5, 9], [51, 23, 9], [54, 32, 8], [22, 38, 9], [33, 40, 8]];
    const STEM = "M35 44H44L45.6 51.2A3.4 3.4 0 0 1 42.3 55.3H39.6A3.4 3.4 0 0 1 36.2 52.3Z";
    const FOLDS = ["M8.5 27.5q4.5 -2.5 8 0.5", "M21.5 12.5q-1.8 4.8 1.8 8.4", "M33.5 8.5q-2.6 6 1.4 10q3 3.6 0.4 8", "M45.5 12.5q-2.5 4.5 1.5 8",
      "M49.5 27q4.5 0.5 6 4.5", "M17 32q6.5 -3.2 13.5 0", "M39.5 29.5q5 2 4 8", "M41.8 40.6q5.6 -3.4 12 -0.4"];
    const markSvg = (id) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
      + `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="64" y2="64"><stop offset="0" stop-color="${LIGHT}"/><stop offset="1" stop-color="${DARK}"/></linearGradient></defs>`
      + `<rect width="64" height="64" rx="14" fill="#fff"/><rect x="0.5" y="0.5" width="63" height="63" rx="13.5" fill="none" stroke="${EDGE}"/>`
      + `<g transform="${AT}"><g fill="url(#${id})"><ellipse cx="32" cy="30" rx="24" ry="15"/>`
      + LOBES.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join("")
      + `<ellipse cx="48" cy="42.5" rx="9" ry="6.5"/><path d="${STEM}"/></g>`
      + `<g fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round">${FOLDS.map((d) => `<path d="${d}"/>`).join("")}</g></g></svg>`;

    let marks = 0;
    function Mark({ size, className }) {
      const [id] = React.useState(() => `rulith-brain-mark-${++marks}`);   // one gradient id per drawn mark
      const edge = size || 24;
      return h("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 64 64", width: edge, height: edge, className,
          role: "img", "aria-label": NAME, style: { display: "block", flex: "none" } },
        h("defs", null, h("linearGradient", { id, gradientUnits: "userSpaceOnUse", x1: 0, y1: 0, x2: 64, y2: 64 },
          h("stop", { offset: 0, stopColor: LIGHT }), h("stop", { offset: 1, stopColor: DARK }))),
        h("rect", { width: 64, height: 64, rx: 14, fill: "#fff" }),
        h("rect", { x: 0.5, y: 0.5, width: 63, height: 63, rx: 13.5, fill: "none", stroke: EDGE }),
        h("g", { transform: AT },
          h("g", { fill: `url(#${id})` },
            h("ellipse", { cx: 32, cy: 30, rx: 24, ry: 15 }),
            ...LOBES.map(([cx, cy, r], k) => h("circle", { key: k, cx, cy, r })),
            h("ellipse", { cx: 48, cy: 42.5, rx: 9, ry: 6.5 }), h("path", { d: STEM })),
          h("g", { fill: "none", stroke: "#fff", strokeWidth: 1.9, strokeLinecap: "round" },
            ...FOLDS.map((d, k) => h("path", { key: k, d })))));
    }
    // the agent's own Brain page: the launcher writes its address here when it copies this plugin into the profile
    // (start.mjs: the forwarder's port is another at every start). As the file ships, there is no address and no entry.
    const PANEL = "__RULITH_BRAIN_PANEL__";
    const hasPanel = /^https?:\/\//.test(PANEL);
    const ZH = typeof navigator !== "undefined" && /^zh\b/i.test(navigator.language || "");
    const WORDS = ZH
      ? { entry: "Rulith Brain", hint: "这个智能体用的记忆：是否已连接，学到了什么，回答用到了哪些内容", close: "关闭" }
      : { entry: "Rulith Brain", hint: "The memory this agent works with: whether it is connected, what it learns, what an answer drew on", close: "Close" };
    const SEEN = "rulith-brain-agent.panel-seen";
    const PANEL_ID = "rulith-brain-panel";

    /** The agent's Brain page over dsh's page: a column at the right, closed by its button, Escape, or a click beside it. */
    function openPanel(doc) {
      if (!hasPanel || !doc || !doc.body || doc.getElementById(PANEL_ID)) return false;
      const back = doc.createElement("div");
      back.id = PANEL_ID;
      back.setAttribute("role", "dialog");
      back.setAttribute("aria-modal", "true");
      back.setAttribute("aria-label", WORDS.entry);
      back.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;justify-content:flex-end;background:rgba(15,23,42,.45)";
      const pane = doc.createElement("div");
      pane.style.cssText = "display:flex;flex-direction:column;width:min(480px,100vw);height:100%;background:Canvas;color:CanvasText;box-shadow:-8px 0 28px rgba(0,0,0,.3)";
      const bar = doc.createElement("div");
      bar.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px 6px 14px;font:600 13px system-ui,sans-serif;border-bottom:1px solid rgba(128,128,128,.35)";
      const name = doc.createElement("span");
      name.textContent = WORDS.entry;
      const shut = doc.createElement("button");
      shut.type = "button";
      shut.textContent = "\u00d7";
      shut.title = WORDS.close;
      shut.setAttribute("aria-label", WORDS.close);
      shut.style.cssText = "width:30px;height:30px;border:1px solid rgba(128,128,128,.5);border-radius:6px;background:transparent;color:inherit;font:400 18px/1 system-ui,sans-serif;cursor:pointer";
      const frame = doc.createElement("iframe");
      frame.src = PANEL + (PANEL.includes("?") ? "&" : "?") + "embed=1";
      frame.title = WORDS.entry;
      frame.style.cssText = "flex:1;width:100%;border:0;background:Canvas";
      const close = () => { back.remove(); doc.removeEventListener("keydown", onKey, true); };
      const onKey = (e) => { if (e.key === "Escape") close(); };
      shut.addEventListener("click", close);
      back.addEventListener("click", (e) => { if (e.target === back) close(); });
      doc.addEventListener("keydown", onKey, true);
      bar.append(name, shut);
      pane.append(bar, frame);
      back.append(pane);
      doc.body.append(back);
      shut.focus();
      return true;
    }
    // (a small brain: two halves, as the app's icon has it)
    function Glyph() {
      return h("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor",
          strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", style: { flex: "none" } },
        h("path", { d: "M12 5.2a3.2 3.2 0 0 0-6 1.2 3.3 3.3 0 0 0-1.6 5.4A3.4 3.4 0 0 0 7 17.6a3 3 0 0 0 5 .9z" }),
        h("path", { d: "M12 5.2a3.2 3.2 0 0 1 6 1.2 3.3 3.3 0 0 1 1.6 5.4A3.4 3.4 0 0 1 17 17.6a3 3 0 0 1-5 .9z" }),
        h("path", { d: "M12 5.2v13.3" }));
    }
    // the entry at the sidebar's foot; the narrow sidebar shows its glyph alone
    function Memory({ wide }) {
      if (!hasPanel) return null;
      return h("button", { type: "button", "data-rulith-memory": "", title: WORDS.hint, "aria-label": `${WORDS.entry}. ${WORDS.hint}`,
          onClick: () => openPanel(document),
          style: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: wide ? "6px 12px" : "6px 0", justifyContent: wide ? "flex-start" : "center",
            border: 0, borderRadius: 6, background: "transparent", color: "inherit", font: "inherit", fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "left" } },
        h(Glyph), wide ? h("span", { style: { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 } }, WORDS.entry) : null);
    }
    // the sidebar's foot: the way to Rulith Brain, and under it the credit (one action of dsh's row, a column of its own)
    function UpdateLink({ wide }) {
      const [notice, setNotice] = React.useState(null);
      React.useEffect(() => {
        let active = true;
        fetch(PANEL + "/agent-update", { credentials: "omit" }).then(r => r.json())
          .then(value => { if (active) setNotice(value); }).catch(() => {});
        return () => { active = false; };
      }, []);
      if (!notice) return null;
      const text = ZH ? `Rulith Brain Agent ${notice.version} 已发布` : `Rulith Brain Agent ${notice.version} is available`;
      return h("a", { href: notice.url, target: "_blank", rel: "noopener noreferrer", title: text, "aria-label": text },
        wide ? text : "↑");
    }

    function Foot({ wide }) {
      const entry = Memory({ wide }), credit = Credit({ wide });
      if (!entry && !credit) return null;
      const capacity = hasPanel && wide ? h("iframe", { src: PANEL + "/capacity?lang=" + (ZH ? "zh" : "en"),
        title: ZH ? "记忆容量" : "Memory capacity", tabIndex: -1, style: { border: 0, width: "100%", height: 42 } }) : null;
      return h("div", { style: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: 2, flex: "1 1 100%", width: "100%", minWidth: 0 } }, entry, capacity, hasPanel ? h(UpdateLink, { wide }) : null, credit);
    }
    /** Once, for a newcomer: the Brain page opens by itself. Whether it did. */
    function introduce(doc, store) {
      if (!hasPanel) return false;
      try {
        if (store.getItem(SEEN)) return false;
        store.setItem(SEEN, "1");
      } catch { return false; }
      return openPanel(doc);
    }
    const line = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 };
    // (the sidebar's brand row is one line high)
    function Name() {
      return h("span", { title: `${NAME}. ${CREDIT}.`, style: { ...line, fontWeight: 700 } }, NAME);
    }
    // the credit, above the settings at the sidebar's foot; the narrow sidebar has no room for it
    function Credit({ wide }) {
      if (!wide) return null;
      return h("div", { "data-rulith-credit": "", style: { ...line, padding: "4px 12px", fontSize: 12, opacity: 0.75 } }, CREDIT);
    }

    // the tab: dsh writes "<conversation> — DeepSeek Harness"; the product's name takes the place of dsh's, and the
    // tab's icon is the mark
    const retitle = (text) => String(text).split(UPSTREAM).join(NAME);
    const ICON = "data:image/svg+xml," + encodeURIComponent(markSvg("m"));
    function brandDocument(doc) {
      const fix = () => {
        if (doc.title.includes(UPSTREAM)) doc.title = retitle(doc.title);
        for (const link of doc.querySelectorAll('link[rel~="icon"]')) if (link.getAttribute("href") !== ICON) link.setAttribute("href", ICON);
      };
      fix();
      // (each change dsh makes is fixed once: what this writes no longer matches)
      const watch = new MutationObserver(fix);
      watch.observe(doc.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["href"] });
      return () => watch.disconnect();
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.inject("sidebar.brand.name", function* () {
        yield ctx.slots.register({ name: "sidebar.brand.mark" }, Mark);
        yield ctx.slots.register({ name: "sidebar.brand.name" }, Name);
      }));
      ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark" }, Mark));
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name: "sidebar.footer.action", id: "rulith-brain-foot",
        inject: () => ({}) }, Foot));
      ctx.effect(() => brandDocument(document));
      ctx.effect(() => {
        const timer = setTimeout(() => { try { introduce(document, localStorage); } catch { /* no storage: no introduction */ } }, 1200);
        return () => clearTimeout(timer);
      });
    }
    exports.apply = apply;
    exports.inject = ["slots"];
    exports.NAME = NAME;
    exports.CREDIT = CREDIT;
    exports.retitle = retitle;
    exports.markSvg = markSvg;
    exports.PANEL = PANEL;
    exports.openPanel = openPanel;
    exports.introduce = introduce;
    return module.exports;
  }
});
