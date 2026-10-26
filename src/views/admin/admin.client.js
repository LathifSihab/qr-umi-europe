// UMI QR manuals admin. Plain JS, no build step. Inlined into /admin by the Worker.
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

  const state = {
    me: null,
    products: [],
    current: null, // product shown in the manage view
    lang: null, // language tab shown in the manage view
    // Running uploads by id: { code, lang, docId (when replacing), title, pct }.
    // Several can run at once, for different languages and products.
    uploads: {},
    dialog: null, // document dialog: { mode: "add" | "edit", lang, docId, file }
  };

  let uploadSeq = 0;

  // ---------- helpers ----------

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
  }

  function formatSize(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function langInfo(code) {
    return state.me.languages.find((l) => l.code === code);
  }

  function toast(message, kind) {
    const el = document.createElement("div");
    el.className = "toast" + (kind === "error" ? " error" : "");
    el.textContent = message;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "error" ? 7000 : 3500);
  }

  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch("/api" + path, opts);
    } catch {
      throw new Error("Can't reach the server. Check your internet connection and try again.");
    }
    const data = await res.json().catch(() => ({}));
    // Staging session expired: back to the login page.
    if (res.status === 401 && data.login) {
      location.href = data.login;
      throw new Error(data.error);
    }
    if (!res.ok) throw new Error(data.error || "Something went wrong (" + res.status + "). Try again.");
    return data;
  }

  function download(href, filename) {
    const a = document.createElement("a");
    a.href = href;
    if (filename) a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function confirmDialog({ title, body, ok }) {
    const dlg = $("#confirm-dialog");
    $("#confirm-title").textContent = title;
    $("#confirm-body").textContent = body;
    $("#confirm-ok").textContent = ok;
    dlg.returnValue = "";
    dlg.showModal();
    return new Promise((resolve) => {
      dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
    });
  }

  function upsertLocal(product) {
    const i = state.products.findIndex((p) => p.code === product.code);
    if (i >= 0) state.products[i] = product;
    else state.products.push(product);
    state.products.sort((a, b) => a.code.localeCompare(b.code));
    if (state.current && state.current.code === product.code) state.current = product;
  }

  const isCurrent = (code) => state.current && state.current.code === code;

  const langOrder = (lang) => state.me.languages.findIndex((l) => l.code === lang);

  function sortDocuments(docs) {
    return docs.sort((a, b) => langOrder(a.lang) - langOrder(b.lang) || a.position - b.position || a.id - b.id);
  }

  function docsFor(product, lang) {
    return product.documents.filter((d) => d.lang === lang);
  }

  /**
   * Applies a server response about one document only. With uploads running in
   * parallel, responses can arrive out of order, so each one changes just its
   * own document instead of replacing the whole product.
   */
  function mergeDocument(code, doc) {
    const local = state.products.find((p) => p.code === code);
    if (!local) return;
    const documents = local.documents.filter((d) => d.id !== doc.id);
    documents.push(doc);
    upsertLocal({ ...local, documents: sortDocuments(documents) });
  }

  function dropDocument(code, id) {
    const local = state.products.find((p) => p.code === code);
    if (local) upsertLocal({ ...local, documents: local.documents.filter((d) => d.id !== id) });
  }

  /** Replaces one language's documents, e.g. after reordering. */
  function setLangDocuments(code, lang, docs) {
    const local = state.products.find((p) => p.code === code);
    if (!local) return;
    const others = local.documents.filter((d) => d.lang !== lang);
    upsertLocal({ ...local, documents: sortDocuments(others.concat(docs)) });
  }

  // ---------- routing ----------

  function route() {
    const m = location.hash.match(/^#\/p\/([^/]+)$/);
    $("#loading").hidden = true;
    if (m) showProduct(decodeURIComponent(m[1]));
    else showList();
  }

  // ---------- list view ----------

  function showList() {
    state.current = null;
    $("#product-view").hidden = true;
    $("#list-view").hidden = false;
    document.title = "QR manuals – UMI Europe";
    renderList();
  }

  function countLabel(n) {
    return n === 0 ? "no documents" : n === 1 ? "1 document" : n + " documents";
  }

  function renderList() {
    const q = $("#search").value.trim().toLowerCase();
    const list = state.products.filter(
      (p) =>
        !q ||
        [p.code, p.name, ...Object.values(p.name_translations)].some((s) => s.toLowerCase().includes(q)),
    );
    const el = $("#list");

    if (state.products.length === 0) {
      el.innerHTML =
        '<div class="empty"><p>No products yet. Add your first product to create its QR code.</p>' +
        '<button class="btn primary" type="button" data-action="add">Add product</button></div>';
      return;
    }
    if (list.length === 0) {
      el.innerHTML = '<div class="empty"><p>No products match “' + esc(q) + "”.</p></div>";
      return;
    }

    const rows = list
      .map((p) => {
        const badges = state.me.languages
          .map((l) => {
            const n = docsFor(p, l.code).length;
            const label = esc(l.english + ": " + countLabel(n));
            return (
              '<span class="badge' + (n ? " on" : "") + '" title="' + label + '">' +
              l.code.toUpperCase() + (n > 1 ? '<span class="count" aria-hidden="true">' + n + "</span>" : "") +
              '<span class="visually-hidden"> ' + label + "</span></span>"
            );
          })
          .join("");
        const href = "#/p/" + encodeURIComponent(p.code);
        return (
          "<tr>" +
          '<td class="code">' + esc(p.code) + "</td>" +
          "<td>" + esc(p.name) + "</td>" +
          '<td><span class="badges">' + badges + "</span></td>" +
          '<td class="actions">' +
          '<a class="btn small" href="' + href + '">Manage</a>' +
          '<a class="btn small" href="/api/products/' + encodeURIComponent(p.code) + '/qr.svg?download" download="UMI-QR-' + esc(p.code) + '.svg">Download QR</a>' +
          "</td></tr>"
        );
      })
      .join("");

    el.innerHTML =
      '<table class="table"><thead><tr><th scope="col">Code</th><th scope="col">Name</th>' +
      '<th scope="col">Documents</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table>";
  }

  // ---------- add product ----------

  function openAdd() {
    $("#add-form").reset();
    $("#add-error").textContent = "";
    updateCodePreview();
    $("#add-dialog").showModal();
    $("#add-code").focus();
  }

  function updateCodePreview() {
    const code = $("#add-code").value.trim().toUpperCase();
    const base = state.me ? state.me.public_base_url.replace(/\/+$/, "") : "";
    const el = $("#add-code-preview");
    if (!code) {
      el.innerHTML = "Short link: <code>" + esc(base) + "/m/…</code>";
    } else if (!CODE_RE.test(code)) {
      el.innerHTML = "Use 2 to 32 characters: letters, numbers and dashes, starting with a letter or number.";
    } else {
      el.innerHTML = "Short link: <code>" + esc(base + "/m/" + code) + "</code>";
    }
  }

  async function submitAdd(e) {
    e.preventDefault();
    const code = $("#add-code").value.trim().toUpperCase();
    const name = $("#add-name").value.trim();
    const btn = e.submitter || $("#add-form button[type=submit]");
    btn.disabled = true;
    $("#add-error").textContent = "";
    try {
      const { product } = await api("POST", "/products", { code, name });
      upsertLocal(product);
      $("#add-dialog").close();
      toast("Product " + product.code + " added.");
      location.hash = "#/p/" + encodeURIComponent(product.code);
    } catch (err) {
      $("#add-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- manage view ----------

  async function showProduct(code) {
    let product = state.products.find((p) => p.code === code.toUpperCase());
    if (!product) {
      try {
        product = (await api("GET", "/products/" + encodeURIComponent(code))).product;
        upsertLocal(product);
      } catch (err) {
        toast(err.message, "error");
        location.hash = "#/";
        return;
      }
    }
    // Open on the first language with documents, unless one was picked before.
    if (!state.current || state.current.code !== product.code) {
      const withDocs = state.me.languages.find((l) => docsFor(product, l.code).length > 0);
      state.lang = (withDocs || state.me.languages[0]).code;
    }
    state.current = product;
    $("#list-view").hidden = true;
    $("#product-view").hidden = false;
    renderProduct();
    $("#p-title").focus();
  }

  function renderProduct() {
    const p = state.current;
    const enc = encodeURIComponent(p.code);
    document.title = p.name + " – QR manuals";
    $("#p-title").textContent = p.name;
    $("#p-code").textContent = p.code;
    if (document.activeElement !== $("#p-name")) $("#p-name").value = p.name;
    renderNameLangs();
    $("#p-link").textContent = p.short_url;
    $("#test-link").href = p.short_url;
    $("#p-qr").src = "/api/products/" + enc + "/qr.svg";
    $("#p-qr").alt = "QR code for " + p.short_url;
    $("#dl-svg").href = "/api/products/" + enc + "/qr.svg?download";
    $("#dl-svg").setAttribute("download", "UMI-QR-" + p.code + ".svg");
    renderDocuments();
  }

  function uploadsFor(code, lang) {
    return Object.entries(state.uploads).filter(([, u]) => u.code === code && u.lang === lang);
  }

  function progressRow(id, u) {
    return (
      '<li class="doc" data-upload="' + id + '">' +
      '<div class="doc-main"><div class="doc-title">' + esc(u.title) + "</div>" +
      '<div class="progress-label">' + progressText(u.pct) + "</div>" +
      '<div class="progress" role="progressbar" aria-label="Upload progress for ' + esc(u.title) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + u.pct + '"><span style="width:' + u.pct + '%"></span></div>' +
      "</div></li>"
    );
  }

  function renderDocuments() {
    const p = state.current;
    const enc = encodeURIComponent(p.code);

    $("#lang-tabs").innerHTML = state.me.languages
      .map((l) => {
        const n = docsFor(p, l.code).length;
        const on = l.code === state.lang;
        return (
          '<button type="button" role="tab" class="lang-tab" id="tab-' + l.code + '" data-tab="' + l.code + '"' +
          ' aria-selected="' + on + '" aria-controls="docs-panel" tabindex="' + (on ? 0 : -1) + '">' +
          '<span class="badge' + (n ? " on" : "") + '">' + l.code.toUpperCase() + "</span>" +
          '<span class="lang-name">' + esc(l.english) + "</span>" +
          '<span class="lang-count">' + n + '<span class="visually-hidden"> ' + (n === 1 ? "document" : "documents") + "</span></span>" +
          "</button>"
        );
      })
      .join("");

    const l = langInfo(state.lang);
    const docs = docsFor(p, state.lang);
    const running = uploadsFor(p.code, state.lang);
    const replacing = Object.fromEntries(running.filter(([, u]) => u.docId).map(([id, u]) => [u.docId, id]));

    const rows = docs.map((d, i) => {
      if (replacing[d.id]) return progressRow(replacing[d.id], state.uploads[replacing[d.id]]);
      const t = esc(d.title);
      return (
        '<li class="doc">' +
        '<div class="doc-main">' +
        '<div class="doc-title">' + t + "</div>" +
        '<div class="meta">' + esc(d.original_name) + " · " + formatSize(d.size_bytes) + " · uploaded " + formatDate(d.uploaded_at) + "</div>" +
        "</div>" +
        '<div class="row">' +
        '<button class="btn small icon" type="button" data-action="up" data-id="' + d.id + '"' + (i === 0 ? " disabled" : "") + ' aria-label="Move ' + t + ' up" title="Move up">↑</button>' +
        '<button class="btn small icon" type="button" data-action="down" data-id="' + d.id + '"' + (i === docs.length - 1 ? " disabled" : "") + ' aria-label="Move ' + t + ' down" title="Move down">↓</button>' +
        '<a class="btn small" href="/f/' + enc + "/" + d.id + '" target="_blank" rel="noopener">View</a>' +
        '<button class="btn small" type="button" data-action="edit" data-id="' + d.id + '">Edit</button>' +
        '<button class="btn small danger-btn" type="button" data-action="remove" data-id="' + d.id + '">Remove</button>' +
        "</div></li>"
      );
    });
    for (const [id, u] of running) if (!u.docId) rows.push(progressRow(id, u));

    $("#docs-panel").setAttribute("aria-labelledby", "tab-" + state.lang);
    $("#docs-panel").innerHTML =
      (rows.length
        ? '<ol class="docs">' + rows.join("") + "</ol>"
        : '<p class="docs-empty">No ' + esc(l.english) + " documents yet. Visitors won't see " + esc(l.english) + " as an option.</p>") +
      '<div class="drop" data-drop>' +
      '<button class="btn primary small" type="button" data-action="add">Add ' + esc(l.english) + " document</button>" +
      "<div>or drag a PDF here</div></div>";
  }

  function selectLang(lang) {
    state.lang = lang;
    renderDocuments();
    $("#tab-" + lang).focus();
  }

  /** One optional name field per language. An empty field falls back to the default name. */
  function renderNameLangs() {
    const p = state.current;
    const box = $("#p-name-langs");
    if (!box.children.length) {
      box.innerHTML = state.me.languages
        .map(
          (l) =>
            '<div class="name-lang">' +
            '<label for="p-name-' + l.code + '"><span class="badge">' + l.code.toUpperCase() + "</span>" + esc(l.english) + "</label>" +
            '<input id="p-name-' + l.code + '" data-lang="' + l.code + '" lang="' + l.code + '" type="text" maxlength="200" autocomplete="off">' +
            "</div>",
        )
        .join("");
    }
    for (const input of box.querySelectorAll("input")) {
      if (document.activeElement !== input) input.value = p.name_translations[input.dataset.lang] || "";
    }
    updateNamePlaceholders();
  }

  function updateNamePlaceholders() {
    const fallback = $("#p-name").value.trim();
    for (const input of $("#p-name-langs").querySelectorAll("input")) {
      input.placeholder = fallback;
      input.previousElementSibling.querySelector(".badge").classList.toggle("on", Boolean(input.value.trim()));
    }
  }

  async function saveName(e) {
    e.preventDefault();
    const name = $("#p-name").value.trim();
    if (!name) {
      toast("Enter a product name.", "error");
      return;
    }
    // Every language is sent, so a cleared field removes that language's name.
    const name_translations = {};
    for (const input of $("#p-name-langs").querySelectorAll("input")) name_translations[input.dataset.lang] = input.value.trim();
    try {
      const { product } = await api("PATCH", "/products/" + encodeURIComponent(state.current.code), { name, name_translations });
      upsertLocal(product);
      renderProduct();
      toast("Names saved.");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(state.current.short_url);
      toast("Link copied.");
    } catch {
      const range = document.createRange();
      range.selectNodeContents($("#p-link"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast("Press Ctrl+C to copy the selected link.");
    }
  }

  async function downloadPng() {
    const code = state.current.code;
    try {
      const res = await fetch("/api/products/" + encodeURIComponent(code) + "/qr.svg");
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(new Blob([await res.text()], { type: "image/svg+xml" }));
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1024;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 1024, 1024);
      ctx.drawImage(img, 0, 0, 1024, 1024);
      URL.revokeObjectURL(url);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const pngUrl = URL.createObjectURL(blob);
      download(pngUrl, "UMI-QR-" + code + ".png");
      setTimeout(() => URL.revokeObjectURL(pngUrl), 1000);
    } catch {
      toast("Couldn't create the PNG. Download the SVG instead.", "error");
    }
  }

  // ---------- documents: add, edit, reorder, remove ----------

  /** Returns an error message, or null when the file can be uploaded. */
  function fileProblem(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return "This file isn't a PDF. Upload a .pdf file.";
    if (file.size > state.me.max_upload_bytes) {
      return "This file is larger than " + Math.round(state.me.max_upload_bytes / 1024 / 1024) + " MB. Upload a smaller PDF.";
    }
    return null;
  }

  /** "Handleiding_X200.pdf" -> "Handleiding X200": a starting point for the title. */
  function titleFromFilename(name) {
    return name.replace(/\.pdf$/i, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  }

  function setDialogFile(file) {
    state.dialog.file = file || null;
    $("#doc-error").textContent = "";
    if (file && !$("#doc-title").value.trim()) $("#doc-title").value = titleFromFilename(file.name);
  }

  function openDocDialog(mode, opts = {}) {
    const p = state.current;
    const doc = mode === "edit" ? p.documents.find((d) => d.id === opts.docId) : null;
    if (mode === "edit" && !doc) return;
    const lang = doc ? doc.lang : state.lang;
    const l = langInfo(lang);
    const maxMb = Math.round(state.me.max_upload_bytes / 1024 / 1024);
    state.dialog = { mode, lang, docId: doc ? doc.id : null, file: null };

    $("#doc-form").reset();
    $("#doc-error").textContent = "";
    $("#doc-dialog-title").textContent = doc ? "Edit document" : "Add document";
    $("#doc-dialog-lang").innerHTML = '<span class="badge on">' + l.code.toUpperCase() + "</span> " + esc(l.english);
    $("#doc-title").value = doc ? doc.title : "";
    $("#doc-file").required = !doc;
    $("#doc-file-label").textContent = doc ? "Replace PDF (optional)" : "PDF";
    $("#doc-file-hint").textContent = doc
      ? "Current file: " + doc.original_name + ". Choose a new PDF only to replace it."
      : "Up to " + maxMb + " MB.";
    $("#doc-submit").textContent = doc ? "Save" : "Add document";

    // A PDF dropped on the list comes along with the dialog.
    if (opts.file) {
      const dt = new DataTransfer();
      dt.items.add(opts.file);
      $("#doc-file").files = dt.files;
      setDialogFile(opts.file);
    }
    $("#doc-dialog").showModal();
    $("#doc-title").focus();
    if (opts.file) $("#doc-title").select();
  }

  async function submitDoc(e) {
    e.preventDefault();
    const p = state.current;
    const d = state.dialog;
    const title = $("#doc-title").value.trim();
    const file = d.file;
    const problem = !title
      ? "Enter a title for the document."
      : d.mode === "add" && !file
        ? "Choose a PDF to upload."
        : file && fileProblem(file);
    if (problem) {
      $("#doc-error").textContent = problem;
      return;
    }

    if (d.mode === "add") {
      $("#doc-dialog").close();
      upload({ code: p.code, lang: d.lang, title, file });
      return;
    }

    const doc = p.documents.find((x) => x.id === d.docId);
    if (!doc) {
      $("#doc-dialog").close();
      return;
    }
    const btn = $("#doc-submit");
    btn.disabled = true;
    try {
      if (title !== doc.title) {
        const res = await api("PATCH", "/products/" + encodeURIComponent(p.code) + "/documents/" + doc.id, { title });
        mergeDocument(p.code, res.document);
      }
      $("#doc-dialog").close();
      if (file) upload({ code: p.code, lang: doc.lang, title, file, docId: doc.id });
      else if (title !== doc.title) toast("Title saved.");
      if (isCurrent(p.code)) renderDocuments();
    } catch (err) {
      $("#doc-error").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // 100 means the file is sent and the server is storing it.
  function progressText(pct) {
    return pct >= 100 ? "Saving…" : "Uploading… " + pct + "%";
  }

  /** Adds a document, or replaces the PDF of document `docId`. */
  function upload({ code, lang, title, file, docId }) {
    const id = "u" + ++uploadSeq;
    state.uploads[id] = { code, lang, title, docId: docId || null, pct: 0 };
    if (isCurrent(code)) renderDocuments();

    const enc = encodeURIComponent(code);
    const xhr = new XMLHttpRequest();
    if (docId) {
      xhr.open("PUT", "/api/products/" + enc + "/documents/" + docId + "/file");
    } else {
      xhr.open("POST", "/api/products/" + enc + "/documents?lang=" + lang);
      xhr.setRequestHeader("X-Title", encodeURIComponent(title));
    }
    xhr.setRequestHeader("Content-Type", "application/pdf");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      state.uploads[id].pct = pct;
      const bar = document.querySelector('[data-upload="' + id + '"] .progress');
      if (bar) {
        bar.firstElementChild.style.width = pct + "%";
        bar.setAttribute("aria-valuenow", pct);
        bar.previousElementSibling.textContent = progressText(pct);
      }
    };
    const done = (error, doc) => {
      delete state.uploads[id];
      if (doc) mergeDocument(code, doc);
      if (isCurrent(code)) renderDocuments();
      if (error) toast(error, "error");
      else toast("“" + title + "” " + (docId ? "replaced." : "added."));
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) done(null, data.document);
      else done(data.error || "Upload failed (" + xhr.status + "). Try again.");
    };
    xhr.onerror = () => done("Upload failed. Check your internet connection and try again.");
    xhr.send(file);
  }

  async function moveDocument(id, step) {
    const p = state.current;
    const doc = p.documents.find((d) => d.id === id);
    if (!doc) return;
    const docs = docsFor(p, doc.lang);
    const i = docs.indexOf(doc);
    const j = i + step;
    if (j < 0 || j >= docs.length) return;
    [docs[i], docs[j]] = [docs[j], docs[i]];

    // Show the new order right away; the server's answer confirms it.
    setLangDocuments(p.code, doc.lang, docs.map((d, k) => ({ ...d, position: k + 1 })));
    renderDocuments();
    // Keep focus on the moved document, on whichever arrow still applies.
    const btn = (action) => document.querySelector('[data-action="' + action + '"][data-id="' + id + '"]');
    const same = btn(step < 0 ? "up" : "down");
    (same && !same.disabled ? same : btn(step < 0 ? "down" : "up")).focus();

    try {
      const res = await api("PUT", "/products/" + encodeURIComponent(p.code) + "/documents/order", {
        lang: doc.lang,
        ids: docs.map((d) => d.id),
      });
      setLangDocuments(p.code, doc.lang, res.documents);
    } catch (err) {
      toast(err.message, "error");
      try {
        upsertLocal((await api("GET", "/products/" + encodeURIComponent(p.code))).product);
      } catch {}
      if (isCurrent(p.code)) renderDocuments();
    }
  }

  async function removeDocument(id) {
    const p = state.current;
    const doc = p.documents.find((d) => d.id === id);
    if (!doc) return;
    const l = langInfo(doc.lang);
    const last = docsFor(p, doc.lang).length === 1;
    const ok = await confirmDialog({
      title: "Remove “" + doc.title + "”?",
      body: last
        ? "This is the only " + l.english + " document. Printed QR codes will no longer offer " + l.english + " until you add one."
        : "Printed QR codes will no longer list this document.",
      ok: "Remove",
    });
    if (!ok) return;
    try {
      await api("DELETE", "/products/" + encodeURIComponent(p.code) + "/documents/" + id);
      dropDocument(p.code, id);
      if (isCurrent(p.code)) renderDocuments();
      toast("“" + doc.title + "” removed.");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // ---------- delete product ----------

  function openDelete() {
    $("#delete-code").textContent = state.current.code;
    $("#delete-confirm").value = "";
    $("#delete-error").textContent = "";
    $("#delete-submit").disabled = true;
    $("#delete-dialog").showModal();
    $("#delete-confirm").focus();
  }

  async function submitDelete(e) {
    e.preventDefault();
    const code = state.current.code;
    if ($("#delete-confirm").value.trim().toUpperCase() !== code) return;
    $("#delete-submit").disabled = true;
    try {
      await api("DELETE", "/products/" + encodeURIComponent(code));
      state.products = state.products.filter((p) => p.code !== code);
      $("#delete-dialog").close();
      toast("Product " + code + " deleted.");
      location.hash = "#/";
    } catch (err) {
      $("#delete-error").textContent = err.message;
      $("#delete-submit").disabled = false;
    }
  }

  // ---------- wiring ----------

  /** Highlights a drop zone while a file is dragged over it and calls onFile on drop. */
  function dropTarget(container, selector, onFile) {
    container.addEventListener("dragover", (e) => {
      const zone = e.target.closest(selector);
      if (!zone) return;
      e.preventDefault();
      zone.classList.add("over");
    });
    container.addEventListener("dragleave", (e) => {
      const zone = e.target.closest(selector);
      if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("over");
    });
    container.addEventListener("drop", (e) => {
      const zone = e.target.closest(selector);
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove("over");
      if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0], e.dataTransfer.files);
    });
  }

  function wire() {
    window.addEventListener("hashchange", route);
    $("#search").addEventListener("input", renderList);
    $("#add-open").addEventListener("click", openAdd);
    $("#add-code").addEventListener("input", updateCodePreview);
    $("#add-form").addEventListener("submit", submitAdd);
    $("#name-form").addEventListener("submit", saveName);
    $("#name-form").addEventListener("input", updateNamePlaceholders);
    $("#copy-link").addEventListener("click", copyLink);
    $("#dl-png").addEventListener("click", downloadPng);
    $("#delete-open").addEventListener("click", openDelete);
    $("#delete-form").addEventListener("submit", submitDelete);
    $("#delete-confirm").addEventListener("input", (e) => {
      $("#delete-submit").disabled = e.target.value.trim().toUpperCase() !== state.current.code;
    });
    document.querySelectorAll("[data-close]").forEach((b) =>
      b.addEventListener("click", () => b.closest("dialog").close()),
    );

    $("#list").addEventListener("click", (e) => {
      if (e.target.closest('[data-action="add"]')) openAdd();
    });

    const tabs = $("#lang-tabs");
    tabs.addEventListener("click", (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) selectLang(tab.dataset.tab);
    });
    // Arrow keys move between tabs, as in any tab list.
    tabs.addEventListener("keydown", (e) => {
      const codes = state.me.languages.map((l) => l.code);
      const i = codes.indexOf(state.lang);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: codes.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      selectLang(codes[(next + codes.length) % codes.length]);
    });

    const panel = $("#docs-panel");
    panel.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const id = Number(btn.dataset.id);
      const action = btn.dataset.action;
      if (action === "add") openDocDialog("add");
      else if (action === "edit") openDocDialog("edit", { docId: id });
      else if (action === "up") moveDocument(id, -1);
      else if (action === "down") moveDocument(id, 1);
      else if (action === "remove") removeDocument(id);
    });
    dropTarget(panel, "[data-drop]", (file) => openDocDialog("add", { file }));

    $("#doc-form").addEventListener("submit", submitDoc);
    $("#doc-file").addEventListener("change", (e) => setDialogFile(e.target.files[0]));
    dropTarget($("#doc-dialog"), "#doc-drop", (file, files) => {
      $("#doc-file").files = files;
      setDialogFile(file);
    });

    // Closing or reloading the page cancels running uploads, so ask first.
    window.addEventListener("beforeunload", (e) => {
      if (Object.keys(state.uploads).length > 0) e.preventDefault();
    });
    // Dropping a file outside a drop zone shouldn't navigate away from the admin.
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
  }

  async function init() {
    wire();
    try {
      const [me, list] = await Promise.all([api("GET", "/me"), api("GET", "/products")]);
      state.me = me;
      state.products = list.products;
      $("#who").textContent = me.email;
      $("#logout").hidden = !me.can_log_out;
      if (me.environment === "development") {
        $("#devbase").textContent = me.public_base_url;
        $("#devbanner").hidden = false;
      }
      route();
    } catch (err) {
      $("#loading").textContent = err.message;
    }
  }

  init();
})();
