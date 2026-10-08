// UMI QR manuals admin. Plain JS, no build step. Inlined into /admin by the Worker.
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

  const state = {
    me: null,
    products: [],
    current: null, // product shown in the manage view
    // "CODE/lang" -> percent while an upload runs. Several can run at once,
    // for different languages and products.
    uploading: {},
  };

  const uploadKey = (code, lang) => code + "/" + lang;

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

  /**
   * Applies a server response about one language only. With uploads running in
   * parallel, responses can arrive out of order and each carries a snapshot of
   * all manuals, so taking the whole product would undo a newer change.
   */
  function applyLangChange(code, lang, product) {
    const local = state.products.find((p) => p.code === code);
    if (!local) return upsertLocal(product);
    const fresh = product.manuals.find((m) => m.lang === lang);
    const manuals = local.manuals.filter((m) => m.lang !== lang);
    if (fresh) manuals.push(fresh);
    manuals.sort((a, b) => a.lang.localeCompare(b.lang));
    upsertLocal({
      ...local,
      manuals,
      updated_at: product.updated_at > local.updated_at ? product.updated_at : local.updated_at,
    });
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

  function renderList() {
    const q = $("#search").value.trim().toLowerCase();
    const list = state.products.filter(
      (p) => !q || p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
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
        const have = new Set(p.manuals.map((m) => m.lang));
        const badges = state.me.languages
          .map((l) => {
            const on = have.has(l.code);
            return (
              '<span class="badge' + (on ? " on" : "") + '" title="' + esc(l.english + (on ? ": manual uploaded" : ": no manual")) + '">' +
              l.code.toUpperCase() + '<span class="visually-hidden">' + (on ? " uploaded" : " missing") + "</span></span>"
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
      '<th scope="col">Manuals</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>' +
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
    $("#p-link").textContent = p.short_url;
    $("#test-link").href = p.short_url;
    $("#p-qr").src = "/api/products/" + enc + "/qr.svg";
    $("#p-qr").alt = "QR code for " + p.short_url;
    $("#dl-svg").href = "/api/products/" + enc + "/qr.svg?download";
    $("#dl-svg").setAttribute("download", "UMI-QR-" + p.code + ".svg");
    renderManuals();
  }

  function renderManuals() {
    const p = state.current;
    const byLang = Object.fromEntries(p.manuals.map((m) => [m.lang, m]));
    $("#manuals").innerHTML = state.me.languages
      .map((l) => {
        const m = byLang[l.code];
        const pct = state.uploading[uploadKey(p.code, l.code)];
        const head =
          '<div class="manual-head"><span class="badge' + (m ? " on" : "") + '">' + l.code.toUpperCase() + "</span>" +
          "<h3>" + esc(l.english) + "</h3>" +
          (m ? '<span class="status-ok">Uploaded</span>' : '<span class="status-missing">No manual</span>') +
          "</div>";

        if (pct !== undefined) {
          return (
            '<div class="manual" data-lang="' + l.code + '">' + head +
            '<div class="progress-label">' + progressText(pct) + "</div>" +
            '<div class="progress" role="progressbar" aria-label="Upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><span style="width:' + pct + '%"></span></div>' +
            "</div>"
          );
        }

        const input = '<input type="file" accept="application/pdf,.pdf" hidden data-file="' + l.code + '">';
        if (m) {
          return (
            '<div class="manual" data-lang="' + l.code + '" data-drop="' + l.code + '">' + head +
            '<div class="file">' + esc(m.original_name) + "</div>" +
            '<div class="meta">' + formatSize(m.size_bytes) + " · uploaded " + formatDate(m.uploaded_at) + "</div>" +
            '<div class="row">' +
            '<a class="btn small" href="/f/' + encodeURIComponent(p.code) + "/" + l.code + '" target="_blank" rel="noopener">View</a>' +
            '<button class="btn small" type="button" data-action="replace" data-lang="' + l.code + '">Replace</button>' +
            '<button class="btn small danger-btn" type="button" data-action="remove" data-lang="' + l.code + '">Remove</button>' +
            "</div>" + input + "</div>"
          );
        }
        return (
          '<div class="manual" data-lang="' + l.code + '">' + head +
          '<div class="drop" data-drop="' + l.code + '">' +
          '<button class="btn primary small" type="button" data-action="upload" data-lang="' + l.code + '">Upload PDF</button>' +
          "<div>or drag a PDF here</div></div>" + input + "</div>"
        );
      })
      .join("");
  }

  async function saveName(e) {
    e.preventDefault();
    const name = $("#p-name").value.trim();
    if (!name) {
      toast("Enter a product name.", "error");
      return;
    }
    try {
      const { product } = await api("PATCH", "/products/" + encodeURIComponent(state.current.code), { name });
      upsertLocal(product);
      renderProduct();
      toast("Name saved.");
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

  // ---------- manuals: upload, replace, remove ----------

  async function handleFile(lang, file) {
    const p = state.current;
    if (!file) return;
    const l = langInfo(lang);
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      toast("This file isn't a PDF. Upload a .pdf file.", "error");
      return;
    }
    if (file.size > state.me.max_upload_bytes) {
      toast("This file is larger than " + Math.round(state.me.max_upload_bytes / 1024 / 1024) + " MB. Upload a smaller PDF.", "error");
      return;
    }
    const existing = p.manuals.find((m) => m.lang === lang);
    if (existing) {
      const ok = await confirmDialog({
        title: "Replace " + l.english + " manual?",
        body: "“" + existing.original_name + "” will be replaced by “" + file.name + "”. Printed QR codes will open the new file.",
        ok: "Replace",
      });
      if (!ok) return;
    }
    upload(p.code, lang, file, !!existing);
  }

  // 100 means the file is sent and the server is storing it.
  function progressText(pct) {
    return pct >= 100 ? "Saving…" : "Uploading… " + pct + "%";
  }

  function upload(code, lang, file, replacing) {
    const l = langInfo(lang);
    const key = uploadKey(code, lang);
    state.uploading[key] = 0;
    renderManuals();

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", "/api/products/" + encodeURIComponent(code) + "/manuals/" + lang);
    xhr.setRequestHeader("Content-Type", "application/pdf");
    xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      state.uploading[key] = pct;
      if (!state.current || state.current.code !== code) return;
      const bar = document.querySelector('.manual[data-lang="' + lang + '"] .progress');
      if (bar) {
        bar.firstElementChild.style.width = pct + "%";
        bar.setAttribute("aria-valuenow", pct);
        bar.previousElementSibling.textContent = progressText(pct);
      }
    };
    const done = (error, product) => {
      delete state.uploading[key];
      if (product) applyLangChange(code, lang, product);
      if (state.current && state.current.code === code) renderManuals();
      if (error) toast(error, "error");
      else toast(l.english + " manual " + (replacing ? "replaced." : "uploaded."));
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) done(null, data.product);
      else done(data.error || "Upload failed (" + xhr.status + "). Try again.");
    };
    xhr.onerror = () => done("Upload failed. Check your internet connection and try again.");
    xhr.send(file);
  }

  async function removeManual(lang) {
    const p = state.current;
    const l = langInfo(lang);
    const ok = await confirmDialog({
      title: "Remove " + l.english + " manual?",
      body: "Printed QR codes will no longer offer the " + l.english + " manual until you upload a new one.",
      ok: "Remove",
    });
    if (!ok) return;
    try {
      const { product } = await api("DELETE", "/products/" + encodeURIComponent(p.code) + "/manuals/" + lang);
      applyLangChange(p.code, lang, product);
      if (state.current && state.current.code === p.code) renderManuals();
      toast(l.english + " manual removed.");
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

  function wire() {
    window.addEventListener("hashchange", route);
    $("#search").addEventListener("input", renderList);
    $("#add-open").addEventListener("click", openAdd);
    $("#add-code").addEventListener("input", updateCodePreview);
    $("#add-form").addEventListener("submit", submitAdd);
    $("#name-form").addEventListener("submit", saveName);
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

    const manuals = $("#manuals");
    manuals.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const lang = btn.dataset.lang;
      if (btn.dataset.action === "upload" || btn.dataset.action === "replace") {
        manuals.querySelector('[data-file="' + lang + '"]').click();
      } else if (btn.dataset.action === "remove") {
        removeManual(lang);
      }
    });
    manuals.addEventListener("change", (e) => {
      const input = e.target.closest("[data-file]");
      if (input) {
        handleFile(input.dataset.file, input.files[0]);
        input.value = "";
      }
    });
    manuals.addEventListener("dragover", (e) => {
      const zone = e.target.closest("[data-drop]");
      if (!zone) return;
      e.preventDefault();
      zone.classList.add("over");
    });
    manuals.addEventListener("dragleave", (e) => {
      const zone = e.target.closest("[data-drop]");
      if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("over");
    });
    manuals.addEventListener("drop", (e) => {
      const zone = e.target.closest("[data-drop]");
      if (!zone) return;
      e.preventDefault();
      zone.classList.remove("over");
      handleFile(zone.dataset.drop, e.dataTransfer.files[0]);
    });
    // Closing or reloading the page cancels running uploads, so ask first.
    window.addEventListener("beforeunload", (e) => {
      if (Object.keys(state.uploading).length > 0) e.preventDefault();
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
