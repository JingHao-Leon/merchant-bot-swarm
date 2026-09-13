/* 海外商家机器人群 · 仪表盘前端逻辑（原生 JS，无依赖） */
"use strict";

const state = {
  data: null,
  events: [],
  activeTab: "chat",
  demoLines: [],
  orderSeq: [],
};

const STATUS_META = {
  inquiry: { label: "询价中", color: "#94a3b8", soft: "#f1f5f9" },
  quoted: { label: "已报价", color: "#2563eb", soft: "#dbeafe" },
  confirmed: { label: "已下单", color: "#4f46e5", soft: "#e0e7ff" },
  declaring: { label: "报关中", color: "#d97706", soft: "#fef3c7" },
  declared: { label: "已放行", color: "#0d9488", soft: "#ccfbf1" },
  fulfilling: { label: "备货中", color: "#7c3aed", soft: "#ede9fe" },
  shipped: { label: "已发货", color: "#0891b2", soft: "#cffafe" },
  delivered: { label: "已签收", color: "#16a34a", soft: "#dcfce7" },
  exception: { label: "异常", color: "#dc2626", soft: "#fee2e2" },
  cancelled: { label: "已取消", color: "#64748b", soft: "#f1f5f9" },
};
const BOARD_COLUMNS = ["confirmed", "declaring", "declared", "shipped", "delivered"];
const ROLE_META = {
  sales: { icon: "💼", name: "销售 Sally" },
  customs: { icon: "🛃", name: "报关 Leo" },
  fulfillment: { icon: "🏭", name: "跟单 Max" },
  coordinator: { icon: "📋", name: "主持人" },
  system: { icon: "⚙️", name: "系统" },
  customer: { icon: "🙋", name: "客户" },
};
const DECL_STATUS_META = {
  draft: { label: "整理中", cls: "draft" },
  submitted: { label: "已提交", cls: "draft" },
  accepted: { label: "海关受理", cls: "accepted" },
  rejected: { label: "退单补正", cls: "rejected" },
  inspection: { label: "查验中", cls: "inspection" },
  cleared: { label: "查验放行", cls: "cleared" },
};
const SHIP_STATUS_META = {
  arranging: "安排中",
  factory_confirmed: "工厂已排产",
  picked_up: "已揽收",
  in_transit: "干线运输中",
  export_cleared: "出口放行",
  delivered: "已签收",
  delayed: "延误",
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
const fmtFull = (ts) => new Date(ts).toLocaleString("zh-CN", { hour12: false });
const flagOf = (cc) => ({ US: "🇺🇸", DE: "🇩🇪", GB: "🇬🇧", FR: "🇫🇷", AU: "🇦🇺", CA: "🇨🇦", JP: "🇯🇵", SG: "🇸🇬", CN: "🇨🇳" }[cc] ?? "🌍");

// ---------------- 数据获取 ----------------
async function refresh() {
  try {
    const res = await fetch("/api/state");
    state.data = await res.json();
    render();
  } catch (e) {
    $("#provider-text").textContent = "服务离线";
  }
}

function connectSSE() {
  const es = new EventSource("/api/events");
  es.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data);
      state.events.unshift(event);
      if (state.events.length > 200) state.events.pop();
      if (event.type === "demo.log") pushDemoLine(event.data.line);
      refresh();
    } catch (e) { /* 忽略心跳 */ }
  };
  es.onerror = () => setTimeout(connectSSE, 3000);
}

// ---------------- 渲染 ----------------
function render() {
  const d = state.data;
  if (!d) return;
  $("#provider-text").textContent = `模型：${d.provider}`;
  renderKpi(d.kpis);
  renderAgents(d.agents);
  renderBoard(d.orders, d.declarations);
  renderTab(d);
  $("#btn-demo").disabled = d.demoRunning;
  $("#btn-demo").textContent = d.demoRunning ? "演示进行中…" : "▶ 开始自动演示";
}

function renderKpi(k) {
  $("#kpi-orders").textContent = k.totalOrders;
  $("#kpi-revenue").innerHTML = `${k.totalRevenueUsd.toLocaleString()} <small>USD</small>`;
  $("#kpi-decl").textContent = k.pendingDeclaration;
  $("#kpi-ok").textContent = k.declaredOk;
  $("#kpi-transit").textContent = k.inTransit;
  $("#kpi-done").textContent = k.delivered;
  const max = Math.max(1, ...k.recentOrdersPerDay.map((x) => x.count));
  $("#chart-days").innerHTML =
    '<svg viewBox="0 0 140 56" width="100%" height="56">' +
    k.recentOrdersPerDay
      .map((x, i) => {
        const w = 140 / Math.max(1, k.recentOrdersPerDay.length);
        const h = (x.count / max) * 40;
        return `<rect x="${i * w + w * 0.18}" y="${44 - h}" width="${w * 0.64}" height="${h}" rx="2.5" fill="#3b82f6"></rect>
                <text x="${i * w + w / 2}" y="53" font-size="7.5" fill="#94a3b8" text-anchor="middle">${x.day.slice(3)}</text>
                ${x.count ? `<text x="${i * w + w / 2}" y="${41 - h}" font-size="7.5" fill="#475569" text-anchor="middle">${x.count}</text>` : ""}`;
      })
      .join("") +
    "</svg>";
}

function renderAgents(agents) {
  $("#agents-row").innerHTML = agents
    .map((a) => {
      const meta = ROLE_META[a.role];
      const last = a.activity[0]?.text ?? "待命";
      return `<div class="card agent-card ${a.busy ? "busy" : ""}">
        <div class="avatar ${a.role}">${meta.icon}<span class="busy"></span></div>
        <div class="info">
          <div class="name">${meta.name} ${a.busy ? '<span style="color:var(--green);font-size:11px">● 工作中</span>' : ""}</div>
          <div class="meta">${esc(a.model)} · 任务 ${a.stats.tasks} 次 · 异常 ${a.stats.errors}</div>
          <div class="last-act" title="${esc(last)}">最近：${esc(last)}</div>
        </div>
      </div>`;
    })
    .join("");
}

function renderBoard(orders, declarations) {
  const cols = BOARD_COLUMNS.map((st) => {
    const meta = STATUS_META[st];
    const list = orders.filter((o) => o.status === st);
    const cards = list
      .map((o) => {
        const flags = [];
        const decl = declarations.find((dd) => dd.orderId === o.id);
        if (decl?.status === "rejected") flags.push("退单补正中");
        if (decl?.status === "inspection") flags.push("海关查验中");
        return `<div class="order-card" style="border-left-color:${meta.color}" onclick="openOrder('${o.id}')">
          <div class="id">${o.id}</div>
          <div class="cust">${flagOf(o.customer.country)} ${esc(o.customer.name)} · ${o.items.map((i) => i.sku + "×" + i.qty).join(", ")}</div>
          <div class="amt">$${o.totalAmount.toLocaleString()}</div>
          ${flags.length ? `<div class="flag">⚠ ${flags.join(" · ")}</div>` : ""}
        </div>`;
      })
      .join("");
    return `<div>
      <div class="col-head"><span style="color:${meta.color}">●</span>${meta.label}<span class="col-count">${list.length}</span></div>
      <div class="olist">${cards || ""}</div>
    </div>`;
  });
  const exceptions = orders.filter((o) => o.status === "exception");
  const extra = exceptions.length
    ? `<div><div class="col-head"><span style="color:#dc2626">●</span>异常<span class="col-count">${exceptions.length}</span></div>
       <div class="olist">${exceptions
         .map(
           (o) => `<div class="order-card" style="border-left-color:#dc2626" onclick="openOrder('${o.id}')">
             <div class="id">${o.id}</div><div class="cust">${esc(o.customer.name)}</div>
             <div class="flag">⚠ ${esc(o.timeline[o.timeline.length - 1]?.text ?? "")}</div></div>`,
         )
         .join("")}</div></div>`
    : "";
  $("#board").innerHTML = cols.join("") + extra;
}

// ---------------- 右侧工作台 Tabs ----------------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    state.activeTab = tab.dataset.tab;
    if (state.data) renderTab(state.data);
  });
});

function renderTab(d) {
  const body = $("#tab-body");
  switch (state.activeTab) {
    case "chat": body.innerHTML = renderChat(d); break;
    case "customs": body.innerHTML = renderCustoms(d); break;
    case "ship": body.innerHTML = renderShip(d); break;
    case "group": body.innerHTML = renderGroup(d); break;
    case "feed": body.innerHTML = renderFeed(); break;
  }
}

function bubble(msg) {
  const meta = ROLE_META[msg.from] ?? { icon: "·", name: msg.from };
  if (msg.from === "system") {
    return `<div class="bubble system">⚙️ ${esc(msg.text)}</div>`;
  }
  const who = msg.from === "customer" ? "🙋 客户" : `${ROLE_META[msg.from].icon} ${ROLE_META[msg.from].name}`;
  return `<div class="bubble ${msg.from}"><div class="who">${who} · ${fmtTime(msg.ts)}</div>${esc(msg.text).replace(/\n/g, "<br>")}</div>`;
}

function renderChat(d) {
  if (!d.customerRooms.length) return emptyHint("暂无客户会话", "点右上角「开始自动演示」，或直接扮演客户发消息");
  return d.customerRooms
    .map((room) => {
      const last = room.messages[room.messages.length - 1];
      const input = `<div class="chat-input">
        <input id="in-${room.id}" placeholder="以 ${esc(room.customerName)} 的身份追问…" onkeydown="if(event.key==='Enter')sendCustomer('${esc(room.customerName)}','${room.country}','in-${room.id}')" />
        <button onclick="sendCustomer('${esc(room.customerName)}','${room.country}','in-${room.id}')">发送</button>
      </div>`;
      return `<div class="chat-room">
        <div class="room-title">${flagOf(room.country)} ${esc(room.customerName)}（${room.country} · ${room.channel}）· ${room.messages.length} 条消息</div>
        ${room.messages.slice(-14).map(bubble).join("")}
        ${last && last.from === "sales" ? input : ""}
      </div>`;
    })
    .join("");
}

async function sendCustomer(name, country, inputId) {
  const input = document.getElementById(inputId);
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await fetch("/api/customer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName: name, country, text }),
  });
}

function renderCustoms(d) {
  if (!d.declarations.length) return emptyHint("暂无报关单", "订单确认后会自动进入报关工作台");
  return d.declarations
    .map((decl) => {
      const meta = DECL_STATUS_META[decl.status];
      const p = decl.payload;
      return `<div class="decl-card">
        <div class="head"><b>${decl.id} · 订单 ${esc(decl.orderId)}</b><span class="chip ${meta.cls}">${meta.label}</span></div>
        <div class="kv">
          <span class="k">报关单号</span><span class="v">${esc(decl.declarationNo ?? "—")}</span>
          <span class="k">出口商</span><span class="v">${esc(p.exporterName)}（${p.exporterCountry}）</span>
          <span class="k">收货人</span><span class="v">${flagOf(p.consigneeCountry)} ${esc(p.consigneeName)}（${p.consigneeCountry}）</span>
          <span class="k">运抵国</span><span class="v">${flagOf(p.destinationCountry)} ${p.destinationCountry}</span>
          <span class="k">申报总值</span><span class="v">${p.currency} ${p.declaredValue.toLocaleString()}</span>
          <span class="k">毛重/条款</span><span class="v">${p.grossWeightKg} kg · ${p.incoterm}</span>
          ${p.notes ? `<span class="k">随附单证</span><span class="v">📄 ${esc(p.notes)}</span>` : ""}
        </div>
        <table class="hs">
          <tr><th>SKU</th><th>品名</th><th>HS 编码</th><th>数量</th><th>单价</th><th>总值</th></tr>
          ${p.items
            .map(
              (it) =>
                `<tr><td>${esc(it.sku)}</td><td>${esc(it.description)}</td><td>${it.hsCode}</td><td>${it.qty}</td><td>${it.unitValue}</td><td>${it.totalValue}</td></tr>`,
            )
            .join("")}
        </table>
        ${decl.issues.length ? decl.issues.map((i) => `<div class="issue">⛔ ${esc(i)}</div>`).join("") : ""}
        ${decl.previousIssues.length ? `<div class="issue warn">🕘 历史退单 ${decl.previousIssues.length} 次：${esc(decl.previousIssues.flat().join("；"))}</div>` : ""}
      </div>`;
    })
    .join("");
}

function renderShip(d) {
  const ships = d.shipments;
  if (!ships.length) return emptyHint("暂无运单", "报关放行后，跟单智能体会联系工厂生产并发货");
  return ships
    .map((s) => {
      const order = d.orders.find((o) => o.id === s.orderId);
      return `<div class="decl-card">
        <div class="head"><b>${s.id} · 订单 ${esc(s.orderId)}</b><span class="chip ${s.status === "delayed" ? "rejected" : s.status === "delivered" ? "cleared" : "inspection"}">${SHIP_STATUS_META[s.status] ?? s.status}</span></div>
        <div class="kv">
          <span class="k">工厂</span><span class="v">${esc(s.factoryId)}${s.factoryOrderNo ? ` · 生产单 ${s.factoryOrderNo}` : ""}</span>
          <span class="k">承运</span><span class="v">${s.carrier ? `${s.carrier} · 运单号 ${s.trackingNo}` : "待安排"}${s.cost ? ` · 头程 $${s.cost}` : ""}</span>
        </div>
        <div class="sec-title">物流轨迹</div>
        <div class="tl">${[...s.events].reverse().map((e) => `<div class="tl-item done">${SHIP_STATUS_META[e.status] ?? e.status} · ${esc(e.text)}<div class="t">${fmtFull(e.ts)}</div></div>`).join("")}</div>
        ${s.factoryChat.length ? `<div class="sec-title">工厂沟通</div>${s.factoryChat.map((m) => `<div class="group-msg"><div class="gavatar" style="background:${m.from === "fulfillment" ? "#7c3aed" : "#0891b2"}">${m.from === "fulfillment" ? "🤖" : "🏭"}</div><div class="gtext"><b>${m.from === "fulfillment" ? "跟单 Max" : "工厂"}</b>${esc(m.text)}</div></div>`).join("")}` : ""}
      </div>`;
    })
    .join("");
}

function renderGroup(d) {
  if (!d.groupRooms.length) return emptyHint("暂无对齐会", "三个智能体会定时/在业务节点自动建群对齐，也可点「立即对齐开会」");
  return d.groupRooms
    .map((room) => {
      const cls = (from) => (ROLE_META[from]?.icon ?? "·");
      const color = (from) => ({ sales: "#2563eb", customs: "#d97706", fulfillment: "#7c3aed", coordinator: "#16a34a" }[from] ?? "#64748b");
      return `<div class="group-room">
        <div class="group-head"><span>👥 ${esc(room.topic)}（${room.id}）</span><span class="chip ${room.status === "open" ? "inspection" : "cleared"}">${room.status === "open" ? "进行中" : "已归档"}</span></div>
        <div class="group-body">
          ${room.messages
            .map(
              (m) => `<div class="group-msg">
                <div class="gavatar" style="background:${color(m.from)}">${cls(m.from)}</div>
                <div class="gtext"><b>${ROLE_META[m.from]?.name ?? m.from} · ${fmtTime(m.ts)}</b>${esc(m.text).replace(/\n/g, "<br>")}</div>
              </div>`,
            )
            .join("")}
          ${room.minutes
            ? `<div class="minutes"><div class="ttl">📋 会议纪要（${fmtFull(room.minutes.closedAt)}）</div>${esc(room.minutes.summary)}<ul>${room.minutes.actionItems.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>`
            : ""}
        </div>
      </div>`;
    })
    .join("");
}

function renderFeed() {
  if (!state.events.length) return emptyHint("暂无事件", "所有业务动作都会实时显示在这里");
  return `<div class="feed">${state.events
    .slice(0, 80)
    .map((e) => {
      const t = fmtTime(e.ts);
      const label = EVENT_LABEL[e.type] ?? e.type;
      const detail = e.orderId ? `<b>${e.orderId}</b> ` : "";
      return `<div class="feed-item"><span class="time">${t}</span><span class="txt">${esc(label)} ${detail}${e.data?.line ? esc(e.data.line) : ""}</span></div>`;
    })
    .join("")}</div>`;
}

const EVENT_LABEL = {
  "quote.created": "生成报价",
  "order.created": "订单成立",
  "order.confirmed": "订单确认",
  "order.declaring": "递交申报",
  "order.declared": "报关放行",
  "order.shipped": "已发货",
  "order.delivered": "客户签收",
  "order.exception": "订单异常",
  "order.amended": "订单修订",
  "declaration.accepted": "申报受理",
  "declaration.rejected": "申报退单",
  "declaration.inspection": "布控查验",
  "shipment.created": "建运单",
  "shipment.updated": "物流更新",
  "factory.message": "工厂消息",
  "meeting.opened": "对齐会开始",
  "meeting.closed": "对齐会结束",
  "group.message": "群消息",
  "customer.message": "客户消息",
  "agent.customer_reply": "销售回复",
  "demo.log": "演示",
  "store.reset": "数据重置",
};

function emptyHint(title, sub) {
  return `<div class="empty"><div class="big">🐳</div><b>${title}</b><div style="margin-top:6px">${sub}</div></div>`;
}

// ---------------- 订单详情弹窗 ----------------
window.openOrder = function (orderId) {
  const d = state.data;
  const o = d.orders.find((x) => x.id === orderId);
  if (!o) return;
  const decl = d.declarations.find((x) => x.orderId === orderId);
  const ship = d.shipments.find((x) => x.orderId === orderId);
  const meta = STATUS_META[o.status];
  $("#modal-body").innerHTML = `
    <h3>${o.id} · ${flagOf(o.customer.country)} ${esc(o.customer.name)}
      <span class="chip" style="background:${meta.soft};color:${meta.color};margin-left:8px">${meta.label}</span></h3>
    <div class="cols">
      <div>
        <div class="kv" style="margin-top:4px">
          <span class="k">渠道/目的国</span><span class="v">${o.customer.channel} → ${flagOf(o.customer.country)} ${o.customer.country}</span>
          <span class="k">金额</span><span class="v">${o.currency} ${o.totalAmount.toLocaleString()}（${o.incoterm}）</span>
          <span class="k">地址</span><span class="v">${esc(o.shippingAddress)}</span>
          ${o.note ? `<span class="k">备注</span><span class="v">${esc(o.note)}</span>` : ""}
        </div>
        <div class="sec-title">商品明细</div>
        <table class="hs">
          <tr><th>SKU</th><th>品名</th><th>数量</th><th>单价</th></tr>
          ${o.items.map((i) => `<tr><td>${i.sku}</td><td>${esc(i.name)}</td><td>${i.qty}</td><td>${i.unitPrice}</td></tr>`).join("")}
        </table>
        <div class="sec-title">订单时间线</div>
        <div class="tl">${[...o.timeline].reverse().map((t) => `<div class="tl-item done">${esc(t.text)}<div class="t">${fmtFull(t.ts)}</div></div>`).join("")}</div>
      </div>
      <div>
        <div class="sec-title">🛃 报关单</div>
        ${decl ? customsBlock(decl) : '<div class="empty">尚未申报</div>'}
        <div class="sec-title">🚚 运单</div>
        ${ship ? shipBlock(ship) : '<div class="empty">尚未建单</div>'}
      </div>
    </div>`;
  $("#modal-mask").classList.add("show");
};

function customsBlock(decl) {
  const meta = DECL_STATUS_META[decl.status];
  const p = decl.payload;
  return `<div class="decl-card">
    <div class="head"><b>${decl.id}</b><span class="chip ${meta.cls}">${meta.label}</span></div>
    <div class="kv">
      <span class="k">报关单号</span><span class="v">${esc(decl.declarationNo ?? "—")}</span>
      <span class="k">申报总值</span><span class="v">${p.currency} ${p.declaredValue.toLocaleString()}</span>
      <span class="k">毛重/条款</span><span class="v">${p.grossWeightKg} kg · ${p.incoterm}</span>
    </div>
    ${decl.issues.length ? decl.issues.map((i) => `<div class="issue">⛔ ${esc(i)}</div>`).join("") : ""}
    ${decl.previousIssues.length ? `<div class="issue warn">🕘 历史退单：${esc(decl.previousIssues.flat().join("；"))}</div>` : ""}
  </div>`;
}

function shipBlock(s) {
  return `<div class="decl-card">
    <div class="head"><b>${s.id}</b><span class="chip ${s.status === "delivered" ? "cleared" : "inspection"}">${SHIP_STATUS_META[s.status] ?? s.status}</span></div>
    <div class="kv">
      <span class="k">生产单</span><span class="v">${esc(s.factoryOrderNo ?? "—")}（${esc(s.factoryId)}）</span>
      <span class="k">承运</span><span class="v">${s.carrier ? `${s.carrier} · ${s.trackingNo}` : "待安排"}</span>
    </div>
    <div class="tl">${[...s.events].reverse().map((e) => `<div class="tl-item done">${SHIP_STATUS_META[e.status] ?? e.status} · ${esc(e.text)}<div class="t">${fmtFull(e.ts)}</div></div>`).join("")}</div>
  </div>`;
}

$("#modal-close").addEventListener("click", () => $("#modal-mask").classList.remove("show"));
$("#modal-mask").addEventListener("click", (e) => {
  if (e.target === $("#modal-mask")) $("#modal-mask").classList.remove("show");
});

// ---------------- 顶栏按钮 ----------------
$("#btn-demo").addEventListener("click", async () => {
  state.demoLines = [];
  await fetch("/api/demo", { method: "POST" });
});
$("#btn-meeting").addEventListener("click", async () => {
  const res = await fetch("/api/meeting", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (res.ok) switchTab("group");
});
$("#btn-reset").addEventListener("click", async () => {
  if (!confirm("确定清空所有业务数据？（订单/报关单/运单/会话/群聊）")) return;
  state.events = [];
  await fetch("/api/reset", { method: "POST" });
  refresh();
});

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  state.activeTab = name;
  if (state.data) renderTab(state.data);
}

// ---------------- 演示进度提示 ----------------
function pushDemoLine(line) {
  state.demoLines.push(line);
  if (state.demoLines.length > 6) state.demoLines.shift();
  const toast = $("#demo-toast");
  toast.innerHTML = state.demoLines.map(esc).join("<br>");
  toast.classList.add("show");
  clearTimeout(pushDemoLine._t);
  pushDemoLine._t = setTimeout(() => toast.classList.remove("show"), 8000);
}

// ---------------- 启动 ----------------
refresh();
connectSSE();
setInterval(refresh, 2500);
