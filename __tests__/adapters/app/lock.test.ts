import { describe, expect, it } from 'vitest'

import { memoryLocks, pullRequestKey } from '../../../src/adapters/app/lock'

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

describe('memoryLocks', () => {
  it('runs two calls on one key one after the other, in order', async () => {
    const locks = memoryLocks()
    const order: string[] = []
    const first = gate()

    const a = locks.withLock('k', async () => {
      order.push('a:start')
      await first.opened
      order.push('a:end')
      return 'a'
    })
    const b = locks.withLock('k', async () => {
      order.push('b:start')
      return 'b'
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual(['a:start'])

    first.open()
    expect(await Promise.all([a, b])).toEqual(['a', 'b'])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('runs different keys at the same time', async () => {
    const locks = memoryLocks()
    const order: string[] = []
    const first = gate()

    const a = locks.withLock('k1', async () => {
      order.push('a:start')
      await first.opened
    })
    const b = locks.withLock('k2', async () => {
      order.push('b:start')
    })
    await b
    expect(order).toEqual(['a:start', 'b:start'])
    first.open()
    await a
  })

  it('releases the lock when the holder throws, and the next holder still runs', async () => {
    const locks = memoryLocks()

    const failed = locks.withLock('k', async () => {
      throw new Error('boom')
    })
    const next = locks.withLock('k', async () => 'ran')

    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ran')
  })

  it('queues a caller that arrives after the first holder is done behind the one still waiting', async () => {
    const locks = memoryLocks()
    const order: string[] = []
    const first = gate()
    const second = gate()

    const a = locks.withLock('k', async () => {
      order.push('a:start')
      await first.opened
    })
    const b = locks.withLock('k', async () => {
      order.push('b:start')
      await second.opened
    })
    first.open()
    await a
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual(['a:start', 'b:start'])

    // a's cleanup must leave b's tail in place, or c would run alongside b
    const c = locks.withLock('k', async () => {
      order.push('c:start')
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual(['a:start', 'b:start'])

    second.open()
    await Promise.all([b, c])
    expect(order).toEqual(['a:start', 'b:start', 'c:start'])
  })

  it('forgets a key once its last holder is done', async () => {
    const locks = memoryLocks()
    await locks.withLock('k', async () => {})
    // a fresh chain: this would hang if the previous one were still awaited incorrectly
    await expect(locks.withLock('k', async () => 'again')).resolves.toBe('again')
  })
})

describe('pullRequestKey', () => {
  const repository = { full_name: 'o/r', name: 'r', owner: { login: 'o' } }

  it('keys a pull request event by repository and number', () => {
    expect(pullRequestKey({ id: 'd', eventName: 'pull_request', payload: { repository, pull_request: { number: 7 } } })).toBe('o/r#7')
  })

  it('keys an issue event the same way', () => {
    expect(pullRequestKey({ id: 'd', eventName: 'issue_comment', payload: { repository, issue: { number: 3 } } })).toBe('o/r#3')
  })

  it('is undefined for an event about no issue, or without a repository', () => {
    expect(pullRequestKey({ id: 'd', eventName: 'push', payload: { repository } })).toBeUndefined()
    expect(pullRequestKey({ id: 'd', eventName: 'issues', payload: { issue: { number: 1 } } })).toBeUndefined()
  })
})
