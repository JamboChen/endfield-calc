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
 * Create a Metastorage import source node ID, unique per
 * (source region, imported item). The delivery arrives at the regional
 * depot so there is no per-instance variant even in Facility View, but
 * two source regions CAN ship the same item into one plan (a region
 * may receive from multiple sources), so the source domain must be
 * part of the id — otherwise the two imports collide on one node and
 * one supply silently disappears from the graph/table.
 *
 * @example
 * createMetastorageSourceId("domain_1", "item_iron_nugget")
 * //=> "metastorage_domain_1_item_iron_nugget"
 */
export function createMetastorageSourceId(
  sourceDomain: string,
  itemId: string,
): string {
  return `metastorage_${sourceDomain}_${itemId}`;
}
