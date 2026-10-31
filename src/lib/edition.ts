import {
  DEFAULT_CONTRIBUTOR_MODEL,
  type ModelEndpointConfig,
  type NerBackendId,
  type NliBackendId,
} from "./types";

/**
 * Locked-model edition (e.g. the Cloud Run bundle): model choices are fixed
 * by the deployment and the Settings pickers render disabled. Enabled at
 * build time via `vite build --mode cloudrun` with a `.env.cloudrun` file:
 *
 *   VITE_LOCK_MODELS=1
 *   VITE_LOCKED_META_MODEL=muse-spark-1.3-contributor
 *   VITE_LOCKED_NER_BACKEND=modal
 *   VITE_LOCKED_NLI_BACKEND=modal
 *
 * The default `vite build` leaves everything unlocked.
 */
/**
 * Read one env flag. The `import.meta.env` accesses stay literal so Vite
 * statically replaces them at build time; the typeof guard keeps this
 * module importable under plain Node/tsx (the dev server shares src/lib,
 * where import.meta.env does not exist). process.env is the Node fallback.
 */
function readEnv(name: string): string | undefined {
  if (typeof import.meta.env !== "undefined") {
    const v = (import.meta.env as Record<string, unknown>)[name];
    if (typeof v === "string") return v;
  }
  if (typeof process !== "undefined" && process.env) {
    const v = process.env[name];
    if (typeof v === "string") return v;
  }
  return undefined;
}

export const MODELS_LOCKED: boolean = (() => {
  const v = readEnv("VITE_LOCK_MODELS");
  return v === "1" || v === "true";
})();

function envOr(fallback: string, ...names: string[]): string {
  for (const name of names) {
    const raw = readEnv(name);
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  }
  return fallback;
}

/** Fixed Meta model id for discovery/synthesis/voice in locked builds. */
export const LOCKED_META_MODEL: string = envOr(
  DEFAULT_CONTRIBUTOR_MODEL,
  "VITE_LOCKED_META_MODEL"
);

function lockedBackend(
  fallback: "local" | "modal",
  ...names: string[]
): "local" | "modal" {
  const v = envOr(fallback, ...names);
  return v === "local" || v === "modal" ? v : fallback;
}

/** Fixed NER backend in locked builds. */
export const LOCKED_NER_BACKEND: NerBackendId = lockedBackend(
  "modal",
  "VITE_LOCKED_NER_BACKEND"
);

/** Fixed NLI backend in locked builds. */
export const LOCKED_NLI_BACKEND: NliBackendId = lockedBackend(
  "modal",
  "VITE_LOCKED_NLI_BACKEND"
);

/** Fixed Meta endpoint for discovery/synthesis/voice in locked builds. */
export function lockedMetaEndpoint(): ModelEndpointConfig {
  return { provider: "meta", model: LOCKED_META_MODEL };
}
