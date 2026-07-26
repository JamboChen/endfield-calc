/**
 * The saved-plan file format (`production-plan.json`) and its conversion
 * to and from the in-app plan state.
 *
 * A **versioned wire format**, deliberately independent of the internal
 * types: fields are optional where older files omit them, and each
 * carries the default the loader must apply. Coupling it to
 * `PlanHashState` would make an internal rename a file-compat break.
 *
 * Everything here is pure, so the load path — including its handling of
 * files that are damaged, hand-edited or from another version — is
 * testable without a DOM (`plan-file.test.ts`).
 */

import type { ProductionTarget } from "@/components/panels/TargetItemsGrid";
import {
  DEFAULT_PLAN_OPTIONS,
  type PlanOptions,
} from "@/lib/plan-options-storage";
import {
  sanitizePersistedShape,
  type PersistedShape,
} from "@/lib/persisted-shape";
import type { PlanHashState } from "@/lib/plan-url";
import { sanitizeMachinesPerVaporizer } from "@/lib/sustain-constants";
import { decodeItemRef, decodeRecipeRef } from "@/lib/url-codes";
import type { ItemId, RecipeId } from "@/types";

export interface SavedPlan {
  version: string;
  /** `locked` is optional/additive: legacy saves omit it (= unlocked). */
  targets: { itemId: string; rate: number; locked?: boolean }[];
  recipeOverrides: Record<string, string>;
  manualRawMaterials: string[];
  ceilMode: boolean;
  /**
   * Optional. When absent (legacy saves predating bin-fusion), the
   * loader defaults to `true` (bin-fusion on) — matching the
   * `parseHash` default.
   */
  binFusion?: boolean;
  /**
   * Optional. Self-sustaining power (Thermal Bank battery burning).
   * When absent (legacy saves), defaults to `false` — matching the
   * `parseHash` default.
   */
  powerSustain?: boolean;
  /**
   * Optional. Gas-environment coverage ratio (1.4): how many env-gated
   * machines one Gas Dispersing Unit's 13×13 aura covers. When absent,
   * defaults to `DEFAULT_MACHINES_PER_VAPORIZER` — matching the
   * `parseHash` default.
   */
  machinesPerVaporizer?: number;
  /**
   * Optional. The author's domain/user settings snapshot (region, AIC
   * research, facility/raw caps, structures, metastorage routes), so the
   * saved plan reproduces exactly as authored. When absent (legacy
   * saves), the plan loads against the opener's own settings. When
   * present + different, opening enters read-only shared-view (same as a
   * shared URL).
   */
  settings?: PersistedShape;
}

/** Serialize the live plan state into the file format. */
export function buildSavedPlan(
  state: PlanHashState,
  settings: PersistedShape,
): SavedPlan {
  return {
    version: "1",
    targets: state.targets.map((t) => ({
      itemId: t.itemId,
      rate: t.rate,
      ...(t.locked ? { locked: true } : {}),
    })),
    recipeOverrides: Object.fromEntries(state.recipeOverrides),
    manualRawMaterials: Array.from(state.manualRawMaterials),
    ceilMode: state.ceilMode,
    binFusion: state.binFusion,
    powerSustain: state.powerSustain,
    ...(state.machinesPerVaporizer !== DEFAULT_PLAN_OPTIONS.machinesPerVaporizer
      ? { machinesPerVaporizer: state.machinesPerVaporizer }
      : {}),
    settings,
  };
}

/** Read the option block, applying each field's documented default. */
function readOptions(data: SavedPlan): PlanOptions {
  return {
    ceilMode: data.ceilMode ?? DEFAULT_PLAN_OPTIONS.ceilMode,
    binFusion: data.binFusion ?? DEFAULT_PLAN_OPTIONS.binFusion,
    powerSustain: data.powerSustain ?? DEFAULT_PLAN_OPTIONS.powerSustain,
    machinesPerVaporizer: sanitizeMachinesPerVaporizer(
      data.machinesPerVaporizer ?? DEFAULT_PLAN_OPTIONS.machinesPerVaporizer,
    ),
  };
}

/**
 * Convert a parsed file into plan state, resolving every id against the
 * live game data.
 *
 * Ids arrive as plain strings and are threaded through the same decoders
 * the URL uses, so a stale or hand-edited file drops the unknown entries
 * here — rather than carrying them further and having them vanish later
 * for reasons the user can't see.
 */
export function savedPlanToHashState(data: SavedPlan): PlanHashState {
  const targets: ProductionTarget[] = [];
  for (const t of data.targets ?? []) {
    const itemId = decodeItemRef(t.itemId);
    if (!itemId || !Number.isFinite(t.rate) || t.rate < 0) continue;
    targets.push(
      t.locked === true
        ? { itemId, rate: t.rate, locked: true }
        : { itemId, rate: t.rate },
    );
  }

  const recipeOverrides = new Map<ItemId, RecipeId>();
  for (const [rawItem, rawRecipe] of Object.entries(
    data.recipeOverrides ?? {},
  )) {
    const itemId = decodeItemRef(rawItem);
    const recipeId = decodeRecipeRef(rawRecipe);
    if (itemId && recipeId) recipeOverrides.set(itemId, recipeId);
  }

  const manualRawMaterials = new Set<ItemId>();
  for (const raw of data.manualRawMaterials ?? []) {
    const itemId = decodeItemRef(raw);
    if (itemId) manualRawMaterials.add(itemId);
  }

  return { targets, recipeOverrides, manualRawMaterials, ...readOptions(data) };
}

/**
 * The file's embedded settings snapshot, or `null` when it has none or
 * the block doesn't survive validation.
 *
 * Damaged settings must read as ABSENT, not as defaults. The default
 * shape is the pre-onboarding world (every non-pinned domain inactive),
 * so treating a corrupt block as "valid, all default" would drop the
 * opener into read-only shared-view against a crippled region set — for
 * a file that is very likely their own. Absent means "load against the
 * opener's own settings", which is the honest outcome.
 */
export function readSavedSettings(data: SavedPlan): PersistedShape | null {
  return data.settings ? sanitizePersistedShape(data.settings) : null;
}
