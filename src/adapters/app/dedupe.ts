/** DeliveryStore remembers webhook delivery ids so a redelivery is handled once */
export interface DeliveryStore {
  /** records the id; true when it was already known */
  seen: (id: string) => Promise<boolean>
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
  }
}
