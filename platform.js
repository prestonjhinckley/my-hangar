/* My Hangar, installable version: the on-device platform.
 *
 * The app page (site/index.html) is written against claude.ai's artifact capabilities:
 * `claude.use("db" | "assets" | "sample" | "downloads")`. This file provides the same calls
 * on the phone itself, so one page runs in both places:
 *   db         -> IndexedDB, one object store per collection (models, stash, wishlist)
 *   assets     -> IndexedDB "photos" store; sw.js serves them at `_blob/<id>`
 *   sample     -> the Claude API from this device, with the owner's own API key
 *   downloads  -> the iOS share sheet (Save to Files), or a normal browser download
 * Plus `window.hangarPlatform` for the PWA-only screens: backup/restore and the API key.
 */
"use strict";
(function () {
  const DB_NAME = "my-hangar";
  const COLLECTIONS = ["models", "stash", "wishlist"];
  const MODEL = "claude-opus-5-5";
  const PRICE_IN = 4 / 1e6, PRICE_OUT = 20 / 1e6;   // USD per token for claude-opus-5-5 (Sept 2026 list price)

  /* ---------- IndexedDB ---------- */
  let dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const c of COLLECTIONS) if (!d.objectStoreNames.contains(c)) d.createObjectStore(c);
        if (!d.objectStoreNames.contains("photos")) d.createObjectStore("photos");
        if (!d.objectStoreNames.contains("settings")) d.createObjectStore("settings");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await idb();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      let out;
      Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("aborted"));
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function getAll(store) {
    return tx(store, "readonly", async (s) => {
      const [keys, vals] = await Promise.all([reqP(s.getAllKeys()), reqP(s.getAll())]);
      return keys.map((k, i) => [k, vals[i]]);
    });
  }
  const setting = {
    get: (k) => tx("settings", "readonly", (s) => reqP(s.get(k))),
    set: (k, v) => tx("settings", "readwrite", (s) => { s.put(v, k); }),
    del: (k) => tx("settings", "readwrite", (s) => { s.delete(k); }),
  };

  /* ---------- db: same shape as the artifact `db` capability ---------- */
  const cache = {};       // collection -> Map(id -> data)
  const listeners = {};   // collection -> Set(fn)
  const META = Object.freeze({ hasPendingWrites: false, fromCache: false });  // IndexedDB writes are durable once the transaction completes
  async function load(c) {
    if (!cache[c]) cache[c] = new Map(await getAll(c));
    return cache[c];
  }
  const docSnap = (id, data) => Object.freeze({ id, exists: data !== undefined, data: () => data, metadata: META });
  function emit(c) {
    const m = cache[c];
    const docs = [...m].map(([id, d]) => docSnap(id, d));
    const snap = { docs, size: docs.length, empty: !docs.length, metadata: META, docChanges: () => [] };
    for (const fn of listeners[c] || []) { try { fn(snap); } catch (e) { console.error(e); } }
  }
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function docRef(c, id) {
    return {
      id, path: c + "/" + id,
      async get() { return docSnap(id, (await load(c)).get(id)); },
      async set(data) {
        const v = clone(data);
        await tx(c, "readwrite", (s) => { s.put(v, id); });
        (await load(c)).set(id, v); emit(c);
      },
      async update(data) {
        const cur = (await load(c)).get(id);
        if (cur === undefined) throw { code: "invalid_argument", message: "no such document" };
        return this.set({ ...cur, ...data });
      },
      async delete() {
        await tx(c, "readwrite", (s) => { s.delete(id); });
        (await load(c)).delete(id); emit(c);
      },
      onSnapshot(next) {
        const fn = () => next(docSnap(id, cache[c].get(id)));
        (listeners[c] ||= new Set()).add(fn);
        load(c).then(fn);
        return () => listeners[c].delete(fn);
      },
    };
  }
  const db = {
    collection(c) {
      if (!COLLECTIONS.includes(c)) throw new TypeError("unknown collection " + c);
      return {
        path: c,
        doc: (id) => docRef(c, id || "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)),
        onSnapshot(next) {
          (listeners[c] ||= new Set()).add(next);
          load(c).then(() => emit(c));
          return () => listeners[c].delete(next);
        },
        async get() { await load(c); let s; const fn = (x) => { s = x; }; listeners[c] ||= new Set(); listeners[c].add(fn); emit(c); listeners[c].delete(fn); return s; },
      };
    },
    doc(path) { const [c, id] = path.split("/"); return docRef(c, id); },
  };

  /* ---------- assets: photos in IndexedDB, served by sw.js at _blob/<id> ---------- */
  const hexId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const assets = {
    async upload(blob, opts = {}) {
      const id = hexId();
      const type = opts.type || blob.type || "application/octet-stream";
      await tx("photos", "readwrite", (s) => { s.put({ blob, type, size: blob.size, createdAt: new Date().toISOString() }, id); });
      return { id, url: "_blob/" + id, sizeBytes: blob.size, contentType: type };
    },
    async delete(id) {
      if (objURLs.has(id)) { URL.revokeObjectURL(objURLs.get(id)); objURLs.delete(id); }
      const had = await tx("photos", "readonly", (s) => reqP(s.count(id)));
      await tx("photos", "readwrite", (s) => { s.delete(id); });
      return { deleted: had > 0 };
    },
    async list() {
      const rows = await getAll("photos");
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {};
      const bytes = rows.reduce((n, [, v]) => n + (v.size || 0), 0);
      return {
        assets: rows.map(([id, v]) => ({ id, url: "_blob/" + id, contentType: v.type, sizeBytes: v.size, createdAt: v.createdAt })),
        usage: { files: rows.length, bytes, maxFiles: Infinity, maxBytes: est.quota || bytes * 10 || 1e9 },
      };
    },
  };
  async function photoBlob(id) { const v = await tx("photos", "readonly", (s) => reqP(s.get(id))); return v ? v.blob : null; }

  /* Photos are addressed as `_blob/<id>`. sw.js answers those from IndexedDB. Where no service
     worker is running (first visit before it takes over, browsers or webviews without one),
     the same addresses are answered here: fetch() is served from IndexedDB, and <img> tags
     get an object URL instead. */
  const BLOB_RE = /\/_blob\/([0-9a-f]{32})$/;
  const objURLs = new Map();
  const swActive = () => !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  const blobIdOf = (u) => { try { const m = BLOB_RE.exec(new URL(u, document.baseURI).pathname); return m && m[1]; } catch { return null; } };
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const id = !swActive() && blobIdOf(typeof input === "string" ? input : input && input.url);
    if (!id) return nativeFetch(input, init);
    const b = await photoBlob(id);
    return b ? new Response(b, { headers: { "Content-Type": b.type } }) : new Response("", { status: 404 });
  };
  async function fixImg(img) {
    const id = blobIdOf(img.getAttribute("src") || "");
    if (!id) return;
    let u = objURLs.get(id);
    if (!u) { const b = await photoBlob(id); if (!b) return; u = URL.createObjectURL(b); objURLs.set(id, u); }
    if (blobIdOf(img.getAttribute("src") || "") === id) img.src = u;
  }
  new MutationObserver((recs) => {
    if (swActive()) return;
    for (const r of recs) {
      if (r.type === "attributes") { if (r.target.tagName === "IMG") fixImg(r.target); continue; }
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === "IMG") fixImg(n);
        n.querySelectorAll && n.querySelectorAll("img").forEach(fixImg);
      }
    }
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });

  /* ---------- sample: Claude API with the owner's key ---------- */
  let sdkP = null;
  const sdk = () => (sdkP ||= import(new URL("vendor/anthropic-sdk.mjs", document.baseURI).href).then((m) => m.default));
  async function apiKey() { return (await setting.get("apiKey")) || ""; }

  async function imageForClaude(blob) {
    // Same as the artifact platform did: about 1.2 megapixels, JPEG, orientation applied.
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const s = Math.min(1, Math.sqrt(1.2e6 / (img.naturalWidth * img.naturalHeight)));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const out = c.toDataURL("image/jpeg", 0.86);
      return out.slice(out.indexOf(",") + 1);
    } finally { URL.revokeObjectURL(url); }
  }

  // The identification answer, as a schema the API enforces (structured outputs).
  const ANSWER_SCHEMA = {
    type: "object",
    properties: {
      name: { type: "string" }, airForce: { type: "string" }, unit: { type: "string" }, codes: { type: "string" },
      markings: { type: "string" }, era: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] },
      evidence: { type: "string" }, history: { type: "string" },
    },
    required: ["name", "airForce", "unit", "codes", "markings", "era", "confidence", "evidence", "history"],
    additionalProperties: false,
  };

  async function addSpend(usage) {
    if (!usage) return;
    const cur = (await setting.get("spend")) || { usd: 0, calls: 0 };
    const usd = (usage.input_tokens || 0) * PRICE_IN + (usage.cache_read_input_tokens || 0) * PRICE_IN * 0.05 + (usage.output_tokens || 0) * PRICE_OUT;
    await setting.set("spend", { usd: cur.usd + usd, calls: cur.calls + 1 });
  }

  async function sampleJSON(prompt, opts = {}) {
    const key = await apiKey();
    if (!key) throw { code: "no_key", message: "No API key on this device" };
    let Anthropic;
    try { Anthropic = await sdk(); } catch { throw { code: "upstream_error", message: "Couldn't load the Claude library" }; }
    const content = [];
    if (opts.images) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: await imageForClaude(opts.images) } });
    content.push({ type: "text", text: prompt });
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 1 });
    let response;
    try {
      response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",                       // a policy decline re-runs on Anthropic's recommended fallback model
        output_config: { effort: "medium", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
        messages: [{ role: "user", content }],
      }, { signal: opts.signal });
    } catch (e) {
      if (opts.signal && opts.signal.aborted) throw { code: "cancelled", message: "Stopped" };
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw { code: "bad_key", message: e.message };
      if (e instanceof Anthropic.RateLimitError) throw { code: "rate_limited", message: e.message };
      if (e instanceof Anthropic.BadRequestError) throw { code: "invalid_request", message: e.message };
      if (e instanceof Anthropic.APIConnectionError) throw { code: "offline", message: e.message };
      if (e instanceof Anthropic.APIError) throw { code: "upstream_error", message: e.message };
      throw { code: "upstream_error", message: String(e && e.message || e) };
    }
    addSpend(response.usage).catch(() => {});
    if (response.stop_reason === "refusal") throw { code: "refused", message: "Claude declined this request" };
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    try { return JSON.parse(text); }
    catch { throw { code: "invalid_json", message: "Unexpected answer", text }; }
  }
  const sample = async () => { throw { code: "invalid_request", message: "Only sample.json is available here" }; };
  sample.json = sampleJSON;
  sample.limits = async () => ((await apiKey()) ? { maxPromptBytes: 262144, images: { maxCount: 1, maxInputBytes: 20e6, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] } } : { maxPromptBytes: 262144 });

  /* ---------- downloads: share sheet on iPhone, download link elsewhere ---------- */
  const MIME = { csv: "text/csv", pdf: "application/pdf", zip: "application/zip", json: "application/json" };
  const downloads = {
    async save({ filename, data }) {
      const ext = (filename.split(".").pop() || "").toLowerCase();
      const blob = data instanceof Blob ? data : new Blob([data], { type: MIME[ext] || "application/octet-stream" });
      const file = new File([blob], filename, { type: MIME[ext] || blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return { status: "saved" }; }
        catch (e) {
          if (e && e.name === "AbortError") throw { code: "declined", message: "Not saved" };
          // NotAllowedError: the tap that started a long export has expired - fall through to a download
        }
      }
      const url = URL.createObjectURL(file);
      const a = document.createElement("a"); a.href = url; a.download = filename; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { status: "saved" };
    },
  };

  /* ---------- backup / restore: one .zip with data.json + the photo files ---------- */
  let zipP = null;
  const zipLib = () => (zipP ||= import(new URL("vendor/fflate.mjs", document.baseURI).href));
  const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

  async function makeBackup() {
    const { zipSync, strToU8 } = await zipLib();
    const data = { app: "my-hangar", format: 1, exportedAt: new Date().toISOString(), photos: {} };
    for (const c of COLLECTIONS) data[c] = [...(await load(c))].map(([id, d]) => ({ id, ...d }));
    const files = {};
    for (const [id, v] of await getAll("photos")) {
      const name = `photos/${id}.${EXT[v.type] || "bin"}`;
      data.photos[id] = { file: name, type: v.type };
      files[name] = [new Uint8Array(await v.blob.arrayBuffer()), { level: 0 }];   // photos are already compressed
    }
    files["data.json"] = strToU8(JSON.stringify(data, null, 1));
    const zip = zipSync(files);
    return { blob: new Blob([zip], { type: "application/zip" }), counts: COLLECTIONS.map((c) => data[c].length), photos: Object.keys(data.photos).length };
  }
  async function readBackup(file) {
    const { unzipSync, strFromU8 } = await zipLib();
    let entries;
    try { entries = unzipSync(new Uint8Array(await file.arrayBuffer())); } catch { throw new Error("not-a-backup"); }
    if (!entries["data.json"]) throw new Error("not-a-backup");
    const data = JSON.parse(strFromU8(entries["data.json"]));
    if (data.app !== "my-hangar") throw new Error("not-a-backup");
    return { data, entries };
  }
  /* Merge: records and photos from the backup are added, same ids are replaced, nothing is deleted. */
  async function restoreBackup({ data, entries }) {
    for (const [id, p] of Object.entries(data.photos || {})) {
      const bytes = entries[p.file]; if (!bytes) continue;
      const blob = new Blob([bytes], { type: p.type });
      await tx("photos", "readwrite", (s) => { s.put({ blob, type: p.type, size: blob.size, createdAt: new Date().toISOString() }, id); });
    }
    for (const c of COLLECTIONS) {
      const rows = data[c] || [];
      await tx(c, "readwrite", (s) => { for (const { id, ...d } of rows) s.put(d, id); });
      cache[c] = null; await load(c); emit(c);
    }
  }

  /* ---------- install the shim ---------- */
  const CAPS = { db, assets, downloads };
  window.claude = {
    use: async (name) => {
      if (name === "sample") return sample;   // limits() reports whether a key (and so images) is available
      return CAPS[name] || null;
    },
  };
  window.hangarPlatform = {
    model: MODEL,
    apiKey, async setApiKey(k) { if (k) await setting.set("apiKey", k.trim()); else await setting.del("apiKey"); },
    spend: async () => (await setting.get("spend")) || { usd: 0, calls: 0 },
    lastBackup: async () => (await setting.get("lastBackup")) || "",
    async backup() {
      const b = await makeBackup();
      const name = `my-hangar-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      await downloads.save({ filename: name, data: b.blob });
      await setting.set("lastBackup", new Date().toISOString());
      return b;
    },
    readBackup, restoreBackup, photoBlob,
  };

  /* ---------- offline + photo serving ---------- */
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((e) => console.warn("Offline support unavailable here:", e && e.message));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
