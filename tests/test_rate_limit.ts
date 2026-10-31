import {
  createRateLimiter,
  isAdminAuthorized,
  isMeteringEnforced,
  isModelAllowed,
  parseAllowedModels,
  parseAllowedOrigins,
} from "../server/security";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function fakeReq(ip: string): any {
  return { ip };
}

function fakeRes(): any {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
}

function runTests() {
  assert(
    parseAllowedOrigins({} as any) === null,
    "unset CORS_ORIGINS means allow-all (local dev)"
  );
  assert(
    parseAllowedOrigins({ CORS_ORIGINS: "  " } as any) === null,
    "blank CORS_ORIGINS means allow-all"
  );
  const listed = parseAllowedOrigins({
    CORS_ORIGINS: "https://app.extbrain.ai, https://admin.extbrain.ai ",
  } as any);
  assert(
    listed !== null &&
      listed.length === 2 &&
      listed[0] === "https://app.extbrain.ai" &&
      listed[1] === "https://admin.extbrain.ai",
    "CORS_ORIGINS parses to a trimmed origin list"
  );

  let t = 1_000_000;
  const limit = createRateLimiter({
    windowMs: 60_000,
    max: 2,
    now: () => t,
  });
  const results: Array<{ code: number; next: boolean }> = [];
  for (let i = 0; i < 3; i++) {
    const res = fakeRes();
    let next = false;
    limit(fakeReq("1.2.3.4"), res, () => {
      next = true;
    });
    results.push({ code: res.statusCode, next });
  }
  assert(
    results[0].next && results[1].next && !results[2].next,
    "first max requests pass, the next is rejected"
  );
  assert(
    results[2].code === 429,
    "rejected request gets a 429 status"
  );

  // A different IP gets its own budget.
  const other = fakeRes();
  let otherNext = false;
  limit(fakeReq("5.6.7.8"), other, () => {
    otherNext = true;
  });
  assert(otherNext, "rate limit budget is per client IP");

  // The window rolling over resets the budget.
  t += 60_001;
  const after = fakeRes();
  let afterNext = false;
  limit(fakeReq("1.2.3.4"), after, () => {
    afterNext = true;
  });
  assert(afterNext, "budget resets after the window elapses");

  // Model allowlist: unset means open, set means exact match (case-insensitive).
  assert(
    parseAllowedModels({} as any) === null,
    "unset allowlist means no restriction"
  );
  assert(
    parseAllowedModels({ ALLOWED_META_MODELS: "  " } as any) === null,
    "blank allowlist means no restriction"
  );
  const allowed = parseAllowedModels({
    ALLOWED_META_MODELS: "muse-spark-1.3-contributor, muse-wonder-1.0",
  } as any);
  assert(
    allowed !== null && allowed.length === 2,
    "allowlist parses to normalized ids"
  );
  assert(
    allowed !== null &&
      isModelAllowed("muse-spark-1.3-contributor", allowed) &&
      isModelAllowed("MUSE-SPARK-1.3-CONTRIBUTOR", allowed),
    "listed models pass (case-insensitive)"
  );
  assert(
    allowed !== null && !isModelAllowed("muse-spark-1.3", allowed),
    "unlisted models are rejected when the list is set"
  );
  assert(
    allowed !== null && !isModelAllowed("", allowed),
    "empty model id rejected when the list is set"
  );
  assert(
    isModelAllowed("anything", null) === true,
    "no allowlist allows everything (local dev)"
  );

  // Admin gate: open without a key, strict with one.
  assert(
    isAdminAuthorized("anything", "") === true,
    "cost writes open when ADMIN_API_KEY unset"
  );
  assert(
    isAdminAuthorized("s3cret", "s3cret") === true,
    "correct admin key authorized"
  );
  assert(
    isAdminAuthorized("wrong", "s3cret") === false,
    "wrong admin key rejected"
  );
  assert(
    isAdminAuthorized(undefined, "s3cret") === false,
    "missing admin key rejected when configured"
  );

  // Metering enforcement.
  assert(
    isMeteringEnforced({} as any) === false,
    "metering opt-out honored by default"
  );
  assert(
    isMeteringEnforced({ METERING_ENFORCED: "1" } as any) === true,
    "METERING_ENFORCED=1 ignores opt-out"
  );
}

runTests();
console.log("All rate limit tests passed.");
