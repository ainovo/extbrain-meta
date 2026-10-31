/**
 * Locked-edition (Cloud Run) export/import contract. Run with the locked
 * env, mirroring `.env.cloudrun`:
 *
 *   VITE_LOCK_MODELS=1 VITE_LOCKED_META_MODEL=muse-spark-1.3-contributor \
 *     VITE_LOCKED_NER_BACKEND=modal VITE_LOCKED_NLI_BACKEND=modal \
 *     tsx tests/test_locked_edition.ts
 *
 * The Settings page disables the model pickers, backend pickers, and the
 * metering toggle in locked builds; this suite pins that the export zip
 * omits those deployment-fixed settings (but keeps the portable ones) and
 * that importing an unlocked backup can never drift a locked client off
 * its fixed values.
 */
import JSZip from "jszip";
import {
  buildExportZip,
  normalizeModelConfig,
  parseExportZip,
  restoreBackup,
  type ExportPayload,
} from "../src/lib/exportData";
import {
  LOCKED_NER_BACKEND,
  LOCKED_NLI_BACKEND,
  LOCKED_META_MODEL,
  MODELS_LOCKED,
  lockedMetaEndpoint,
} from "../src/lib/edition";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  } else {
    console.log(`✅ ${message}`);
  }
}

const FIXED_KEYS = [
  "discovery",
  "synthesis",
  "voice",
  "nerBackend",
  "nliBackend",
];

function unlockedFixture(): ExportPayload {
  return {
    userid: "u-locked",
    exportedAt: new Date().toISOString(),
    histories: [],
    fileNames: [],
    summaries: [],
    tags: [],
    entities: {},
    categories: {},
    taxonomy: { removed: [], added: [] },
    templates: [],
    modelConfig: {
      useSameModel: true,
      discovery: { provider: "meta", model: "muse-spark-1.3" },
      synthesis: { provider: "meta", model: "muse-wonder-1.0" },
      voice: { provider: "meta", model: "muse-spark-1.3" },
      maxTokensPerSynthesisBatch: 1000000,
      zeroShotThreshold: 0.4,
      mentionMinChats: 4,
      nerBackend: "local",
      nliBackend: "local",
    },
  };
}

async function runTests() {
  assert(MODELS_LOCKED === true, "suite runs in the locked edition");
  assert(
    LOCKED_NER_BACKEND === "modal" && LOCKED_NLI_BACKEND === "modal",
    "locked backends are the modal deployment"
  );

  const blob = await buildExportZip(unlockedFixture());
  const zip = await JSZip.loadAsync(blob);
  const exported = JSON.parse(
    (await zip.file("model-config.json")?.async("string")) ?? "{}"
  );
  assert(
    FIXED_KEYS.every((k) => !(k in exported)),
    "locked export omits deployment-fixed settings (models + backends)"
  );
  assert(
    exported.maxTokensPerSynthesisBatch === 1000000 &&
      exported.zeroShotThreshold === 0.4 &&
      exported.mentionMinChats === 4,
    "locked export keeps portable settings (batch limit, thresholds)"
  );

  // An unlocked backup (with model picks) imported on a locked client.
  const parsed = await parseExportZip(blob);
  assert(
    parsed.modelConfig.discovery.model === LOCKED_META_MODEL &&
      parsed.modelConfig.synthesis.model === LOCKED_META_MODEL &&
      parsed.modelConfig.voice.model === LOCKED_META_MODEL &&
      parsed.modelConfig.nerBackend === LOCKED_NER_BACKEND &&
      parsed.modelConfig.nliBackend === LOCKED_NLI_BACKEND,
    "parseExportZip clamps imported settings to the locked values"
  );
  assert(
    parsed.modelConfig.maxTokensPerSynthesisBatch === 1000000 &&
      parsed.modelConfig.mentionMinChats === 4,
    "parseExportZip preserves portable settings on locked clients"
  );

  const direct = normalizeModelConfig({
    discovery: { provider: "meta", model: "muse-wonder-1.0" },
    nerBackend: "local",
    nliBackend: "local",
  });
  assert(
    direct.discovery.model === lockedMetaEndpoint().model &&
      direct.nerBackend === LOCKED_NER_BACKEND &&
      direct.nliBackend === LOCKED_NLI_BACKEND,
    "normalizeModelConfig pins fixed settings on locked clients"
  );

  const memStore = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => (memStore.has(k) ? memStore.get(k)! : null),
    setItem: (k: string, v: string) => {
      memStore.set(k, String(v));
    },
    removeItem: (k: string) => {
      memStore.delete(k);
    },
  };
  try {
    const restored = await restoreBackup("u-locked", parsed);
    assert(
      restored.modelConfig.discovery.model === LOCKED_META_MODEL &&
        restored.modelConfig.nerBackend === LOCKED_NER_BACKEND &&
        restored.modelConfig.nliBackend === LOCKED_NLI_BACKEND,
      "restoreBackup keeps locked values when applying an unlocked backup"
    );
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }

  console.log("=== All locked edition tests passed! ===");
}

void runTests();
