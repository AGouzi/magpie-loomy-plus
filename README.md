# 讯飞 Loomy Plus for Magpie

这是 `MYCF711/magpie-loomy-auth` 的个人增强分支，保留原插件已经验证过的
Loomy 登录、签到、额度窗口、桌面端 leveldb 读取和聊天追踪头，只补足并发与
风控稳定性。

> 本仓库是第三方插件，不是讯飞官方产品，也不承诺账号不会被风控。
> 它修正的是**插件契约与请求行为**，不能消除平台规则、上游故障或账号共享带来的风险。

## 与原插件的关系

- 上游基线：`MYCF711/magpie-loomy-auth` `0.1.28`
- 本分支：`AGouzi/magpie-loomy-plus` `0.2.0`
- Magpie 内部供应商 ID 仍是 `loomy`，这样已有登录态、路由组和账号记录不会断
- 卡片与供应商显示名改为 **讯飞 Loomy Plus**

## 修复的核心问题

- `auth.usage(getAuth, provider)`、`auth.checkin(getAuth, provider)`、
  `provider.models(provider, { auth })` 全部按 Magpie 宿主真实签名调用
- 签到只返回契约允许的 `claimed / done / ineligible / inactive / captcha / failed`
- `code: "000000"` 的 Loomy 成功信封不会被误判为失败
- 两个积分池按宿主语义上报：今日池参与路由，永久池 `aside`，两池皆空时沉底
- 桌面端登录读取 Loomy 0.9.39 的 `Local Storage/leveldb`，不依赖不存在的 `auth.json`
- `/chat/completions` 带官方客户端要求的追踪头，SSE 不缓冲

## 本分支新增

- **并发去重**：同一账号的 usage、models、checkin 并发刷新只向上游发一次
- **有界缓存**：TTL + 容量上限，避免长会话积累无界 Map
- **持久风控冷却**：明确命中风控 / 人机验证后，该账号冷却两小时；普通 403 冷却十分钟
- **同账号错峰**：聊天请求起点间隔约 120–200 ms，不限制不同账号并行
- **请求头收缩**：不把外部 SDK、Anthropic、OpenAI、代理转发的指纹头透传给 Loomy
- **动态开关**：读取 `magpie.option("loomy", key)`，修改后无需重启

## 开关

| key | 默认 | 作用 |
|---|---:|---|
| `auto_checkin` | 开 | 关闭后签到返回 `ineligible`，不调用写端点 |
| `claim_task_rewards` | 开 | 尝试领取新手奖励；上游拒绝的任务跳过，不影响签到 |
| `auto_invite` | **关** | 开启后才使用本机其它账号的邀请码，且每号只兑换一次 |
| `smooth_chat` | 开 | 同账号聊天请求轻微错峰 |
| `risk_cooldown` | 开 | 命中风控后持久冷却，跨 Magpie 重启保留 |

自动跨账号邀请默认关闭。它会明显增加账号关联和风控风险，不建议主账号开启。

## 登录

1. **桌面端导入**：读取本机 Loomy 客户端 leveldb 中的 `loomy-auth-session`
2. **手机号 + 短信验证码**
3. **粘贴 session**

Loomy 没有续期接口，session 固定 14 天；插件不会伪造 refresh token。

## 安装

本分支尚未发布到 npm。可直接从 GitHub 安装：

```bash
magpie plugin add github:AGouzi/magpie-loomy-plus
```

或本地打包：

```bash
npm pack
```

安装前先卸载其它 Loomy 插件，因为它们会争用同一个 `loomy` 供应商 ID。

## 测试

```bash
npm test
npm run check:ua
```

测试全部离线，不读取真实账号、不消费积分。

## 许可与来源

MIT。原项目版权与第三方参考见 [`NOTICE.md`](./NOTICE.md) 和 [`LICENSE`](./LICENSE)。
