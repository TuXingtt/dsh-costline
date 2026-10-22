# dsh-costline · DSH 花费线

**DeepSeek Harness 的用量与花费，一行看完。** 输入框下方常驻一行：按 **今日 / 本周 / 本月 / 累计** 统计花费，把 **API key 通道** 与 **登录账户通道** 分开计算，并显示两个钱包余额。

```
14 轮 357 步 · 239 tok/s · 112M tok · 缓存命中 99% · 今日 ▾ 合计 ▾ ¥1.23 · API 1.00 · 账户 0.23 · 余 100.00 / 10.00
```

> 为 DSH 0.2.x 编写（`session/event` + `webServer` + `conversation.composer.dock`），不依赖 0.1.x 的 settings-section API。

## 功能

- **四个窗口**：今日 / 本周（周一起）/ 本月 / 累计，下拉一键切换。
- **两个通道分开算**：`API key` 与 `登录账户` 各自计费、各自余额；可切「合计 / API / 账户」。
- **金额跟随官网**：单价每小时从 [官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 抓一次人民币价，峰谷（北京时间工作日 09:00–12:00、14:00–18:00 高峰 ×2）自动切换；抓不到时回落内置价表。
- **历史可回溯**：启动后扫描 `<DSH_HOME>/sessions/**/*.jsonl.zstd`，把每一步 `assistant/message` 的精确 usage 按发生时刻计价写回账本，所以「今日/累计」覆盖日志保留的全部历史，而不是从安装那一刻算起；`seq` 去重，重复回溯不会翻倍。
- **持久账本**：`<DSH_HOME>/storages/dsh-billing-ledger.json`（按天分桶，含 token 与费用），重启不丢。
- **余额**：API key 走 `GET /user/balance`，登录账户走账户钱包；60 秒缓存，失败降级不挡显示。

## 为什么两个通道的取数不一样

| 通道 | 来源 | 说明 |
| --- | --- | --- |
| API key | 本机 token × 官网单价 | 只统计**你自己**的调用。API key 常挂在一个多人共用的账户上，余额差含别人的用量，不可用 |
| 登录账户 | 官方钱包余额变化 | 每分钟采样；当天覆盖不足时回落本机估算 |
| 合计 | API + 账户 | — |

## 安装

```bash
# 方式一：插件管理里选 install_bundle，指向 tgz
# 方式二：CLI
dsh plugin add file:/绝对路径/dsh-costline-0.8.0.tgz
```

重启 DSH 后，输入框下方出现这一行。

## 兼容性

- DSH `>= 0.2.0`（实测 `0.2.1-rc.2`）
- Node `>= 22.19.0`（用到 `zlib.zstdDecompressSync` 回溯会话日志）

## 配置

当前版本无设置页（内置默认 + 官网抓价）。计划：货币选择、峰谷开关、按模型覆盖价、CSV 导出。

## 结构

```
lib/index.js      宿主：session/event 折叠、账本持久化、会话日志回溯、定价页解析、GET /dsh-billing/summary
lib/client.js     浏览器：composer dock 一行 + 两个下拉 + 余额
cordis.patch.yml  挂载行（id: costline）
```

只读接口：`GET /dsh-billing/summary?sessionId=<id>[&refresh=1]`

## License

MIT
