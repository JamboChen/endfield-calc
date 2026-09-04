/**
 * Local text draft for a numeric override input, kept in step with its
 * source value.
 *
 * A settings override is `number | undefined` ("no override"), but an
 * `<input>` needs a string that can hold intermediate, unparseable states
 * while the user types ("", "-", "1."). So each row keeps a draft and
 * commits it on blur.
 *
 * The subtle part is the way back. When the source value changes from
 * somewhere OTHER than this input — a bulk "clear all", a validator that
 * rejected the commit and dropped the override, a re-seed of the whole
 * settings state — the draft must follow, or the field goes on displaying
 * a value the app never stored and the next blur writes that stale value
 * back as if the user had typed it.
 *
 * That resync is the entire reason this is a hook rather than two lines
 * inline: the pattern was implemented twice, one copy omitted it, and the
 * omission was invisible because it only bites when something external
 * moves the value. One implementation cannot half-exist.
 */
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/** `undefined` (no override) renders as an empty field, not "undefined". */
function toDraft(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/**
 * Returns the draft and its setter. The setter is exposed because commit
 * handlers need it for local reverts (restoring the previous text when
 * the typed value is rejected), which must NOT go through the source.
 *
 * Note the draft is re-derived whenever `value` changes, including
 * immediately after a successful commit: the field then shows exactly
 * what was stored, so `007` settles to `7`.
 */
export function useNumericDraft(
  value: number | undefined,
): [string, Dispatch<SetStateAction<string>>] {
  const [draft, setDraft] = useState<string>(() => toDraft(value));

  useEffect(() => {
    setDraft(toDraft(value));
  }, [value]);

  return [draft, setDraft];
}
