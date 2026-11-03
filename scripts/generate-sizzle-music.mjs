// Sizzle score v2 — 124 BPM product-sizzle arc, exactly 59.8s (autoplay total).
// Play order: 9 logo cold open → 1-3 frustrated "AI amnesia" → 4 pivot riser
// → 5-8 feature build (drums enter, layers stack) → 10 anthem CTA + resolve.
// Run: node scripts/generate-sizzle-music.mjs  (+ ffmpeg to mp3, see below)
import { writeFileSync } from "node:fs";

const SR = 22050;
const DUR = 59.8; // sum of AUTOPLAY_AFTER in sizzle.js (whole reel < 60s)
const N = Math.round(SR * DUR);
const BPM = 124;
const BEAT = 60 / BPM; // 0.4839s
const S16 = BEAT / 4;

// Scene boundaries (seconds) in play order 9,1,2,3,4,5,6,7,8,10.
const SECT = [
  { id: "intro", t0: 0, t1: 5.2 }, // 9 logo cold open
  { id: "s1", t0: 5.2, t1: 17.2 }, // 1 frustrated conversation
  { id: "s2", t0: 17.2, t1: 20.4 }, // 2 "AI amnesia"
  { id: "s3", t0: 20.4, t1: 23.4 }, // 3 flipping words
  { id: "pivot", t0: 23.4, t1: 26.8 }, // 4 "extended brain" riser
  { id: "f1", t0: 26.8, t1: 33.3 }, // 5 tags: drums enter
  { id: "f2", t0: 33.3, t1: 39.8 }, // 6 brief
  { id: "f3", t0: 39.8, t1: 47.3 }, // 7 summaries: snare enters
  { id: "f4", t0: 47.3, t1: 53.8 }, // 8 voice
  { id: "cta", t0: 53.8, t1: 59.8 }, // 10 anthem CTA + warm resolve
];

// Pad chords: [root, 3rd/5th voices...] + bass root.
const CH = {
  C: { pad: [130.81, 196.0, 261.63, 329.63], bass: 65.41 },
  G: { pad: [98.0, 196.0, 246.94, 392.0], bass: 49.0 },
  Am: { pad: [110.0, 164.81, 220.0, 261.63], bass: 55.0 },
  F: { pad: [87.31, 174.61, 220.0, 261.63], bass: 43.65 },
};
// Arp tone rows (bright, chord-matched).
const ARP_TONES = {
  C: [261.63, 329.63, 392.0, 523.25, 659.25],
  G: [246.94, 293.66, 392.0, 493.88, 587.33],
  Am: [220.0, 261.63, 329.63, 440.0, 523.25],
  F: [220.0, 261.63, 349.23, 440.0, 523.25],
};
const ARP_PAT = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 4, 3, 2];

// Chord per section (pivot splits F -> C halfway).
function chordAt(t) {
  if (t < 5.2) return "C";
  if (t < 20.4) return "Am";
  if (t < 23.4) return "F";
  if (t < 25.1) return "F";
  if (t < 33.3) return "C";
  if (t < 39.8) return "G";
  if (t < 47.3) return "Am";
  if (t < 53.8) return "F";
  return "C";
}
function sectAt(t) {
  for (const s of SECT) if (t < s.t1) return s;
  return SECT[SECT.length - 1];
}
function sectEnv(t, s, a = 0.6, r = 0.9) {
  const attack = Math.min(1, (t - s.t0) / a);
  const rel = Math.min(1, (s.t1 - t) / r);
  return Math.max(0, Math.min(attack, rel));
}
// Master energy per section: flat frustration, then rising excitement.
function energy(t) {
  if (t < 5.2) return 0.9;
  if (t < 17.2) return 0.5;
  if (t < 20.4) return 0.45;
  if (t < 23.4) return 0.55;
  if (t < 26.8) return 0.7 + 0.3 * ((t - 23.4) / 3.4);
  if (t < 33.3) return 0.85;
  if (t < 39.8) return 0.9;
  if (t < 47.3) return 0.95;
  return 1.0;
}

// Deterministic noise (LCG) so builds are reproducible.
let seed = 1234567;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x40000000 - 1;
}

// Flip-word tick times in s3 — same acceleration as sizzle.js (RATIO 0.8).
const TICKS = (() => {
  const out = [];
  const d0 = ((2.7 - 0.5) * (1 - 0.8)) / (1 - Math.pow(0.8, 7));
  let tt = 20.4 + 0.5;
  out.push(tt);
  for (let k = 1; k < 8; k++) {
    tt += d0 * Math.pow(0.8, k - 1);
    out.push(tt);
  }
  return out;
})();

const out = new Float32Array(N);
let prevNoise = 0;

for (let i = 0; i < N; i++) {
  const t = i / SR;
  const s = sectAt(t);
  const e = energy(t);
  const ch = CH[chordAt(t)];
  const env = sectEnv(t, s);
  let v = 0;

  // Pad (pumped by the kick once drums enter).
  let pad = 0;
  for (let k = 0; k < ch.pad.length; k++) {
    const f = ch.pad[k];
    pad += Math.sin(2 * Math.PI * f * t) * (k === 0 ? 0.26 : 0.11);
    pad += Math.sin(2 * Math.PI * f * 2 * t) * 0.03;
  }
  let pump = 1;
  if (t >= 26.8 && t < 57.5) {
    const bp = (t - 26.8) % BEAT;
    pump = 1 - 0.32 * Math.exp(-bp * 11);
  }
  v += pad * env * pump * (t < 26.8 ? 0.5 : 0.62);

  // Bass: half-note roots, enters at pivot.
  if (t >= 23.4) {
    const half = (t - 23.4) % (BEAT * 2);
    v += Math.sin(2 * Math.PI * ch.bass * t) * Math.exp(-half * 2.2) * 0.3 * e;
  }

  // Logo sting at 0: bright C stack + rising sparkle.
  if (t < 4) {
    const stack = [523.25, 659.25, 783.99, 1046.5];
    let sting = 0;
    for (const f of stack) sting += Math.sin(2 * Math.PI * f * t);
    v += sting * Math.exp(-t * 2.4) * 0.1;
    const sp = Math.floor(t / 0.12);
    if (sp < 4) {
      const st = t - sp * 0.12;
      const f = [523.25, 659.25, 783.99, 1046.5][sp];
      v += Math.sin(2 * Math.PI * f * t) * Math.exp(-st * 14) * 0.12;
    }
  }

  // Frustration texture: heartbeat thump + descending sad pings (s1-s2).
  if (t >= 5.2 && t < 20.4) {
    const hb = (t - 5.2) % 1.0;
    v += Math.sin(2 * Math.PI * 52 * t) * Math.exp(-hb * 16) * 0.16;
    const bar = Math.floor((t - 5.2) / 4);
    const bt = t - 5.2 - bar * 4;
    const f = [466.16, 440.0, 415.3, 392.0][bar % 4];
    v += Math.sin(2 * Math.PI * f * t) * Math.exp(-bt * 3.2) * 0.09;
  }
  // Uneasy rub drone under scene 2.
  if (t >= 17.2 && t < 20.4) {
    v += Math.sin(2 * Math.PI * 349.23 * t) * 0.05 * env;
    v += Math.sin(2 * Math.PI * 110.5 * t) * 0.07 * env; // slight detune rub
  }
  // Accelerating flip ticks under scene 3.
  for (const tk of TICKS) {
    const p = t - tk;
    if (p >= 0 && p < 0.12) {
      v += Math.sin(2 * Math.PI * 2093 * t) * Math.exp(-p * 55) * 0.14;
      break;
    }
  }

  // Pivot riser: sweep + swell, cut on the f1 downbeat.
  if (t >= 23.4 && t < 26.8) {
    const k = (t - 23.4) / 3.4;
    const f = 180 + (1500 - 180) * k * k;
    v += Math.sin(2 * Math.PI * f * t) * k * 0.1;
    v += rnd() * k * k * 0.05;
  }

  const drums = t >= 26.8 && t < 57.5; // drums drop for the CTA resolve
  if (drums) {
    // Fade the kit in over 2 bars so the drop never startles.
    const kit = 0.25 + 0.75 * Math.min(1, Math.max(0, (t - 26.8) / (BEAT * 8)));
    // Kick: four on the floor.
    const bp = (t - 26.8) % BEAT;
    if (bp < 0.5) {
      const ph = 42 * bp + (68 * (1 - Math.exp(-bp * 30))) / 30;
      v += Math.sin(2 * Math.PI * ph) * Math.exp(-bp * 9) * 0.55 * kit;
    }
    // Snare on 2 & 4 from f3, eased in over a bar.
    if (t >= 39.8) {
      const snRamp =
        0.3 + 0.7 * Math.min(1, Math.max(0, (t - 39.8) / (BEAT * 4)));
      const beatN = Math.floor((t - 26.8) / BEAT);
      const sp = t - 26.8 - beatN * BEAT;
      if (beatN % 2 === 1 && sp < 0.3) {
        const n = rnd();
        v += (n - prevNoise * 0.6) * Math.exp(-sp * 20) * 0.3 * snRamp;
        v += Math.sin(2 * Math.PI * 190 * sp) * Math.exp(-sp * 24) * 0.16 * snRamp;
      }
    }
    // Hats: 8ths, 16ths in the CTA.
    const div = t >= 53.8 ? S16 : S16 * 2;
    const hStep = Math.floor((t - 26.8) / div);
    const hp = t - 26.8 - hStep * div;
    if (hp < 0.05) {
      const n = rnd();
      const diff = n - prevNoise; // crude highpass
      v += diff * Math.exp(-hp * 90) * (t >= 53.8 ? 0.16 : 0.11) * kit;
    }
    // Arp 16ths, louder + brighter as excitement builds.
    const aStep = Math.floor((t - 26.8) / S16);
    const ap = t - 26.8 - Math.floor((t - 26.8) / S16) * S16;
    if (ap < 0.14) {
      const tones = ARP_TONES[chordAt(t)];
      const f = tones[ARP_PAT[((aStep % 16) + 16) % 16]];
      const g = t < 39.8 ? 0.13 : t < 53.8 ? 0.15 : 0.17;
      v += Math.sin(2 * Math.PI * f * t) * Math.exp(-ap * 26) * g;
      v += Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-ap * 34) * g * 0.25;
    }
  } else if (t >= 23.4 && t < 26.8) {
    // Pivot-only: soft arp preview before drums drop.
    const ap = (t - 23.4) % S16;
    if (ap < 0.14) {
      const tones = ARP_TONES[chordAt(t)];
      const f = tones[ARP_PAT[Math.floor((t - 23.4) / S16) % 16]];
      v += Math.sin(2 * Math.PI * f * t) * Math.exp(-ap * 26) * 0.09;
    }
  }

  // CTA resolve: one warm unhurried hit after the drums drop, then let
  // the pad carry the "go visit" moment to a soft landing.
  if (t >= 57.7) {
    const p = t - 57.7;
    let stab = 0;
    for (const f of [130.81, 196.0, 261.63, 329.63, 392.0, 523.25]) {
      stab += Math.sin(2 * Math.PI * f * t);
    }
    v += stab * Math.exp(-p * 1.7) * 0.09;
    // Gentle sparkle ascent pointing at the URL.
    const sp = Math.floor((t - 57.7) / 0.3);
    if (sp < 5) {
      const st = t - 57.7 - sp * 0.3;
      const f = [523.25, 587.33, 659.25, 783.99, 1046.5][sp];
      v += Math.sin(2 * Math.PI * f * t) * Math.exp(-st * 8) * 0.07;
    }
  }

  prevNoise = rnd();
  out[i] = v * (0.35 + 0.65 * e);
}

// Master: short fades (loop-friendly), normalize.
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  let g = 1;
  if (t < 0.4) g = t / 0.4;
  if (t > DUR - 1.5) g = (DUR - t) / 1.5;
  out[i] *= g;
  peak = Math.max(peak, Math.abs(out[i]));
}
const norm = 0.72 / Math.max(peak, 1e-6);
const pcm = new Int16Array(N);
for (let i = 0; i < N; i++) {
  pcm[i] = Math.round(Math.max(-1, Math.min(1, out[i] * norm)) * 32767);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + N * 2, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(N * 2, 40);
writeFileSync(
  new URL("../sizzle/music.wav", import.meta.url),
  Buffer.concat([header, Buffer.from(pcm.buffer)])
);
console.log(`wrote sizzle/music.wav ${DUR.toFixed(1)}s @ ${SR}Hz mono (${BPM} BPM)`);
