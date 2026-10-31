// ExtBrain landing: one random pitch section per visit.
"use strict";

/** Hosted ExtBrain app URL. */
const APP_URL = "https://extbrain.app";

const SECTIONS = [
  { id: "chats", label: "Chats" },
  { id: "activity", label: "Activity" },
  { id: "tags", label: "Tags" },
  { id: "voice", label: "Voice" },
  { id: "summary", label: "Summary" },
];

const reduceMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)"
).matches;

// ---- timers (cancelled when leaving/replaying a section) ----
const timers = { chats: [], tags: [], voice: [], activity: [], summary: [] };
const repeaters = { chats: [], tags: [], voice: [], activity: [], summary: [] };

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

// ---- svg helper ----
const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

// ---- section 1 data ----
const AI_SERIES = [
  { key: "openai", name: "ChatGPT", color: "#10a37f" },
  { key: "gemini", name: "Gemini", color: "#6b7cff" },
  { key: "claude", name: "Claude", color: "#d97757" },
];

// Sample daily chat counts, oldest → today, per AI.
const CHAT_COUNTS = [
  [12, 18, 9, 22, 15, 27, 19],
  [8, 11, 14, 10, 17, 13, 21],
  [5, 7, 12, 8, 11, 9, 14],
];

const CHART = { w: 720, h: 440, l: 52, r: 130, t: 40, b: 48, yMax: 60 };

function last7Labels() {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    out.push(i === 6 ? "Today" : `${days[d.getDay()]} ${d.getDate()}`);
  }
  return out;
}

function chartGeom() {
  const plotW = CHART.w - CHART.l - CHART.r;
  const plotH = CHART.h - CHART.t - CHART.b;
  const baseY = CHART.t + plotH;
  const groupW = plotW / 7;
  const barW = 54;
  return {
    plotW,
    plotH,
    baseY,
    groupW,
    barW,
    y: (v) => baseY - (v / CHART.yMax) * plotH,
    groupX: (i) => CHART.l + i * groupW + (groupW - barW) / 2,
    /** today's stack segment midpoint for AI index ai (stacked bottom-up). */
    todayMid: (ai) => {
      let below = 0;
      for (let k = 0; k < ai; k++) below += CHAT_COUNTS[k][6];
      const mid = below + CHAT_COUNTS[ai][6] / 2;
      return baseY - (mid / CHART.yMax) * plotH;
    },
  };
}

/** Official logo artwork: ChatGPT matches the ExtBrain app (SourceLogo); Gemini + Claude per supplied brand marks. */
const LOGO_MARKS = {
  openai: { viewBox: "0 0 24 24", fill: "#1F2428", body: `<path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />` },
  gemini: { viewBox: "0 0 65 65", fill: null, body: `<mask id="maskme" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="65" height="65"><path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z" fill="#000"/><path d="M32.447 0c.68 0 1.273.465 1.439 1.125a38.904 38.904 0 001.999 5.905c2.152 5 5.105 9.376 8.854 13.125 3.751 3.75 8.126 6.703 13.125 8.855a38.98 38.98 0 005.906 1.999c.66.166 1.124.758 1.124 1.438 0 .68-.464 1.273-1.125 1.439a38.902 38.902 0 00-5.905 1.999c-5 2.152-9.375 5.105-13.125 8.854-3.749 3.751-6.702 8.126-8.854 13.125a38.973 38.973 0 00-2 5.906 1.485 1.485 0 01-1.438 1.124c-.68 0-1.272-.464-1.438-1.125a38.913 38.913 0 00-2-5.905c-2.151-5-5.103-9.375-8.854-13.125-3.75-3.749-8.125-6.702-13.125-8.854a38.973 38.973 0 00-5.905-2A1.485 1.485 0 010 32.448c0-.68.465-1.272 1.125-1.438a38.903 38.903 0 005.905-2c5-2.151 9.376-5.104 13.125-8.854 3.75-3.749 6.703-8.125 8.855-13.125a38.972 38.972 0 001.999-5.905A1.485 1.485 0 0132.447 0z" fill="url(#prefix__paint0_linear_2001_67)"/></mask><g mask="url(#maskme)"><g filter="url(#prefix__filter0_f_2001_67)"><path d="M-5.859 50.734c7.498 2.663 16.116-2.33 19.249-11.152 3.133-8.821-.406-18.131-7.904-20.794-7.498-2.663-16.116 2.33-19.25 11.151-3.132 8.822.407 18.132 7.905 20.795z" fill="#FFE432"/></g><g filter="url(#prefix__filter1_f_2001_67)"><path d="M27.433 21.649c10.3 0 18.651-8.535 18.651-19.062 0-10.528-8.35-19.062-18.651-19.062S8.78-7.94 8.78 2.587c0 10.527 8.35 19.062 18.652 19.062z" fill="#FC413D"/></g><g filter="url(#prefix__filter2_f_2001_67)"><path d="M20.184 82.608c10.753-.525 18.918-12.244 18.237-26.174-.68-13.93-9.95-24.797-20.703-24.271C6.965 32.689-1.2 44.407-.519 58.337c.681 13.93 9.95 24.797 20.703 24.271z" fill="#00B95C"/></g><g filter="url(#prefix__filter3_f_2001_67)"><path d="M20.184 82.608c10.753-.525 18.918-12.244 18.237-26.174-.68-13.93-9.95-24.797-20.703-24.271C6.965 32.689-1.2 44.407-.519 58.337c.681 13.93 9.95 24.797 20.703 24.271z" fill="#00B95C"/></g><g filter="url(#prefix__filter4_f_2001_67)"><path d="M30.954 74.181c9.014-5.485 11.427-17.976 5.389-27.9-6.038-9.925-18.241-13.524-27.256-8.04-9.015 5.486-11.428 17.977-5.39 27.902 6.04 9.924 18.242 13.523 27.257 8.038z" fill="#00B95C"/></g><g filter="url(#prefix__filter5_f_2001_67)"><path d="M67.391 42.993c10.132 0 18.346-7.91 18.346-17.666 0-9.757-8.214-17.667-18.346-17.667s-18.346 7.91-18.346 17.667c0 9.757 8.214 17.666 18.346 17.666z" fill="#3186FF"/></g><g filter="url(#prefix__filter6_f_2001_67)"><path d="M-13.065 40.944c9.33 7.094 22.959 4.869 30.442-4.972 7.483-9.84 5.987-23.569-3.343-30.663C4.704-1.786-8.924.439-16.408 10.28c-7.483 9.84-5.986 23.57 3.343 30.664z" fill="#FBBC04"/></g><g filter="url(#prefix__filter7_f_2001_67)"><path d="M34.74 51.43c11.135 7.656 25.896 5.524 32.968-4.764 7.073-10.287 3.779-24.832-7.357-32.488C49.215 6.52 34.455 8.654 27.382 18.94c-7.072 10.288-3.779 24.833 7.357 32.49z" fill="#3186FF"/></g><g filter="url(#prefix__filter8_f_2001_67)"><path d="M54.984-2.336c2.833 3.852-.808 11.34-8.131 16.727-7.324 5.387-15.557 6.631-18.39 2.78-2.833-3.853.807-11.342 8.13-16.728 7.324-5.387 15.558-6.631 18.39-2.78z" fill="#749BFF"/></g><g filter="url(#prefix__filter9_f_2001_67)"><path d="M31.727 16.104C43.053 5.598 46.94-8.626 40.41-15.666c-6.53-7.04-21.006-4.232-32.332 6.274s-15.214 24.73-8.683 31.77c6.53 7.04 21.006 4.232 32.332-6.274z" fill="#FC413D"/></g><g filter="url(#prefix__filter10_f_2001_67)"><path d="M8.51 53.838c6.732 4.818 14.46 5.55 17.262 1.636 2.802-3.915-.384-10.994-7.116-15.812-6.731-4.818-14.46-5.55-17.261-1.636-2.802 3.915.383 10.994 7.115 15.812z" fill="#FFEE48"/></g></g><defs><filter id="prefix__filter0_f_2001_67" x="-19.824" y="13.152" width="39.274" height="43.217" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="2.46" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter1_f_2001_67" x="-15.001" y="-40.257" width="84.868" height="85.688" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="11.891" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter2_f_2001_67" x="-20.776" y="11.927" width="79.454" height="90.916" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="10.109" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter3_f_2001_67" x="-20.776" y="11.927" width="79.454" height="90.916" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="10.109" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter4_f_2001_67" x="-19.845" y="15.459" width="79.731" height="81.505" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="10.109" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter5_f_2001_67" x="29.832" y="-11.552" width="75.117" height="73.758" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="9.606" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter6_f_2001_67" x="-38.583" y="-16.253" width="78.135" height="78.758" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="8.706" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter7_f_2001_67" x="8.107" y="-5.966" width="78.877" height="77.539" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="7.775" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter8_f_2001_67" x="13.587" y="-18.488" width="56.272" height="51.81" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="6.957" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter9_f_2001_67" x="-15.526" y="-31.297" width="70.856" height="69.306" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="5.876" result="effect1_foregroundBlur_2001_67"/></filter><filter id="prefix__filter10_f_2001_67" x="-14.168" y="20.964" width="55.501" height="51.571" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feBlend in="SourceGraphic" in2="BackgroundImageFix" result="shape"/><feGaussianBlur stdDeviation="7.273" result="effect1_foregroundBlur_2001_67"/></filter><linearGradient id="prefix__paint0_linear_2001_67" x1="18.447" y1="43.42" x2="52.153" y2="15.004" gradientUnits="userSpaceOnUse"><stop stop-color="#4893FC"/><stop offset=".27" stop-color="#4893FC"/><stop offset=".777" stop-color="#969DFF"/><stop offset="1" stop-color="#BD99FE"/></linearGradient></defs>` },
  claude: { viewBox: "0 -0.01 39.5 39.53", fill: null, body: `<path d="m7.75 26.27 7.77-4.36.13-.38-.13-.21h-.38l-1.3-.08-4.44-.12-3.85-.16-3.73-.2-.94-.2-.88-1.16.09-.58.79-.53 1.13.1 2.5.17 3.75.26 2.72.16 4.03.42h.64l.09-.26-.22-.16-.17-.16-3.88-2.63-4.2-2.78-2.2-1.6-1.19-.81-.6-.76-.26-1.66 1.08-1.19 1.45.1.37.1 1.47 1.13 3.14 2.43 4.1 3.02.6.5.24-.17.03-.12-.27-.45-2.23-4.03-2.38-4.1-1.06-1.7-.28-1.02c-.1-.42-.17-.77-.17-1.2l1.23-1.67.68-.22 1.64.22.69.6 1.02 2.33 1.65 3.67 2.56 4.99.75 1.48.4 1.37.15.42h.26v-.24l.21-2.81.39-3.45.38-4.44.13-1.25.62-1.5 1.23-.81.96.46.79 1.13-.11.73-.47 3.05-.92 4.78-.6 3.2h.35l.4-.4 1.62-2.15 2.72-3.4 1.2-1.35 1.4-1.49.9-.71h1.7l1.25 1.86-.56 1.92-1.75 2.22-1.45 1.88-2.08 2.8-1.3 2.24.12.18.31-.03 4.7-1 2.54-.46 3.03-.52 1.37.64.15.65-.54 1.33-3.24.8-3.8.76-5.66 1.34-.07.05.08.1 2.55.24 1.09.06h2.67l4.97.37 1.3.86.78 1.05-.13.8-2 1.02-2.7-.64-6.3-1.5-2.16-.54h-.3v.18l1.8 1.76 3.3 2.98 4.13 3.84.21.95-.53.75-.56-.08-3.63-2.73-1.4-1.23-3.17-2.67h-.21v.28l.73 1.07 3.86 5.8.2 1.78-.28.58-1 .35-1.1-.2-2.26-3.17-2.33-3.57-1.88-3.2-.23.13-1.11 11.95-.52.61-1.2.46-1-.76-.53-1.23.53-2.43.64-3.17.52-2.52.47-3.13.28-1.04-.02-.07-.23.03-2.36 3.24-3.59 4.85-2.84 3.04-.68.27-1.18-.61.11-1.09.66-.97 3.93-5 2.37-3.1 1.53-1.79-.01-.26h-.09l-10.44 6.78-1.86.24-.8-.75.1-1.23.38-.4 3.14-2.16z" fill="#d97757"/>` },
};

/** 30px nested logo inside a chip group (centered on 0,0). */
function drawLogoMark(parent, key) {
  const spec = LOGO_MARKS[key];
  const s = el("svg", { x: -15, y: -15, width: 30, height: 30, viewBox: spec.viewBox }, parent);
  if (spec.fill) s.setAttribute("fill", spec.fill);
  s.innerHTML = spec.body;
  return s;
}

/** Build the chart skeleton; returns handles the player animates. */
function buildChatsChart() {
  const svg = document.getElementById("chats-chart");
  svg.innerHTML = "";
  const g = chartGeom();
  const labels = last7Labels();


  const chrome = el("g", { class: "fadeable", opacity: 0 }, svg);
  // Gridlines + y labels.
  for (const v of [0, 15, 30, 45, 60]) {
    const y = g.y(v);
    el(
      "line",
      {
        x1: CHART.l,
        y1: y,
        x2: CHART.w - CHART.r,
        y2: y,
        class: v === 0 ? "axis-line" : "grid-line",
      },
      chrome
    );
    const t = el(
      "text",
      {
        x: CHART.l - 12,
        y: y + 5,
        "text-anchor": "end",
        "font-size": 14,
      },
      chrome
    );
    t.textContent = String(v);
  }
  // X labels.
  labels.forEach((label, i) => {
    const cx = g.groupX(i) + g.barW / 2;
    const t = el(
      "text",
      {
        x: cx,
        y: g.baseY + 30,
        "text-anchor": "middle",
        "font-size": 14,
        "font-weight": i === 6 ? 700 : 400,
      },
      chrome
    );
    t.textContent = label;
  });

  // Leaders paint beneath the bars; dots stay on top.
  const leaderLayer = el("g", {}, svg);

  // One stacked bar per day, segments parked at zero height.
  const bars = [];
  for (let day = 0; day < 7; day++) {
    let below = 0;
    for (let ai = 0; ai < AI_SERIES.length; ai++) {
      const v = CHAT_COUNTS[ai][day];
      const top = below + v;
      const y = g.y(top);
      const h = g.y(below) - y;
      const rect = el(
        "rect",
        {
          x: g.groupX(day),
          y: g.baseY,
          width: g.barW,
          height: 0,
          fill: AI_SERIES[ai].color,
          class: "bar",
        },
        svg
      );
      bars.push({ rect, day, ai, y, h });
      below = top;
    }
  }

  // Logo chips + leaders, hidden until the bars finish rising. Chips sit
  // in a right-side lane, each level with its segment in today's stacked
  // bar, joined by a short horizontal leader.
  const chips = el("g", { class: "fadeable", opacity: 0 }, svg);
  const leaders = [];
  const chipCX = CHART.w - 65;
  const todayCX = g.groupX(6) + g.barW / 2;
  for (let ai = 0; ai < AI_SERIES.length; ai++) {
    const midY = g.todayMid(ai);
    const chip = el("g", { transform: `translate(${chipCX},${midY})` }, chips);
    el(
      "circle",
      { cx: 0, cy: 0, r: 23, fill: "#ffffff", stroke: "#e3e5e8", "stroke-width": 1.5 },
      chip
    );
    const mark = el("g", {}, chip);
    drawLogoMark(mark, AI_SERIES[ai].key);
    const name = el(
      "text",
      {
        x: 0,
        y: 43,
        "text-anchor": "middle",
        "font-size": 15,
        "font-weight": 600,
        fill: "#1f2428",
      },
      chip
    );
    name.textContent = AI_SERIES[ai].name;
    const line = el(
      "line",
      {
        x1: chipCX - 27,
        y1: midY,
        x2: todayCX,
        y2: midY,
        stroke: AI_SERIES[ai].color,
        "stroke-width": 2,
        class: "leader",
        opacity: 0,
      },
      leaderLayer
    );
    const dot = el(
      "circle",
      { cx: todayCX, cy: midY, r: 5, fill: AI_SERIES[ai].color, stroke: "#ffffff", "stroke-width": 2, class: "leader-dot", opacity: 0 },
      svg
    );
    leaders.push({ line, dot });
  }

  return { svg, g, chrome, bars, chips, leaders };
}

function playChatsChart() {
  const { g, chrome, bars, chips, leaders } = buildChatsChart();
  if (reduceMotion) {
    chrome.setAttribute("opacity", 1);
    for (const b of bars) {
      b.rect.setAttribute("y", b.y);
      b.rect.setAttribute("height", b.h);
    }
    chips.setAttribute("opacity", 1);
    for (const l of leaders) {
      l.line.setAttribute("opacity", 1);
      l.line.classList.add("drawn");
      l.dot.setAttribute("opacity", 1);
    }
    return;
  }
  later("chats", () => chrome.setAttribute("opacity", 1), 150);
  // Stacks rise day by day, oldest → today, bottom segment first.
  for (const b of bars) {
    const at = 350 + b.day * 320 + b.ai * 110;
    later(
      "chats",
      () => {
        b.rect.setAttribute("y", b.y);
        b.rect.setAttribute("height", b.h);
      },
      at
    );
  }
  const finale = 350 + 6 * 320 + 2 * 110 + 600;
  later("chats", () => chips.setAttribute("opacity", 1), finale);
  leaders.forEach((l, i) => {
    later(
      "chats",
      () => {
        l.line.setAttribute("opacity", 1);
        l.line.classList.add("drawn");
        l.dot.setAttribute("opacity", 1);
      },
      finale + 250 + i * 160
    );
  });
}

// ---- section 2 demo: auto-tagging (draft plates) ----
const TAG_ROWS = [
  {
    chat: "“How should we price the annual plan?”",
    tags: ["pricing", "myhoros"],
  },
  {
    chat: "“Draft the onboarding email for new users.”",
    tags: ["onboarding"],
  },
  {
    chat: "“Which ad channel had the best ROAS?”",
    tags: ["paid-acquisition", "reporting"],
  },
];
const TAG_TOTAL = 1247;

function playTagsDemo() {
  const box = document.getElementById("tags-demo");
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
    later("tags", () => r.div.classList.add("in"), 200 + i * 550);
    r.pillEls.forEach((p, j) => {
      later("tags", () => p.classList.add("in"), 500 + i * 550 + j * 140);
    });
  });
  later("tags", () => count.classList.add("in"), 200 + 3 * 550);
  const t0 = Date.now();
  const dur = 1300;
  every("tags", () => {
    const k = Math.min(1, (Date.now() - t0 - (200 + 3 * 550)) / dur);
    if (k < 0) return;
    const eased = 1 - Math.pow(1 - k, 2);
    count.textContent = `${Math.round(TAG_TOTAL * eased).toLocaleString()} chats tagged`;
    if (k >= 1) {
      for (const r of repeaters.tags) window.clearInterval(r);
      repeaters.tags = [];
    }
  }, 40);
}

// ---- section 3 demo: voice Q&A (draft plates) ----
const VOICE_Q = "What did we decide about pricing last quarter?";
const VOICE_A =
  "You decided to test $99/year against the $79 cohort first — from 3 chats in September.";

function playVoiceDemo() {
  const box = document.getElementById("voice-demo");
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
  later("voice", () => {
    wrap.classList.add("live");
    wave.classList.add("live");
    q.classList.add("in");
  }, 250);
  // Type the question, then reveal the answer.
  let i = 0;
  const caret = document.createElement("span");
  caret.className = "caret";
  later(
    "voice",
    () => {
      q.appendChild(caret);
      every("voice", () => {
        i += 1;
        caret.textContent = VOICE_Q.slice(0, i);
        if (i >= VOICE_Q.length) {
          for (const r of repeaters.voice) window.clearInterval(r);
          repeaters.voice = [];
          caret.classList.remove("caret");
          later("voice", () => {
            a.textContent = VOICE_A;
            a.classList.add("in");
          }, 450);
        }
      }, 32);
    },
    600
  );
}

// ---- section 4 demo: activity breakdown ----
const ACTIVITY_ROWS = [
  { tag: "#utilities", pct: 38, val: "14d 13h", color: "#0064e0" },
  { tag: "#business", pct: 36, val: "13d 20h", color: "#7b5cff" },
  { tag: "#finance", pct: 23, val: "8d 17h", color: "#0e9f6e" },
  { tag: "#social", pct: 3, val: "1d 2h", color: "#e05a9a" },
  { tag: "#entertainment", pct: 1, val: "10h", color: "#f08c00" },
  { tag: "#health", pct: 0, val: "1h", color: "#98a2ad" },
  { tag: "#education", pct: 0, val: "0m", color: "#aeb6bf" },
  { tag: "#productivity", pct: 0, val: "0m", color: "#c3c9d1" },
  { tag: "#travel", pct: 0, val: "0m", color: "#d5dade" },
];
const ACTIVITY_MODES = ["Duration", "Chats", "Threads"];

function playActivityDemo() {
  const box = document.getElementById("activity-demo");
  box.innerHTML = "";

  const head = document.createElement("div");
  head.className = "activity-head";
  const title = document.createElement("span");
  title.className = "activity-title";
  title.textContent = "Activity Category";
  const modes = document.createElement("div");
  modes.className = "activity-modes";
  for (const [i, m] of ACTIVITY_MODES.entries()) {
    const s = document.createElement("span");
    s.className = "activity-mode" + (i === 0 ? " on" : "");
    s.textContent = m;
    modes.appendChild(s);
  }
  head.appendChild(title);
  head.appendChild(modes);
  box.appendChild(head);

  const bar = document.createElement("div");
  bar.className = "activity-bar";
  const segs = ACTIVITY_ROWS.map((row) => {
    const s = document.createElement("span");
    s.className = "activity-seg";
    s.style.background = row.color;
    s.style.flex = row.pct > 0 ? `${row.pct} ${row.pct} 0%` : "0 0 4px";
    bar.appendChild(s);
    return s;
  });
  box.appendChild(bar);

  const list = document.createElement("div");
  list.className = "activity-rows";
  const rowEls = ACTIVITY_ROWS.map((row) => {
    const r = document.createElement("div");
    r.className = "activity-row";
    const left = document.createElement("span");
    left.className = "activity-left";
    const dot = document.createElement("span");
    dot.className = "activity-dot";
    dot.style.background = row.color;
    const chip = document.createElement("span");
    chip.className = "activity-tag";
    chip.textContent = row.tag;
    left.appendChild(dot);
    left.appendChild(chip);
    const pct = document.createElement("span");
    pct.className = "activity-pct";
    pct.textContent = `${row.pct}%`;
    const val = document.createElement("span");
    val.className = "activity-val";
    val.textContent = row.val;
    r.appendChild(left);
    r.appendChild(pct);
    r.appendChild(val);
    list.appendChild(r);
    return r;
  });
  box.appendChild(list);

  const flip = document.getElementById("activity-flip");
  const words = ACTIVITY_ROWS.map((r) => r.tag.slice(1));
  flip.textContent = words[0];

  if (reduceMotion) {
    for (const s of segs) s.classList.add("in");
    for (const r of rowEls) r.classList.add("in");
    return;
  }
  // Each bar segment grows in sync with its category row, top-down.
  ACTIVITY_ROWS.forEach((_, i) => {
    later(
      "activity",
      () => {
        segs[i].classList.add("in");
        rowEls[i].classList.add("in");
      },
      250 + i * 220
    );
  });
  // Flip the title word through every category before autoplay moves on.
  let wi = 0;
  later("activity", () => {
    every("activity", () => {
      wi = (wi + 1) % words.length;
      flip.classList.remove("flip");
      void flip.offsetWidth;
      flip.textContent = words[wi];
      flip.classList.add("flip");
    }, 800);
  }, 600);
}

// ---- section 5 demo: one-click summaries (mirrors ThreadSummary) ----
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
  const box = document.getElementById("summary-demo");
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
    btn.classList.remove("busy");
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
  later("summary", () => head.classList.add("in"), 250);
  later("summary", () => drop.classList.add("open"), 900);
  later("summary", () => tplEls[SUMMARY_PICK].classList.add("active"), 1700);
  later("summary", () => {
    drop.classList.remove("open");
    btn.classList.add("busy");
    label.textContent = "Summarizing…";
    panel.classList.add("in");
  }, 2300);
  blockEls.forEach((b, i) => {
    later(
      "summary",
      () => {
        caret.remove();
        b.classList.add("in");
        b.appendChild(caret);
      },
      2500 + i * 450
    );
  });
  later(
    "summary",
    () => {
      actions.classList.add("in");
      finish();
    },
    2500 + blockEls.length * 450
  );
}

const PLAYERS = {
  chats: playChatsChart,
  tags: playTagsDemo,
  voice: playVoiceDemo,
  activity: playActivityDemo,
  summary: playSummaryDemo,
};

// ---- section framework ----
let current = null;

function dots() {
  return [...document.querySelectorAll("#pager-dots .dot")];
}

function updateDots() {
  for (const d of dots()) {
    if (d.dataset.section === current) d.setAttribute("aria-current", "true");
    else d.removeAttribute("aria-current");
  }
}

function show(id, push = true) {
  if (current) {
    document.getElementById(`section-${current}`).hidden = true;
    clearTimers(current);
  }
  current = id;
  document.getElementById(`section-${id}`).hidden = false;
  try {
    sessionStorage.setItem("extbrain-last-section", id);
  } catch {
    /* private mode: still random */
  }
  if (push) {
    try {
      history.replaceState(null, "", `#${id}`);
    } catch {
      /* file:// : hash only */
      location.hash = id;
    }
  }
  updateDots();
  PLAYERS[id]();
  queueFit();
  scheduleAutoplay(id);
}

function step(dir) {
  const i = SECTIONS.findIndex((s) => s.id === current);
  const n = SECTIONS[(i + dir + SECTIONS.length) % SECTIONS.length];
  show(n.id);
}

// ---- autoplay: advance a few seconds after each animation ends, looping ----
// Per-section delay = animation end + ~3s pause (chats ≈4.2s, voice ≈3s,
// tags ≈3.2s, summary ≈4.7s; activity ≈7s for the full title flip cycle).
const AUTOPLAY_AFTER = {
  chats: 7500,
  voice: 6000,
  activity: 8500,
  tags: 6500,
  summary: 8000,
};
let autoplayId = 0;
function scheduleAutoplay(id) {
  window.clearTimeout(autoplayId);
  autoplayId = window.setTimeout(() => step(1), AUTOPLAY_AFTER[id] ?? 7000);
}

// ---- fit-to-viewport: shrink the demo card just enough that the whole
// page (through the footer) fits without scrolling ----
function fitDemo() {
  const card = document.querySelector(`#section-${current} .demo-card`);
  if (!card) return;
  card.style.zoom = "";
  const over =
    document.documentElement.scrollHeight - window.innerHeight;
  if (over <= 0) return;
  const h = card.getBoundingClientRect().height;
  if (h <= 0) return;
  const z = Math.min(1, Math.max(0.55, (h - over - 8) / h));
  card.style.zoom = String(z);
}

let fitQueued = false;
function queueFit() {
  if (fitQueued) return;
  fitQueued = true;
  window.requestAnimationFrame(() => {
    fitQueued = false;
    fitDemo();
  });
}

function pickInitial() {
  const hash = window.location.hash.replace("#", "");
  if (SECTIONS.some((s) => s.id === hash)) return hash;
  let last = null;
  try {
    last = sessionStorage.getItem("extbrain-last-section");
  } catch {
    /* ignore */
  }
  const pool = SECTIONS.filter((s) => s.id !== last);
  const options = pool.length > 0 ? pool : SECTIONS;
  return options[Math.floor(Math.random() * options.length)].id;
}

function init() {
  for (const a of [document.getElementById("nav-cta"), document.getElementById("foot-cta")]) {
    a.href = APP_URL;
  }
  document
    .getElementById("brand-home")
    .addEventListener("click", (e) => e.preventDefault());

  const dotBox = document.getElementById("pager-dots");
  for (const s of SECTIONS) {
    const d = document.createElement("button");
    d.type = "button";
    d.className = "dot";
    d.dataset.section = s.id;
    d.title = s.label;
    d.setAttribute("aria-label", `Show ${s.label} section`);
    d.addEventListener("click", () => show(s.id));
    dotBox.appendChild(d);
  }
  document.getElementById("page-prev").addEventListener("click", () => step(-1));
  document.getElementById("page-next").addEventListener("click", () => step(1));
  document.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
  });
  for (const b of document.querySelectorAll("[data-replay]")) {
    b.addEventListener("click", () => {
      const key = b.dataset.replay;
      clearTimers(key);
      PLAYERS[key]();
      scheduleAutoplay(key);
    });
  }
  window.addEventListener("resize", queueFit);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(queueFit).catch(() => {});
  }
  show(pickInitial(), false);
  // Reflect a shareable hash without adding history entries.
  try {
    history.replaceState(null, "", `#${current}`);
  } catch {
    /* ignore */
  }
}

init();

