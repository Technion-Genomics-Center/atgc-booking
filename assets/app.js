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

    // The letterbox holds this call open until the answer is there (letterbox
    // v2), so the page asks again only when a wait runs out.
    const sep = C.letterboxUrl.includes("?") ? "&" : "?";
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const asked = Date.now();
      const res = await fetch(C.letterboxUrl + sep + "op=get_out&wait=20000&id=" + rid);
      const got = await res.json();
      if (got.ok && got.found) {
        const reply = await Seal.open(state.keyPair.privateKey, JSON.parse(got.blob));
        if (reply.rid !== rid) throw new Error("An answer to another request arrived.");
        return reply;
      }
      // An older letterbox answers at once; do not hammer it.
      if (Date.now() - asked < 1500) await sleep(1500);
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
    state.tubes = state.orders && state.orders.tubes;
    showWho();
    if (state.me) renderHome();
    const reply = await call("home");
    if (reply && reply.ok) {
      setMe(reply.data);
      renderHome();
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

  // A "home" reply carries the orders too; they are kept apart from the rest.
  function setMe(data) {
    const { orders, ...me } = data;
    state.me = me;
    cache.set("me", me);
    if (orders) setOrders(orders);
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

  const isOpen = g => g.group_status === "active";

  function groupLabel(g) {
    if (g.group_status === "pending") return "waiting";
    if (g.group_status === "refused") return "refused";
    return g.manager ? "manager" : "member";
  }

  function groupClass(g) {
    if (g.group_status === "pending") return "pending";
    if (g.group_status === "refused") return "refused";
    return "approved";
  }

  function renderHome(message) {
    const me = state.me;
    if (!me) return;
    if (!me.person) return renderProfile();

    // A group opened on the page waits for ATGC staff before anything works.
    const approved = me.groups.filter(g => g.status === "approved" && isOpen(g));
    const invitations = me.invitations || [];

    const groupRows = me.groups.map(g => el("tr", {},
      el("td", {}, g.name), el("td", {}, g.pi_name),
      el("td", {}, el("span", { class: "status " + groupClass(g) }, groupLabel(g))),
      el("td", {}, g.manager && isOpen(g) ? el("button", { class: "link", onclick: () => renderMembers(g) }, "Members") : ""),
      el("td", {}, g.folder ? el("a", { href: g.folder, target: "_blank", rel: "noopener" }, "Group folder") : "")));

    show(
      message ? errorLine(message) : null,
      invitations.length ? el("div", { class: "card invite" },
        el("h2", {}, "Invitations (" + invitations.length + ")"),
        el("div", { class: "table-wrap" }, el("table", {}, el("tbody", {}, invitations.map(i => el("tr", {},
          el("td", {}, i.name), el("td", {}, i.pi_name), el("td", { class: "muted small" }, i.by || ""),
          el("td", {}, el("div", { class: "row" },
            el("button", { class: "primary", onclick: () => answerInvite(i, true) }, "Accept"),
            el("button", { onclick: () => answerInvite(i, false) }, "Decline"))))))))) : null,
      el("div", { class: "card" },
        el("div", { class: "row" },
          approved.length ? el("button", { class: "primary", onclick: () => renderOrderForm() }, "New Sanger order") : null,
          me.folder ? el("a", { href: me.folder, target: "_blank", rel: "noopener" }, "Results folder") : null,
          me.staff ? el("button", { onclick: () => renderBench() }, "Staff") : null)),
      el("h2", {}, "Groups"),
      el("div", { class: "card" },
        me.groups.length
          ? el("div", { class: "table-wrap" }, el("table", {}, el("tbody", {}, groupRows)))
          : null,
        el("div", { class: "row", style: "margin-top:10px" },
          el("button", { onclick: () => renderOpenGroup() }, "Open a group"),
          el("button", { class: "link", onclick: () => renderProfile() }, "Profile"))),
      el("h2", {}, "Orders"),
      renderOrderList(),
    );
  }

  async function answerInvite(invitation, accept) {
    const reply = await call("answer", { group_id: invitation.group_id, accept }, "");
    if (!reply) return;
    if (!reply.ok) return renderHome(reply.error);
    setMe(reply.data);
    renderHome();
    if (accept) refreshOrders();
  }

  function setOrders(data) {
    state.orders = data;
    state.tubes = data.tubes || state.tubes;
    cache.set("orders", data);
  }

  async function refreshOrders() {
    const reply = await call("orders", {}, "");
    if (reply && reply.ok) {
      setOrders(reply.data);
      if (document.getElementById("orders")) renderHome();
    }
  }

  // The order table follows Bookitlab's request-lines table, column for column
  // with Service added because one order mixes services.
  const LINE_HEADS = ["ID", "Status", "Service", "Template source", "Template name", "Template label",
    "Size", "Conc ng/ul", "Primer source", "Primer name", "Primer label"];

  function dateOf(stamp) {
    const d = (stamp || "").slice(0, 10).split("-");
    return d.length === 3 ? d[2] + "/" + d[1] + "/" + d[0] : "";
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
      const printable = order.status === "new" || order.status === "started";
      box.append(el("div", { class: "card" },
        el("div", { class: "row" },
          el("strong", {}, "#" + order.order_id),
          el("span", { class: "status " + order.status.replace(" ", "-") }, order.status),
          el("span", { class: "muted small" }, order.group_name + (mine ? "" : " · " + order.by)),
          el("span", { class: "muted small" }, (order.created_at || "").replace("T", " ").slice(0, 16)),
          el("span", { class: "grow" }),
          printable ? el("button", { onclick: () => renderLabels(order) }, "Print labels") : null,
          mine ? el("button", { class: "link", onclick: () => renderOrderForm(null, order) }, "Repeat") : null,
          mine && order.status === "new"
            ? el("button", { class: "link", onclick: () => cancelOrder(order.order_id) }, "Cancel")
            : null),
        el("div", { class: "table-wrap" }, el("table", { class: "lines" },
          el("thead", {}, el("tr", {}, LINE_HEADS.map(h => el("th", {}, h)))),
          el("tbody", {}, order.lines.map(l => el("tr", {},
            el("td", {}, l.line_id), el("td", {}, l.status), el("td", {}, l.service_name),
            el("td", {}, l.template.source), el("td", {}, l.template.name || ""), el("td", {}, l.template.label || ""),
            el("td", {}, l.template.size == null ? "" : String(l.template.size)),
            el("td", {}, l.template.concentration == null ? "" : String(l.template.concentration)),
            el("td", {}, l.primer.source), el("td", {}, l.primer.name || ""), el("td", {}, l.primer.label || "")))))),
        order.remarks ? el("p", { class: "muted small" }, order.remarks) : null));
    }
    return box;
  }

  async function cancelOrder(orderId) {
    const reply = await call("cancel", { order_id: orderId }, "");
    if (!reply) return;
    if (!reply.ok) return renderHome(reply.error);
    setOrders(reply.data);
    renderHome();
  }

  // ---------------------------------------------------------------- labels
  //
  // Printed in the browser, one 38 x 12 mm CRYO-TAG per page, laid out like the
  // lab's own stickers: the date up the left edge, then the label in bold, the
  // tube's name and the PI. Printing starts the order.

  // The labels an order needs: its own new templates and primers, each once.
  // A template or primer from an earlier order is already at the centre, like
  // a core primer, so it gets none (Nitsan, 2026-09-17). Nothing to tick.
  function renderLabels(order, message) {
    const tubes = labelsOf(order);
    const go = el("button", { class: "primary" }, tubes.length ? "Print " + tubes.length : "No labels needed");
    if (!tubes.length && order.status !== "new") go.disabled = true;
    go.addEventListener("click", async () => {
      if (tubes.length) printStickers(order, tubes);
      const reply = await call("labels_printed", { order_id: order.order_id, tube_ids: tubes.map(t => t.tube_id) }, "");
      if (!reply) return;
      if (!reply.ok) return renderLabels(order, reply.error);
      setOrders(reply.data);
      renderHome();
    });

    show(el("h2", {}, "Labels · #" + order.order_id),
      message ? errorLine(message) : null,
      el("div", { class: "card" },
        tubes.length ? el("div", { class: "table-wrap" }, el("table", {}, el("tbody", {}, tubes.map(t => el("tr", {},
          el("td", {}, el("strong", {}, t.label || "")), el("td", {}, t.name || ""))))))
          : null,
        el("div", { class: "row", style: "margin-top:10px" }, go,
          el("button", { class: "link", onclick: () => renderHome() }, "Back"))));
  }

  // An order's own new tubes, each once - what its labels are.
  function labelsOf(order) {
    const seen = new Map();
    for (const l of order.lines) {
      for (const t of [l.template, l.primer]) {
        if (t.new && t.tube_id && !seen.has(t.tube_id)) seen.set(t.tube_id, t);
      }
    }
    return [...seen.values()];
  }

  function printStickers(order, tubes) {
    printSheet(tubes.map(t => [order, t]));
  }

  // One sticker per page, for any mix of orders: [[order, tube], ...].
  function printSheet(pairs) {
    let sheet = document.getElementById("print-sheet");
    if (!sheet) {
      sheet = el("div", { id: "print-sheet" });
      document.body.append(sheet);
    }
    sheet.replaceChildren(...pairs.map(([order, t]) => el("div", { class: "sticker" },
      el("div", { class: "sticker-date" }, dateOf(order.created_at)),
      el("div", { class: "sticker-text" },
        el("b", {}, t.label || ""), el("span", {}, t.name || ""), el("span", {}, order.pi_name || "")))));
    window.print();
  }

  // ----------------------------------------------------------------- staff
  //
  // ATGC staff on the page: the bench's labels, plates, orders and waiting
  // groups - the same rules as the staff app, from any PC (Nitsan, 2026-09-17).
  // Managing people and billing stay in the staff app.

  function staffTabs(on) {
    const tab = (name, fn) => el("button", { class: name === on ? "tab on" : "tab", onclick: fn }, name);
    return el("div", { class: "row tabs" },
      tab("Labels", () => renderBench()), tab("Plates", () => renderPlates()),
      tab("Orders", () => renderStaffOrders()), tab("Groups", () => renderStaffGroups()),
      el("span", { class: "grow" }),
      el("button", { class: "link", onclick: () => renderHome() }, "Back"));
  }

  function download(name, base64) {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const a = el("a", { href: URL.createObjectURL(blob), download: name + ".xlsx" });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function downloadPlate(name) {
    const reply = await call("bench_plate_file", { name }, "");
    if (!reply) return;
    if (!reply.ok) return renderPlates(reply.error);
    download(reply.data.name, reply.data.data);
  }

  async function renderPlates(message, data) {
    let view = data;
    if (!view) {
      const reply = await call("bench_plates", {}, "");
      if (!reply) return;
      if (!reply.ok) return renderHome(reply.error);
      view = reply.data;
    }
    const exportNow = async () => {
      const reply = await call("bench_export", {}, "");
      if (!reply) return;
      if (!reply.ok) return renderPlates(reply.error, view);
      for (const f of reply.data.made) {
        if (f.data) download(f.name, f.data); else await downloadPlate(f.name);
      }
      renderPlates(reply.data.made.length ? null : "Nothing to export: no started order.", reply.data);
    };
    show(staffTabs("Plates"),
      message ? errorLine(message) : null,
      el("div", { class: "card" },
        el("div", { class: "row" }, el("button", { class: "primary", onclick: exportNow }, "Export")),
        view.plates.length ? el("div", { class: "table-wrap", style: "margin-top:12px" }, el("table", {},
          el("thead", {}, el("tr", {}, ["Plate", "Kind", "Wells", "Made", ""].map(h => el("th", {}, h)))),
          el("tbody", {}, view.plates.map(p => el("tr", {},
            el("td", {}, el("strong", {}, p.name)), el("td", {}, (p.family || "").toUpperCase()),
            el("td", {}, String(p.wells)), el("td", {}, (p.created_at || "").replace("T", " ").slice(0, 16)),
            el("td", {}, p.file ? el("button", { class: "link", onclick: () => downloadPlate(p.name) }, "Download") : "")))))) : null));
  }

  async function renderStaffOrders(message, filters) {
    const f = filters || { status: "", group_id: "", q: "" };
    const reply = await call("staff_orders", f, "");
    if (!reply) return;
    if (!reply.ok) return renderHome(reply.error);
    const view = reply.data;
    const status = el("select", {}, el("option", { value: "" }, ""),
      ["new", "started", "in process", "completed", "cancelled"].map(x => el("option", { value: x, selected: f.status === x }, x)));
    const group = el("select", {}, el("option", { value: "" }, ""),
      view.groups.map(g => el("option", { value: g.group_id, selected: f.group_id === g.group_id }, g.name)));
    const q = el("input", { value: f.q, placeholder: "Order, name or email" });
    show(staffTabs("Orders"),
      message ? errorLine(message) : null,
      el("form", {
        class: "card row", onsubmit: e => {
          e.preventDefault();
          renderStaffOrders(null, { status: status.value, group_id: group.value, q: q.value.trim() });
        },
      }, el("label", {}, "Status", status), el("label", {}, "Group", group), el("label", { class: "grow" }, "Find", q),
        el("button", { class: "primary", type: "submit" }, "Show")),
      el("div", { class: "card" },
        view.orders.length ? el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, ["Order", "Placed", "Status", "Group", "By", "Lines"].map(h => el("th", {}, h)))),
          el("tbody", {}, view.orders.map(o => el("tr", {},
            el("td", {}, el("button", { class: "link", onclick: () => renderStaffOrder(o.order_id, null, f) }, "#" + o.order_id)),
            el("td", {}, (o.created_at || "").replace("T", " ").slice(0, 16)),
            el("td", {}, el("span", { class: "status " + o.status.replace(" ", "-") }, o.status)),
            el("td", {}, o.group_name || ""), el("td", {}, o.by || ""), el("td", {}, String(o.lines))))))) : el("p", { class: "muted" }, "—"),
        view.more ? el("p", { class: "muted small" }, "Newest " + view.orders.length + " shown.") : null));
  }

  async function renderStaffOrder(orderId, message, filters, data) {
    let order = data;
    if (!order) {
      const reply = await call("staff_order", { order_id: orderId }, "");
      if (!reply) return;
      if (!reply.ok) return renderStaffOrders(reply.error, filters);
      order = reply.data.order;
    }
    const act = async (op, args) => {
      const reply = await call(op, Object.assign({ order_id: orderId }, args), "");
      if (!reply) return;
      if (!reply.ok) return renderStaffOrder(orderId, reply.error, filters, order);
      renderStaffOrder(orderId, null, filters, reply.data.order);
    };
    const open = order.status !== "completed" && order.status !== "cancelled";
    show(staffTabs("Orders"),
      message ? errorLine(message) : null,
      el("div", { class: "card" },
        el("div", { class: "row" },
          el("strong", {}, "#" + order.order_id),
          el("span", { class: "status " + order.status.replace(" ", "-") }, order.status),
          el("span", { class: "muted small" }, order.group_name + " · " + (order.by || "") + " · " + (order.by_email || "")),
          el("span", { class: "muted small" }, "Budget " + (order.budget || "")),
          el("span", { class: "grow" }),
          open ? el("button", {
            onclick: () => { if (confirm("Cancel order #" + order.order_id + "?")) act("staff_cancel", {}); },
          }, "Cancel order") : null,
          el("button", { class: "link", onclick: () => renderStaffOrders(null, filters) }, "All orders")),
        el("div", { class: "table-wrap", style: "margin-top:10px" }, el("table", { class: "lines" },
          el("thead", {}, el("tr", {}, LINE_HEADS.map(h => el("th", {}, h)), el("th", {}, ""))),
          el("tbody", {}, order.lines.map(l => el("tr", {},
            el("td", {}, l.line_id), el("td", {}, l.status), el("td", {}, l.service_name),
            el("td", {}, l.template.source), el("td", {}, l.template.name || ""), el("td", {}, l.template.label || ""),
            el("td", {}, l.template.size == null ? "" : String(l.template.size)),
            el("td", {}, l.template.concentration == null ? "" : String(l.template.concentration)),
            el("td", {}, l.primer.source), el("td", {}, l.primer.name || ""), el("td", {}, l.primer.label || ""),
            el("td", {}, open && l.status !== "Done"
              ? el("button", { class: "link", onclick: () => act("staff_line", { line_id: l.line_id, skip: l.status !== "Skip" }) },
                l.status === "Skip" ? "Unskip" : "Skip")
              : "")))))),
        order.remarks ? el("p", { class: "muted small" }, order.remarks) : null));
  }

  async function renderStaffGroups(message, data) {
    let view = data;
    if (!view) {
      const reply = await call("staff_groups", {}, "");
      if (!reply) return;
      if (!reply.ok) return renderHome(reply.error);
      view = reply.data;
    }
    const decide = async (g, approve) => {
      if (!approve && !confirm("Turn down " + g.name + "?")) return;
      const reply = await call("staff_group_decide", { group_id: g.group_id, approve }, "");
      if (!reply) return;
      if (!reply.ok) return renderStaffGroups(reply.error, view);
      renderStaffGroups(null, reply.data);
    };
    show(staffTabs("Groups"),
      message ? errorLine(message) : null,
      el("div", { class: "card" },
        view.waiting.length ? el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, ["Group", "PI", "Faculty", "Institute", "Budget", "Manager", "Opened", ""].map(h => el("th", {}, h)))),
          el("tbody", {}, view.waiting.map(g => el("tr", {},
            el("td", {}, g.name), el("td", {}, g.pi_name || ""), el("td", {}, g.faculty || ""), el("td", {}, g.institute || ""),
            el("td", {}, g.budgets.join(", ")), el("td", {}, g.managers.join(", ")),
            el("td", {}, (g.created_at || "").replace("T", " ").slice(0, 16)),
            el("td", {}, el("div", { class: "row" },
              el("button", { class: "primary", onclick: () => decide(g, true) }, "Approve"),
              el("button", { onclick: () => decide(g, false) }, "Turn down")))))))) : el("p", { class: "muted" }, "—")));
  }

  // ----------------------------------------------------------------- bench
  //
  // At the printer, for ATGC staff: every order whose labels are not printed.
  // Not everything placed is brought in on the day, so the bench ticks the
  // orders that arrived and prints theirs (Nitsan, 2026-09-17).

  async function renderBench(message, data) {
    let orders = data;
    if (!orders) {
      const reply = await call("bench_orders", {}, "");
      if (!reply) return;
      if (!reply.ok) return renderHome(reply.error);
      orders = reply.data.orders;
    }
    const picked = new Set();
    const go = el("button", { class: "primary", disabled: true }, "Print");
    const count = () => {
      const labels = orders.filter(o => picked.has(o.order_id)).reduce((n, o) => n + labelsOf(o).length, 0);
      go.textContent = picked.size ? "Print " + labels + " · " + picked.size + " order" + (picked.size > 1 ? "s" : "") : "Print";
      go.disabled = !picked.size;
    };
    const all = el("input", { type: "checkbox", title: "All" });
    const boxes = orders.map(o => {
      const box = el("input", { type: "checkbox" });
      box.addEventListener("change", () => {
        if (box.checked) picked.add(o.order_id); else picked.delete(o.order_id);
        all.checked = picked.size === orders.length;
        count();
      });
      return box;
    });
    all.addEventListener("change", () => {
      boxes.forEach((b, i) => { b.checked = all.checked; if (all.checked) picked.add(orders[i].order_id); });
      if (!all.checked) picked.clear();
      count();
    });

    go.addEventListener("click", async () => {
      const chosen = orders.filter(o => picked.has(o.order_id));
      const pairs = [];
      chosen.forEach(o => labelsOf(o).forEach(t => pairs.push([o, t])));
      if (pairs.length) printSheet(pairs);
      const reply = await call("bench_labels_printed", { order_ids: chosen.map(o => o.order_id) }, "");
      if (!reply) return;
      if (!reply.ok) return renderBench(reply.error, orders);
      renderBench(null, reply.data.orders);
    });

    const rows = [];
    orders.forEach((o, i) => {
      const detail = el("tr", { class: "detail", hidden: true },
        el("td", {}), el("td", { colspan: "6" }, el("div", { class: "table-wrap" }, el("table", { class: "lines" },
          el("tbody", {}, o.lines.map(l => el("tr", {},
            el("td", {}, l.line_id), el("td", {}, l.service_name),
            el("td", {}, l.template.name || ""), el("td", {}, l.template.label || ""),
            el("td", {}, l.primer.name || ""), el("td", {}, l.primer.source === "Core" ? "Core" : (l.primer.label || "")))))))));
      rows.push(el("tr", {},
        el("td", {}, boxes[i]),
        el("td", {}, el("button", { class: "link", onclick: () => { detail.hidden = !detail.hidden; } }, "#" + o.order_id)),
        el("td", {}, (o.created_at || "").replace("T", " ").slice(0, 16)),
        el("td", {}, o.by || ""), el("td", {}, o.group_name || ""),
        el("td", {}, String(o.lines.length)), el("td", {}, String(labelsOf(o).length))));
      rows.push(detail);
    });

    show(staffTabs("Labels"),
      message ? errorLine(message) : null,
      el("div", { class: "card" },
        orders.length ? el("div", { class: "table-wrap" }, el("table", {},
          el("thead", {}, el("tr", {}, el("th", {}, all), ["Order", "Placed", "By", "Group", "Lines", "Labels"].map(h => el("th", {}, h)))),
          el("tbody", {}, rows))) : el("p", { class: "muted" }, "—"),
        el("div", { class: "row", style: "margin-top:10px" }, go,
          el("button", { class: "link", onclick: () => renderBench() }, "Refresh"))));
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

  // Groups are never listed: a manager invites people by address.
  async function renderMembers(group, message, data) {
    let view = data;
    if (!view) {
      const reply = await call("members", { group_id: group.group_id }, "");
      if (!reply) return;
      if (!reply.ok) return renderHome(reply.error);
      view = reply.data;
    }
    const again = async (op, args) => {
      const reply = await call(op, Object.assign({ group_id: group.group_id }, args), "");
      if (!reply) return;
      if (!reply.ok) return renderMembers(group, reply.error, view);
      if (reply.data.left) return refreshMe();          // handed the group over
      renderMembers(group, null, reply.data);
    };
    const address = el("input", { type: "email", required: true, autocomplete: "off" });
    show(el("h2", {}, view.name),
      message ? errorLine(message) : null,
      el("div", { class: "card" },
        el("div", { class: "table-wrap" }, el("table", {}, el("tbody", {},
          view.members.map(m => el("tr", {},
            el("td", {}, m.name), el("td", {}, m.email), el("td", {}, m.phone_lab),
            el("td", {}, m.manager ? el("span", { class: "status approved" }, "manager") : ""),
            el("td", {}, m.manager
              ? el("button", { class: "link", onclick: () => again("set_manager", { email: m.email, manager: false }) }, "Not manager")
              : el("button", { class: "link", onclick: () => again("set_manager", { email: m.email, manager: true }) }, "Make manager")))),
          view.invited.map(i => el("tr", {},
            el("td", { class: "muted" }, "—"), el("td", {}, i.email), el("td", {}, ""),
            el("td", {}, el("div", { class: "row" },
              el("span", { class: "status pending" }, "invited"),
              el("button", { class: "link", onclick: () => again("withdraw", { email: i.email }) }, "Withdraw"))), el("td", {})))))),
        el("form", {
          class: "row", style: "margin-top:12px", onsubmit: e => {
            e.preventDefault();
            again("invite", { email: address.value.trim() });
          },
        }, address, el("button", { class: "primary", type: "submit" }, "Invite"),
          el("button", { type: "button", class: "link", onclick: () => renderHome() }, "Back"))));
    address.focus();
  }

  // ----------------------------------------------------------------- order

  async function renderOrderForm(message, from) {
    if (!state.tubes) {
      const reply = await call("tubes", {}, "");
      if (!reply) return;
      state.tubes = reply.ok ? reply.data.tubes : [];
    }
    const groups = state.me.groups.filter(g => g.status === "approved" && isOpen(g));
    const group = el("select", { required: true }, groups.map(g =>
      el("option", { value: g.group_id, selected: from && from.group_id === g.group_id }, g.name)));
    const budget = el("select", { required: true });
    const fillBudgets = () => {
      const g = groups.find(x => x.group_id === group.value) || groups[0];
      budget.replaceChildren(...(g ? g.budgets : []).map(b =>
        el("option", { value: b.code, selected: from ? from.budget === b.code : b.default }, b.code)));
    };
    group.addEventListener("change", fillBudgets);
    fillBudgets();

    const body = el("tbody");
    if (from) from.lines.forEach(l => body.append(lineRow(l)));
    else body.append(lineRow());
    const remarks = el("textarea", { rows: "3", maxlength: "1000" });

    show(el("form", {
      class: "card", onsubmit: async e => {
        e.preventDefault();
        const lines = [...body.children].map(tr => tr.readLine());
        const reply = await call("place_order", { group_id: group.value, budget: budget.value, lines, remarks: remarks.value }, "");
        if (!reply) return;
        if (!reply.ok) {
          const err = document.getElementById("form-error");
          err.replaceChildren(document.createTextNode(reply.error));
          return;
        }
        setOrders(reply.data);
        renderHome();
      },
    }, el("h2", {}, "New Sanger order"),
      el("div", { class: "row" }, el("label", {}, "Group", group), el("label", {}, "Budget", budget),
        el("span", { class: "grow" }),
        state.me.core_primers_url
          ? el("a", { class: "button", href: state.me.core_primers_url, target: "_blank", rel: "noopener" }, "Core primers")
          : null),
      el("div", { class: "table-wrap", style: "margin-top:12px" }, el("table", { class: "lines form" },
        el("thead", {}, el("tr", {}, LINE_HEADS.map(h => el("th", {}, h)), el("th", {}, ""))),
        body)),
      el("label", { style: "margin-top:12px" }, "Comments", remarks),
      el("div", { class: "row", style: "margin-top:10px" },
        el("button", { class: "primary", type: "submit" }, "Place order"),
        el("button", { type: "button", class: "link", onclick: () => renderHome() }, "Back")),
      el("p", { class: "error", id: "form-error", role: "alert" }, message || "")));
  }

  // One box for a tube: type a name for a new one, or find one of yours by name
  // or label - hundreds of them - and pick it. Typing a name or label that is
  // exactly one of yours picks it too, which is what the server would do anyway.
  function tubePicker(kind, labelCell, onPick) {
    const own = () => (state.tubes || []).filter(t => t.kind === kind);
    const input = el("input", { required: true, autocomplete: "off", spellcheck: "false" });
    const list = el("div", { class: "suggest", hidden: true });
    const wrap = el("div", { class: "picker" }, input, list);
    let picked = null;
    let active = -1;

    const set = tube => {
      picked = tube;
      if (tube) input.value = tube.name;
      input.classList.toggle("linked", !!tube);
      labelCell.textContent = tube ? tube.label : (input.value.trim() ? "new" : "");
      labelCell.classList.toggle("muted", !tube);
      onPick(tube);
    };
    const matches = () => {
      const q = input.value.trim().toLowerCase();
      return own().filter(t => !q || t.name.toLowerCase().includes(q) || t.label.toLowerCase().includes(q)).slice(0, 8);
    };
    const draw = () => {
      const found = matches();
      active = Math.min(active, found.length - 1);
      list.replaceChildren(...found.map((t, i) => el("div", {
        class: "option" + (i === active ? " active" : ""),
        onmousedown: e => { e.preventDefault(); set(t); list.hidden = true; },
      }, el("strong", {}, t.label), " ", t.name, el("span", { class: "muted small" }, " " + dateOf(t.date)))));
      list.hidden = !found.length || document.activeElement !== input;
      if (!list.hidden) {
        // Fixed, not absolute: the table scrolls sideways and would cut it off.
        const r = input.getBoundingClientRect();
        list.style.left = r.left + "px";
        list.style.top = r.bottom + 2 + "px";
      }
    };
    window.addEventListener("scroll", () => { list.hidden = true; }, { passive: true });
    input.addEventListener("focus", draw);
    input.addEventListener("blur", () => { list.hidden = true; });
    input.addEventListener("input", () => {
      const typed = input.value.trim();
      set(own().find(t => t.name === typed) || own().find(t => t.label.toLowerCase() === typed.toLowerCase()) || null);
      active = -1;
      draw();
    });
    input.addEventListener("keydown", e => {
      const found = matches();
      if (list.hidden || !found.length) return;
      if (e.key === "ArrowDown") { active = (active + 1) % found.length; draw(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = (active - 1 + found.length) % found.length; draw(); e.preventDefault(); }
      else if (e.key === "Enter" && active >= 0) { set(found[active]); list.hidden = true; e.preventDefault(); }
      else if (e.key === "Escape") { list.hidden = true; }
    });
    return {
      node: wrap,
      input,
      pick: set,
      read: extra => picked ? { tube_id: picked.tube_id } : { name: input.value, attrs: extra },
    };
  }

  function lineRow(from) {
    const service = el("select", { required: true },
      state.me.services.map(s => el("option", { value: s.id, selected: from && from.service === s.id }, s.name)));

    const templateLabel = el("td", { class: "muted" });
    const size = el("input", { inputmode: "numeric" });
    const conc = el("input", { inputmode: "decimal" });
    let wasPicked = false;
    const template = tubePicker("template", templateLabel, tube => {
      // A tube of yours already has its size and concentration on record.
      size.disabled = conc.disabled = !!tube;
      if (tube) {
        size.value = tube.size == null ? "" : tube.size;
        conc.value = tube.concentration == null ? "" : tube.concentration;
      } else if (wasPicked) {
        size.value = conc.value = "";
      }
      wasPicked = !!tube;
    });

    const primerLabel = el("td", { class: "muted" });
    const primerSource = el("select", {}, el("option", { value: "User" }, "User"), el("option", { value: "Core" }, "Core"));
    const primer = tubePicker("primer", primerLabel, () => {});
    const coreName = el("select", { required: true, hidden: true },
      el("option", { value: "" }, ""),
      (state.me.core_primers || []).map(name => el("option", { value: name }, name)));
    const primerCell = el("td", {}, primer.node, coreName);
    const setSource = () => {
      const core = primerSource.value === "Core";
      primer.node.hidden = core; primer.input.required = !core;
      coreName.hidden = !core; coreName.required = core;
      primerLabel.textContent = core ? "" : (primerLabel.textContent || "");
    };
    primerSource.addEventListener("change", setSource);

    if (from) {
      const find = t => t.tube_id && (state.tubes || []).find(x => x.tube_id === t.tube_id);
      const t = find(from.template);
      if (t) template.pick(t);
      else {
        template.input.value = from.template.name || "";
        template.pick(null);
        if (from.template.size != null) size.value = from.template.size;
        if (from.template.concentration != null) conc.value = from.template.concentration;
      }
      if (from.primer.source === "Core") { primerSource.value = "Core"; coreName.value = from.primer.name || ""; }
      else {
        const p = find(from.primer);
        if (p) primer.pick(p); else { primer.input.value = from.primer.name || ""; primer.pick(null); }
      }
    }
    setSource();

    const tr = el("tr", {},
      el("td", { class: "muted" }, "—"), el("td", { class: "muted" }, "New"), el("td", {}, service),
      el("td", { class: "muted" }, "User"), el("td", {}, template.node), templateLabel,
      el("td", { class: "narrow" }, size), el("td", { class: "narrow" }, conc),
      el("td", {}, primerSource), primerCell, primerLabel,
      el("td", {}, el("div", { class: "row nowrap" },
        el("button", {
          type: "button", class: "danger", title: "Remove line",
          onclick: () => { if (tr.parentNode.children.length > 1) tr.remove(); },
        }, "×"),
        el("button", {
          type: "button", title: "Add a line below", onclick: () => tr.after(lineRow(tr.readView())),
        }, "+"))));
    tr.readLine = () => ({
      service: service.value,
      template: template.read({ insert_length: size.value, concentration: conc.value }),
      primer: primerSource.value === "Core" ? { core: coreName.value } : primer.read({}),
    });
    // The same shape as a line of a placed order, so "+" copies this line.
    tr.readView = () => {
      const l = tr.readLine();
      return {
        service: l.service,
        template: { tube_id: l.template.tube_id, name: template.input.value,
          size: size.value || null, concentration: conc.value || null },
        primer: primerSource.value === "Core" ? { source: "Core", name: coreName.value }
          : { tube_id: l.primer.tube_id, name: primer.input.value },
      };
    };
    return tr;
  }

  boot();
})();
