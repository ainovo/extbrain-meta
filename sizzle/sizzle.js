// ExtBrain sizzle reel: full-screen scenes, client-side only.
"use strict";

// Play order: cold open on the logo (9), then problem → features → CTA.
const SCENES = [
  { id: "9", label: "Intro" },
  { id: "1", label: "Conversation" },
  { id: "2", label: "Familiar?" },
  { id: "3", label: "Remember?" },
  { id: "4", label: "Extended brain" },
  { id: "5", label: "Tags" },
  { id: "6", label: "Brief" },
  { id: "7", label: "Summaries" },
  { id: "8", label: "Voice" },
  { id: "10", label: "CTA" },
];

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

// ---- timers (cancelled when leaving/replaying a scene) ----
const timers = {};
const repeaters = {};
for (const s of SCENES) {
  timers[s.id] = [];
  repeaters[s.id] = [];
}

function later(key, fn, ms) {
  if (reduceMotion) {
    fn();
    return;
  }
  timers[key].push(window.setTimeout(fn, ms));
}

function every(key, fn, ms) {
  const id = window.setInterval(fn, ms);
  repeaters[key].push(id);
  return id;
}

function clearTimers(key) {
  for (const t of timers[key]) window.clearTimeout(t);
  for (const r of repeaters[key]) window.clearInterval(r);
  timers[key] = [];
  repeaters[key] = [];
}

// ---- scene 1: the conversation (user callout, then AI answer) ----
const SZ_USER_TEXT =
  "you have all the history of this chat... you don't even remember the time i made those changes? shame...";
const SZ_AI_MAIN =
  "I completely deserve that callout. You caught me relying on the high-level summary of our funnel strategy instead of pinning down the exact timestamp from the raw chat logs. ";
const SZ_AI_HL = "I will take the hit for the amnesia.";

function playScene1() {
  const userEl = document.getElementById("sz-user-text");
  const userCaret = userEl.nextElementSibling;
  const aiHead = document.getElementById("sz-ai-head");
  const aiBubble = document.getElementById("sz-ai-bubble");
  const aiEl = document.getElementById("sz-ai-text");
  const aiCaret = aiEl.nextElementSibling;
  userEl.textContent = "";
  userCaret.classList.remove("done");
  aiHead.classList.remove("in");
  aiBubble.classList.remove("in");
  aiEl.textContent = "";
  aiCaret.classList.remove("done");
  if (reduceMotion) {
    userEl.textContent = SZ_USER_TEXT;
    userCaret.classList.add("done");
    aiHead.classList.add("in");
    aiBubble.classList.add("in");
    aiEl.textContent = SZ_AI_MAIN;
    const hl = document.createElement("span");
    hl.className = "hl";
    hl.textContent = SZ_AI_HL;
    aiEl.appendChild(hl);
    aiCaret.classList.add("done");
    return;
  }
  const playAi = () => {
    aiHead.classList.add("in");
    aiBubble.classList.add("in");
    let i = 0;
    const stepMain = window.setInterval(() => {
      i += 1;
      aiEl.textContent = SZ_AI_MAIN.slice(0, i);
      if (i >= SZ_AI_MAIN.length) {
        window.clearInterval(stepMain);
        const hl = document.createElement("span");
        hl.className = "hl";
        aiEl.appendChild(hl);
        let j = 0;
        const stepHl = window.setInterval(() => {
          j += 1;
          hl.textContent = SZ_AI_HL.slice(0, j);
          if (j >= SZ_AI_HL.length) {
            window.clearInterval(stepHl);
            aiCaret.classList.add("done");
          }
        }, 26);
        repeaters["1"].push(stepHl);
      }
    }, 20);
    repeaters["1"].push(stepMain);
  };
  later("1", () => {
    let i = 0;
    every("1", () => {
      i += 1;
      userEl.textContent = SZ_USER_TEXT.slice(0, i);
      if (i >= SZ_USER_TEXT.length) {
        for (const r of repeaters["1"]) window.clearInterval(r);
        repeaters["1"] = [];
        userCaret.classList.add("done");
        // A quick second later, the AI responds.
        later("1", playAi, 1000);
      }
    }, 28);
  }, 800);
}

// ---- scene 3: accelerating category flip ----
const SZ_FLIP_START = "utilities";
const SZ_WORDS = [
  "business",
  "finance",
  "social",
  "entertainment",
  "health",
  "education",
  "productivity",
  "travel",
];

function playScene4() {
  const flip = document.getElementById("sz-flip");
  flip.textContent = SZ_FLIP_START;
  if (reduceMotion) {
    flip.textContent = SZ_WORDS[SZ_WORDS.length - 1];
    return;
  }
  // Gaps derived from the total flip span, so acceleration stays
  // consistent and the last word lands exactly on time.
  const WORD_LEAD = 500; // pause on "utilities" before flipping
  const WORD_TIME = 2700; // "travel" lands at this mark
  const RATIO = 0.8;
  const gaps = SZ_WORDS.length - 1;
  const d0 = ((WORD_TIME - WORD_LEAD) * (1 - RATIO)) / (1 - Math.pow(RATIO, gaps));
  let wi = 0;
  const tick = () => {
    flip.classList.remove("flip");
    void flip.offsetWidth;
    flip.textContent = SZ_WORDS[wi];
    flip.classList.add("flip");
    wi += 1;
    // Flip through once only — stop on the last word.
    if (wi < SZ_WORDS.length) {
      timers["3"].push(window.setTimeout(tick, d0 * Math.pow(RATIO, wi - 1)));
    }
  };
  later("3", tick, WORD_LEAD);
}

// ---- scene 5: auto-tagging (same animation as docs section 3) ----
const TAG_ROWS = [
  {
    chat: "\u201CHow should we price the annual plan?\u201D",
    tags: ["pricing", "myhoros"],
  },
  {
    chat: "\u201CDraft the onboarding email for new users.\u201D",
    tags: ["onboarding"],
  },
  {
    chat: "\u201CWhich ad channel had the best ROAS?\u201D",
    tags: ["paid-acquisition", "reporting"],
  },
];
const TAG_TOTAL = 1247;

function playTagsDemo() {
  const box = document.getElementById("sz-tags-demo");
  box.innerHTML = "";
  const rows = TAG_ROWS.map((row) => {
    const div = document.createElement("div");
    div.className = "tag-row";
    const line = document.createElement("div");
    line.className = "chat-line";
    line.textContent = row.chat;
    const pills = document.createElement("div");
    pills.className = "tag-pills";
    const pillEls = row.tags.map((t) => {
      const p = document.createElement("span");
      p.className = "tag-pill";
      p.textContent = t;
      pills.appendChild(p);
      return p;
    });
    div.appendChild(line);
    div.appendChild(pills);
    box.appendChild(div);
    return { div, pillEls };
  });
  const count = document.createElement("div");
  count.className = "tag-count";
  box.appendChild(count);

  if (reduceMotion) {
    for (const r of rows) {
      r.div.classList.add("in");
      for (const p of r.pillEls) p.classList.add("in");
    }
    count.textContent = `${TAG_TOTAL.toLocaleString()} chats tagged`;
    count.classList.add("in");
    return;
  }
  rows.forEach((r, i) => {
    later("5", () => r.div.classList.add("in"), 200 + i * 550);
    r.pillEls.forEach((p, j) => {
      later("5", () => p.classList.add("in"), 500 + i * 550 + j * 140);
    });
  });
  later("5", () => count.classList.add("in"), 200 + 3 * 550);
  const t0 = Date.now();
  const dur = 1300;
  every("5", () => {
    const k = Math.min(1, (Date.now() - t0 - (200 + 3 * 550)) / dur);
    if (k < 0) return;
    const eased = 1 - Math.pow(1 - k, 2);
    count.textContent = `${Math.round(TAG_TOTAL * eased).toLocaleString()} chats tagged`;
    if (k >= 1) {
      for (const r of repeaters["5"]) window.clearInterval(r);
      repeaters["5"] = [];
    }
  }, 40);
}

// ---- scene 6: daily brief (today's date + open action items) ----
const BRIEF_ITEMS = [
  "Launch the $99/year test cell. Deadline: 2026-11-05.",
  "Draft the pricing FAQ for support.",
  "Confirm Finance sign-off on the 60-day window.",
  "Pick the ad channel with the best ROAS for December.",
];

function playBriefDemo() {
  const box = document.getElementById("sz-brief-demo");
  box.innerHTML = "";
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  document.getElementById("sz-brief-head").textContent =
    `Your daily brief · ${today}`;

  const date = document.createElement("div");
  date.className = "brief-stat";
  date.innerHTML = `Here's <strong>${today}</strong> at a glance.`;
  const stats = document.createElement("div");
  stats.className = "brief-stats";
  const statTexts = [
    "<strong>19</strong> chats yesterday",
    "<strong>3</strong> decisions pinned",
    `<strong>${BRIEF_ITEMS.length}</strong> open action items`,
  ];
  const statEls = statTexts.map((html) => {
    const s = document.createElement("span");
    s.className = "brief-stat";
    s.innerHTML = html;
    stats.appendChild(s);
    return s;
  });
  const list = document.createElement("ul");
  list.className = "brief-list";
  const itemEls = BRIEF_ITEMS.map((text) => {
    const li = document.createElement("li");
    const boxSpan = document.createElement("span");
    boxSpan.className = "sum-box";
    li.appendChild(boxSpan);
    li.appendChild(document.createTextNode(text));
    list.appendChild(li);
    return li;
  });
  const count = document.createElement("div");
  count.className = "brief-count";
  box.appendChild(date);
  box.appendChild(stats);
  box.appendChild(list);
  box.appendChild(count);

  if (reduceMotion) {
    date.classList.add("in");
    for (const s of statEls) s.classList.add("in");
    for (const li of itemEls) li.classList.add("in");
    count.textContent = `${BRIEF_ITEMS.length} open action items`;
    count.classList.add("in");
    return;
  }
  later("6", () => date.classList.add("in"), 250);
  statEls.forEach((s, i) => {
    later("6", () => s.classList.add("in"), 600 + i * 200);
  });
  itemEls.forEach((li, i) => {
    later("6", () => li.classList.add("in"), 1300 + i * 350);
  });
  later("6", () => count.classList.add("in"), 1300 + BRIEF_ITEMS.length * 350);
  const t0 = Date.now();
  const startAt = 1300 + BRIEF_ITEMS.length * 350;
  every("6", () => {
    const k = Math.min(1, (Date.now() - t0 - startAt) / 900);
    if (k < 0) return;
    count.textContent = `${Math.round(BRIEF_ITEMS.length * k)} open action items`;
    if (k >= 1) {
      for (const r of repeaters["6"]) window.clearInterval(r);
      repeaters["6"] = [];
    }
  }, 40);
}

// ---- scene 7: one-click summaries (same animation as docs section 5) ----
const SUMMARY_THREAD = "Annual plan pricing · 24 chats";
const SUMMARY_TEMPLATES = [
  {
    name: "Milestone Timeline",
    badge: "Timeline",
    desc: "Chronological project milestones with exact timestamps and results.",
  },
  {
    name: "Retrospective",
    badge: "Review",
    desc: "Day review: executive summary, progress, learnings, action items.",
  },
  {
    name: "Action Items",
    badge: "Tasks",
    desc: "Open action items as a strict checklist with deadlines.",
  },
];
const SUMMARY_PICK = 1;
const SUMMARY_BLOCKS = [
  {
    h: "Executive Summary",
    p: "We compared $79 vs $99 annual pricing across 24 chats and decided to test $99/year against the $79 cohort first. Finance signed off on Sept 28 for a 60-day window.",
  },
  {
    h: "What Moved Forward",
    ul: [
      "Picked $99 as the test cell, measured by net revenue per signup.",
      "Got Finance approval for the 60-day test window.",
    ],
  },
  {
    h: "Key Learnings",
    ul: ["Annual-upfront beats monthly for cash flow even at lower conversion."],
  },
  {
    h: "Action Items",
    check: [
      "Launch the $99/year test cell. Deadline: 2026-11-05.",
      "Draft the pricing FAQ for support. Deadline: Next session.",
    ],
  },
];

const SVG_ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const SPARKLES_SVG = `<svg ${SVG_ICON_ATTRS}><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>`;
const CHEV_SVG = `<svg ${SVG_ICON_ATTRS} class="chev"><path d="m6 9 6 6 6-6"/></svg>`;

function playSummaryDemo() {
  const box = document.getElementById("sz-summary-demo");
  box.innerHTML = "";

  const head = document.createElement("div");
  head.className = "sum-head";
  const thread = document.createElement("span");
  thread.className = "sum-thread";
  thread.textContent = SUMMARY_THREAD;
  const wrap = document.createElement("div");
  wrap.className = "sum-wrap";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sum-btn";
  btn.innerHTML = `${SPARKLES_SVG}<span class="sum-label">Summarize</span>${CHEV_SVG}`;
  const label = btn.querySelector(".sum-label");
  const drop = document.createElement("div");
  drop.className = "sum-drop";
  const tplEls = SUMMARY_TEMPLATES.map((t) => {
    const b = document.createElement("div");
    b.className = "sum-tpl";
    const top = document.createElement("div");
    top.className = "sum-tpl-top";
    const name = document.createElement("span");
    name.className = "sum-tpl-name";
    name.textContent = t.name;
    const badge = document.createElement("span");
    badge.className = "sum-badge";
    badge.textContent = t.badge;
    top.appendChild(name);
    top.appendChild(badge);
    const desc = document.createElement("p");
    desc.className = "sum-desc";
    desc.textContent = t.desc;
    b.appendChild(top);
    b.appendChild(desc);
    drop.appendChild(b);
    return b;
  });
  wrap.appendChild(btn);
  wrap.appendChild(drop);
  head.appendChild(thread);
  head.appendChild(wrap);
  box.appendChild(head);

  const panel = document.createElement("div");
  panel.className = "sum-panel";
  const blockEls = SUMMARY_BLOCKS.map((b) => {
    const div = document.createElement("div");
    div.className = "sum-block";
    const h = document.createElement("div");
    h.className = "sum-h";
    h.textContent = b.h;
    div.appendChild(h);
    if (b.p) {
      const p = document.createElement("p");
      p.className = "sum-p";
      p.textContent = b.p;
      div.appendChild(p);
    }
    if (b.ul) {
      const ul = document.createElement("ul");
      ul.className = "sum-ul";
      for (const item of b.ul) {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      }
      div.appendChild(ul);
    }
    if (b.check) {
      const ul = document.createElement("ul");
      ul.className = "sum-check";
      for (const item of b.check) {
        const li = document.createElement("li");
        const boxSpan = document.createElement("span");
        boxSpan.className = "sum-box";
        li.appendChild(boxSpan);
        li.appendChild(document.createTextNode(item));
        ul.appendChild(li);
      }
      div.appendChild(ul);
    }
    panel.appendChild(div);
    return div;
  });
  const actions = document.createElement("div");
  actions.className = "sum-actions";
  for (const t of ["Copy", ".md"]) {
    const m = document.createElement("button");
    m.type = "button";
    m.className = "sum-mini";
    m.textContent = t;
    actions.appendChild(m);
  }
  panel.appendChild(actions);
  box.appendChild(panel);

  const caret = document.createElement("span");
  caret.className = "sum-caret";
  const finish = () => {
    label.textContent = "Summarize";
    caret.remove();
  };

  if (reduceMotion) {
    head.classList.add("in");
    tplEls[SUMMARY_PICK].classList.add("active");
    panel.classList.add("in");
    for (const b of blockEls) b.classList.add("in");
    actions.classList.add("in");
    return;
  }
  later("7", () => head.classList.add("in"), 250);
  later("7", () => drop.classList.add("open"), 900);
  later("7", () => tplEls[SUMMARY_PICK].classList.add("active"), 1700);
  later("7", () => {
    drop.classList.remove("open");
    label.textContent = "Summarizing…";
    panel.classList.add("in");
  }, 2300);
  blockEls.forEach((b, i) => {
    later(
      "8",
      () => {
        caret.remove();
        b.classList.add("in");
        b.appendChild(caret);
      },
      2500 + i * 450
    );
  });
  later(
    "8",
    () => {
      actions.classList.add("in");
      finish();
    },
    2500 + blockEls.length * 450
  );
}

// ---- scene 8: voice Q&A (same animation as docs section 4) ----
const VOICE_Q = "What did we decide about pricing last quarter?";
const VOICE_A =
  "You decided to test $99/year against the $79 cohort first — from 3 chats in September.";

function playVoiceDemo() {
  const box = document.getElementById("sz-voice-demo");
  box.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "mic-wrap";
  for (let i = 0; i < 3; i++) {
    const ring = document.createElement("span");
    ring.className = "mic-ring";
    wrap.appendChild(ring);
  }
  const btn = document.createElement("div");
  btn.className = "mic-btn";
  btn.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>';
  wrap.appendChild(btn);
  box.appendChild(wrap);

  const wave = document.createElement("div");
  wave.className = "wave";
  for (let i = 0; i < 26; i++) {
    const s = document.createElement("span");
    const h = 10 + Math.round(Math.random() * 34);
    s.style.height = `${h}px`;
    s.style.animationDelay = `${(i % 9) * 0.09}s`;
    wave.appendChild(s);
  }
  box.appendChild(wave);

  const script = document.createElement("div");
  script.className = "voice-script";
  const q = document.createElement("div");
  q.className = "voice-q";
  const a = document.createElement("div");
  a.className = "voice-a";
  script.appendChild(q);
  script.appendChild(a);
  box.appendChild(script);

  if (reduceMotion) {
    q.textContent = VOICE_Q;
    a.textContent = VOICE_A;
    q.classList.add("in");
    a.classList.add("in");
    return;
  }
  later("8", () => {
    wrap.classList.add("live");
    wave.classList.add("live");
    q.classList.add("in");
  }, 250);
  let i = 0;
  const caret = document.createElement("span");
  caret.className = "caret";
  later(
    "9",
    () => {
      q.appendChild(caret);
      every("8", () => {
        i += 1;
        caret.textContent = VOICE_Q.slice(0, i);
        if (i >= VOICE_Q.length) {
          for (const r of repeaters["8"]) window.clearInterval(r);
          repeaters["8"] = [];
          caret.classList.remove("caret");
          later("8", () => {
            a.textContent = VOICE_A;
            a.classList.add("in");
          }, 450);
        }
      }, 32);
    },
    600
  );
}

// ---- scene 9: logo assembly ----
function playScene10() {
  const left = document.getElementById("sz-logo-left");
  const right = document.getElementById("sz-logo-right");
  const tagline = document.getElementById("sz-tagline");
  left.classList.remove("in");
  right.classList.remove("in");
  tagline.classList.remove("in");
  if (reduceMotion) {
    left.classList.add("in");
    right.classList.add("in");
    tagline.classList.add("in");
    return;
  }
  later("9", () => left.classList.add("in"), 400);
  later("9", () => right.classList.add("in"), 1200);
  later("9", () => tagline.classList.add("in"), 2000);
}

const PLAYERS = {
  1: playScene1,
  3: playScene4,
  5: playTagsDemo,
  6: playBriefDemo,
  7: playSummaryDemo,
  8: playVoiceDemo,
  9: playScene10,
};

// ---- background music (locked to the scene clock) ----
let wantMusic = true;
let sceneTs = 0;

function musicEl() {
  return document.getElementById("sz-music");
}

// Position in the reel for the current scene, in seconds.
function reelPos() {
  return (OFFSETS[current] ?? 0) + (performance.now() - sceneTs) / 1000;
}

function tryPlay() {
  const audio = musicEl();
  if (!audio || !wantMusic || !audio.paused) return;
  audio.play().catch(() => {});
}

// Pin the track to the reel so a late start or toggle can never drift.
function syncMusic() {
  const audio = musicEl();
  if (!audio || !current || audio.readyState < 1) return;
  const target = Math.min(reelPos(), (audio.duration || Infinity) - 0.05);
  try {
    if (target >= 0 && Math.abs(audio.currentTime - target) > 0.5) {
      audio.currentTime = target;
    }
  } catch {
    /* ignore */
  }
}

function initMusic() {
  const audio = musicEl();
  const btn = document.getElementById("music-btn");
  if (!audio || !btn) return;
  audio.volume = 0.35;
  audio.preload = "auto";
  try {
    audio.load();
  } catch {
    /* ignore */
  }
  // The reel starts on first tap, which is the gesture that unlocks sound.
  for (const evt of ["pointerdown", "keydown", "touchend"]) {
    document.addEventListener(
      evt,
      () => {
        if (!started) startReel();
        else tryPlay();
      },
      { passive: true }
    );
  }
  btn.addEventListener("click", () => {
    wantMusic = !wantMusic;
    btn.setAttribute("aria-pressed", String(wantMusic));
    if (wantMusic) {
      syncMusic();
      tryPlay();
    } else audio.pause();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) audio.pause();
    else if (started) tryPlay();
  });
  audio.addEventListener("error", () => {
    wantMusic = false;
    btn.setAttribute("aria-pressed", "false");
  });
}

// ---- scene framework (mirrors docs autoplay) ----
let current = null;

// Per-scene delay = animation end + hold before advancing.
const AUTOPLAY_AFTER = {
  1: 12000,
  2: 3200,
  3: 3000,
  4: 3400,
  5: 6500,
  6: 6500,
  7: 7500,
  8: 6500,
  9: 5200,
  10: 6000,
};
// Scene-start offsets in seconds, in play order (music sync anchor).
const OFFSETS = (() => {
  const o = {};
  let acc = 0;
  for (const s of SCENES) {
    o[s.id] = acc;
    acc += (AUTOPLAY_AFTER[s.id] ?? 6000) / 1000;
  }
  return o;
})();
let autoplayId = 0;

function dots() {
  return [...document.querySelectorAll("#pager-dots .dot")];
}

function updateDots() {
  for (const d of dots()) {
    if (d.dataset.scene === current) d.setAttribute("aria-current", "true");
    else d.removeAttribute("aria-current");
  }
}

function show(id, push = true) {
  const prev = current;
  if (current) {
    document.getElementById(`scene-${current}`).hidden = true;
    clearTimers(current);
  }
  current = id;
  document.getElementById(`scene-${id}`).hidden = false;
  if (push) {
    try {
      history.replaceState(null, "", `#${id}`);
    } catch {
      location.hash = id;
    }
  }
  updateDots();
  if (PLAYERS[id]) PLAYERS[id]();
  sceneTs = performance.now();
  scheduleAutoplay(id);
  // Only pin music on natural forward play (autoplay or single step):
  // scrubbing the dots leaves the background bed untouched.
  const prevIdx = SCENES.findIndex((s) => s.id === prev);
  const natural =
    prev !== null && SCENES[(prevIdx + 1) % SCENES.length].id === id;
  if (natural) syncMusic();
  tryPlay();
}

function step(dir) {
  const i = SCENES.findIndex((s) => s.id === current);
  const n = SCENES[(i + dir + SCENES.length) % SCENES.length];
  show(n.id);
}

function scheduleAutoplay(id) {
  window.clearTimeout(autoplayId);
  autoplayId = window.setTimeout(() => step(1), AUTOPLAY_AFTER[id] ?? 6000);
}

function pickInitial() {
  // Every load (including refresh) starts from the beginning.
  return SCENES[0].id;
}

let started = false;

function startReel() {
  if (started) return;
  started = true;
  document.getElementById("sz-start")?.setAttribute("hidden", "");
  show(pickInitial(), false);
}

function init() {

  const dotBox = document.getElementById("pager-dots");
  for (const s of SCENES) {
    const d = document.createElement("button");
    d.type = "button";
    d.className = "dot";
    d.dataset.scene = s.id;
    d.title = `Scene ${s.id}: ${s.label}`;
    d.setAttribute("aria-label", `Show scene ${s.id}: ${s.label}`);
    d.addEventListener("click", () => {
      if (!started) startReel();
      else show(s.id);
    });
    dotBox.appendChild(d);
  }
  document.getElementById("sz-start-btn")?.addEventListener("click", startReel);
  document.addEventListener("keydown", (e) => {
    if (!started) {
      startReel();
      return;
    }
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
      step(1);
    }
  });
  initMusic();
  // Drop any incoming hash so a refresh visibly restarts the reel.
  // Scenes stay hidden until the first tap starts reel + music together.
  try {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search
    );
  } catch {
    /* ignore */
  }
}

init();

