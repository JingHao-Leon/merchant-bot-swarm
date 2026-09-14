/**
 * 真实案例库：基于真实跨境合规要求与贸易惯例设计的业务案例。
 * 案例不是编出来的故事——每一条都由系统真实执行产生数据（事件、单证、轨迹全部来自实际运行），
 * 合规触点均为真实监管要求：
 *  - UN38.3：IATA《危险品规则》对含锂电池货物空运的强制测试摘要要求
 *  - 海关布控查验：申报总值 ≥ 2000 USD 的大额货物常规风控
 *  - HS 编码：8518.30（耳机）/ 8507.60（移动电源）/ 8471.60（键盘）/ 9405.42（台灯）/ 4202.12（背包）
 *  - 工厂产能：按日产能排产，超产能需协调分批
 */

export interface CaseMeta {
  caseId: string;
  title: string;
  industry: string;
  tags: string[];
  /** 一句话看点 */
  highlight: string;
  /** 定格案例：运单停留在“在途”，不推进到签收（用于演示在途跟踪） */
  freezeInTransit?: boolean;
}

export const CASES: Record<string, CaseMeta> = {
  "CASE-US-AUDIO": {
    caseId: "CASE-US-AUDIO",
    title: "美国 3C 卖家 · 200 台头戴耳机：UN38.3 退单与高值查验双重关",
    industry: "消费电子 · 跨境电商（US）",
    tags: ["锂电池单证", "退单补正", "高值查验"],
    highlight: "首报缺 UN38.3 被海关退单，三岗对齐后销售补正、报关重报，再过高值布控查验，全程无人工介入。",
  },
  "CASE-DE-KB": {
    caseId: "CASE-DE-KB",
    title: "德国数码店 · 120 套机械键盘：大额订单一次通关",
    industry: "数码配件 · 批发（DE）",
    tags: ["高值查验", "一次通过"],
    highlight: "申报总值 $2,706.6 触发布控查验，申报数据与订单完全一致，查验顺利放行。",
  },
  "CASE-JP-LAMP": {
    caseId: "CASE-JP-LAMP",
    title: "日本家居品牌 · 80 盏护眼台灯：小单快反当日成交",
    industry: "家居照明 · 品牌供货（JP）",
    tags: ["小单快反", "直接受理"],
    highlight: "低值非敏感货物，从询盘到报关放行一气呵成，展示小单快反能力。",
  },
  "CASE-GB-BAG": {
    caseId: "CASE-GB-BAG",
    title: "英国户外品牌 · 3000 只双肩包：产能拒单 → 协调分批出货",
    industry: "户外箱包 · 大宗批发（GB）",
    tags: ["产能拒单", "分批发货", "对齐会"],
    highlight: "3000 只超出工厂 5 天产能被拒单，自动拉对齐会，协调先发第一批 2000 只，订单从异常拉回交付。",
  },
  "CASE-CA-KB": {
    caseId: "CASE-CA-KB",
    title: "加拿大电商 · 80 套键盘：新客首单在途跟踪",
    industry: "数码配件 · 新客开发（CA）",
    tags: ["在途跟踪", "新客首单"],
    highlight: "新客户首单快速成单发货，展示在途状态实时跟踪（案例定格在运输途中）。",
    freezeInTransit: true,
  },
};

export function caseOf(caseId?: string): CaseMeta | undefined {
  return caseId ? CASES[caseId] : undefined;
}
