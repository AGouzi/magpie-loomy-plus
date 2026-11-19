// 真实宿主签名 + 本分支新增稳定性机制的离线回归。
//
// Magpie 的宿主源码固定调用：
//   provider.models(provider, { auth })
//   auth.usage(async () => auth, provider)
//   auth.checkin(async () => auth, provider)
// 任何改成 models(auth) / usage(auth) 的写法都会静默拿不到 session。

import { after, test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "loomy-plus-host-"))
process.env.LOOMY_PLUS_STATE_DIR = stateDir

const { LoomyAuthPlugin, _internal } = await import("../index.mjs")
const { RiskCircuit, AccountPacer, classifyRestriction } = await import("../src/resilience.mjs")
const { chatFetch } = await import("../src/chat.mjs")

after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true })
})

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

function stubFetch(t, handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const entry = { url: String(url), init }
    calls.push(entry)
    return handler(entry, calls)
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

function options(values = {}) {
  const defaults = {
    auto_checkin: true,
    claim_task_rewards: true,
    auto_invite: false,
    smooth_chat: true,
    risk_cooldown: true,
  }
  return {
    option(provider, key) {
      assert.equal(provider, "loomy")
      return Object.hasOwn(values, key) ? values[key] : defaults[key]
    },
  }
}

async function pluginWith(t, values = {}) {
  const api = await LoomyAuthPlugin({ client: {}, magpie: options(values) })
  return api
}

const authFor = (session, extra = {}) => ({
  type: "oauth",
  access: session,
  refresh: "",
  accountId: "测试账号",
  uid: `uid-${session}`,
  ...extra,
})

const today = _internal.pure.beijingCycleDate(Date.now())

test("宿主签名：usage(getAuth, provider) 拿到真实账号并返回契约窗口", async (t) => {
  const fetcher = stubFetch(t, ({ url }) => {
    if (url.includes("/api/v1/points/balance")) {
      return json({ code: "000000", data: { balance: 5500, dailyBalance: 4014, availableBalance: 9514 } })
    }
    if (url.includes("/api/v1/onboarding/tasks")) {
      return json({ code: "000000", data: { tasks: {}, total: 10000 } })
    }
    throw new Error(`unexpected URL: ${url}`)
  })
  const plugin = await pluginWith(t)
  const auth = authFor("host-usage", { dailyQuota: 5000, dailyCycleDate: today })

  const usage = await plugin.auth.usage(async () => auth, { id: "loomy" })
  assert.equal(usage.error, undefined)
  assert.equal(usage.balance, "9514 积分")
  assert.equal(usage.windows[0].name, "今日积分")
  assert.equal(usage.windows[0].used, 19.72)
  assert.equal(usage.windows[1].aside, true)
  assert.ok(fetcher.some((c) => c.url.includes("/points/balance")))
})

test("宿主签名：provider.models(provider, { auth }) 拉取并返回模型映射", async (t) => {
  stubFetch(t, ({ url }) => {
    if (url.includes("/api/v1/models")) {
      return json({
        code: "000000",
        data: [
          {
            id: "deepseek-v4-flash-1017",
            type: "chat",
            name: "DeepSeek V4.1 Flash 1017(x2.0)",
            context_length: 1048576,
            max_output_tokens: 384000,
            capabilities: { reasoning: true, function_calling: true, vision: true },
          },
        ],
      })
    }
    throw new Error(`unexpected URL: ${url}`)
  })
  const plugin = await pluginWith(t)
  const models = await plugin.provider.models({ id: "loomy" }, { auth: authFor("host-models") })
  assert.equal(models["deepseek-v4-flash-1017"].limit.context, 1048576)
  assert.equal(models["deepseek-v4-flash-1017"].rate, "x2.0")
})

test("宿主签名：checkin(getAuth, provider) 返回合法 outcome，并默认不跨账号邀请", async (t) => {
  const calls = stubFetch(t, ({ url }) => {
    if (url.includes("/api/v1/points/first-login")) {
      return json({
        code: "000000",
        data: {
          alreadyProcessed: false,
          dailyQuota: 5000,
          dailyConsumed: 0,
          dailyCycleDate: today,
        },
      })
    }
    if (url.includes("/api/v1/onboarding/tasks")) {
      return json({ code: "000000", data: { tasks: {}, total: 10000 } })
    }
    throw new Error(`unexpected URL: ${url}`)
  })
  const plugin = await pluginWith(t)

  const result = await plugin.auth.checkin(async () => authFor("host-checkin"), { id: "loomy" })
  assert.equal(result.outcome, "claimed")
  assert.match(result.message, /每日赠送额度/)
  assert.equal(calls.some((c) => c.url.includes("/points/activation")), false)
  assert.equal(calls.some((c) => c.url.includes("/invitation-codes")), false)
})

test("并发刷新：usage / models / checkin 各只向上游发一次", async (t) => {
  let balance = 0
  let models = 0
  let checkin = 0
  let onboarding = 0
  stubFetch(t, async ({ url }) => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (url.includes("/points/balance")) {
      balance += 1
      return json({ code: "000000", data: { balance: 2500, dailyBalance: 4000, availableBalance: 6500 } })
    }
    if (url.includes("/api/v1/models")) {
      models += 1
      return json({ code: "000000", data: [{ id: "spark-x2.6", type: "chat", name: "Spark X2.6 限时免费(x0.0)" }] })
    }
    if (url.includes("/points/first-login")) {
      checkin += 1
      return json({
        code: "000000",
        data: { alreadyProcessed: false, dailyQuota: 5000, dailyConsumed: 0, dailyCycleDate: today },
      })
    }
    if (url.includes("/onboarding/tasks")) {
      onboarding += 1
      return json({ code: "000000", data: { tasks: {}, total: 10000 } })
    }
    throw new Error(`unexpected URL: ${url}`)
  })
  const plugin = await pluginWith(t)
  const auth = authFor("same-flight", { dailyQuota: 5000, dailyCycleDate: today })

  await Promise.all([
    plugin.auth.usage(async () => auth, { id: "loomy" }),
    plugin.auth.usage(async () => auth, { id: "loomy" }),
    plugin.auth.usage(async () => auth, { id: "loomy" }),
  ])
  assert.equal(balance, 1)
  assert.equal(onboarding, 1)

  await Promise.all([
    plugin.provider.models({}, { auth }),
    plugin.provider.models({}, { auth }),
  ])
  assert.equal(models, 1)

  await Promise.all([
    plugin.auth.checkin(async () => auth, { id: "loomy" }),
    plugin.auth.checkin(async () => auth, { id: "loomy" }),
  ])
  assert.equal(checkin, 1)
})

test("动态开关：auto_checkin=false 时返回 ineligible 且不调用写端点", async (t) => {
  let calls = 0
  stubFetch(t, () => {
    calls += 1
    throw new Error("should not be called")
  })
  const plugin = await pluginWith(t, { auto_checkin: false })
  const result = await plugin.auth.checkin(async () => authFor("disabled-checkin"), { id: "loomy" })
  assert.equal(result.outcome, "ineligible")
  assert.equal(calls, 0)
})

test("动态开关：创建插件后读取 magpie.option，修改立即生效", async (t) => {
  let autoCheckin = true
  const plugin = await LoomyAuthPlugin({
    client: {},
    magpie: {
      option(provider, key) {
        assert.equal(provider, "loomy")
        if (key === "auto_checkin") return autoCheckin
        if (key === "claim_task_rewards") return false
        if (key === "auto_invite") return false
        return true
      },
    },
  })

  let calls = 0
  stubFetch(t, ({ url }) => {
    if (url.includes("/points/first-login")) {
      calls += 1
      return json({
        code: "000000",
        data: { alreadyProcessed: true, dailyQuota: 5000, dailyConsumed: 0, dailyCycleDate: today },
      })
    }
    throw new Error(`unexpected URL: ${url}`)
  })

  const first = await plugin.auth.checkin(async () => authFor("dynamic-option"), { id: "loomy" })
  assert.equal(first.outcome, "done")
  assert.equal(calls, 1)

  autoCheckin = false
  const second = await plugin.auth.checkin(async () => authFor("dynamic-option"), { id: "loomy" })
  assert.equal(second.outcome, "ineligible")
  assert.equal(calls, 1)
})

test("插件声明 Magpie 可识别的 auth.options 与 Plus 显示名", async (t) => {
  const plugin = await pluginWith(t)
  assert.equal(plugin.provider.name, "讯飞 Loomy Plus")
  assert.equal(plugin.auth.maxConcurrency, 3)
  const keys = plugin.auth.options.map((option) => option.key)
  assert.deepEqual(keys, [
    "auto_checkin",
    "claim_task_rewards",
    "auto_invite",
    "smooth_chat",
    "risk_cooldown",
  ])
})

test("风控冷却持久化：新实例仍能阻止同一账号继续请求", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loomy-plus-circuit-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const first = new RiskCircuit({ stateDir: dir })
  first.trip("acc_demo", { reason: "需要安全验证", seconds: 600, explicit: true })

  const second = new RiskCircuit({ stateDir: dir })
  const active = second.get("acc_demo")
  assert.ok(active)
  assert.ok(active.remainingSec > 590 && active.remainingSec <= 600)
  assert.equal(active.reason, "需要安全验证")
})

test("同账号错峰：同 key 第二次等待，不同 key 不等待", async () => {
  let now = 1_000
  const delays = []
  const pacer = new AccountPacer({
    minGapMs: 120,
    jitterMinMs: 20,
    jitterMaxMs: 20,
    now: () => now,
    sleep: async (ms) => {
      delays.push(ms)
      now += ms
    },
  })

  await pacer.wait("acc_a")
  await pacer.wait("acc_a")
  await pacer.wait("acc_b")
  assert.deepEqual(delays, [140])
})

test("风控分类：11140 / captcha 冷却两小时，普通 403 冷却十分钟", () => {
  const risk = classifyRestriction({
    status: 200,
    envelope: { code: "11140", message: "账号存在异常行为" },
  })
  assert.equal(risk.restricted, true)
  assert.equal(risk.seconds, 7200)

  const forbidden = classifyRestriction({ status: 403, envelope: { message: "denied" } })
  assert.equal(forbidden.restricted, true)
  assert.equal(forbidden.seconds, 600)
})

test("聊天热路径：已冷却账号本地返回 403 / audit_blocked，零上游请求", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loomy-plus-chat-circuit-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const breaker = new RiskCircuit({ stateDir: dir })
  breaker.trip("acc_chat", { reason: "captcha", seconds: 120, explicit: true })
  let upstream = 0
  stubFetch(t, () => {
    upstream += 1
    return json({ code: "000000", choices: [] })
  })

  const res = await chatFetch({
    input: "https://loomyad.xunfei.cn/api/v1/chat/completions",
    init: { method: "POST", body: JSON.stringify({ model: "spark-x", messages: [] }) },
    credential: null,
    session: "session-under-test",
    usageValue: undefined,
    accountKey: "acc_chat",
    riskCircuit: breaker,
  })

  assert.equal(res.status, 403)
  assert.equal(res.headers.get("X-Magpie-Sign-In"), "kept")
  assert.ok(Number(res.headers.get("Retry-After")) > 0)
  assert.equal((await res.json()).error.code, "audit_blocked")
  assert.equal(upstream, 0)
})

test("聊天热路径：HTTP 200 + code 11140 被改成 403 并写入持久冷却", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loomy-plus-chat-trip-"))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))

  const breaker = new RiskCircuit({ stateDir: dir })
  let upstream = 0
  stubFetch(t, () => {
    upstream += 1
    return json({ code: "11140", message: "账号存在异常行为，请完成安全验证" })
  })

  const first = await chatFetch({
    input: "https://loomyad.xunfei.cn/api/v1/chat/completions",
    init: { method: "POST", body: JSON.stringify({ model: "spark-x", messages: [] }) },
    credential: null,
    session: "session-under-test",
    usageValue: undefined,
    accountKey: "acc_trip",
    riskCircuit: breaker,
  })
  assert.equal(first.status, 403)
  assert.equal(first.headers.get("X-Magpie-Sign-In"), "kept")
  assert.ok(breaker.get("acc_trip"))

  const second = await chatFetch({
    input: "https://loomyad.xunfei.cn/api/v1/chat/completions",
    init: { method: "POST", body: JSON.stringify({ model: "spark-x", messages: [] }) },
    credential: null,
    session: "session-under-test",
    usageValue: undefined,
    accountKey: "acc_trip",
    riskCircuit: breaker,
  })
  assert.equal(second.status, 403)
  assert.equal(upstream, 1, "第二次请求必须由本地冷却拦住")
})

test("聊天成功：code 000000 原样 200，并剥掉外部 SDK / 代理指纹头", async (t) => {
  const calls = stubFetch(t, () => json({ code: "000000", choices: [] }))
  const res = await chatFetch({
    input: "https://loomyad.xunfei.cn/api/v1/chat/completions",
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-stainless-os": "Windows",
        "x-anthropic-version": "2023-06-01",
        "openai-organization": "org-test",
        "x-forwarded-for": "1.2.3.4",
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
        "x-loomy-session": "session-a",
      },
      body: JSON.stringify({ model: "spark-x", messages: [{ role: "user", content: "hi" }] }),
    },
    credential: null,
    session: "session-under-test",
    usageValue: undefined,
  })

  assert.equal(res.status, 200)
  const headers = new Headers(calls[0].init.headers)
  assert.equal(headers.get("x-stainless-os"), null)
  assert.equal(headers.get("x-anthropic-version"), null)
  assert.equal(headers.get("openai-organization"), null)
  assert.equal(headers.get("x-forwarded-for"), null)
  assert.match(headers.get("traceparent"), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  assert.notEqual(headers.get("traceparent"), "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01")
})
