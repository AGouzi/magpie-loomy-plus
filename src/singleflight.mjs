// Loomy Plus · 并发去重与有界缓存
//
// Magpie 会同时刷新账号卡片、模型目录和请求热路径。没有去重时，同一次
// 自动刷新会向上游打多份完全相同的只读请求；没有上限的 Map 又会随会话数
// 一直增长。这两个小工具只做一件事：同一 key 的并发调用共享一次 Promise，
// 缓存条目按 TTL 与容量淘汰。

export class SingleFlight {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} */
    this.inflight = new Map()
  }

  run(key, fn) {
    const current = this.inflight.get(key)
    if (current) return current

    const pending = Promise.resolve()
      .then(fn)
      .finally(() => {
        if (this.inflight.get(key) === pending) this.inflight.delete(key)
      })

    this.inflight.set(key, pending)
    return pending
  }

  get size() {
    return this.inflight.size
  }
}

export class BoundedCache {
  constructor(maxEntries = 64) {
    this.maxEntries = Math.max(1, Number(maxEntries) || 64)
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this.entries = new Map()
  }

  get(key, now = Date.now()) {
    const hit = this.entries.get(key)
    if (!hit) return undefined
    if (hit.expiresAt > 0 && now >= hit.expiresAt) {
      this.entries.delete(key)
      return undefined
    }
    // 命中后移到末尾，淘汰时先丢最久没用过的条目。
    this.entries.delete(key)
    this.entries.set(key, hit)
    return hit.value
  }

  set(key, value, ttlMs = 0, now = Date.now()) {
    if (this.entries.has(key)) this.entries.delete(key)
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, {
      value,
      expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    })
    return value
  }

  delete(key) {
    return this.entries.delete(key)
  }

  clear() {
    this.entries.clear()
  }

  get size() {
    return this.entries.size
  }
}
