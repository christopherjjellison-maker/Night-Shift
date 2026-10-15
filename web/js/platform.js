/* Night Shift platform shim.
   The page was born as a Claude artifact and talks to `window.claude.use(name)`.
   This file provides that surface on top of Supabase (auth, docs table, realtime)
   and our own Claude edge function, so the page logic ports untouched.

   use("db")     -> document store (collection/doc/set/delete/onSnapshot) on the `docs` table
   use("sample") -> ai(prompt, opts) / ai.json(prompt, opts) via /functions/v1/ai
   use("user")   -> who is signed in
   use("mcp")    -> null (calendar/gmail are v1.1; the page hides those blocks)
*/
(function () {
  const CFG = window.NS_CONFIG || {};
  const SUPABASE_URL = CFG.SUPABASE_URL;
  const ANON = CFG.SUPABASE_ANON_KEY;

  const listeners = { session: [] };
  let supabase = null, session = null, sessionReady = null, resolveSession = null;
  sessionReady = new Promise(r => (resolveSession = r));

  async function boot() {
    if (!SUPABASE_URL || !ANON) {
      console.error("Night Shift: web/config.js is missing. Copy config.example.js to config.js.");
      return;
    }
    const mod = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
    supabase = mod.createClient(SUPABASE_URL, ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    supabase.auth.onAuthStateChange((_evt, s) => setSession(s));
  }
  function setSession(s) {
    const was = !!session; session = s || null;
    listeners.session.forEach(fn => { try { fn(session) } catch (e) { } });
    if (session && resolveSession) { resolveSession(session); resolveSession = null; }
    if (was && !session) location.reload(); // signed out: start clean
  }
  const booted = boot();

  /* ---------------- db ---------------- */
  // One realtime channel for the user's rows; a local cache per collection; listeners keyed by path.
  const cache = new Map();           // collection -> Map(doc_id -> data)
  const loaded = new Set();          // collections fully fetched at least once
  const colSubs = new Map();         // collection -> Set(cb)
  const docSubs = new Map();         // "col/id" -> Set(cb)
  let channel = null;

  function split(path) { const p = String(path).split("/").filter(Boolean); if (p.length % 2) throw new TypeError("document path needs an even number of segments: " + path); return { col: p.slice(0, -1).join("/"), id: p[p.length - 1] }; }
  function snapDoc(col, id) { const m = cache.get(col); const d = m && m.get(id); return { id, exists: !!d, data: () => d ? structuredClone(d) : undefined, metadata: { fromCache: false, hasPendingWrites: false } }; }
  function snapCol(col) { const m = cache.get(col) || new Map(); const docs = [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([id, d]) => ({ id, exists: true, data: () => structuredClone(d), metadata: { fromCache: false, hasPendingWrites: false } })); return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } }; }
  function notify(col, id) { (colSubs.get(col) || []).forEach(cb => cb(snapCol(col))); (docSubs.get(col + "/" + id) || []).forEach(cb => cb(snapDoc(col, id))); }
  async function ensureLoaded(col) {
    if (loaded.has(col)) return;
    const { data, error } = await supabase.from("docs").select("doc_id,data").eq("user_id", session.user.id).eq("collection", col);
    if (error) throw mapDbErr(error);
    const m = cache.get(col) || new Map(); for (const r of data) m.set(r.doc_id, r.data); cache.set(col, m); loaded.add(col);
  }
  function ensureChannel() {
    if (channel) return;
    channel = supabase.channel("docs:" + session.user.id)
      .on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "user_id=eq." + session.user.id }, payload => {
        const row = payload.new && payload.new.doc_id ? payload.new : payload.old; if (!row) return;
        const col = row.collection, id = row.doc_id; const m = cache.get(col) || new Map();
        if (payload.eventType === "DELETE") m.delete(id); else m.set(id, payload.new.data);
        cache.set(col, m); notify(col, id);
      }).subscribe();
  }
  function mapDbErr(e) { const code = e && (e.code === "42501" || e.code === "PGRST301") ? "invalid_argument" : "unavailable"; return { code, message: (e && e.message) || "db error" }; }

  function docRef(col, id) {
    return {
      id, path: col + "/" + id,
      async get() { await ensureLoaded(col); return snapDoc(col, id); },
      async set(data) {
        if (!data || typeof data !== "object" || Array.isArray(data)) throw { code: "invalid_argument", message: "document body must be an object" };
        const m = cache.get(col) || new Map(); m.set(id, structuredClone(data)); cache.set(col, m); notify(col, id); // optimistic
        const { error } = await supabase.from("docs").upsert({ user_id: session.user.id, collection: col, doc_id: id, data }, { onConflict: "user_id,collection,doc_id" });
        if (error) throw mapDbErr(error);
      },
      async update(data) { const cur = (cache.get(col) || new Map()).get(id); if (!cur) throw { code: "invalid_argument", message: "update needs an existing document" }; return this.set(Object.assign({}, cur, data)); },
      async delete() {
        const m = cache.get(col); if (m) { m.delete(id); notify(col, id); }
        const { error } = await supabase.from("docs").delete().eq("user_id", session.user.id).eq("collection", col).eq("doc_id", id);
        if (error) throw mapDbErr(error);
      },
      onSnapshot(next, err) {
        const key = col + "/" + id; const set = docSubs.get(key) || new Set(); set.add(next); docSubs.set(key, set);
        ensureChannel(); ensureLoaded(col).then(() => next(snapDoc(col, id))).catch(e => err && err(e));
        return () => set.delete(next);
      },
      collection(sub) { return colRef(col + "/" + id + "/" + sub); },
      async acquire() { return { acquired: true, holder: session.user.id }; }
    };
  }
  function colRef(col) {
    const q = {
      path: col,
      doc(id) { return docRef(col, id || ("d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7))); },
      async add(data) { const r = this.doc(); await r.set(data); return r; },
      where() { return q; }, orderBy() { return q; }, limit() { return q; },
      async get() { await ensureLoaded(col); return snapCol(col); },
      onSnapshot(next, err) {
        const set = colSubs.get(col) || new Set(); set.add(next); colSubs.set(col, set);
        ensureChannel(); ensureLoaded(col).then(() => next(snapCol(col))).catch(e => err && err(e));
        return () => set.delete(next);
      }
    };
    return q;
  }
  const db = { doc(path) { const { col, id } = split(path); return docRef(col, id); }, collection(path) { const p = String(path).split("/").filter(Boolean); if (!(p.length % 2)) throw new TypeError("collection path needs an odd number of segments: " + path); return colRef(p.join("/")); } };

  /* ---------------- ai ---------------- */
  function parseJsonTolerant(text) {
    try { return JSON.parse(text); } catch (e) { }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) { try { return JSON.parse(fence[1]); } catch (e) { } }
    const a = text.search(/[\[{]/), b = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]")); if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { } }
    throw { code: "invalid_json", message: "no JSON value in reply", text };
  }
  async function callAi(input, opts, json) {
    opts = opts || {};
    if (!session) throw { code: "not_granted", message: "sign in first" };
    const body = { input, tier: opts.modelTier || "default", json: !!json, effort: opts.effort };
    let res;
    try {
      res = await fetch(SUPABASE_URL + "/functions/v1/ai", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + session.access_token, "apikey": ANON }, body: JSON.stringify(body), signal: opts.signal });
    } catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled", message: "aborted" }; throw { code: "upstream_error", message: String(e) }; }
    if (res.status === 401) throw { code: "session_expired", message: "sign in again" };
    if (res.status === 429) throw { code: "rate_limited", message: "daily budget reached" };
    if (!res.ok) { let m = ""; try { m = (await res.json()).error } catch (e) { } throw { code: res.status === 400 ? "invalid_request" : "upstream_error", message: m || ("HTTP " + res.status) }; }
    const out = await res.json();
    if (!out.text || !String(out.text).trim()) throw { code: "empty_completion", message: "empty" };
    if (opts.onText) { try { opts.onText({ text: out.text, delta: out.text }) } catch (e) { } }
    return { text: out.text, truncated: !!out.truncated, modelTierApplied: out.tier || body.tier };
  }
  const ai = (input, opts) => callAi(input, opts, false);
  ai.json = async (input, opts) => { const r = await callAi(input, opts, true); return parseJsonTolerant(r.text); };
  ai.limits = async () => ({ maxPromptBytes: 262144 });

  /* ---------------- user ---------------- */
  const user = { id: async () => session && session.user.id, me: async () => ({ id: session && session.user.id }), isOwner: () => true, canEdit: () => true, can: () => true, profiles: async () => ({}), search: async () => [] };

  /* ---------------- push ---------------- */
  async function enablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return { ok: false, why: "unsupported" };
    const reg = await navigator.serviceWorker.ready;
    const perm = await Notification.requestPermission(); if (perm !== "granted") return { ok: false, why: "denied" };
    const key = CFG.VAPID_PUBLIC_KEY; if (!key) return { ok: false, why: "no-vapid" };
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) });
    const j = sub.toJSON();
    const { error } = await supabase.from("push_subscriptions").upsert({ user_id: session.user.id, endpoint: j.endpoint, keys: j.keys }, { onConflict: "endpoint" });
    return { ok: !error, why: error && error.message };
  }
  function urlB64(s) { const pad = "=".repeat((4 - s.length % 4) % 4); const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, c => c.charCodeAt(0)); }

  /* ---------------- public surface ---------------- */
  window.claude = {
    use: async function (name) {
      await booted;
      if (!supabase) return null;
      if (name === "mcp") return null;
      if (name === "user") { await sessionReady; return user; }
      if (name === "sample") { await sessionReady; return ai; }
      if (name === "db") { await sessionReady; return db; }
      return null;
    }
  };
  window.NightShift = {
    get client() { return supabase; },
    get session() { return session; },
    ready: booted,
    onSession(fn) { listeners.session.push(fn); if (session) fn(session); },
    signInWithEmail: async (email) => { await booted; return supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } }); },
    signInWithGoogle: async () => { await booted; return supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } }); },
    signOut: async () => { await booted; return supabase.auth.signOut(); },
    getProfile: async () => { const { data } = await supabase.from("profiles").select("*").eq("user_id", session.user.id).maybeSingle(); return data; },
    saveProfile: async (p) => supabase.from("profiles").upsert(Object.assign({ user_id: session.user.id }, p)),
    enablePush
  };
})();
