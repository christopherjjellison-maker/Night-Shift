/* Sign-in gate + 3-question onboarding + notification opt-in.
   Renders over the page until there is a session; the page itself keeps booting underneath
   (its db/ai calls wait on the session, so nothing breaks). */
(function () {
  const NS = window.NightShift; if (!NS) return;
  const el = document.createElement("div"); el.id = "gate"; el.innerHTML = `
  <div class="gatecard" id="gatecard">
    <div class="glogo"><i></i>Night Shift</div>
    <div id="gatebody"></div>
  </div>`;
  document.body.appendChild(el);
  const body = el.querySelector("#gatebody");
  const TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || "America/Los_Angeles";

  function viewSignIn(msg) {
    body.innerHTML = `
      <h1>Your brain,<br>with a night shift.</h1>
      <p>One home base for the plan, the detours, and the parts you don't say out loud. Sign in and it starts remembering.</p>
      <form id="gform"><input id="gemail" type="email" placeholder="you@email.com" autocomplete="email" required><button class="pill w" type="submit">Email me a link</button></form>
      <button class="pill k" id="ggoogle">Continue with Google</button>
      <div class="ghint" id="ghint">${msg || ""}</div>`;
    body.querySelector("#gform").onsubmit = async e => { e.preventDefault(); const em = body.querySelector("#gemail").value.trim(); if (!em) return; body.querySelector("#ghint").textContent = "Sending…"; const { error } = await NS.signInWithEmail(em); body.querySelector("#ghint").textContent = error ? error.message : "Check your email. Tap the link on this device."; };
    body.querySelector("#ggoogle").onclick = async () => { const { error } = await NS.signInWithGoogle(); if (error) body.querySelector("#ghint").textContent = error.message; };
  }
  function viewOnboard(profile) {
    let p = Object.assign({ name: "", bluntness: "frank", chronotype: "night", tz: TZ }, profile || {});
    body.innerHTML = `
      <span class="mono">Three questions. Then it's yours.</span>
      <h1>What should it call you?</h1>
      <input id="gname" placeholder="first name, nickname, codename" maxlength="40" value="${(p.name || "").replace(/"/g, "&quot;")}">
      <h2>How blunt?</h2>
      <div class="gseg" data-k="bluntness"><button data-v="frank" class="${p.bluntness === "frank" ? "on" : ""}">Frank. Say it.</button><button data-v="gentle" class="${p.bluntness === "gentle" ? "on" : ""}">Gentle. I bruise.</button></div>
      <h2>When does your brain wake up?</h2>
      <div class="gseg" data-k="chronotype"><button data-v="night" class="${p.chronotype === "night" ? "on" : ""}">Night owl</button><button data-v="early" class="${p.chronotype === "early" ? "on" : ""}">Early bird</button></div>
      <div class="grow"><button class="pill w" id="gsave">Open the home base</button><span class="ghint" id="ghint">Time zone: ${TZ}</span></div>`;
    body.querySelectorAll(".gseg").forEach(seg => seg.onclick = e => { const b = e.target.closest("button"); if (!b) return; p[seg.dataset.k] = b.dataset.v; seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); });
    body.querySelector("#gsave").onclick = async () => {
      p.name = body.querySelector("#gname").value.trim() || "you";
      p.tz = TZ; p.brief_hour = p.chronotype === "early" ? 6 : 8; p.nudge_hour = 22;
      const { error } = await NS.saveProfile(p); if (error) { body.querySelector("#ghint").textContent = error.message; return; }
      viewPush();
    };
  }
  function viewPush() {
    body.innerHTML = `
      <span class="mono">Last thing</span>
      <h1>Let it tap you on the shoulder?</h1>
      <p>A brief in the morning that quotes you. One question at 10pm if you haven't checked in. Nothing else, ever.</p>
      <div class="grow"><button class="pill w" id="gpush">Turn on notifications</button><button class="pill k" id="gskip">Not now</button></div>
      <div class="ghint" id="ghint"></div>`;
    body.querySelector("#gpush").onclick = async () => { body.querySelector("#ghint").textContent = "Asking…"; const r = await NS.enablePush(); body.querySelector("#ghint").textContent = r.ok ? "On." : ("Couldn't turn on notifications (" + r.why + "). You can retry from the nav later."); setTimeout(close, r.ok ? 600 : 2500); };
    body.querySelector("#gskip").onclick = close;
  }
  function close() { el.classList.add("gone"); setTimeout(() => el.remove(), 350); }

  viewSignIn("");
  NS.onSession(async s => {
    if (!s) return;
    let prof = null; try { prof = await NS.getProfile(); } catch (e) { }
    if (prof && prof.name) close(); else viewOnboard(prof);
  });

  // nav extras: sign out + notification toggle (injected so the ported page stays untouched)
  NS.onSession(s => {
    if (!s || document.getElementById("nsmenu")) return;
    const nav = document.querySelector(".nav .row"); if (!nav) return;
    const m = document.createElement("button"); m.id = "nsmenu"; m.className = "pill k"; m.style.cssText = "font-family:var(--mono);font-size:11px;letter-spacing:.06em"; m.textContent = "⋯"; m.setAttribute("aria-label", "account menu");
    const menu = document.createElement("div"); menu.className = "card nsmenucard"; menu.innerHTML = `<span class="mono">Account</span><div class="q" id="nsemail"></div><div class="row wrap" style="justify-content:flex-start"><button class="pill k" id="nspush">Turn on notifications</button><button class="pill k" id="nsout">Sign out</button></div>`;
    document.body.appendChild(menu);
    menu.querySelector("#nsemail").textContent = s.user.email || "";
    m.onclick = () => menu.classList.toggle("show");
    menu.querySelector("#nspush").onclick = async e => { e.target.textContent = "Asking…"; const r = await NS.enablePush(); e.target.textContent = r.ok ? "Notifications on" : "Couldn't (" + r.why + ")"; };
    menu.querySelector("#nsout").onclick = () => NS.signOut();
    document.addEventListener("click", e => { if (!menu.contains(e.target) && e.target !== m) menu.classList.remove("show"); });
    nav.appendChild(m);
  });
})();
