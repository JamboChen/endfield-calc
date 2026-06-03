import { useEffect, useState } from "react";
import { Factory } from "lucide-react";
import { cn } from "@/lib/utils";
import { facilityIconUrl, isMonochromeFacilityIcon } from "@/lib/facility-icons";
import type { Facility } from "@/types";
import type { FacilityId } from "@/types/constants";

/**
 * Module-level set of facility ids we've already dev-warned about, to
 * keep the console clean across React re-renders. Cleared on full page
 * reload; never inspected by production code.
 */
const warnedFacilities = new Set<string>();

function devWarn(facilityId: string, message: string): void {
  if (!import.meta.env?.DEV) return;
  if (warnedFacilities.has(facilityId)) return;
  warnedFacilities.add(facilityId);
  console.warn(`[FacilityIcon] ${message}`);
}

interface FacilityIconProps {
  /**
   * Provide either a full `Facility` (preferred — uses the data-field
   * `iconUrl`/`iconIsMonochrome`) OR just a `facilityId` (helper
   * resolves both). The data-field path is preferred because it's
   * already memoized at module load.
   */
  facility?: Facility;
  facilityId?: FacilityId;
  /** Tailwind classes for sizing/spacing. Forwarded to the `<img>`. */
  className?: string;
  /**
   * Accessible label. Leave empty to mark the icon as decorative
   * (`aria-hidden`). Set to a meaningful string when the icon is the
   * only signal carrying the facility identity.
   */
  alt?: string;
}

/**
 * Single rendering primitive for facility icons across the app.
 *
 * Responsibilities:
 *   1. **URL resolution** — `facility.iconUrl` first (set at data-load
 *      via `facilityIconUrl()`), `facilityIconUrl(facilityId)` as
 *      fallback. The two stay aligned because the data setters use the
 *      same helper.
 *   2. **Monochrome styling** — applies `invert dark:invert-0` when
 *      the icon is a monochrome game glyph (today: synthetic manual
 *      facilities reusing structure port glyphs). Detected via
 *      `Facility.iconIsMonochrome` or `isMonochromeFacilityIcon()`.
 *   3. **Defensive fallback** — falls back to a Lucide `<Factory>`
 *      icon if no URL is resolvable OR the resolved URL 404s in the
 *      browser, so a missing entry never crashes a render and the
 *      user gets a visible cue that something's off.
 *   4. **Dev-mode visibility** — `console.warn` (throttled to once
 *      per facility id per session) when either (a) the resolved URL
 *      404s in the browser, or (b) the `<Factory>` fallback fires
 *      due to a missing URL. Only genuine misses surface, so the
 *      maintainer can ship the missing asset (and follow the
 *      console.warn's path hint).
 *
 * Use this component everywhere a facility icon needs to render.
 * Direct `<img src={facility.iconUrl}>` bypasses the monochrome
 * handling and the dev-warning hooks.
 */
export function FacilityIcon({
  facility,
  facilityId,
  className,
  alt,
}: FacilityIconProps) {
  const id = facility?.id ?? facilityId;
  const url = id
    ? (facility?.iconUrl ?? facilityIconUrl(id))
    : undefined;

  // Track 404s via state (NOT via direct DOM mutation): this lets a
  // re-render with a different URL retry the load. The effect resets
  // `errored` whenever the resolved URL changes — e.g. a parent
  // updates `facility.iconUrl` after the bad asset gets shipped.
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setErrored(false);
  }, [url]);

  if (!id) return null;

  const isMono =
    facility?.iconIsMonochrome ?? isMonochromeFacilityIcon(id);

  if (!url) {
    devWarn(
      id,
      `no iconUrl for facility \`${id}\`; rendering <Factory> fallback. ` +
        `Ship public/images/facilities/${id}.png to fix.`,
    );
    return <Factory className={className} aria-hidden={!alt} aria-label={alt} />;
  }

  if (errored) {
    return <Factory className={className} aria-hidden={!alt} aria-label={alt} />;
  }

  return (
    <img
      src={url}
      alt={alt ?? ""}
      aria-hidden={!alt}
      draggable={false}
      className={cn(className, isMono && "invert dark:invert-0")}
      onError={() => {
        devWarn(
          id,
          `asset 404 for facility \`${id}\` at ${url}. ` +
            `Ship the asset at public/images/facilities/${id}.png.`,
        );
        setErrored(true);
      }}
    />
  );
}
