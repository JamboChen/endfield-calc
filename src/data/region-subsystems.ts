// AUTO-GENERATED — do not hand-edit. Run `pnpm run extract:structures` to regenerate.
//
// Region subsystems: map-placed structures that wire into the factory but
// aren't roster/AIC buildings, plus the collapsed capped facility and the
// recipe variants they toggle. Derived from the upstream game-data dump.
// Structure display names live in `public/locales/{lang}/structure.json`.

import type { Facility, Recipe } from "@/types";
import type { RegionStructure } from "@/types/structures";
import {
  DomainId,
  FacilityId,
  ItemId,
  RecipeId,
  RegionStructureId,
} from "@/types/constants";
import { facilityIconUrl, isMonochromeFacilityIcon } from "@/lib/facility-icons";

export const regionFacilities: Facility[] = [
  {
    id: FacilityId.LIQUID_CLEAN_GATE_1,
    tier: 1,
    category: 37,
    powerConsumption: 0,
    footprint: { width: 10, depth: 3 },
    buffersIn: { belt: [], pipe: [{ ports: 1 }] },
    buffersOut: { belt: [], pipe: [{ ports: 1 }] },
    domains: [DomainId.DOMAIN_2],
  },
];

// Icon URLs + the monochrome-glyph flag flow through the shared
// `facility-icons` helpers so structure-port glyphs (e.g.
// `liquid_clean_gate_1`) get `invert dark:invert-0` styling like the
// auto-generated roster facilities do.
regionFacilities.forEach((f) => {
  f.iconUrl = facilityIconUrl(f.id);
  f.iconIsMonochrome = isMonochromeFacilityIcon(f.id);
});

export const regionRecipes: Recipe[] = [
  {
    id: RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL,
    inputs: [{ itemId: ItemId.ITEM_LIQUID_SEWAGE, amount: 1 }],
    outputs: [],
    facilityId: FacilityId.LIQUID_CLEAN_GATE_1,
    craftingTime: 0.5,
  },
  {
    id: RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT,
    inputs: [{ itemId: ItemId.ITEM_LIQUID_SEWAGE, amount: 30 }],
    outputs: [{ itemId: ItemId.ITEM_LIQUID_XIRANITE_POLY, amount: 1 }],
    facilityId: FacilityId.LIQUID_CLEAN_GATE_1,
    craftingTime: 15,
  },
];

export const regionFacilityVariants: ReadonlyMap<
  FacilityId,
  { readonly default: RecipeId; readonly toggled: RecipeId }
> = new Map([
  [
    FacilityId.LIQUID_CLEAN_GATE_1,
    {
      default: RecipeId.LIQUID_CLEAN_GATE_1_DISPOSAL,
      toggled: RecipeId.LIQUID_CLEAN_GATE_1_BYPRODUCT,
    },
  ],
]);

export const regionStructures: ReadonlyMap<
  DomainId,
  readonly RegionStructure[]
> = new Map([
  [
    DomainId.DOMAIN_2,
    [
      {
        id: RegionStructureId.LIQUID_CLEAN_GATE_1,
        domainId: DomainId.DOMAIN_2,
        nodeId: "liquidcleanfactory_005_1",
        index: 1,
        iconSlug: "liquid_clean_gate_1",
        solver: { role: "instance", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 },
      },
      {
        id: RegionStructureId.LIQUID_CLEAN_GATE_2,
        domainId: DomainId.DOMAIN_2,
        nodeId: "liquidcleanfactory_005_1",
        requires: RegionStructureId.LIQUID_CLEAN_GATE_1,
        index: 2,
        iconSlug: "liquid_clean_gate_1",
        solver: { role: "instance", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 },
      },
      {
        id: RegionStructureId.LIQUID_CLEAN_GATE_3,
        domainId: DomainId.DOMAIN_2,
        nodeId: "liquidcleanfactory_005_1",
        requires: RegionStructureId.LIQUID_CLEAN_GATE_2,
        index: 3,
        iconSlug: "liquid_clean_gate_1",
        solver: { role: "instance", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 },
      },
      {
        id: RegionStructureId.LIQUID_RECYCLE_GATE_1,
        domainId: DomainId.DOMAIN_2,
        nodeId: "liquidcleanfactory_005_1",
        requires: RegionStructureId.LIQUID_CLEAN_GATE_3,
        iconSlug: "liquid_recycle_gate_1",
        solver: { role: "recipeToggle", facilityId: FacilityId.LIQUID_CLEAN_GATE_1 },
      },
    ],
  ],
]);
