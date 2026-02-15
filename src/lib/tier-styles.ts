/* ── Tier colour class mappings (T0=Q1 … T5=Q6) ── */

export type TierClasses = {
  chip: string;
  border: string;
  dot: string;
  ring: string;
  bg: string;
  gradient: string;
};

const TIER_CLASSES: Record<number, TierClasses> = {
  0: {
    chip: "bg-tier-0/15 text-tier-0 border-tier-0/30",
    border: "border-l-tier-0",
    dot: "bg-tier-0",
    ring: "ring-tier-0/50",
    bg: "bg-tier-0-muted",
    gradient: "from-tier-0/80 via-tier-0/40",
  },
  1: {
    chip: "bg-tier-1/15 text-tier-1 border-tier-1/30",
    border: "border-l-tier-1",
    dot: "bg-tier-1",
    ring: "ring-tier-1/50",
    bg: "bg-tier-1-muted",
    gradient: "from-tier-1/80 via-tier-1/40",
  },
  2: {
    chip: "bg-tier-2/15 text-tier-2 border-tier-2/30",
    border: "border-l-tier-2",
    dot: "bg-tier-2",
    ring: "ring-tier-2/50",
    bg: "bg-tier-2-muted",
    gradient: "from-tier-2/80 via-tier-2/40",
  },
  3: {
    chip: "bg-tier-3/15 text-tier-3 border-tier-3/30",
    border: "border-l-tier-3",
    dot: "bg-tier-3",
    ring: "ring-tier-3/50",
    bg: "bg-tier-3-muted",
    gradient: "from-tier-3/80 via-tier-3/40",
  },
  4: {
    chip: "bg-tier-4/15 text-tier-4 border-tier-4/30",
    border: "border-l-tier-4",
    dot: "bg-tier-4",
    ring: "ring-tier-4/50",
    bg: "bg-tier-4-muted",
    gradient: "from-tier-4/80 via-tier-4/40",
  },
  5: {
    chip: "bg-tier-5/15 text-tier-5 border-tier-5/30",
    border: "border-l-tier-5",
    dot: "bg-tier-5",
    ring: "ring-tier-5/50",
    bg: "bg-tier-5-muted",
    gradient: "from-tier-5/80 via-tier-5/40",
  },
};

export function tierClasses(tier: number): TierClasses {
  return TIER_CLASSES[tier] ?? TIER_CLASSES[1];
}
