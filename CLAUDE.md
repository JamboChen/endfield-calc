# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Endfield Calc is a production chain calculator for "Arknights: Endfield" — a single-page React + TypeScript app that computes resource requirements, production ratios, and facility needs for potentially circular production loops. Deployed to GitHub Pages at `/endfield-calc/`.

## Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Start dev server
pnpm build            # Type-check (tsc -b) then Vite build
pnpm lint             # ESLint
pnpm test             # Vitest (run all tests)
pnpm knip             # Detect unused code/exports
```

Tests are in `src/tests/lib/`. Run a single test file with:
```bash
pnpm vitest run src/tests/lib/calculator.test.ts
```

## Architecture

### Core Algorithm (`src/lib/calculator.ts`)

The central piece of the codebase. Implements a graph-based production planner.

**Pipeline** (`calculateProductionPlan`, outer loop runs up to 100 iterations for backtracking):

1. **Build bipartite graph** (`buildBipartiteGraph`) — DFS from each target. Items + recipes as two node types. For each item pick one recipe via `selectRecipe` heuristic: prefer single-output recipes, prefer non-circular (not consuming `visitedPath`), else first. Respects `recipeOverrides` (user-pinned) and `recipeConstraints` (backtrack exclusions). Forced raw materials (`forcedRawMaterials` + `manualRawMaterials`) terminate recursion. Byproducts added to graph as non-raw nodes but NOT marked visited — lets them be re-discovered with external producers.

2. **SCC detection** (`detectSCCs`) — Tarjan on bipartite graph. Successors: item → consuming recipes, recipe → output items. Each SCC captures items, recipes, and `externalInputs` (inputs from recipes outside SCC).

3. **Condensed DAG + topo sort** (`buildCondensedDAGAndSort`) — collapse each SCC into one super-node. Kahn's algorithm topologically orders.

4. **Flow calculation** (`calculateFlows`, reverse topo order so consumers processed before producers):
   - **Plain recipe node**: facility count = max over outputs of `demand / ratePerFacility`. Propagate input demand `= calcRate(input.amount, craftingTime) * facilityCount` to `itemDemands`.
   - **SCC node**: delegate to `solveSCCFlow`. If fails, record in `invalidSCCs`.

5. **SCC solver** (`solveSCCFlow`, 5 phases):
   - Phase 1: external demands for internal items (external consumers + target rates).
   - Phase 2: external-output demands — SCC recipes producing items OUTSIDE the SCC with non-zero demand. Pins those recipes' facility counts to `demand / rate`.
   - Phase 3: build `n × m` matrix of net production coefficients `calcRate(output, t) - calcRate(input, t)` per (item, recipe). Before solving, drop impossible disposal-item rows via `filterImpossibleDisposalRows` (forced-disposal item with all-zero LHS + non-zero RHS — surplus handled later by `injectDisposalRecipes`). If any pinned, substitute their contribution into RHS and solve reduced system on `freeM` free recipes via `solveOverdetermined` (linear-solver.ts): `numVars == 0` → `[]`; overdetermined + 1 free var → `max(b/a)`; overdetermined multi-var → pick `numVars` rows with largest `|RHS|` and solve that square system; else plain `solveLinearSystem`. Fallback on no-solution → `tryExtendSCCWithFeeders`.
   - Phase 4: deficit propagation. For each internal item compute net production, if `externalDemand - netProduction > 0` push deficit into `itemDemands` (via `Math.max`, NOT addition — external demand already counted in Phase 1).
   - Phase 5: propagate consumption back to `scc.externalInputs` (demand += consumption).

6. **Feeder extension** (`tryExtendSCCWithFeeders`) — fallback when SCC unsolvable. For each overridden item in SCC, find alternate non-SCC producing recipe (feeder) with at least one non-SCC input. Adds feeders to graph + SCC, pins the override recipe to its external demand, solves extended system. Validates: if target item still has deficit, rollback all mutations (`addedRecipeIds`, `addedItemIds`, `addedConsumptionEdges`, original `scc.recipes`/`externalInputs` sets) and return false. On success adds `scc.id` to `resolvedSCCIds` (cycle linearized — excluded from `detectedCycles`).

7. **Disposal injection** (`injectDisposalRecipes`) — for each `forcedDisposalItems` with surplus (`production - consumption - targetDemand > 0`), find disposal recipe (empty outputs), add to graph with `facilityCount = surplus / rate`.

8. **Backtracking** (`backtrackRecipeChoices`) — when `invalidSCCs` non-empty, collect items in those SCCs with `recipeChoices` (multiple options), pick one with next untried recipe, extend `recipeConstraints` excluding all recipes up to current index, rerun. Gives up when all combos exhausted → returns best-effort graph with `invalidCycles`.

9. **Build final graph** (`buildProductionGraph`) — assemble `ProductionDependencyGraph` with nodes (sum production across ALL producing recipes for multi-producer items), edges (item↔recipe both directions), `detectedCycles` (excluding resolved SCCs), `invalidCycles`.

**Invariants**:
- Pool capacity / item production is tracked in primary-output units (first output). Byproducts computed via ratio `byproductAmount / primaryAmount`.
- `itemDemands` uses `Math.max` for deficit, `+=` for external-input consumption and plain recipe inputs.
- `resolvedSCCIds` filters `detectedCycles` so linearized cycles don't render backward edges.

### Data Flow

```
User selects targets + rates
  → useProductionPlan hook (src/hooks/useProductionPlan.ts)
    → calculateProductionPlan (src/lib/calculator.ts)
      → ProductionDependencyGraph
        ├→ Table View: useProductionTable → ProductionTable
        └→ Tree View: mapper (merged or separated) → ELK layout → React Flow
```

### Two Visualization Paths

Both transform `ProductionDependencyGraph` → React Flow `{nodes, edges}`. Both use ELK (`src/lib/layout.ts`) for hierarchical graph layout, preloaded at startup.

#### Merged mapper (`merged-mapper.ts`)

One node per recipe, annotated with `facilityCount`. Pipeline:

1. **Create recipe flow nodes** — skip terminal recipes (no consumers, no secondary outputs — their output rendered in target sink instead). Rate per node = `calcRate(output.amount, craftingTime) * facilityCount` for THIS recipe's output (NOT total item production — multi-producer items split per-recipe).

2. **Greedy allocation** (`computeGreedyAllocation` from `plan-helpers`) — multi-producer items (2+ non-disposal producers): collect all consumers with their demand, cascade whole producer outputs to consumers to minimize pipe connections. For multi-producer target items: target sink prepended to consumer list so override recipe goes to target first, feeders go to internal consumers (avoids visual cycles).

3. **Item → Recipe edges** — if greedy allocation exists, emit one edge per `(producerRecipeId, consumerId)` pair. Else single producer → one edge at full rate. Raw material → create `rawMaterialId` node, edge from it. Terminal target recipes redirect edge target to `targetSinkId`.

4. **Target sink nodes** — one per target item. Embed producer recipe info only if exactly one producer AND no separate flow node exists (terminal single-recipe target). Edges created when non-terminal OR any producer already has flow node (byproduct scenario).

5. **Disposal sink nodes** — per disposal recipe. Edges from producers use `greedy.remainingByProducer` if greedy exists (remaining after consumer allocation), else proportional split by producer rate.

#### Separated mapper (`separated-mapper.ts`)

One node per physical facility instance via `CapacityPoolManager`. Pipeline:

1. **Create pools** — per recipe, pool sized by `perRecipeRate = calcRate(output.amount, t) * facilityCount`.

2. **Cycle detection prebuild** — `cyclePairs = Set<"recipeA:recipeB">` from `plan.detectedCycles`. Used to tag edges as `"backward"` when producer + consumer in same SCC.

3. **Allocate upstream** (`allocateUpstream`, recursive) — for each demand: raw material → `ensurePickupPointNodes` (multiple pickup points per `getPickupPointCount(totalDemand, item)`, each capped by `getTransportCapacity`). Else sort producers by rate desc, greedy cascade, track `actuallyAllocated` (not requested) so deficit flows to next producer — prevents backward-byproduct exhaustion from stalling demand.

4. **Pool allocation** (`allocateFromPool`):
   - Primary-output demand: `poolManager.allocate(recipeId, demand)`.
   - **Byproduct demand** (`demandedItemId !== primaryOutputId`): convert to pool units via `conversionRatio = byproductAmount / primaryAmount`, `poolDemandRate = demand / ratio`.
     - `backward` direction: `allocateByproduct(..., forceRunning=true)` — NEVER consume primary capacity. Facilities guaranteed by SCC solver; prevents the double-allocation bug (cf. PR #53) where backward sewage consumed primary Xircon capacity.
     - Forward: `allocateByproduct` first (free from running facilities), then `allocate` for remainder to activate new facilities.
   - On first visit to a facility instance (`!isProcessed`): create flow node for primary output, recursively `allocateUpstream` for recipe inputs (scaled by `actualOutputRate / primaryOutputRate`).
   - Return actual allocated (in demanded-item units) so caller can cascade remainder.

5. **Main recipe pass** — iterate non-terminal recipes, force-create flow nodes for unprocessed facility instances + allocate their upstream. Terminal recipes skipped (target sink pass handles them).

6. **Target sink pass** — three branches per target item:
   - **Byproduct target** (producer already processed): allocate per-facility byproduct via `calcByproductRate(recipe, itemId, actualOutputRate)`. Greedy fill: `Math.min(byproductRate, remainingDemand)` per facility. Write into `byproductAllocatedToTarget` so disposal pass subtracts. Sink WITHOUT production info.
   - **Terminal + multi-facility**: split into per-facility flow nodes with `isDirectTarget=true`, edges to sink, allocate inputs per facility.
   - **Else**: sink with production info. Terminal single-facility → `allocateUpstream` inputs to sink. Non-terminal → `allocateFromPool` producer pool to sink.

7. **Disposal pass** — per disposal recipe, compute per-facility byproduct rate, subtract `byproductAllocatedToTarget[facilityId:itemId]`, emit edge with remaining if `> 0.01`.

**Shared helpers** (`src/lib/plan-helpers.ts`):
- `getItemProducers(plan, itemId)` — all recipes producing item with per-recipe rate.
- `getRecipeOutputItemId` — primary output (first non-disposal).
- `isRecipeTerminal` — recipe has no downstream consumers for any output.
- `computeGreedyAllocation(producers, consumers)` — merged mapper's whole-producer-to-consumer cascade.

**Key invariant**: merged + separated mappers MUST agree on per-recipe rate (`calcRate(output, t) * facilityCount`). Changes to production rate computation in one require matching change in the other.

### Type System

Branded types in `src/types/constants.ts` prevent mixing IDs:
```typescript
type ItemId = string & { readonly __brand: "ItemId" };
type RecipeId = string & { readonly __brand: "RecipeId" };
type FacilityId = string & { readonly __brand: "FacilityId" };
```

Core domain types are in `src/types/core.ts` (Item, Recipe, Facility), `src/types/production.ts` (ProductionNode, DetectedCycle, ProductionDependencyGraph), and `src/types/flow.ts` (visualization-specific types).

### Game Data

Static game data lives in `src/data/` — `items.ts`, `recipes.ts`, `facilities.ts`. The `forcedRawMaterials` constant defines items that are always treated as raw inputs.

### Internationalization

7 languages supported via i18next. Translation files are in `public/locales/{lang}/{namespace}.json` with namespaces: `item`, `facility`, `app`, `production`. Language config is in `src/i18n.ts` with extraction config in `i18next.config.ts`.

### UI Stack

Shadcn/ui components (Radix UI primitives + Tailwind CSS) in `src/components/ui/`. Custom React Flow nodes in `src/components/nodes/`. Component scaffolding config in `components.json`.

## Commit Convention

- `Add:` new feature
- `Fix:` bug fix
- `Update:` enhancement to existing feature
- `Refactor:` code restructuring
