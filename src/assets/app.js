// The ATGC booking page.
//
// Everything this page sends is sealed to the server's key before it leaves the
// browser (seal.js), dropped in the letterbox, and answered by the lab's server,
// which alone decides what is allowed. The page only asks and shows.
//
// Server data is always put on the page as text, never as HTML.

(() => {
  "use strict";

  const C = BOOKING_CONFIG;
  const app = document.getElementById("app");
  const who = document.getElementById("who");
  const busyBox = document.getElementById("busy");
  const busyText = document.getElementById("busy-text");

  // ---------------------------------------------------------------- helpers

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "value") node.value = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (typeof kid === "string" || typeof kid === "number") {
        node.appendChild(document.createTextNode(String(kid)));
      } else if (kid instanceof Node) {
        node.appendChild(kid);
      }
      // Anything else - null, false, an event object - is dropped rather than
      // shown as "null" or allowed to throw.
    }
    return node;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // replaceChildren turns a null into the text "null", so empty slots go first.
  function show(...nodes) {
    app.replaceChildren(...nodes.flat().filter(n => n instanceof Node));
  }

  function errorLine(text) {
    return typeof text === "string" && text
      ? el("p", { class: "error", role: "alert" }, text) : null;
  }

  // ------------------------------------------------------ browser storage
  //
  // IndexedDB, because a CryptoKey can be stored there as itself - its private
  // half never becomes readable data, not even here.

  const DB = (() => {
    let db;
    function open() {
      if (db) return Promise.resolve(db);
      return new Promise((resolve, reject) => {
        const req = indexedDB.open("atgc-booking", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => { db = req.result; resolve(db); };
        req.onerror = () => reject(req.error);
      });
    }
    async function op(mode, fn) {
      const d = await open();
      return new Promise((resolve, reject) => {
        const tx = d.transaction("kv", mode);
        const req = fn(tx.objectStore("kv"));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      });
    }
    return {
      get: k => op("readonly", s => s.get(k)),
      set: (k, v) => op("readwrite", s => s.put(v, k)),
      clear: () => op("readwrite", s => s.clear()),
    };
  })();

  const cache = {
    get(k) { try { return JSON.parse(localStorage.getItem("booking." + k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem("booking." + k, JSON.stringify(v)); } catch (e) { /* ok */ } },
    clear() {
      try {
        Object.keys(localStorage).filter(k => k.startsWith("booking.")).forEach(k => localStorage.removeItem(k));
      } catch (e) { /* ok */ }
    },
  };

  // -------------------------------------------------------------- transport

  const state = { keyPair: null, session: null, email: null, me: null, orders: null, tubes: null };

  async function send(envelope) {
    const rid = randomId();
    const sealed = await Seal.seal(C.serverPublicKey, Object.assign({}, envelope, {
      v: 1, rid, at: Date.now(), reply_key: await Seal.publicRaw(state.keyPair),
    }));
    const put = await fetch(C.letterboxUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ op: "put_in", blob: JSON.stringify(sealed) }),
    });
    const accepted = await put.json();
    if (!accepted.ok) throw new Error("The message was not accepted.");

    const sep = C.letterboxUrl.includes("?") ? "&" : "?";
    const deadline = Date.now() + 120000;
    await sleep(2500);
    while (Date.now() < deadline) {
      const res = await fetch(C.letterboxUrl + sep + "op=get_out&id=" + rid);
      const got = await res.json();
      if (got.ok && got.found) {
        const reply = await Seal.open(state.keyPair.privateKey, JSON.parse(got.blob));
        if (reply.rid !== rid) throw new Error("An answer to another request arrived.");
        return reply;
      }
      await sleep(2500);
    }
    throw new Error("No answer yet. Please try again in a minute.");
  }

  // Every request goes through here: one at a time, with a visible wait.
  let working = false;
  async function request(envelope, label) {
    if (working) return null;
    working = true;
    const started = Date.now();
    busyText.textContent = label || "";
    busyBox.hidden = false;
    const tick = setInterval(() => {
      busyText.textContent = (label ? label + " " : "") + Math.round((Date.now() - started) / 1000) + " s";
    }, 1000);
    document.querySelectorAll("button").forEach(b => { b.dataset.was = b.disabled; b.disabled = true; });
    try {
      const reply = await send(envelope);
      if (!reply.ok && reply.error === "Please sign in.") {
        await signOutLocally();
        renderSignIn("Please sign in again.");
        return null;
      }
      return reply;
    } catch (e) {
      return { ok: false, error: e.message || "Something went wrong." };
    } finally {
      clearInterval(tick);
      busyBox.hidden = true;
      working = false;
      document.querySelectorAll("button").forEach(b => { b.disabled = b.dataset.was === "true"; });
    }
  }

  const call = (op, args, label) =>
    request({ type: "call", session: state.session, op, args: args || {} }, label);

  // ----------------------------------------------------------------- start

  async function boot() {
    if (!C.serverPublicKey || !window.crypto || !crypto.subtle) {
      show(errorLine("This browser cannot be used for booking."));
      return;
    }
    try {
      state.keyPair = await DB.get("keyPair");
      state.session = await DB.get("session");
      state.email = await DB.get("email");
    } catch (e) {
      state.session = null;
    }
    if (!state.session || !state.keyPair) return renderSignIn();

    state.me = cache.get("me");
    state.orders = cache.get("orders");
    showWho();
    if (state.me) renderHome();
    const reply = await call("me");
    if (reply && reply.ok) {
      setMe(reply.data);
      renderHome();
      refreshOrders();
    } else if (reply && !state.me) {
      renderSignIn(reply.error);
    }
  }

  function showWho() {
    who.replaceChildren();
    if (!state.session) return;
    who.append(el("span", {}, state.email || ""),
      el("button", { class: "link", onclick: () => signOut() }, "Sign out"));
  }

  function setMe(me) {
    state.me = me;
    cache.set("me", me);
  }

  async function signOutLocally() {
    state.session = null;
    state.me = state.orders = state.tubes = null;
    cache.clear();
    try { await DB.clear(); } catch (e) { /* ok */ }
    showWho();
  }

  async function signOut() {
    // Tell the server in the background, outside the one-at-a-time gate: a
    // sign-out still travelling must not block the next person's sign-in.
    if (state.session && state.keyPair) {
      send({ type: "signout", session: state.session }).catch(() => null);
    }
    await signOutLocally();
    renderSignIn();
  }

  // --------------------------------------------------------------- sign in

  function renderSignIn(message) {
    const email = el("input", { type: "email", autocomplete: "email", required: true, value: state.email || "" });
    const go = el("button", { class: "primary", type: "submit" }, "Send code");
    show(el("form", {
      class: "card stack", onsubmit: async e => {
        e.preventDefault();
        const address = email.value.trim().toLowerCase();
        if (!address) return;
        state.keyPair = await Seal.newBrowserKey();
        state.email = address;
        const reply = await request({ type: "signin_start", email: address }, "");
        if (!reply) return;
        if (!reply.ok) return renderSignIn(reply.error);
        renderCode();
      },
    }, el("h2", {}, "Sign in"), el("label", {}, "Email", email), go,
      message ? errorLine(message) : null));
    email.focus();
  }

  function renderCode(message) {
    const code = el("input", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]{6}", required: true });
    show(el("form", {
      class: "card stack", onsubmit: async e => {
        e.preventDefault();
        const secret = Seal.randomB64(32);
        const reply = await request({ type: "signin_confirm", email: state.email, code: code.value.trim(), session: secret }, "");
        if (!reply) return;
        if (!reply.ok) return renderCode(reply.error);
        state.session = secret;
        await DB.set("keyPair", state.keyPair);
        await DB.set("session", secret);
        await DB.set("email", state.email);
        setMe(reply.data);
        showWho();
        renderHome();
        refreshOrders();
      },
    }, el("h2", {}, "Code"), el("p", { class: "muted small" }, state.email),
      el("label", {}, "6 digits", code),
      el("div", { class: "row" },
        el("button", { class: "primary", type: "submit" }, "Sign in"),
        el("button", { type: "button", class: "link", onclick: () => renderSignIn() }, "Another address")),
      message ? errorLine(message) : null));
    code.focus();
  }

  // ------------------------------------------------------------------ home

  function renderHome(message) {
    const me = state.me;
    if (!me) return;
    if (!me.person) return renderProfile();

    const approved = me.groups.filter(g => g.status === "approved");
    const managing = me.groups.filter(g => g.manager);

    const groupRows = me.groups.map(g => el("tr", {},
      el("td", {}, g.name), el("td", {}, g.pi_name),
      el("td", {}, el("span", { class: "status " + g.status }, g.manager ? "manager" : g.status)),
      el("td", {}, g.folder ? el("a", { href: g.folder, target: "_blank", rel: "noopener" }, "Group folder") : "")));

    show(
      message ? errorLine(message) : null,
      el("div", { class: "card" },
        el("div", { class: "row" },
          approved.length ? el("button", { class: "primary", onclick: () => renderOrderForm() }, "New Sanger order") : null,
          me.folder ? el("a", { href: me.folder, target: "_blank", rel: "noopener" }, "Results folder") : null,
          managing.length ? el("button", { onclick: () => renderRequests() }, "Requests") : null)),
      el("h2", {}, "Groups"),
      el("div", { class: "card" },
        me.groups.length
          ? el("div", { class: "table-wrap" }, el("table", {}, el("tbody", {}, groupRows)))
          : null,
        el("div", { class: "row", style: "margin-top:10px" },
          el("button", { onclick: () => renderJoin() }, "Join a group"),
          el("button", { onclick: () => renderOpenGroup() }, "Open a group"),
          el("button", { class: "link", onclick: () => renderProfile() }, "Profile"))),
      el("h2", {}, "Orders"),
      renderOrderList(),
    );
  }

  async function refreshOrders() {
    const reply = await call("orders", {}, "");
    if (reply && reply.ok) {
      state.orders = reply.data;
      cache.set("orders", reply.data);
      if (document.getElementById("orders")) renderHome();
    }
  }

  function renderOrderList() {
    const data = state.orders;
    const box = el("div", { id: "orders" });
    if (!data) {
      box.append(el("p", { class: "muted small" }, "…"));
      return box;
    }
    const all = [...data.mine.map(o => [o, true]), ...data.group.map(o => [o, false])];
    if (!all.length) {
      box.append(el("p", { class: "muted small" }, "—"));
      return box;
    }
    for (const [order, mine] of all) {
      box.append(el("div", { class: "card" },
        el("div", { class: "row" },
          el("strong", {}, "#" + order.order_id),
          el("span", { class: "status " + order.status.replace(" ", "-") }, order.status),
          el("span", { class: "muted small" }, order.group_name + (mine ? "" : " · " + order.by)),
          el("span", { class: "muted small" }, (order.created_at || "").replace("T", " ").slice(0, 16)),
          mine && order.status === "new"
            ? el("button", { class: "link", onclick: () => cancelOrder(order.order_id) }, "Cancel")
            : null),
        el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, el("th", {}, "Line"), el("th", {}, "Service"),
            el("th", {}, "Template"), el("th", {}, "Primer"), el("th", {}, "Status"))),
          el("tbody", {}, order.lines.map(l => el("tr", {},
            el("td", {}, l.line_id), el("td", {}, l.service_name),
            el("td", {}, (l.template.label || "") + "  " + (l.template.name || "")),
            el("td", {}, (l.primer.label || "") + "  " + (l.primer.name || "")),
            el("td", {}, l.status))))))));
    }
    return box;
  }

  async function cancelOrder(orderId) {
    const reply = await call("cancel", { order_id: orderId }, "");
    if (!reply) return;
    if (!reply.ok) return renderHome(reply.error);
    state.orders = reply.data;
    cache.set("orders", reply.data);
    renderHome();
  }

  // --------------------------------------------------------------- profile

  function renderProfile(message) {
    const p = (state.me && state.me.person) || {};
    const name = el("input", { required: true, value: p.name || "", autocomplete: "name" });
    const lab = el("input", { value: p.phone_lab || "", autocomplete: "tel" });
    const mobile = el("input", { value: p.phone_personal || "", autocomplete: "tel" });
    show(el("form", {
      class: "card stack", onsubmit: async e => {
        e.preventDefault();
        const reply = await call("save_profile", { name: name.value, phone_lab: lab.value, phone_personal: mobile.value }, "");
        if (!reply) return;
        if (!reply.ok) return renderProfile(reply.error);
        setMe(reply.data);
        renderHome();
      },
    }, el("h2", {}, "Profile"),
      el("label", {}, "Name", name), el("label", {}, "Lab phone", lab), el("label", {}, "Mobile", mobile),
      el("div", { class: "row" }, el("button", { class: "primary", type: "submit" }, "Save"),
        state.me && state.me.person ? el("button", { type: "button", class: "link", onclick: () => renderHome() }, "Back") : null),
      message ? errorLine(message) : null));
    name.focus();
  }

  // ---------------------------------------------------------------- groups

  function renderOpenGroup(message) {
    const f = {
      name: el("input", { required: true }),
      pi_name: el("input", { required: true, placeholder: "Surname Name" }),
      faculty: el("input", {}),
      institute: el("input", {}),
      budget: el("input", { required: true }),
    };
    show(el("form", {
      class: "card stack", onsubmit: async e => {
        e.preventDefault();
        const args = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.value]));
        const reply = await call("open_group", args, "");
        if (!reply) return;
        if (!reply.ok) return renderOpenGroup(reply.error);
        setMe(reply.data);
        renderHome();
      },
    }, el("h2", {}, "Open a group"),
      el("label", {}, "Group", f.name), el("label", {}, "PI", f.pi_name),
      el("label", {}, "Faculty", f.faculty), el("label", {}, "Institute", f.institute),
      el("label", {}, "Budget", f.budget),
      el("div", { class: "row" }, el("button", { class: "primary", type: "submit" }, "Open"),
        el("button", { type: "button", class: "link", onclick: () => renderHome() }, "Back")),
      message ? errorLine(message) : null));
    f.name.focus();
  }

  async function renderJoin(message) {
    const reply = await call("list_groups", {}, "");
    if (!reply) return;
    if (!reply.ok) return renderHome(reply.error);
    const mine = new Set(state.me.groups.map(g => g.group_id));
    const options = reply.data.groups.filter(g => !mine.has(g.group_id));
    const pick = el("select", { required: true },
      el("option", { value: "" }, ""),
      options.map(g => el("option", { value: g.group_id }, g.name + " — " + g.pi_name)));
    show(el("form", {
      class: "card stack", onsubmit: async e => {
        e.preventDefault();
        if (!pick.value) return;
        const r = await call("join_group", { group_id: pick.value }, "");
        if (!r) return;
        if (!r.ok) return renderHome(r.error);
        setMe(r.data);
        renderHome();
      },
    }, el("h2", {}, "Join a group"), el("label", {}, "Group", pick),
      el("div", { class: "row" }, el("button", { class: "primary", type: "submit" }, "Ask to join"),
        el("button", { type: "button", class: "link", onclick: () => renderHome() }, "Back")),
      message ? errorLine(message) : null));
  }

  async function renderRequests(message, data) {
    let list = data;
    if (!list) {
      const reply = await call("requests", {}, "");
      if (!reply) return;
      if (!reply.ok) return renderHome(reply.error);
      list = reply.data.requests;
    }
    const decide = async (r, approve) => {
      const reply = await call("decide", { group_id: r.group_id, user_id: r.user_id, approve }, "");
      if (!reply) return;
      if (!reply.ok) return renderRequests(reply.error, list);
      renderRequests(null, reply.data.requests);
    };
    show(el("h2", {}, "Requests"),
      message ? errorLine(message) : null,
      el("div", { class: "card" },
        list.length ? el("div", { class: "table-wrap" }, el("table", {}, el("tbody", {}, list.map(r => el("tr", {},
          el("td", {}, r.name), el("td", {}, r.email), el("td", {}, r.phone_lab), el("td", {}, r.group_name),
          el("td", {}, el("div", { class: "row" },
            el("button", { class: "primary", onclick: () => decide(r, true) }, "Approve"),
            el("button", { onclick: () => decide(r, false) }, "Refuse")))))))) : el("p", { class: "muted" }, "—"),
        el("div", { class: "row", style: "margin-top:10px" },
          el("button", { class: "link", onclick: () => { refreshMe(); } }, "Back"))));
  }

  async function refreshMe() {
    const reply = await call("me", {}, "");
    if (reply && reply.ok) setMe(reply.data);
    renderHome();
  }

  // ----------------------------------------------------------------- order

  async function renderOrderForm(message) {
    if (!state.tubes) {
      const reply = await call("tubes", {}, "");
      if (!reply) return;
      state.tubes = reply.ok ? reply.data.tubes : [];
    }
    const groups = state.me.groups.filter(g => g.status === "approved");
    const group = el("select", { required: true }, groups.map(g => el("option", { value: g.group_id }, g.name)));
    const budget = el("select", { required: true });
    const fillBudgets = () => {
      const g = groups.find(x => x.group_id === group.value) || groups[0];
      budget.replaceChildren(...(g ? g.budgets : []).map(b =>
        el("option", { value: b.code, selected: b.default }, b.code)));
    };
    group.addEventListener("change", fillBudgets);
    fillBudgets();

    const body = el("tbody");
    const addLine = () => body.append(lineRow());
    addLine();

    show(el("form", {
      class: "card", onsubmit: async e => {
        e.preventDefault();
        const lines = [...body.children].map(tr => tr.readLine());
        const reply = await call("place_order", { group_id: group.value, budget: budget.value, lines }, "");
        if (!reply) return;
        if (!reply.ok) {
          const err = document.getElementById("form-error");
          err.replaceChildren(document.createTextNode(reply.error));
          return;
        }
        state.orders = reply.data;
        cache.set("orders", reply.data);
        state.tubes = null;
        renderHome();
      },
    }, el("h2", {}, "New Sanger order"),
      el("div", { class: "row" }, el("label", {}, "Group", group), el("label", {}, "Budget", budget)),
      el("div", { class: "table-wrap", style: "margin-top:12px" }, el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Service"), el("th", {}, "Template"), el("th", { class: "narrow" }, "ng/µl"),
          el("th", {}, "Primer"), el("th", { class: "narrow" }, "µM"), el("th", {}, "Remarks"), el("th", {}, ""))),
        body)),
      el("div", { class: "row", style: "margin-top:10px" },
        el("button", { type: "button", onclick: () => addLine() }, "+ Line"),
        el("button", { class: "primary", type: "submit" }, "Place order"),
        el("button", { type: "button", class: "link", onclick: () => renderHome() }, "Back")),
      el("p", { class: "error", id: "form-error", role: "alert" }, message || "")));
  }

  function tubePicker(kind) {
    const own = (state.tubes || []).filter(t => t.kind === kind);
    const select = el("select", {},
      el("option", { value: "" }, "New"),
      own.map(t => el("option", { value: t.tube_id }, t.label + "  " + t.name)));
    const name = el("input", { required: true });
    const conc = el("input", { inputmode: "decimal" });
    select.addEventListener("change", () => {
      const reuse = !!select.value;
      name.hidden = reuse; name.required = !reuse; conc.disabled = reuse;
    });
    return {
      cells: [el("td", {}, own.length ? select : null, name), el("td", { class: "narrow" }, conc)],
      read: () => select.value
        ? { tube_id: select.value }
        : { name: name.value, attrs: { concentration: conc.value } },
    };
  }

  function lineRow() {
    const service = el("select", { required: true },
      state.me.services.map(s => el("option", { value: s.id }, s.name)));
    const template = tubePicker("template");
    const primer = tubePicker("primer");
    const remarks = el("input", { maxlength: "200" });
    const tr = el("tr", {},
      el("td", {}, service), ...template.cells, ...primer.cells, el("td", {}, remarks),
      el("td", {}, el("button", {
        type: "button", class: "link", onclick: () => { if (tr.parentNode.children.length > 1) tr.remove(); },
      }, "×")));
    tr.readLine = () => ({ service: service.value, template: template.read(), primer: primer.read(), remarks: remarks.value });
    return tr;
  }

  boot();
})();
