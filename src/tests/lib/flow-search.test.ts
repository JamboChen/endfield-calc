import { describe, test, expect } from "vitest";
import { filterSearchCandidates } from "@/lib/flow-search";

describe("filterSearchCandidates", () => {
  const CANDIDATES = [
    { id: "n1", label: "Dense Carbon Powder", sublabel: "Grinding Unit 1/11" },
    { id: "n2", label: "Carbon", sublabel: "Refining Unit 1/6" },
    { id: "n3", label: "Stabilized Carbon", sublabel: "Refining Unit 2/6" },
    { id: "n4", label: "Clean Water", sublabel: "Fluid Pump 3/14" },
    { id: "n5", label: "Xiranite", sublabel: "Forge of the Sky 1/6" },
  ];

  test("empty / whitespace query matches nothing", () => {
    expect(filterSearchCandidates(CANDIDATES, "")).toEqual([]);
    expect(filterSearchCandidates(CANDIDATES, "   ")).toEqual([]);
  });

  test("ranks label-prefix before label-substring before sublabel match", () => {
    const results = filterSearchCandidates(CANDIDATES, "carbon");
    expect(results.map((r) => r.id)).toEqual(["n2", "n1", "n3"]);
  });

  test("matches facility names via sublabel", () => {
    const results = filterSearchCandidates(CANDIDATES, "refining");
    expect(results.map((r) => r.id)).toEqual(["n2", "n3"]);
  });

  test("case-insensitive", () => {
    expect(filterSearchCandidates(CANDIDATES, "XIRANITE")[0].id).toBe("n5");
  });

  test("respects the limit", () => {
    expect(filterSearchCandidates(CANDIDATES, "n", 2)).toHaveLength(2);
  });
});
