/**
 * Hand a plan link to the OS share sheet, falling back to the clipboard.
 *
 * Isolated from the button for one reason above all: the Web Share API
 * requires **transient user activation**, so `navigator.share()` has to be
 * reached synchronously from the click handler. Any `await` before it
 * consumes the activation token and the call rejects with
 * `NotAllowedError`. Everything here is therefore ordered so the share
 * call is the first thing that happens, and every asynchronous step comes
 * after it.
 *
 * # Support, and why the fallback is not optional
 *
 * Native sharing is a mobile-first API. Android Chrome, iOS/macOS Safari,
 * Samsung Internet, Edge and desktop Chromium all have it; **desktop
 * Firefox does not implement it at all**. It is also gated on a secure
 * context, so it is absent over plain HTTP (though `localhost` counts as
 * secure, and the deployed site is HTTPS). A share button that only
 * worked where `navigator.share` exists would be dead UI for a real share
 * of users, hence the clipboard path.
 */

/**
 * What became of the user's request. The caller decides how to narrate
 * each one; `"dismissed"` and `"shared"` both want silence.
 */
export type ShareOutcome =
  /** Handed to a share target. */
  | "shared"
  /** The user opened the share sheet and closed it without choosing. */
  | "dismissed"
  /** No native share available (or it failed); the link is on the clipboard. */
  | "copied"
  /** Neither route worked. */
  | "unavailable";

export interface SharePlanData {
  /** The absolute link. Read at click time, never captured earlier. */
  url: string;
  /** Shown by some share targets; ignored by others. */
  title: string;
}

/** Copy to the clipboard, reporting whether it took. */
async function copyToClipboard(url: string): Promise<ShareOutcome> {
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    // No clipboard API, an insecure context, or permission refused.
    return "unavailable";
  }
}

/**
 * Share `data`, or copy its URL if sharing isn't available.
 *
 * MUST be called synchronously from a user gesture — see the module note.
 */
export async function sharePlanLink(data: SharePlanData): Promise<ShareOutcome> {
  if (typeof navigator.share !== "function") {
    return copyToClipboard(data.url);
  }

  // `canShare` post-dates `share` in some engines (older Android
  // WebViews), so its absence is not a reason to skip sharing.
  if (
    typeof navigator.canShare === "function" &&
    !navigator.canShare(data)
  ) {
    return copyToClipboard(data.url);
  }

  try {
    await navigator.share(data);
    return "shared";
  } catch (err) {
    // AbortError is the user closing the sheet without picking a target.
    // It is a decision, not a failure: reporting an error would be wrong,
    // and quietly copying the link they just declined to share would be
    // worse.
    if (err instanceof DOMException && err.name === "AbortError") {
      return "dismissed";
    }
    // Anything else (no OS share targets registered, a policy block, a
    // payload the platform refused) still leaves the user wanting the
    // link.
    return copyToClipboard(data.url);
  }
}
