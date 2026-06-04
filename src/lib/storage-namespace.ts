/**
 * localStorage key namespacing for the beta channel.
 *
 * Beta builds (served at `/endfield-calc/beta/`) share the same origin
 * as production (`/endfield-calc/`), so without namespacing every
 * persisted key would collide between channels. A schema change on
 * beta could then corrupt prod state and vice-versa.
 *
 * This helper suffixes any base key with `:beta` when the runtime base
 * path indicates a beta build, otherwise returns the key untouched.
 * Production users continue reading and writing the unsuffixed keys
 * exactly as before — only beta gets the suffix.
 *
 * Vite's `import.meta.env.BASE_URL` is set from the `--base` build
 * flag (see the `build:beta` script in `package.json`):
 *
 *   - Production build: `/endfield-calc/`        -> no suffix
 *   - Beta build:       `/endfield-calc/beta/`   -> `:beta` suffix
 *   - Dev / tests:      `/`                      -> no suffix
 *
 * First-visit consequence: a user opening the beta channel for the
 * first time will see the AIC onboarding dialog again and start with
 * default settings, because the suffixed keys don't exist yet. This
 * is intentional — the two channels are fully independent.
 */
const IS_BETA_CHANNEL = import.meta.env.BASE_URL.includes("/beta/");

/**
 * Returns the input key suffixed with `:beta` on beta builds, or the
 * key unchanged on production / dev / test builds.
 *
 * @example
 *   const STORAGE_KEY = namespaceStorageKey("endfield-calc:aic-v1");
 *   // prod:  "endfield-calc:aic-v1"
 *   // beta:  "endfield-calc:aic-v1:beta"
 */
export function namespaceStorageKey(key: string): string {
  return IS_BETA_CHANNEL ? `${key}:beta` : key;
}
