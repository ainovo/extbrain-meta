import { describeTagFilter } from "../src/lib/tags";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function runTests() {
  // No tags: empty header, nothing to expand.
  const empty = describeTagFilter([]);
  assert(
    empty.title === "" &&
      empty.entries.length === 0 &&
      empty.hiddenCount === 0,
    "no tags yields an empty header with nothing hidden"
  );

  // Single tag: title carries the tag; subtitle shows the first match and
  // first exclude bullet; the rest hide behind the expander.
  const single = describeTagFilter([
    {
      id: "t1",
      name: "paid acquisition",
      targetLabels: ["user acquisition chats", "ad channel optimization"],
      contrastLabels: ["monetization", "pricing"],
    },
  ]);
  assert(
    single.title === "#paid acquisition",
    "single tag title prefixes the tag name"
  );
  assert(
    single.entries.length === 1 &&
      single.entries[0].tagId === "t1" &&
      single.entries[0].match === "user acquisition chats" &&
      single.entries[0].exclude === "monetization" &&
      single.entries[0].targetLabels.length === 2 &&
      single.entries[0].contrastLabels.length === 2,
    "single tag entry shows first match/exclude and keeps full label lists"
  );
  assert(
    single.hiddenCount === 2,
    "hidden count is total labels minus the two shown bullets"
  );

  // One match bullet and no excludes: nothing hides, so no expander.
  const lean = describeTagFilter([
    { id: "t2", name: "solo", targetLabels: ["only me"], contrastLabels: [] },
  ]);
  assert(
    lean.entries[0].match === "only me" &&
      lean.entries[0].exclude === null &&
      lean.hiddenCount === 0,
    "a lone match bullet with no excludes hides nothing"
  );

  // Multiple tags: titles join, each tag keeps its own first bullets, and
  // the hidden count spans every tag.
  const multi = describeTagFilter([
    {
      id: "a",
      name: "alpha",
      targetLabels: ["a1", "a2"],
      contrastLabels: ["ax"],
    },
    {
      id: "b",
      name: "#beta",
      targetLabels: ["b1"],
      contrastLabels: ["bx", "by"],
    },
  ]);
  assert(
    multi.title === "#alpha + #beta",
    "multiple tag titles join with plus (stored hashes left alone)"
  );
  assert(
    multi.entries.length === 2 &&
      multi.entries[0].match === "a1" &&
      multi.entries[0].exclude === "ax" &&
      multi.entries[1].match === "b1" &&
      multi.entries[1].exclude === "bx",
    "each tag contributes its own first match/exclude bullets"
  );
  assert(
    multi.hiddenCount === 2,
    "hidden count spans leftover labels across every tag"
  );

  // Degenerate tag with no labels at all: no bullets, nothing hidden.
  const bare = describeTagFilter([
    { id: "t3", name: "bare", targetLabels: [], contrastLabels: [] },
  ]);
  assert(
    bare.title === "#bare" &&
      bare.entries[0].match === null &&
      bare.entries[0].exclude === null &&
      bare.hiddenCount === 0,
    "a tag with no labels shows no bullets and hides nothing"
  );

  console.log("=== All tag filter display tests passed! ===");
}

runTests();
