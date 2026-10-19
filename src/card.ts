// The live build card (MCP Apps, `ui://` resource). Hosts that support MCP
// Apps (Claude, ChatGPT, our voice page) show it next to a build_app,
// build_with_team, edit_app or check_build call.
//
// It is one self-contained HTML page: no external scripts, styles, fonts or
// images, so it needs nothing from a host's content security policy. The
// official MCP Apps client (`@modelcontextprotocol/ext-apps`, its prebuilt
// browser bundle) is inlined. The card reads the tool's result for the build
// id, then asks the server's own check_build every few seconds (through the
// host) and shows what it says: the team's rooms for an AI Team build, how
// much code is written for a quick build, then an Open button. All text from
// the server is set with textContent, never as HTML.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** The card's fixed address: Shipd's voice page reads it, so it never changes. */
export const CARD_URI = "ui://shipd/build-card.html";

let cached: string | null = null;
let versioned: string | null = null;

/** The address the build tools point hosts at, named after the card's own
 * content. Hosts keep a card by its address: Claude went on showing the old
 * card after it changed (2026-10-06), so a changed card gets a new address. */
export function cardUri(): string {
  if (!versioned) {
    const h = createHash("sha256").update(cardHtml()).digest("hex").slice(0, 10);
    versioned = `ui://shipd/build-card-${h}.html`;
  }
  return versioned;
}

/** `_meta` for a tool whose calls show the card (both the current key and
 * the older one some hosts still read). */
export function cardMeta(): Record<string, unknown> {
  const uri = cardUri();
  return { ui: { resourceUri: uri }, "ui/resourceUri": uri };
}

/** The MCP Apps browser bundle, with its closing `export {...}` turned into a
 * global, so it runs as a plain inline script. */
export function appsBundle(): string {
  const require = createRequire(import.meta.url);
  const src = readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  const m = src.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!m || m.index === undefined) throw new Error("Unexpected MCP Apps bundle: no closing export.");
  const pairs = m[1]
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [local, as, exported] = p.split(/\s+/);
      const name = as === "as" && exported ? exported : local;
      return `${JSON.stringify(name)}:${local}`;
    });
  // Inlined in a <script> element: a literal "</script" would end it early.
  const body = src.slice(0, m.index).replace(/<\/script/gi, "<\\/script");
  return `${body}\nglobalThis.ShipdMcpApps={${pairs.join(",")}};\n`;
}

const STYLE = `
:root{--card:#FBF8F1;--ink:#1D1B16;--ink2:#625D52;--line:#E2DAC9;--soft:#F1ECE0;--accent:#1F7A4D;--accent-ink:#FFFFFF;--warn:#A8432B}
:root[data-theme="dark"]{--card:#22211D;--ink:#F1ECE0;--ink2:#B3AC9C;--line:#3A372F;--soft:#2B2A25;--accent:#46A877;--accent-ink:#0F1C14;--warn:#E3907A}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--card:#22211D;--ink:#F1ECE0;--ink2:#B3AC9C;--line:#3A372F;--soft:#2B2A25;--accent:#46A877;--accent-ink:#0F1C14;--warn:#E3907A}}
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px 18px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.brand{display:flex;align-items:center;gap:7px;font-weight:600;font-size:13px;color:var(--accent)}
.brand i{display:block;width:9px;height:12px;background:var(--accent);clip-path:polygon(0 0,100% 50%,0 100%)}
.chip{font-size:12px;color:var(--ink2);border:1px solid var(--line);border-radius:999px;padding:2px 9px}
h1{font-family:Newsreader,"Iowan Old Style",Georgia,serif;font-weight:500;font-size:20px;line-height:1.25;margin:0 0 4px}
.said{margin:0;color:var(--ink2);min-height:1.45em}
.team{list-style:none;margin:14px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));gap:8px}
.team li{--c:var(--accent);border:1px solid var(--line);border-radius:10px;padding:9px 10px;background:var(--soft);transition:border-color .3s,box-shadow .3s,opacity .3s}
.team .head{display:flex;align-items:center;gap:8px}
.team .face{flex:none;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:12px;color:#fff;background:var(--c)}
.team b{display:block;font-weight:600;font-size:13px;line-height:1.2}
.team .role{display:block;font-size:11.5px;color:var(--ink2);line-height:1.2}
.team .now{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin-top:6px;font-size:12px;line-height:1.35;color:var(--ink2)}
.team li[data-s="active"]{border-color:var(--c);box-shadow:0 0 0 1px var(--c) inset}
.team li[data-s="active"] .face{animation:glow 1.6s ease-in-out infinite}
.team li[data-s="active"] .now:empty::before{content:"working";animation:pulse 1.2s ease-in-out infinite}
.team li[data-s="done"] b::after{content:" \\2713";color:var(--c)}
.team li[data-s="waiting"]{opacity:.55}
.team li[data-s="error"]{border-color:var(--warn)}
.room{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
.room-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.room-top b{font-size:12px;font-weight:600;color:var(--ink2);text-transform:uppercase;letter-spacing:.04em}
.feed{list-style:none;margin:0;padding:0;max-height:200px;overflow-y:auto;display:grid;gap:6px}
.feed li{font-size:13px;line-height:1.4}
.feed li b{font-weight:600;color:var(--c,var(--accent));margin-right:6px}
.right{display:flex;align-items:center;gap:8px}
.clock{font-size:12px;color:var(--ink2);font-variant-numeric:tabular-nums}
button.ghost{font-weight:600;font-size:12px;padding:4px 10px;border-radius:999px;background:transparent;color:var(--ink);border:1px solid var(--line)}
button.ghost[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.bar{position:relative;height:4px;border-radius:4px;background:var(--soft);overflow:hidden;margin:14px 0 0}
.bar span{position:absolute;inset:0 auto 0 0;width:35%;border-radius:4px;background:var(--accent);animation:slide 1.6s ease-in-out infinite}
.bar[data-s="done"] span{width:100%;animation:none}
.bar[data-s="off"]{display:none}
.meta{margin:8px 0 0;font-size:12px;color:var(--ink2);min-height:1.45em}
.actions{display:flex;gap:8px;margin-top:12px}
button{font:inherit;font-weight:600;border-radius:9px;padding:8px 14px;cursor:pointer;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink)}
.failed h1{color:var(--warn)}
[hidden]{display:none!important}
@keyframes pulse{50%{opacity:.25}}
@keyframes glow{50%{box-shadow:0 0 0 5px color-mix(in srgb,var(--c) 25%,transparent)}}
@keyframes slide{0%{left:-35%}100%{left:100%}}
@media (prefers-reduced-motion:reduce){.bar span,.team li b::after,.team .face,.team .now::before{animation:none!important}}
`;

const SCRIPT = `
(function () {
  var Apps = globalThis.ShipdMcpApps || {};
  var $ = function (id) { return document.getElementById(id); };
  // The default team; a team job's own stage list (which follows hires and
  // fires) replaces it as soon as check_build reports one.
  var TEAM = [
    { key: "pm", name: "Maya", title: "Plan" },
    { key: "director", name: "Theo", title: "Look" },
    { key: "designer", name: "Ren", title: "Screens" },
    { key: "engineer", name: "Sam", title: "Build" }
  ];
  var buildId = null, polling = false, finished = false, kind = "build", link = null, told = false, misses = 0;
  var lastStages = null; // the team as the job last described it (titles, hires)
  // Each person's colour (as on the voice page), what they last said, and how
  // many of the team's lines this card has already shown.
  var COLOURS = { pm: "#2F7FB0", director: "#C2652A", designer: "#7656D1", backend: "#138A7A", engineer: "#2E8B57" };
  var latest = {}, heard = 0, startedAt = 0, endedAt = 0, clockTimer = 0;
  var checked = false; // check_build has answered at least once
  // The voice page speaks the team's lines itself and keeps its own log, so it
  // tells the card (host context shipdVoice) to leave both out.
  var onVoicePage = false;
  function colour(key) { return COLOURS[key] || "var(--accent)"; }

  function theme(t) { if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t); }
  function say(id, text) { $(id).textContent = text || ""; }
  function heading(status, name) {
    if (status === "completed") return (name || "Your app") + (kind === "edit" ? " is updated" : " is ready");
    if (status === "failed") return kind === "edit" ? "The change didn't go through" : "The build didn't finish";
    if (status === "unknown") return "Can't see this build any more";
    if (status === "cancelled") return "Stopped";
    return kind === "team" ? "Your team is on it" : kind === "edit" ? "Making your change" : "Building your app";
  }
  function drawTeam(sc) {
    if (Array.isArray(sc.stages) && sc.stages.length) lastStages = sc.stages;
    var people = lastStages || TEAM;
    var at = people.map(function (p) { return p.key; }).indexOf(sc.stage);
    // Before the first report, the first person is already at work.
    if (at < 0 && !lastStages && sc.status === "working") at = 0;
    var list = $("team");
    while (list.firstChild) list.removeChild(list.firstChild);
    people.forEach(function (p, i) {
      var s = sc.stages ? p.status : undefined; // remembered statuses are stale
      var state =
        sc.status === "completed" || s === "done" || (at >= 0 && i < at) ? "done"
        : s === "error" ? "error"
        : s === "working" || (at >= 0 && i === at && sc.status === "working") ? "active"
        : "waiting";
      var li = document.createElement("li");
      li.setAttribute("data-s", state);
      li.style.setProperty("--c", colour(p.key));
      var head = document.createElement("div");
      head.className = "head";
      var face = document.createElement("span");
      face.className = "face";
      face.textContent = (p.name || p.key || "?").charAt(0).toUpperCase();
      var who = document.createElement("span");
      var b = document.createElement("b");
      b.textContent = p.name || p.key || "";
      var role = document.createElement("span");
      role.className = "role";
      role.textContent = p.title || "";
      who.appendChild(b);
      who.appendChild(role);
      head.appendChild(face);
      head.appendChild(who);
      var now = document.createElement("span");
      now.className = "now";
      // What they last said; nothing yet for someone still waiting.
      now.textContent = state === "waiting" ? "" : latest[p.key] || "";
      li.appendChild(head);
      li.appendChild(now);
      list.appendChild(li);
    });
  }
  // ── the team chat, read aloud on request ──
  var synth = typeof window !== "undefined" && window.speechSynthesis ? window.speechSynthesis : null;
  // The chat follows the newest line unless the person scrolled up to read.
  var stick = true;
  $("feed").addEventListener("scroll", function () {
    var f = $("feed");
    stick = f.scrollHeight - f.scrollTop - f.clientHeight < 24;
  });
  var listening = false, voices = [];
  // A different browser voice per person where the device has them.
  var PREFER = {
    pm: /samantha|jenny|aria|zira|google us english|female/i,
    director: /daniel|guy|david|google uk english male|male/i,
    designer: /karen|moira|tessa|libby|sonia|google uk english female/i,
    backend: /alex|fred|rishi|ryan|mark/i,
    engineer: /aaron|arthur|tom|eddy|christopher/i
  };
  function loadVoices() {
    try { voices = synth.getVoices().filter(function (v) { return /^en/i.test(v.lang); }); } catch (e) { voices = []; }
  }
  function voiceFor(key) {
    if (!voices.length) return null;
    var re = PREFER[key];
    var keys = Object.keys(PREFER);
    var used = {};
    keys.forEach(function (k) {
      if (k === key) return;
      var v = PREFER[k] && voices.filter(function (x) { return PREFER[k].test(x.name); })[0];
      if (v) used[v.name] = true;
    });
    var mine = re && voices.filter(function (x) { return re.test(x.name) && !used[x.name]; })[0];
    if (mine) return mine;
    var i = keys.indexOf(key);
    return voices[(i < 0 ? 0 : i) % voices.length];
  }
  // Each person's own voice first: the same Amazon Polly voices as Shipd's
  // voice page, through the server's card-only speak_line tool, played with
  // Web Audio (no audio URL, so no media CSP to satisfy). If Shipd's voices
  // are not on for the account, the device's own voices read the lines.
  var SPEAKERS = { assistant: 1, pm: 1, director: 1, designer: 1, backend: 1, engineer: 1 };
  var Ctx = typeof window !== "undefined" ? window.AudioContext || window.webkitAudioContext : null;
  var actx = null, polly = !!Ctx, misses = 0, gen = 0, playing = null, queue = Promise.resolve();
  function bytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function play(buf) {
    return actx.decodeAudioData(buf).then(function (audio) {
      return new Promise(function (done) {
        var src = actx.createBufferSource();
        src.buffer = audio;
        src.connect(actx.destination);
        src.onended = function () { if (playing === src) playing = null; done(); };
        playing = src;
        src.start();
      });
    });
  }
  function device(key, text) {
    if (!synth) return Promise.resolve();
    return new Promise(function (done) {
      try {
        var u = new SpeechSynthesisUtterance(text);
        var v = voiceFor(key);
        if (v) u.voice = v;
        u.rate = 1.04;
        u.onend = u.onerror = function () { done(); };
        synth.speak(u);
        setTimeout(done, 20000); // never hold the queue on a voice that never ends
      } catch (e) { done(); }
    });
  }
  function speak(key, text) {
    if (!listening || !text) return;
    var mine = gen;
    queue = queue.then(function () {
      if (!listening || mine !== gen) return;
      if (!polly || !actx || !app) return device(key, text);
      return app.callServerTool({ name: "speak_line", arguments: { voice: SPEAKERS[key] ? key : "assistant", text: text.slice(0, 300) } })
        .then(function (r) {
          var a = r && !r.isError && (r.content || []).filter(function (c) { return c && c.type === "audio" && c.data; })[0];
          if (!a) throw new Error("no audio");
          misses = 0;
          if (!listening || mine !== gen) return;
          return play(bytes(a.data));
        })
        .catch(function () {
          misses += 1;
          if (misses >= 2) polly = false; // voices are off for this account: stop asking
          if (listening && mine === gen) return device(key, text);
        });
    }).catch(function () {});
  }
  function addLine(v) {
    var key = String(v.key || ""), name = String(v.name || ""), text = String(v.text || "");
    if (!text) return;
    latest[key] = text;
    var feed = $("feed");
    var li = document.createElement("li");
    li.style.setProperty("--c", colour(key));
    var b = document.createElement("b");
    b.textContent = name || key;
    var span = document.createElement("span");
    span.textContent = text;
    li.appendChild(b);
    li.appendChild(span);
    feed.appendChild(li);
    while (feed.children.length > 60) feed.removeChild(feed.firstChild);
    if (stick) feed.scrollTop = feed.scrollHeight;
    speak(key, text);
  }
  function hearLines(sc) {
    if (!Array.isArray(sc.voice) || typeof sc.voice_total !== "number") return;
    var fresh = sc.voice_total - heard;
    if (fresh <= 0) return;
    if (!onVoicePage) $("room").hidden = false; // shown first, so it can scroll
    sc.voice.slice(-Math.min(fresh, sc.voice.length)).forEach(addLine);
    heard = sc.voice_total;
  }
  function tick() {
    if (!startedAt) return;
    var secs = Math.max(0, Math.round(((endedAt || Date.now()) - startedAt) / 1000));
    var m = Math.floor(secs / 60), r = secs % 60;
    $("clock").textContent = (endedAt ? "Took " : "") + m + ":" + (r < 10 ? "0" : "") + r;
    $("clock").hidden = false;
  }

  // fromTool: the tool's own result, which a host also shows again when a
  // chat is reopened, maybe long after the build ended. A "started" result is
  // then not news: until check_build says where the build really is, the card
  // says it is checking, with no guessed person at work and no new clock.
  function apply(sc, fromTool) {
    if (!sc || typeof sc !== "object") return;
    if (sc.kind) kind = sc.kind;
    var status = sc.status || "working";
    if (!fromTool) checked = true;
    var unsure = fromTool && status === "working" && !checked;
    if (sc.build_id && !buildId) {
      buildId = sc.build_id;
      if (status === "working") poll(); // a finished result needs no polling
    }
    $("card").className = "card" + (status === "failed" ? " failed" : "");
    say("chip", kind === "team" ? "AI Team" : kind === "edit" ? "Change" : "Quick build");
    var title = unsure ? "Checking on your build" : heading(status, sc.app_name);
    say("title", title);
    // A quick build's progress is the code count below; its "Still building."
    // would only repeat that. The team's lines are the story, so they show.
    var progressOnly = status === "working" && kind !== "team" && sc.chars;
    if (sc.message && !progressOnly && !unsure) {
      // "Fade Street is ready. Your team..." under a "Fade Street is ready"
      // title; "Your team is on it, and Maya..." under "Your team is on it".
      var rest = sc.message;
      if (rest.indexOf(title) === 0) {
        rest = rest.slice(title.length).replace(/^[.,;:!\s]+/, "").replace(/^and\s+/i, "");
        rest = rest.charAt(0).toUpperCase() + rest.slice(1);
      }
      say("said", rest || sc.message);
    }
    var team = $("team");
    team.hidden = kind !== "team" || unsure;
    if (kind === "team" && !unsure) {
      hearLines(sc); // before drawing, so each tile shows its newest line
      drawTeam(sc);
      // The build's own start time, so a reopened chat shows the real time.
      if (!startedAt && typeof sc.started_at === "number" && sc.started_at > 0) startedAt = sc.started_at;
      if (!startedAt && status === "working") startedAt = Date.now();
      if (status === "working" && !clockTimer) clockTimer = setInterval(tick, 1000);
      tick();
    }
    $("bar").setAttribute("data-s", status === "working" ? "on" : status === "completed" ? "done" : "off");
    if (status === "working" && sc.chars) say("meta", "About " + Math.round(sc.chars / 1000) + " thousand characters of code written");
    else if (status === "completed" && sc.version) say("meta", /version/i.test(sc.message || "") ? "" : "Version " + sc.version);
    else if (status !== "working") say("meta", "");
    // Links come from the server as https://<Shipd>/builder?project=<uuid>;
    // anything else is never offered.
    if (typeof sc.link === "string" && sc.link.indexOf("https://") === 0) { link = sc.link; $("actions").hidden = false; }
    if (status !== "working") {
      finished = true;
      if (startedAt && !endedAt) {
        // When it really ended (its last update), not when the card heard.
        var ended = Date.parse(sc.updated_at || "");
        endedAt = ended && ended > startedAt ? ended : Date.now();
        clearInterval(clockTimer);
        tick();
        if (status === "completed") speak("assistant", heading(status, sc.app_name) + ".");
      }
      if (status === "completed" && !told && app) {
        told = true;
        app.updateModelContext({
          content: [{ type: "text", text: "The Shipd build finished: " + heading(status, sc.app_name) + (sc.version ? ", version " + sc.version : "") + (link ? ". Link: " + link : ".") }],
          structuredContent: { build_id: buildId, status: status, link: link, version: sc.version || null }
        }).catch(function () {});
      }
    }
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  // Every 5 s for the first 3 minutes, every 10 s to 15 minutes, then every
  // 20 s; give up after 40 minutes. An AI Team build with a backend (Devin,
  // then Sam) took 16 minutes on prod (2026-10-06), so 15 was too short. A
  // reply without a status (a passing backend error) is a miss, never a failure.
  async function poll() {
    if (polling || !buildId || !app) return;
    polling = true;
    var started = Date.now(), first = true;
    while (!finished) {
      var age = Date.now() - started;
      if (age > 40 * 60 * 1000) { say("meta", "Still going after 40 minutes. Ask me to check on it."); break; }
      await wait(first ? 300 : age < 3 * 60 * 1000 ? 5000 : age < 15 * 60 * 1000 ? 10000 : 20000);
      first = false;
      if (finished) break;
      var r = null;
      try { r = await app.callServerTool({ name: "check_build", arguments: { build_id: buildId } }); } catch (e) { r = null; }
      if (r && r.structuredContent && r.structuredContent.status) { misses = 0; apply(r.structuredContent); continue; }
      misses += 1;
      if (misses >= 5) { say("meta", "Lost touch with the build. Ask me to check on it."); break; }
    }
    polling = false;
  }

  if (synth || Ctx) {
    if (synth) {
      loadVoices();
      try { synth.onvoiceschanged = loadVoices; } catch (e) {}
    }
    $("listen").hidden = false;
    $("listen").addEventListener("click", function () {
      listening = !listening;
      this.setAttribute("aria-pressed", listening ? "true" : "false");
      this.textContent = listening ? "Mute" : "Listen";
      if (!listening) {
        gen += 1; // drop what is queued
        try { if (playing) playing.stop(); } catch (e) {}
        try { if (synth) synth.cancel(); } catch (e) {}
        return;
      }
      // Made and started on the tap itself: browsers play sound only after one.
      if (Ctx && !actx) { try { actx = new Ctx(); } catch (e) { polly = false; } }
      if (actx) { try { actx.resume(); } catch (e) {} }
      speak("assistant", "I'll read the team's updates out loud.");
    });
  }

  // The host decides whether to open it; the card never goes around the host.
  $("open").addEventListener("click", function () {
    if (link && app) app.openLink({ url: link }).catch(function () {});
  });

  var app = Apps.App ? new Apps.App({ name: "Shipd build card", version: "1.0.0" }) : null;
  if (!app) { say("said", "This card needs a host that supports MCP Apps."); return; }
  app.ontoolinput = function (p) {
    var a = (p && p.arguments) || {};
    if (a.change) kind = "edit";
    var what = a.description || a.change || "";
    if (what && !$("said").textContent) say("said", what.length > 160 ? what.slice(0, 157) + "..." : what);
  };
  app.ontoolresult = function (p) { apply((p && p.structuredContent) || {}, true); };
  function host(c) {
    if (!c) return;
    theme(c.theme);
    if (c.shipdVoice === true) {
      onVoicePage = true;
      $("room").hidden = true;
      $("listen").hidden = true;
    }
  }
  app.onhostcontextchanged = host;
  app.onteardown = async function () { finished = true; return {}; };
  app.connect().then(function () {
    host(app.getHostContext());
  }).catch(function () { say("said", "This card could not reach its host."); });
})();
`;

/** The card's HTML, built once per process (the bundle is ~330 KB). */
export function cardHtml(): string {
  if (cached) return cached;
  cached = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shipd build</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card" id="card">
  <div class="top"><span class="brand"><i></i>Shipd</span><span class="right"><span class="clock" id="clock" hidden></span><span class="chip" id="chip">Quick build</span></span></div>
  <h1 id="title">Starting your build</h1>
  <p class="said" id="said" role="status" aria-live="polite"></p>
  <ol class="team" id="team" hidden></ol>
  <div class="bar" id="bar" data-s="on"><span></span></div>
  <section class="room" id="room" hidden aria-label="Team chat">
    <div class="room-top"><b>Team chat</b><button type="button" class="ghost" id="listen" hidden aria-pressed="false">Listen</button></div>
    <ol class="feed" id="feed" aria-live="polite"></ol>
  </section>
  <p class="meta" id="meta"></p>
  <div class="actions" id="actions" hidden><button type="button" id="open">Open in Shipd</button></div>
</main>
<script>${appsBundle()}</script>
<script>${SCRIPT}</script>
</body>
</html>`;
  return cached;
}
