import { useTranslation } from "react-i18next";

/**
 * Full-area overlay shown over the production view while the HiGHS
 * WASM module is still loading. Visual-only; doesn't block pointer
 * events (the rest of the app stays interactive).
 *
 * The character art alone communicates "in progress" via the pulse
 * animation; no visible text. aria-label provides a screen-reader
 * label, routed through i18n's defaultValue so any future locale
 * additions pick it up automatically.
 *
 * Caller renders conditionally based on `solverReady` from
 * `useProductionPlan`.
 */
export default function SolverLoadingOverlay() {
  const { i18n } = useTranslation("app");
  const label = i18n.t("solverLoading", { defaultValue: "Loading solver" });

  return (
    <div
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none"
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <img
        src={`${import.meta.env.BASE_URL}images/loading.png`}
        alt=""
        className="w-40 h-40 animate-pulse"
        draggable={false}
      />
    </div>
  );
}
