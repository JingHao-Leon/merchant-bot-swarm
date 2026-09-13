# 海外商家机器人群 · Merchant Bot Swarm

基于 **[pi agent 框架](https://github.com/badlogic/pi-mono)**（`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`）构建的海外商家多智能体协作系统：三个业务智能体各司其职、自动接力，时不时自动建一个「业务对齐小群」同步进度，并配有一个**实时可视化仪表盘**。

```
客户消息 ──→ 💼 销售智能体 Sally ──→ 🛃 报关智能体 Leo ──→ 🏭 跟单智能体 Max
             询价/报价/下单           结构化报关单/海关申报       工厂生产单/头程发货
                │                        │                        │
                └──────────── 退单/产能告警 → 自动拉群「业务对齐」←────┘
```

## 三个智能体与业务闭环

| 智能体 | 职责 | 关键工具（TypeBox 强类型） | 业务规则 |
|---|---|---|---|
| 💼 销售 Sally | 联系客户、报价、促成订单 | `search_catalog` `create_quote` `reply_customer` `create_order` `amend_order` | 阶梯折扣定价、头程物流计费、订单信息与报价强一致 |
| 🛃 报关 Leo | 订单 → 结构化报关单 → 海关申报 | `get_order` `get_hs_code` `submit_declaration` `clear_inspection` `request_order_fix` | 7 条审单规则（HS 编码/单货一致/毛重/UN38.3…），高值布控查验，退单自动转销售补正 |
| 🏭 跟单 Max | 联系工厂生产、安排出货 | `get_declaration` `factory_quote` `place_factory_order` `arrange_shipment` | 未放行不出运、产能不足明确拒单、运单号+物流轨迹全程留痕 |

**业务对齐小群**：海关退单 / 工厂拒单等异常自动拉「三岗对齐群」，定时（默认 3 分钟，可配）也会例行开会——主持人发议程 → 三岗依次汇报 → 自动生成会议纪要（含行动项）归档。

**编排方式**：没有硬编码调用链。所有智能体通过 pi 的 AgentTool 产生业务副作用（建单/申报/发货），副作用变成事件，事件驱动下一环节的智能体接单——真实 LLM 与离线脚本模型走的是同一套协议。

## 快速开始

```bash
npm install

# 1) 跑测试（49 个用例：单测 + 全链路集成 + API/SSE，全部离线）
npm test

# 2) 无头演示：3 笔订单走完全流程 + 退单补正 + 查验放行 + 对齐会
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

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MERCHANT_PORT` | `8799` | 仪表盘端口 |
| `MERCHANT_LLM_PROVIDER` | 自动探测 | `faux` / `aihubmix` / `openai` / `anthropic` / `google` / `deepseek` / `openrouter` / `zai` |
| `MERCHANT_LLM_MODEL` | 按 provider 默认 | 模型 ID |
| `MERCHANT_MEETING_INTERVAL_MS` | `180000` | 例行对齐会间隔，`0` 关闭（保留事件触发） |
| `MERCHANT_CARRIER_TICK_MS` | `4000` | 物流轨迹推进间隔 |
| `MERCHANT_DATA_DIR` | `data` | 状态持久化目录（JSON，原子写入） |

## 仪表盘一览

- **KPI 区**：总订单 / 成交额 / 待报关 / 已放行 / 在途 / 已交付 + 近 7 日成单柱状图
- **智能体状态卡**：三个岗位的模型、任务数、异常数、实时忙闲与最近动作
- **订单看板**：已下单 → 报关中 → 已放行 → 已发货 → 已签收 五列流水线，异常单独成列，点击订单看完整详情（时间线 / 报关单 / 运单轨迹 / 退单留痕）
- **客户会话**：销售与客户的全过程对话，可亲自扮演客户追问
- **报关工作台**：结构化报关单卡片（申报要素 + HS 编码表 + 海关回执 + 历次退单原因）
- **出货工作台**：生产单、工厂沟通记录、承运商物流时间线
- **对齐群聊**：每场对齐会的议程、三岗发言、会议纪要
- **事件流**：全系统业务事件实时推送（SSE）

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

## 设计要点

- **pi Agent 循环原样使用**：每个岗位一个 `Agent` 实例（`pi-agent-core`），TypeBox 工具校验、事件流、串行任务队列全部来自框架本身。
- **两套大脑、一套协议**：`tasks.ts` 定义的任务信封同时是真实 LLM 的用户提示与 faux 脚本大脑的解析输入；接真实模型不改任何业务代码。
- **确定性可回归**：海关规则、工厂产能、轨迹推进全部纯函数；faux 大脑按对话状态决策，因此 49 个测试完全离线、毫秒级、可 CI。
- **熔断保护**：同一订单重报超过 3 次自动停止重试并转人工，杜绝“退单→补正”死循环。
- **事件溯源式留痕**：订单时间线、报关单退单历史、运单轨迹全部持久化，GUI 所见即可复查。

## License

MIT
