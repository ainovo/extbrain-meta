import {
  FREE_BUDGET_USD,
  META_MODEL_COSTS,
  getEffectiveModalPerSec,
  metaCostUsd,
  modalCostUsd,
  parseMetaUsage,
  remainingFreePct,
  resetEffectiveCosts,
  sanitizeCustomCosts,
  setEffectiveCosts,
} from "../server/costs";
import { ModalJobAggregator } from "../server/modalJobs";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function approx(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

function runTests() {
  // Contributor tier: $0.10 in / $0.002 cached / $0.20 out per 1M.
  assert(
    approx(metaCostUsd("muse-spark-1.3-contributor", 1_000_000, 0, 1_000_000), 0.3),
    "contributor 1M in + 1M out costs $0.30"
  );
  assert(
    approx(
      metaCostUsd("muse-spark-1.3-contributor", 1000, 400, 500),
      (600 * 0.1 + 400 * 0.002 + 500 * 0.2) / 1_000_000
    ),
    "cached input tokens bill at the discounted rate"
  );
  assert(
    approx(metaCostUsd("muse-wonder-1.0", 1_000_000, 0, 1_000_000), 24),
    "wonder 1M in + 1M out costs $24"
  );
  assert(
    metaCostUsd("some-future-model", 1000, 0, 1000) === 0,
    "models without a cost-table entry are free"
  );
  assert(
    approx(modalCostUsd(1000), 0.00023),
    "modal bills $0.00023 per second"
  );
  assert(
    modalCostUsd(0) === 0 && modalCostUsd(-5) === 0,
    "non-positive modal durations cost nothing"
  );
  assert(
    "muse-spark-1.3-contributor" in META_MODEL_COSTS,
    "locked cloudrun model has a cost entry"
  );

  const usage = parseMetaUsage({
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 20 },
    },
  });
  assert(
    usage.inputTokens === 100 &&
      usage.cachedInputTokens === 20 &&
      usage.outputTokens === 50,
    "usage parsed from the Meta response, cached split included"
  );
  const empty = parseMetaUsage({});
  assert(
    empty.inputTokens === 0 &&
      empty.cachedInputTokens === 0 &&
      empty.outputTokens === 0,
    "missing usage parses to zeros"
  );

  // Aggregator: chunks accumulate, one row on complete.
  let t = 1_000_000;
  const agg = new ModalJobAggregator(() => t);
  agg.addChunk("job-1", { userId: "u1", kind: "modal-ner", model: "modal", durationMs: 400 });
  t += 1000;
  agg.addChunk("job-1", { userId: "u1", kind: "modal-ner", model: "modal", durationMs: 600 });
  assert(agg.size === 1, "open job held without logging");
  const total = agg.completeJob("job-1");
  assert(
    total !== null && total.totalMs === 1000 && total.chunks === 2,
    "complete logs one aggregate row for the whole job"
  );
  assert(
    agg.completeJob("job-1") === null,
    "double-complete logs nothing (one row per job)"
  );
  assert(agg.size === 0, "completed job removed");

  // Aborted jobs (never completed) log one partial row on expiry.
  const agg2 = new ModalJobAggregator(() => t, 1000);
  agg2.addChunk("job-2", { userId: "u2", kind: "modal-nli", model: "modal", durationMs: 250 });
  assert(agg2.sweepExpired().length === 0, "fresh jobs survive the sweep");
  t += 2000;
  const expired = agg2.sweepExpired();
  assert(
    expired.length === 1 &&
      expired[0].jobId === "job-2" &&
      expired[0].totalMs === 250,
    "expired job logs one partial row, then is dropped"
  );
  assert(agg2.size === 0, "expired jobs removed");

  // Custom rates: validated, applied, and resettable.
  const good = sanitizeCustomCosts({
    rates: {
      "muse-spark-1.3-contributor": {
        inputPer1M: 1,
        cachedInputPer1M: 0.01,
        outputPer1M: 2,
      },
    },
    modalPerSec: 0.001,
  });
  assert(good.ok === true, "valid custom rates pass validation");
  if (good.ok) {
    setEffectiveCosts({ ...META_MODEL_COSTS, ...good.costs.rates }, good.costs.modalPerSec);
    assert(
      approx(metaCostUsd("muse-spark-1.3-contributor", 1_000_000, 0, 0), 1),
      "custom input rate takes effect"
    );
    assert(
      approx(getEffectiveModalPerSec(), 0.001),
      "custom modal rate takes effect"
    );
    resetEffectiveCosts();
    assert(
      approx(metaCostUsd("muse-spark-1.3-contributor", 1_000_000, 0, 0), 0.1),
      "reset restores built-in rates"
    );
    assert(
      approx(modalCostUsd(1000), 0.00023),
      "reset restores the built-in modal rate"
    );
  }
  assert(
    sanitizeCustomCosts({ rates: {}, modalPerSec: 0.001 }).ok === false,
    "empty rates rejected"
  );
  assert(
    sanitizeCustomCosts({
      rates: { "muse-spark-1.3": { inputPer1M: -1, cachedInputPer1M: 0, outputPer1M: 1 } },
      modalPerSec: 0.001,
    }).ok === false,
    "negative rates rejected"
  );
  assert(
    sanitizeCustomCosts({
      rates: { "not-a-model": { inputPer1M: 1, cachedInputPer1M: 1, outputPer1M: 1 } },
      modalPerSec: 0.001,
    }).ok === false,
    "unknown models rejected"
  );
  assert(
    sanitizeCustomCosts({
      rates: { "muse-spark-1.3": { inputPer1M: 1, cachedInputPer1M: 1, outputPer1M: 1 } },
      modalPerSec: "free",
    }).ok === false,
    "non-numeric modal rate rejected"
  );

  // Free-tier meter: 1 - sum(cost) / budget, clamped to 0–100.
  assert(FREE_BUDGET_USD === 200, "free pool is $200");
  assert(remainingFreePct(0) === 100, "untouched pool reads 100%");
  assert(remainingFreePct(100) === 50, "half the pool spent reads 50%");
  assert(remainingFreePct(200) === 0, "exhausted pool reads 0%");
  assert(remainingFreePct(500) === 0, "overspend clamps to 0%");
  assert(remainingFreePct(-5) === 100, "negative total treated as zero");
  assert(remainingFreePct(NaN) === 100, "NaN total treated as zero");
}

runTests();
console.log("All metering cost tests passed.");
