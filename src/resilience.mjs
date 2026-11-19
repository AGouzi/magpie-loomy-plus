// Loomy Plus · 请求稳定性
//
// 1. 每账号的持久化风控冷却：命中明确的风控 / 人机验证后停止继续打上游，
//    不再让 Magpie 的自动重试把一个临时限制放大成长期封号。
// 2. 每账号的轻量节流：只拉开同一账号的请求起点，不限制不同账号并行。
// 3. 账号作用域只存哈希，不把 session 原值写进本地状态文件。

import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const RISK_COOLDOWN_SECONDS = 2 * 60 * 60
export const FORBIDDEN_COOLDOWN_SECONDS = 10 * 60

const RESTRICTED_RE =
  /(账号异常|账号存在异常|异常行为|已被限制|已封禁|风控|安全验证|人机验证|滑块|captcha|risk.?control|account.?(restricted|banned|suspended|frozen))/i

export function accountScope(credential) {
  const named = credential?.uid || credential?.accountId || credential?.phone
  if (named) {
    return `acc_${crypto.createHash("sha256").update(String(named)).digest("hex").slice(0, 20)}`
  }
  const token = String(credential?.session ?? "")
  return `tok_${crypto.createHash("sha256").update(token).digest("hex").slice(0, 20)}`
}

export function defaultStateDir() {
  const override = String(process.env.LOOMY_PLUS_STATE_DIR ?? "").trim()
  if (override) return path.resolve(override)
  const home = os.homedir()
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "magpie", "loomy-plus")
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Caches", "magpie", "loomy-plus")
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(home, ".local", "state"), "magpie", "loomy-plus")
}

function readJsonSafe(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, filePath)
}

export function classifyRestriction({ status, envelope, rawText = "" } = {}) {
  const code = String(envelope?.code ?? envelope?.error?.code ?? "").trim()
  const message = String(
    envelope?.error?.message ??
      envelope?.message ??
      envelope?.msg ??
      envelope?.desc ??
      rawText ??
      "",
  ).trim()
  const said = `${code} ${message}`
  const explicit = RESTRICTED_RE.test(said) || code === "11140"
  if (explicit) {
    return {
      restricted: true,
      explicit: true,
      status: 403,
      seconds: RISK_COOLDOWN_SECONDS,
      code,
      reason: message.slice(0, 300) || "Loomy 要求安全验证",
    }
  }
  if (status === 403) {
    return {
      restricted: true,
      explicit: false,
      status: 403,
      seconds: FORBIDDEN_COOLDOWN_SECONDS,
      code,
      reason: message.slice(0, 300) || "Loomy 返回 HTTP 403",
    }
  }
  return null
}

export class RiskCircuit {
  constructor({ stateDir = defaultStateDir(), now = Date.now } = {}) {
    this.filePath = path.join(stateDir, "risk-circuit.json")
    this.now = now
    this.state = null
  }

  _load() {
    if (this.state === null) {
      const loaded = readJsonSafe(this.filePath)
      this.state = loaded
      this._prune()
    }
    return this.state
  }

  _prune() {
    const now = this.now()
    let changed = false
    for (const [key, value] of Object.entries(this.state ?? {})) {
      if (!value || Number(value.until) <= now) {
        delete this.state[key]
        changed = true
      }
    }
    if (changed) this._save()
  }

  _save() {
    writeJsonAtomic(this.filePath, this.state ?? {})
  }

  get(accountKey) {
    const store = this._load()
    const hit = store[accountKey]
    if (!hit) return null
    const now = this.now()
    if (Number(hit.until) <= now) {
      delete store[accountKey]
      this._save()
      return null
    }
    return {
      ...hit,
      remainingSec: Math.max(1, Math.ceil((Number(hit.until) - now) / 1000)),
    }
  }

  trip(accountKey, { reason = "Loomy restricted", seconds = RISK_COOLDOWN_SECONDS, explicit = true } = {}) {
    const store = this._load()
    const now = this.now()
    store[accountKey] = {
      reason: String(reason).slice(0, 300),
      explicit: explicit === true,
      trippedAt: now,
      until: now + Math.max(1, Number(seconds) || RISK_COOLDOWN_SECONDS) * 1000,
    }
    this._save()
    return this.get(accountKey)
  }

  clear(accountKey) {
    const store = this._load()
    if (!(accountKey in store)) return false
    delete store[accountKey]
    this._save()
    return true
  }
}

export class AccountPacer {
  constructor({
    minGapMs = 120,
    jitterMinMs = 20,
    jitterMaxMs = 80,
    now = Date.now,
    sleep = (ms, signal) => abortableSleep(ms, signal),
  } = {}) {
    this.minGapMs = Math.max(0, Number(minGapMs) || 0)
    this.jitterMinMs = Math.max(0, Number(jitterMinMs) || 0)
    this.jitterMaxMs = Math.max(this.jitterMinMs, Number(jitterMaxMs) || this.jitterMinMs)
    this.now = now
    this.sleep = sleep
    /** @type {Map<string, number>} */
    this.nextAt = new Map()
  }

  async wait(accountKey, signal) {
    if (this.minGapMs <= 0 && this.jitterMaxMs <= 0) return
    const now = this.now()
    const startAt = Math.max(now, this.nextAt.get(accountKey) || 0)
    const jitter =
      this.jitterMaxMs > this.jitterMinMs
        ? this.jitterMinMs + Math.floor(Math.random() * (this.jitterMaxMs - this.jitterMinMs + 1))
        : this.jitterMinMs
    this.nextAt.set(accountKey, startAt + this.minGapMs + jitter)
    const delay = startAt - now
    if (delay > 0) await this.sleep(delay, signal)
  }
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.("abort", onAbort)
      reject(signal.reason || new DOMException("Aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener?.("abort", onAbort, { once: true })
  })
}
