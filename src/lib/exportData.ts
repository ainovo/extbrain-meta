import JSZip from "jszip";
import {
  DEFAULT_MAX_TOKENS_PER_BATCH,
  DEFAULT_META_MODEL,
  DualModelConfig,
  isMetaModelId,
  MAX_MODEL_CONTEXT_TOKENS,
  ModelEndpointConfig,
  ParsedActivityItem,
  PromptTemplate,
} from "./types";
import { loadHistories, saveHistories } from "./storage";
import {
  SavedSummary,
  loadSavedSummaries,
  replaceSavedSummaries,
} from "./savedSummaries";
import { TagDef, loadTags, saveTags } from "./tags";
import { ChatEntityMap, loadChatEntities, saveChatEntities } from "./entities";
import {
  TaxonomyEdits,
  ThreadCategoryMap,
  effectiveTaxonomy,
  loadTaxonomyEdits,
  loadThreadCategories,
  normalizeTaxonomyEdits,
  normalizeThreadCategoryMap,
  saveTaxonomyEdits,
  saveThreadCategories,
} from "./categoryTags";
import {
  loadCustomThreadTemplates,
  replaceCustomThreadTemplates,
} from "./promptTemplates";

export interface ExportPayload {
  userid: string;
  exportedAt: string;
  histories: unknown[];
  fileNames: string[];
  summaries: SavedSummary[];
  tags: TagDef[];
  entities: ChatEntityMap;
  categories: ThreadCategoryMap;
  taxonomy: TaxonomyEdits;
  templates: PromptTemplate[];
  modelConfig: DualModelConfig;
}

/** Download name for a full data export. */
export function exportFileName(uuid: string): string {
  return `extbrain_${uuid}.zip`;
}

/**
 * Everything the app persists: histories (IndexedDB), summaries, tags and
 * entities (per-user localStorage), plus global custom templates. Model
 * config comes from the caller (same object it persists).
 */
export async function collectExportPayload(
  uuid: string,
  modelConfig: DualModelConfig
): Promise<ExportPayload> {
  const stored = await loadHistories(uuid);
  let histories: unknown[] = [];
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored.itemsJson);
      histories = Array.isArray(parsed) ? parsed : [];
    } catch {
      histories = [];
    }
  }
  return {
    userid: uuid,
    exportedAt: new Date().toISOString(),
    histories,
    fileNames: stored?.fileNames ?? [],
    summaries: loadSavedSummaries(uuid),
    tags: loadTags(uuid),
    entities: loadChatEntities(uuid),
    categories: loadThreadCategories(uuid),
    taxonomy: loadTaxonomyEdits(uuid),
    templates: loadCustomThreadTemplates(),
    modelConfig,
  };
}

/** Payload serialized as a zip of pretty-printed JSON files + manifest. */
export async function buildExportZip(payload: ExportPayload): Promise<Blob> {
  const zip = new JSZip();
  const dump = (v: unknown): string => JSON.stringify(v, null, 2);
  zip.file("histories.json", dump(payload.histories));
  zip.file("summaries.json", dump(payload.summaries));
  zip.file("tags.json", dump(payload.tags));
  zip.file("entities.json", dump(payload.entities));
  // Thread-keyed verdicts (per-chat categories.json from older builds is
  // obsolete and intentionally unread).
  zip.file("thread-categories.json", dump(payload.categories));
  zip.file("thread-taxonomy.json", dump(payload.taxonomy));
  zip.file("custom-templates.json", dump(payload.templates));
  // No secrets live in the model config (the key stays in the server
  // .env), so it exports as-is.
  zip.file("model-config.json", dump(payload.modelConfig));
  zip.file(
    "manifest.json",
    dump({
      app: "extbrain",
      userid: payload.userid,
      exportedAt: payload.exportedAt,
      fileNames: payload.fileNames,
      counts: {
        histories: payload.histories.length,
        summaries: payload.summaries.length,
        tags: payload.tags.length,
        entities: Object.keys(payload.entities).length,
        categories: Object.keys(payload.categories).length,
        taxonomy: effectiveTaxonomy(payload.taxonomy).length,
        templates: payload.templates.length,
      },
    })
  );
  return zip.generateAsync({ type: "blob" });
}

/** Collects and zips one user's full persisted state. */
export async function exportUserDataZip(
  uuid: string,
  modelConfig: DualModelConfig
): Promise<Blob> {
  return buildExportZip(await collectExportPayload(uuid, modelConfig));
}

export interface BackupManifest {
  app: string;
  userid: string;
  exportedAt: string;
  fileNames: string[];
}

export interface ParsedBackup {
  manifest: BackupManifest;
  histories: ParsedActivityItem[];
  /**
   * Verbatim histories.json when every entry validated (store it directly
   * instead of re-serializing); null when entries were dropped.
   */
  historiesJson: string | null;
  summaries: SavedSummary[];
  tags: TagDef[];
  entities: ChatEntityMap;
  categories: ThreadCategoryMap;
  taxonomy: TaxonomyEdits;
  templates: PromptTemplate[];
  modelConfig: DualModelConfig;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeEndpoint(raw: unknown): ModelEndpointConfig {
  const r = isRecord(raw) ? raw : {};
  return {
    provider: "meta",
    // Legacy provider/model IDs (and any stored key material) fail closed
    // to the default Meta model.
    model: isMetaModelId(r.model) ? r.model : DEFAULT_META_MODEL,
  };
}

/**
 * Validates a stored model config; also migrates pre-Meta configs
 * (browser localStorage and old backups) to Meta-only endpoints.
 */
export function normalizeModelConfig(raw: unknown): DualModelConfig {
  const r = isRecord(raw) ? raw : {};
  // The pre-1M default (45000) also migrates up: it meant "default"
  // whenever it was stored, and the 1M window makes batching rare.
  const LEGACY_DEFAULT_BATCH_TOKENS = 45000;
  const maxTokens =
    typeof r.maxTokensPerSynthesisBatch === "number" &&
    r.maxTokensPerSynthesisBatch > 0 &&
    r.maxTokensPerSynthesisBatch !== LEGACY_DEFAULT_BATCH_TOKENS
      ? Math.min(r.maxTokensPerSynthesisBatch, MAX_MODEL_CONTEXT_TOKENS)
      : DEFAULT_MAX_TOKENS_PER_BATCH;
  const threshold =
    typeof r.zeroShotThreshold === "number" &&
    r.zeroShotThreshold >= 0 &&
    r.zeroShotThreshold <= 1
      ? r.zeroShotThreshold
      : 0.4;
  const nerFloor =
    typeof r.nerScoreFloor === "number" && r.nerScoreFloor >= 0
      ? r.nerScoreFloor
      : undefined;
  return {
    useSameModel: r.useSameModel !== false,
    discovery: normalizeEndpoint(r.discovery),
    synthesis: normalizeEndpoint(r.synthesis),
    voice: normalizeEndpoint(r.voice),
    maxTokensPerSynthesisBatch: maxTokens,
    zeroShotThreshold: threshold,
    ...(nerFloor !== undefined ? { nerScoreFloor: nerFloor } : {}),
    nerBackend: r.nerBackend === "modal-gliner" ? "modal-gliner" : "local",
    nliBackend: r.nliBackend === "modal-tbd" ? "modal-tbd" : "local",
    mentionMinChats:
      typeof r.mentionMinChats === "number" && Number.isFinite(r.mentionMinChats)
        ? Math.min(Math.max(Math.round(r.mentionMinChats), 1), 50)
        : 4,
  };
}

/**
 * Validates an ExtBrain backup zip into restorable stores. Every file our
 * exporter writes is required (a partial zip must never wipe a store), and
 * malformed entries are dropped per store.
 */
export async function parseExportZip(data: Blob | ArrayBuffer): Promise<ParsedBackup> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error("This doesn't look like a zip file.");
  }
  const read = async (name: string): Promise<unknown> => {
    const file = zip.file(name);
    if (!file) throw new Error(`Backup is missing "${name}".`);
    try {
      return JSON.parse(await file.async("string"));
    } catch {
      throw new Error(`"${name}" is not valid JSON.`);
    }
  };
  const readRaw = async (name: string): Promise<string> => {
    const file = zip.file(name);
    if (!file) throw new Error(`Backup is missing "${name}".`);
    return file.async("string");
  };
  const manifest = (await read("manifest.json")) as BackupManifest;
  if (!isRecord(manifest) || manifest.app !== "extbrain") {
    throw new Error("Not an ExtBrain backup (missing or invalid manifest).");
  }
  const asArray = async (name: string): Promise<unknown[]> => {
    const v = await read(name);
    return Array.isArray(v) ? v : [];
  };
  const historiesRaw = await readRaw("histories.json");
  let historiesAll: unknown[] = [];
  let historiesIsArray = false;
  try {
    const parsed: unknown = JSON.parse(historiesRaw);
    historiesIsArray = Array.isArray(parsed);
    historiesAll = historiesIsArray ? (parsed as unknown[]) : [];
  } catch {
    throw new Error('"histories.json" is not valid JSON.');
  }
  const histories = historiesAll.filter(
    (it): it is ParsedActivityItem =>
      isRecord(it) &&
      typeof it.id === "string" &&
      Array.isArray(it.turns)
  );
  const summaries = (await asArray("summaries.json")).filter(
    (s): s is SavedSummary =>
      isRecord(s) &&
      typeof s.id === "string" &&
      typeof s.markdown === "string" &&
      typeof s.templateId === "string"
  );
  const tags = (await asArray("tags.json")).filter(
    (t): t is TagDef => isRecord(t) && typeof t.id === "string"
  );
  const entitiesRaw = await read("entities.json");
  const entities: ChatEntityMap = isRecord(entitiesRaw)
    ? (entitiesRaw as ChatEntityMap)
    : {};
  // Missing in pre-category backups: normalize to an empty map (a rescore
  // run refills it) instead of failing the restore.
  const categories = normalizeThreadCategoryMap(await read("thread-categories.json"));
  // Missing in pre-taxonomy backups: default to unedited built-ins.
  let taxonomy: TaxonomyEdits = { removed: [], added: [] };
  try {
    taxonomy = normalizeTaxonomyEdits(await read("thread-taxonomy.json"));
  } catch {
    // optional file: old backups restore fine without it
  }
  const templates = (await asArray("custom-templates.json")).filter(
    (t): t is PromptTemplate =>
      isRecord(t) &&
      typeof t.id === "string" &&
      typeof t.name === "string" &&
      typeof t.systemInstruction === "string"
  );
  return {
    manifest: {
      app: "extbrain",
      userid: typeof manifest.userid === "string" ? manifest.userid : "",
      exportedAt:
        typeof manifest.exportedAt === "string" ? manifest.exportedAt : "",
      fileNames: Array.isArray(manifest.fileNames)
        ? manifest.fileNames.filter((f): f is string => typeof f === "string")
        : [],
    },
    histories,
    historiesJson:
      historiesIsArray && histories.length === historiesAll.length
        ? historiesRaw
        : null,
    summaries,
    tags,
    entities,
    categories,
    taxonomy,
    templates,
    modelConfig: normalizeModelConfig(await read("model-config.json")),
  };
}

export interface RestoreResult {
  items: ParsedActivityItem[];
  tags: TagDef[];
  entities: ChatEntityMap;
  categories: ThreadCategoryMap;
  taxonomy: TaxonomyEdits;
  modelConfig: DualModelConfig;
}

/**
 * Writes a parsed backup over one user's stores (full replace). The
 * validated histories JSON is stored verbatim (no re-serialize). The model
 * config carries no secrets, so the backup's takes effect directly.
 * Callers refresh React state from the result.
 */
export async function restoreBackup(
  uuid: string,
  backup: ParsedBackup,
  onStage?: (stage: string) => void
): Promise<RestoreResult> {
  const modelConfig: DualModelConfig = backup.modelConfig;
  onStage?.("Saving chats…");
  await saveHistories(
    uuid,
    backup.histories,
    backup.manifest.fileNames,
    (done, total) => onStage?.(`Saving chats… (${done}/${total})`)
  );
  onStage?.("Saving summaries, tags, and settings…");
  replaceSavedSummaries(uuid, backup.summaries);
  saveTags(uuid, backup.tags);
  saveChatEntities(uuid, backup.entities);
  saveThreadCategories(uuid, backup.categories);
  saveTaxonomyEdits(uuid, backup.taxonomy);
  replaceCustomThreadTemplates(backup.templates);
  return {
    items: backup.histories,
    tags: backup.tags,
    entities: backup.entities,
    categories: backup.categories,
    taxonomy: backup.taxonomy,
    modelConfig,
  };
}
