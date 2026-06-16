/**
 * Create a target sink node ID.
 *
 * @example
 * createTargetSinkId("item_iron_powder") // "target-sink-item_iron_powder"
 */
export function createTargetSinkId(itemId: string): string {
  return `target-sink-${itemId}`;
}

/**
 * Create a raw material node ID.
 *
 * @example
 * createRawMaterialId("iron_ore") // "raw_iron_ore"
 */
export function createRawMaterialId(itemId: string): string {
  return `raw_${itemId}`;
}

/**
 * Create a Metastorage import source node ID (one per imported item —
 * the delivery arrives at the regional depot, so there is no
 * per-instance variant even in Facility View).
 *
 * @example
 * createMetastorageSourceId("item_iron_nugget") // "metastorage_item_iron_nugget"
 */
export function createMetastorageSourceId(itemId: string): string {
  return `metastorage_${itemId}`;
}
