/**
 * `useNumericDraft` — the draft/source contract both override inputs rely
 * on.
 *
 * The resync is the part worth pinning: it only matters when something
 * OTHER than the input moves the source value, which is exactly why its
 * absence went unnoticed in one of the two call sites.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useNumericDraft } from "@/hooks/useNumericDraft";

describe("useNumericDraft", () => {
  it("seeds from the source value, and renders 'no override' as empty", () => {
    expect(renderHook(() => useNumericDraft(7)).result.current[0]).toBe("7");
    expect(
      renderHook(() => useNumericDraft(undefined)).result.current[0],
    ).toBe("");
  });

  it("follows the source when it changes externally", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number | undefined }) => useNumericDraft(value),
      { initialProps: { value: 7 as number | undefined } },
    );

    rerender({ value: 42 });
    expect(result.current[0]).toBe("42");

    // Clearing the override empties the field rather than leaving the old
    // number behind for the next blur to write back.
    rerender({ value: undefined });
    expect(result.current[0]).toBe("");
  });

  it("keeps a locally-set draft until the source actually moves", () => {
    const { result, rerender } = renderHook(
      ({ value }: { value: number | undefined }) => useNumericDraft(value),
      { initialProps: { value: 7 as number | undefined } },
    );

    // Typing, and a commit handler's local revert, both go through the
    // setter and must survive re-renders that don't change the source.
    act(() => result.current[1]("1."));
    expect(result.current[0]).toBe("1.");

    rerender({ value: 7 });
    expect(result.current[0]).toBe("1.");

    rerender({ value: 3 });
    expect(result.current[0]).toBe("3");
  });
});
