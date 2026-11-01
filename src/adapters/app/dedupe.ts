/**
 * DeliveryStore remembers webhook delivery ids so a redelivery is handled once.
 * `seen` claims an id when the delivery arrives; a store that can tell a claim
 * from a finished delivery also takes `done` once the handler succeeded and
 * `forget` once it failed, so a failed delivery can be redelivered.
 */
export interface DeliveryStore {
  /** claims the id; true when it was already claimed or handled */
  seen: (id: string) => Promise<boolean>
  /** the claimed delivery was handled; remember it for as long as the store remembers handled ids */
  done?: (id: string) => Promise<void>
  /** the claimed delivery failed; drop the claim so a redelivery is handled */
  forget?: (id: string) => Promise<void>
}

export function memoryDeliveryStore(capacity = 10_000): DeliveryStore {
  const ids = new Set<string>()
  return {
    async seen(id) {
      if (ids.has(id)) {
        return true
      }
      ids.add(id)
      if (ids.size > capacity) {
        const oldest = ids.values().next().value as string
        ids.delete(oldest)
      }
      return false
    },
    // one process holds its claims in memory, so a claim and a handled id are the same entry
    async done() {},
    async forget(id) {
      ids.delete(id)
    },
  }
}
