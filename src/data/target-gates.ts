// AUTO-GENERATED — do not hand-edit. Run `pnpm run extract:target-gates` to regenerate.
//
// Derived from committed src/data (recipes, facilities, items, region raws,
// AIC plans) by `computeTargetGates` — no game-data dir required. See
// scripts/extract-target-gates.ts and src/lib/target-gate-helpers.ts.
//
// item → per factory region (currentDomain), the AIC techs to research
// before it becomes producible there, grouped by plan region and ordered
// earliest-first (by sortId).

import type { ItemId } from "@/types/constants";
import { DomainId } from "@/types/constants";
import type { AicTechId } from "@/types/aic";
import type { TargetGate } from "@/types/target-gates";

export const targetGates: ReadonlyMap<ItemId, TargetGate> = new Map([
  ["item_activity_xiranite_bottle" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_activity_xiranite_cmpt" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_activity_xiranite_enr_bottle" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_activity_xiranite_enr_cmpt" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_activity_xiranite_enr_hulu" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_activity_xiranite_enr_tool" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_activity_xiranite_hulu" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_food_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_food_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_food_3" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_food_4" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_food_5" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_rec_hp_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_rec_hp_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_rec_hp_3" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_rec_hp_4" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_bottled_rec_hp_5" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_carbon_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_carbon_enr_powder" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_carbon_mtl" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_carbon_powder" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_bottle" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_cmpt" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_enr_bottle" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_enr_cmpt" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_enr2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_gas_reactor_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId, "tech_jinlong_4_vaporizer_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_enr2_cmpt" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_gas_reactor_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId, "tech_jinlong_4_vaporizer_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_jar" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_nugget" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_copper_powder" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_crystal_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_crystal_enr_powder" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_equip_script_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_winder_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_equip_script_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_winder_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_winder_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_equip_script_3" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_1_winder_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_equip_script_4" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_1_winder_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_equip_script_4_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_winder_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_equip_script_4_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_1_winder_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_equip_script_4_3" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_1_winder_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_gas_reactor_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId, "tech_jinlong_4_vaporizer_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_filter_core" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_gas_acid" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_gas_copper" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_gas_copper_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_gas_copper_enr2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_gas_reactor_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId, "tech_jinlong_4_vaporizer_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_gas_water" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_gas_xiranite_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_gasjar_copper_gas_acid" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_filling_and_dismantler_mode_2" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_gasjar_copper_gas_copper" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_filling_and_dismantler_mode_2" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_gasjar_copper_gas_copper_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_filling_and_dismantler_mode_2" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_gasjar_copper_gas_copper_enr2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_filling_and_dismantler_mode_2" as AicTechId, "tech_jinlong_4_gas_reactor_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId, "tech_jinlong_4_vaporizer_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_gasjar_copper_gas_inert" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_filling_and_dismantler_mode_2" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_gasjar_copper_gas_water" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_filling_and_dismantler_mode_2" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_gasjar_copper_gas_xiranite" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_filling_and_dismantler_mode_2" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_gasjar_copper_gas_xiranite_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_filling_and_dismantler_mode_2" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_glass_bottle" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_glass_cmpt" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_glass_enr_bottle" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_glass_enr_cmpt" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_iron_bottle" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_iron_cmpt" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_iron_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_iron_enr_bottle" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_iron_enr_cmpt" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_iron_enr_powder" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_liquid_copper" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_liquid_copper_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_liquid_plant_grass_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_liquid_plant_grass_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_liquid_sewage" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_liquid_xiranite" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_liquid_xiranite_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_3_liquid_purifier_1" as AicTechId, "tech_jinlong_4_liquid_purifier_mode_1" as AicTechId, "tech_jinlong_4_shaper_mode_2" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_liquid_xiranite_lowpoly" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_liquid_xiranite_poly" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_muck_xiranite_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_originium_enr_powder" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_bbflower_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_bbflower_powder_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_bbflower_seed_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_grass_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_grass_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_grass_powder_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_grass_powder_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_grass_seed_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_grass_seed_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_3" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_enr_powder_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_enr_powder_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_powder_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_powder_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_powder_3" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_seed_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_seed_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_moss_seed_3" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_sp_seed_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_sp_seed_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_sp_seed_3" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_plant_sp_seed_4" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_proc_battery_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_proc_battery_2" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_proc_battery_3" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_proc_battery_4" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_proc_battery_5" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_proc_bomb_1" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_cmpt_1" as AicTechId, "tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_asm_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_quartz_enr" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_quartz_enr_powder" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_1, planRegions: [
        { domainId: DomainId.DOMAIN_1, techIds: ["tech_tundra_1_shaper_1" as AicTechId, "tech_tundra_2_filling_1" as AicTechId, "tech_tundra_2_plant_1" as AicTechId, "tech_tundra_3_thickener_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_xiranite_enr_powder" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
  ["item_xiranite_poly" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_1_planter_mode_1" as AicTechId, "tech_jinlong_2_furnance_mode_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId] },
      ] },
    ],
  }],
  ["item_xiranite_powder" as ItemId, {
    factories: [
      { factoryDomainId: DomainId.DOMAIN_2, planRegions: [
        { domainId: DomainId.DOMAIN_2, techIds: ["tech_jinlong_1_filling_mode_1" as AicTechId, "tech_jinlong_1_mix_1" as AicTechId, "tech_jinlong_4_transmuter_1" as AicTechId, "tech_jinlong_4_transmuter_2" as AicTechId] },
      ] },
    ],
  }],
]);
