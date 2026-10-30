import {
  VOICE_ENDPOINT_LEVEL_THRESHOLD,
  VOICE_ENDPOINT_MIN_RECORD_MS,
  VOICE_ENDPOINT_SILENCE_MS,
  VoiceEndpointDetector,
} from "../src/lib/voiceAgent";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

function runTests() {
  // Defaults are sane: sub-2s trailing silence, a minimum record window,
  // and a low speech threshold matching the recorder's 0..1 level scale.
  assert(
    VOICE_ENDPOINT_SILENCE_MS >= 1000 &&
      VOICE_ENDPOINT_SILENCE_MS <= 3000 &&
      VOICE_ENDPOINT_MIN_RECORD_MS >= 500 &&
      VOICE_ENDPOINT_LEVEL_THRESHOLD > 0 &&
      VOICE_ENDPOINT_LEVEL_THRESHOLD < 0.5,
    "voice endpoint defaults are sane (silence window, min record, threshold)"
  );

  const LOUD = VOICE_ENDPOINT_LEVEL_THRESHOLD + 0.2;
  const QUIET = Math.max(0, VOICE_ENDPOINT_LEVEL_THRESHOLD - 0.02);

  // Sustained silence after speech ends the turn.
  const d1 = new VoiceEndpointDetector(0);
  assert(!d1.update(LOUD, 100), "speech at t=100ms does not end the turn");
  assert(!d1.update(LOUD, 500), "continued speech does not end the turn");
  assert(
    !d1.update(QUIET, 500 + VOICE_ENDPOINT_SILENCE_MS - 1),
    "a pause just under the silence window does not end the turn"
  );
  assert(
    d1.update(QUIET, 500 + VOICE_ENDPOINT_SILENCE_MS),
    "sustained silence after speech ends the turn"
  );
  assert(
    d1.update(QUIET, 500 + VOICE_ENDPOINT_SILENCE_MS + 5000),
    "endpoint stays detected once hit (sticky)"
  );

  // A mid-sentence pause followed by more speech resets the silence clock.
  const d2 = new VoiceEndpointDetector(0);
  d2.update(LOUD, 100);
  assert(
    !d2.update(QUIET, 100 + VOICE_ENDPOINT_SILENCE_MS - 200),
    "brief mid-sentence pause does not end the turn"
  );
  assert(
    !d2.update(LOUD, 100 + VOICE_ENDPOINT_SILENCE_MS - 100),
    "resumed speech cancels the pending endpoint"
  );
  assert(
    !d2.update(QUIET, 100 + VOICE_ENDPOINT_SILENCE_MS * 2 - 200),
    "silence clock restarts from the resumed speech"
  );
  assert(
    d2.update(QUIET, 100 + VOICE_ENDPOINT_SILENCE_MS * 2 - 100),
    "trailing silence after resumed speech ends the turn"
  );

  // Pure silence with no speech yet never auto-stops (graceful when the
  // mic level tap is unavailable and level() always reads 0).
  const d3 = new VoiceEndpointDetector(0);
  assert(
    !d3.update(QUIET, VOICE_ENDPOINT_SILENCE_MS * 10),
    "leading silence before any speech does not end the turn"
  );
  assert(
    !d3.update(QUIET, 60_000),
    "a full minute of silence with no speech still does not end the turn"
  );

  // The minimum record window guards against instant cutoffs.
  const d4 = new VoiceEndpointDetector(
    0,
    { minRecordMs: 10_000, silenceMs: 100 }
  );
  d4.update(LOUD, 50);
  assert(
    !d4.update(QUIET, 5000),
    "silence past the window but before the min record time does not end the turn"
  );
  assert(
    d4.update(QUIET, 10_000),
    "silence after the min record time ends the turn"
  );

  // At-threshold levels count as speech; reset() restarts cleanly.
  const d5 = new VoiceEndpointDetector(0, { silenceMs: 1000 });
  d5.update(VOICE_ENDPOINT_LEVEL_THRESHOLD, 1600);
  assert(
    !d5.update(QUIET, 1600 + 999),
    "at-threshold input counts as speech and holds the turn open"
  );
  d5.reset(50_000);
  assert(
    !d5.update(QUIET, 50_000 + 5000),
    "reset() clears speech history so old audio cannot end a new turn"
  );

  console.log("=== All voice endpoint tests passed! ===");
}

runTests();
