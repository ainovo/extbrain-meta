import { shouldAutoStartProcessing } from "../src/lib/processRunner";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

const ready = {
  hasChats: true,
  active: false,
  userStopped: false,
  serverReady: true,
  blocked: false,
  queuesReady: true,
  pendingCount: 3,
  alreadyStarted: false,
};

function runTests() {
  assert(
    shouldAutoStartProcessing(ready) === true,
    "fresh import with pending work auto-starts"
  );
  assert(
    shouldAutoStartProcessing({ ...ready, hasChats: false }) === false,
    "mount-time dataset never auto-starts"
  );
  assert(
    shouldAutoStartProcessing({ ...ready, active: true }) === false,
    "running job does not auto-start again"
  );
  assert(
    shouldAutoStartProcessing({ ...ready, userStopped: true }) === false,
    "manual stop opts out until the next import"
  );
  assert(
    shouldAutoStartProcessing({ ...ready, serverReady: false }) === false,
    "waits for the backend version before starting"
  );
  assert(
    shouldAutoStartProcessing({ ...ready, blocked: true }) === false,
    "blocked modal backend holds the auto-start"
  );
  assert(
    shouldAutoStartProcessing({ ...ready, queuesReady: false }) === false,
    "waits for pending queues to resolve"
  );
  assert(
    shouldAutoStartProcessing({ ...ready, pendingCount: 0 }) === false,
    "nothing pending means nothing to start"
  );
  assert(
    shouldAutoStartProcessing({ ...ready, alreadyStarted: true }) === false,
    "each dataset auto-starts at most once"
  );
}

runTests();
console.log("All auto-start tests passed.");
