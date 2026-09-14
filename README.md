<div align="center">

# Merchant Bot Swarm · 海外商家机器人群

**三智能体协作：销售出单 ⇄ 海关报关 ⇄ 工厂出货，还会自动建群对齐业务**

[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pi agent framework](https://img.shields.io/badge/pi_agent_framework-pi--agent--core_+_pi--ai-8A2BE2)](https://github.com/badlogic/pi-mono)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-49%20passing-16a34a)](../../actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-green)](LICENSE)

*Multi-agent e-commerce automation: AI sales agents close orders, structure customs declarations, coordinate factory shipping — built on the pi agent framework (pi-agent-core + pi-ai).*

</div>

基于 **[pi agent 框架](https://github.com/badlogic/pi-mono)** 构建的海外商家多智能体（multi-agent）协作系统：三位 AI 智能体各司其职、事件驱动自动接力，异常时自动拉「业务对齐小群」三岗对齐，并配有一个**中文实时可视化仪表盘**（订单看板 / 客户会话 / 报关工作台 / 物流时间线 / 群聊纪要）。

## 它解决什么问题

跨境出海商家的日常 = 跟单员盯客户 + 报关员盯申报 + 采购盯工厂。本项目把这三条线交给三个各司其职的 AI 智能体，用一个**事件驱动编排器**串联成全自动业务闭环：

```
客户消息 ──→ 💼 销售智能体 Sally ──→ 🛃 报关智能体 Leo ──→ 🏭 跟单智能体 Max
             询价/报价/下单           结构化报关单/海关申报       工厂生产单/头程发货
                │                        │                        │
                └──────────── 退单/产能告警 → 自动拉群「业务对齐」←────┘
```

| 智能体 | 职责 | 关键工具（TypeBox 强类型） | 业务规则 |
|---|---|---|---|
| 💼 销售 Sally | 联系客户、报价、促成订单 | `search_catalog` `create_quote` `reply_customer` `create_order` `amend_order` | 阶梯折扣定价、头程物流计费、订单信息与报价强一致 |
| 🛃 报关 Leo | 订单 → 结构化报关单 → 海关申报 | `get_order` `get_hs_code` `submit_declaration` `clear_inspection` `request_order_fix` | 7 条审单规则（HS 编码/单货一致/毛重/UN38.3…），高值布控查验，退单自动转销售补正 |
| 🏭 跟单 Max | 联系工厂生产、安排出货 | `get_declaration` `factory_quote` `place_factory_order` `arrange_shipment` | 未放行不出运、产能不足明确拒单、运单号+物流轨迹全程留痕 |

## 运行效果

**仪表盘总览**——KPI 指标、智能体实时忙闲、订单看板（已下单→报关中→已放行→已发货→已签收）、客户会话：

![仪表盘总览](docs/screenshots/dashboard.png)

**报关工作台**——结构化报关单卡片：申报要素、逐行 HS 编码表、海关受理/查验/退单状态与历史留痕：

![报关工作台](docs/screenshots/customs-workbench.png)

**业务对齐小群**——主持人发议程、三岗依次汇报、自动生成会议纪要（左：订单详情弹窗含完整业务时间线）：

![对齐群聊](docs/screenshots/group-chat.png)

![订单详情](docs/screenshots/order-detail.png)

## 快速开始

```bash
npm install

# 1) 跑测试（49 个用例：单测 + 全链路集成 + API/SSE，全部离线，毫秒级）
npm test

# 2) 无头演示：3 笔订单走完 询价→报价→下单→报关(退单补正/查验放行)→生产→发货→签收 + 对齐会
npm run demo

# 3) 打开可视化仪表盘（默认 http://localhost:8799）
npm run dev
```

打开仪表盘后点 **「▶ 开始自动演示」**，即可实时观看三位客户（美/德/日）从询盘到签收的全过程；也可以在「客户会话」面板亲自扮演客户与销售智能体对话。

### 接入真实大模型

默认使用 pi-ai 自带的 **Faux 假模型**（脚本大脑，离线可跑、行为确定）。配置任意一家 API Key 后自动切换真实模型，系统提示词、工具、编排协议完全不变：

```bash
# AIHubMix（OpenAI 兼容网关）
export AIHUBMIX_API_KEY=sk-xxx
export MERCHANT_LLM_MODEL=gpt-4o-mini        # 可选，默认 gpt-4o-mini

# 或 OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter / ZAI …
export OPENAI_API_KEY=sk-xxx

# 显式指定 provider 与模型
export MERCHANT_LLM_PROVIDER=anthropic
export MERCHANT_LLM_MODEL=claude-sonnet-4-6
```

凭据只从环境变量读取（pi-ai 的凭证解析链），代码与配置不落任何密钥。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MERCHANT_PORT` | `8799` | 仪表盘端口 |
| `MERCHANT_LLM_PROVIDER` | 自动探测 | `faux` / `aihubmix` / `openai` / `anthropic` / `google` / `deepseek` / `openrouter` / `zai` |
| `MERCHANT_LLM_MODEL` | 按 provider 默认 | 模型 ID |
| `MERCHANT_MEETING_INTERVAL_MS` | `180000` | 例行对齐会间隔，`0` 关闭（保留事件触发） |
| `MERCHANT_CARRIER_TICK_MS` | `4000` | 物流轨迹推进间隔 |
| `MERCHANT_DATA_DIR` | `data` | 状态持久化目录（JSON，原子写入） |

## 核心特性

- **多智能体协作（multi-agent orchestration）**：每个岗位一个 pi `Agent` 实例，TypeBox 工具校验、事件流、串行任务队列全部来自 pi 框架本身，无自研黑盒。
- **结构化报关输出**：报关单是强类型 JSON Schema（出口商/收货人/逐行 HS 编码/申报价值/毛重/随附单证），由海关规则引擎做 7 条确定性审单。
- **业务对齐小群（agent group chat）**：海关退单、工厂拒单等异常自动拉三岗对齐会；议程 → 汇报 → 会议纪要（含行动项）全程留痕。
- **双大脑一套协议**：faux 脚本大脑与真实 LLM 消费同一份任务信封与系统提示词，测试结果对线上行为有约束力。
- **完整留痕**：订单时间线、报关单退单历史、运单轨迹全部持久化（JSON 原子写入），仪表盘所见即可复查。
- **实时可视化**：SSE 推送全部业务事件，无依赖单页中文仪表盘，`node src/main.ts` 即起。

## 实测数据（本仓库自带场景，可复现）

`npm run demo` 的实测输出（faux 脚本模型，Node 26 / macOS arm64）：

```
订单 3 笔 | 营收 $7307 | 已交付 3 | 对齐会 2 场 | 智能体任务 27 次
```

覆盖的业务支线：

- **UN38.3 退单补正**：含锂电池货物首报缺 UN38.3 → 海关退单 → 自动拉对齐群 → 销售补正备注 → 重报放行（报关单 `previousIssues` 留痕）
- **高值布控查验**：申报总值 ≥ 2000 USD → 海关布控 → 查验放行（David $3648.8 / Lena $2706.6 两单命中）
- **直接受理**：低值非电池订单一次通过（Ken $951.6）
- **工厂产能**：排产确认；产能不足时明确拒单 → 订单转异常 → 对齐群协调
- **物流轨迹**：揽收 → 干线中转 → 出口放行 → 签收，全程事件留痕

```bash
# 复现测试结果
npm test
# 期望：Test Files 5 passed · Tests 49 passed
```

## 项目结构

```
src/
  config.ts            运行配置与 provider 自动探测
  types.ts             领域模型（订单/报关单/运单/群聊/事件）
  catalog.ts           商品目录、阶梯定价、头程报价
  customsRules.ts      海关审单规则引擎（7 条规则，纯函数）
  factoryService.ts    工厂产能/生产单 + 承运商轨迹模拟
  store.ts             业务状态仓库 + 事件总线 + JSON 持久化
  llm.ts               pi-ai 模型装配（faux / aihubmix / 内置 provider）
  swarm.ts             编排器：事件驱动联动 + 对齐会 + 自动客户
  scenario.ts          自动演示场景（CLI 与 GUI 共用）
  server.ts            HTTP + REST + SSE
  agents/
    base.ts            pi Agent 基座（串行任务队列 + 活动日志）
    tools.ts           三岗业务工具（TypeBox 强类型）
    tasks.ts           任务信封协议（渲染/解析互逆，两套大脑共用）
    director.ts        faux 模式脚本大脑（确定性决策器）
  public/              无依赖单页仪表盘（中文）
test/
  unit/                规则引擎 / 定价 / 工厂 / 状态机 / 信封协议
  integration/         全链路 e2e（两条客户路径）+ API/SSE
scripts/demo.ts        无头演示入口
```

## 常见问题（FAQ）

**Q：必须配大模型 API Key 才能跑吗？**
不需要。默认走 pi-ai 的 Faux 假模型（脚本大脑），离线即可演示与跑完全部 49 个测试。配置任意一家 Key 后自动切换真实模型。

**Q：报关单是自由文本还是结构化数据？**
结构化 JSON（TypeBox Schema 强校验）：出口商、收货人、运抵国、贸易术语、逐行 HS 编码/数量/单价、毛重、随附单证。海关规则引擎按 7 条规则审单，退单会给出具体原因清单。

**Q：三个智能体是怎么协作的？谁调用谁？**
没有硬编码调用链。每个工具调用产生业务事件（如 `order.created`、`declaration.rejected`），编排器把事件变成下一个岗位的任务信封；对齐会由异常事件或定时器触发。

**Q：可以换成真实的海关/工厂/物流接口吗？**
可以。`customsRules.ts`、`factoryService.ts` 是纯函数模块，把模拟实现替换成真实 API 适配器即可，智能体工具层与编排协议不变。

**Q：重报一直失败会不会死循环？**
不会。同一订单重报超过 3 次自动熔断，转人工并在对齐群留痕。

## 局限（诚实说明）

- 海关审单、工厂产能、物流轨迹均为**模拟服务**（规则确定性，便于回归测试），接真实接口需自行适配。
- faux 脚本大脑只覆盖演示场景的话术路径；真实业务对话请接入真实 LLM（换 Key 即可，业务代码零改动）。
- 状态持久化是单机 JSON 文件，适合演示与中小规模；高并发需要换 SQLite/Postgres 后端。

## 相关项目

- [agent-mesh](https://github.com/JingHao-Leon/agent-mesh) — ~700 行多 Agent 框架（工具 schema 自动生成、Swarm handoff、护栏、记忆）
- [llm-gateway](https://github.com/JingHao-Leon/llm-gateway) — OpenAI 兼容网关（路由/故障转移/熔断/限流/Prometheus）
- [rag-forge](https://github.com/JingHao-Leon/rag-forge) — BM25×稠密混合检索 + RRF + MMR

## License

MIT
