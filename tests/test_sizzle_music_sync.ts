import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Guards the music<->scene sync: the generated score bakes scene boundary
// times in as constants, so any autoplay or reorder edit must stay in step.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sizzleJs = readFileSync(join(root, "sizzle/sizzle.js"), "utf8");
const sizzleHtml = readFileSync(join(root, "sizzle/index.html"), "utf8");
const genJs = readFileSync(
  join(root, "scripts/generate-sizzle-music.mjs"),
  "utf8"
);

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

// Play order from SCENES, per-scene holds from AUTOPLAY_AFTER.
const order = [...sizzleJs.matchAll(/\{\s*id:\s*"(\d+)"/g)].map((m) => m[1]);
const holdsBlock = sizzleJs.match(/AUTOPLAY_AFTER = \{([^}]*)\}/)?.[1] ?? "";
const holds: Record<string, number> = Object.fromEntries(
  [...holdsBlock.matchAll(/(\d+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])])
);
assert(order.length === 10, "ten scenes in play order");
assert(order[0] === "9", "cold open on the intro scene");
assert(
  /function pickInitial\(\) \{\s*\/\/[^\n]*\n\s*return SCENES\[0\]\.id;\s*\}/.test(sizzleJs),
  "every load starts from the first scene (hash ignored)"
);
assert(
  /let wantMusic = true;/.test(sizzleJs),
  "music defaults to on"
);
assert(
  sizzleHtml.includes('id="sz-start"') && /getElementById\("sz-start"\)/.test(sizzleJs),
  "click-to-play overlay gates the reel start"
);
assert(
  /audio\.currentTime\s*=/.test(sizzleJs),
  "music seeks to the scene clock on start and toggle"
);
assert(
  /if \(natural\) syncMusic\(\);/.test(sizzleJs),
  "manual dot scrub leaves the music bed untouched (sync on natural play only)"
);

// Cumulative scene boundaries in seconds.
const bounds: number[] = [0];
for (const id of order) bounds.push(bounds[bounds.length - 1] + holds[id] / 1000);
const total = bounds[bounds.length - 1];

// Generator constants.
const dur = Number(genJs.match(/const DUR = ([\d.]+)/)?.[1]);
const sects = [...genJs.matchAll(
  /\{\s*id:\s*"(\w+)",\s*t0:\s*([\d.]+),\s*t1:\s*([\d.]+)\s*\}/g
)].map((m) => ({ id: m[1], t0: Number(m[2]), t1: Number(m[3]) }));
assert(Math.abs(dur - total) < 0.01, `score length matches reel (${total.toFixed(2)}s)`);
assert(sects.length === order.length, "score covers every scene");
sects.forEach((s, i) => {
  assert(
    Math.abs(s.t0 - bounds[i]) < 0.01 && Math.abs(s.t1 - bounds[i + 1]) < 0.01,
    `score section ${s.id} matches scene ${order[i]} window`
  );
});

// Flip-tick times mirror sizzle.js (WORD_LEAD 0.5s, accelerating RATIO 0.8)
// starting at the flipping-words scene.
const scene3Start = bounds[order.indexOf("3")];
const tickBase = Number(genJs.match(/let tt = ([\d.]+) \+ 0\.5/)?.[1]);
assert(
  Math.abs(tickBase - scene3Start) < 0.01,
  `flip ticks start with scene 3 (${scene3Start.toFixed(2)}s)`
);
const words = sizzleJs.match(/const SZ_WORDS = \[([\s\S]*?)\];/)?.[1] ?? "";
const wordCount = (words.match(/"/g) ?? []).length / 2;
const tickCount = Number(genJs.match(/for \(let k = 1; k < (\d+); k\+\+\)/)?.[1]);
assert(tickCount === wordCount, `one tick per flip word (${wordCount})`);
