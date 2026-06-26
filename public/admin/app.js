const STORAGE_BACKEND = "sema_admin_backend";
const STORAGE_ADMIN_USER = "sema_admin_user";

const $ = (sel) => document.querySelector(sel);

let allUsers = [];
let sortKey = "totalTokens";
let sortDir = "desc";
let selectedMonth = "";

function fmt(n) {
  if (n == null || n === "") return "—";
  return Number(n).toLocaleString("zh-CN");
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function getBackendBase() {
  const saved = localStorage.getItem(STORAGE_BACKEND)?.trim();
  if (saved) return saved.replace(/\/+$/, "");
  if (location.pathname.startsWith("/admin")) return location.origin;
  return "";
}

function getAdminUser() {
  return localStorage.getItem(STORAGE_ADMIN_USER)?.trim() || "";
}

function showStatus(message, type = "error") {
  const bar = $("#statusBar");
  bar.textContent = message;
  bar.className = `status-bar ${type}`;
  bar.classList.remove("hidden");
}

function hideStatus() {
  $("#statusBar").classList.add("hidden");
}

function currentMonthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function fetchUsage(month) {
  const base = getBackendBase();
  if (!base) {
    throw new Error("请先填写后端地址（连接设置）");
  }

  const url = new URL("/api/admin/usage", base);
  if (month) url.searchParams.set("month", month);

  const headers = {};
  const adminUser = getAdminUser();
  if (adminUser) headers["X-SEMA-User"] = adminUser;

  const res = await fetch(url.toString(), { headers });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const hint = data.hint ? ` ${data.hint}` : "";
    throw new Error(`${data.error || res.statusText}${hint}`);
  }
  if (!data.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function renderSummary(overview) {
  const cards = [
    { label: "用户数", value: overview.userCount },
    { label: "活跃用户", value: overview.activeUserCount },
    { label: "总请求", value: overview.requests },
    { label: "总 Token", value: overview.totalTokens },
    { label: "输入 Token", value: overview.inputTokens },
    { label: "输出 Token", value: overview.outputTokens }
  ];

  $("#summaryCards").innerHTML = cards
    .map(
      (c) => `
      <div class="card">
        <div class="card-label">${c.label}</div>
        <div class="card-value">${fmt(c.value)}</div>
      </div>`
    )
    .join("");
}

function quotaPercent(user) {
  if (!user.quota || user.quota <= 0) return null;
  return Math.min(100, Math.round((user.totalTokens / user.quota) * 100));
}

function renderRouteTags(byRoute) {
  if (!byRoute || !Object.keys(byRoute).length) return '<span class="badge badge-muted">无</span>';
  return `<div class="route-tags">${Object.entries(byRoute)
    .map(([route, info]) => {
      const short = route.replace("/api/", "");
      return `<span class="route-tag" title="${route}">${short}: ${fmt(info.totalTokens)}</span>`;
    })
    .join("")}</div>`;
}

function renderQuotaCell(user) {
  const pct = quotaPercent(user);
  if (pct == null) return '<span class="badge badge-muted">无限制</span>';
  const cls = pct >= 100 ? "over" : pct >= 80 ? "warn" : "";
  return `
    <div>
      <span class="quota-bar"><span class="quota-bar-fill ${cls}" style="width:${pct}%"></span></span>
      ${pct}%
    </div>`;
}

function sortUsers(users) {
  return [...users].sort((a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    if (sortKey === "user") {
      av = String(av || "").toLowerCase();
      bv = String(bv || "").toLowerCase();
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    av = Number(av) || 0;
    bv = Number(bv) || 0;
    return sortDir === "asc" ? av - bv : bv - av;
  });
}

function renderTable(users) {
  const keyword = $("#inputSearch").value.trim().toLowerCase();
  const filtered = users.filter((u) => !keyword || u.user.toLowerCase().includes(keyword));
  const sorted = sortUsers(filtered);

  if (!sorted.length) {
    $("#userTableBody").innerHTML =
      '<tr><td colspan="9" class="empty">暂无数据。用户开始翻译后会出现在这里。</td></tr>';
    return;
  }

  $("#userTableBody").innerHTML = sorted
    .map((u) => {
      const exceeded = u.quotaExceeded
        ? '<span class="badge badge-danger">超额</span>'
        : "";
      return `
      <tr>
        <td class="user-cell">${escapeHtml(u.user)}${exceeded}</td>
        <td class="num">${fmt(u.requests)}</td>
        <td class="num">${fmt(u.inputTokens)}</td>
        <td class="num">${fmt(u.outputTokens)}</td>
        <td class="num">${fmt(u.totalTokens)}</td>
        <td class="num">${u.quota ? fmt(u.quota) : "—"}</td>
        <td>${renderQuotaCell(u)}</td>
        <td>${renderRouteTags(u.byRoute)}</td>
        <td class="time-cell">${fmtTime(u.updatedAt)}</td>
      </tr>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fillMonthSelect(availableMonths, current) {
  const select = $("#selectMonth");
  const months = [...new Set([current, ...availableMonths])].filter(Boolean).sort().reverse();
  select.innerHTML = months
    .map((m) => `<option value="${m}"${m === current ? " selected" : ""}>${m}</option>`)
    .join("");
  selectedMonth = current;
}

async function loadData() {
  hideStatus();
  $("#userTableBody").innerHTML = '<tr><td colspan="9" class="empty">正在加载…</td></tr>';

  try {
    const month = $("#selectMonth").value || selectedMonth || currentMonthKey();
    const data = await fetchUsage(month);
    allUsers = data.users || [];
    selectedMonth = data.month;
    fillMonthSelect(data.availableMonths || [], data.month);
    renderSummary(data.overview || {});
    renderTable(allUsers);
    $("#lastUpdated").textContent = `更新于 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
    hideStatus();
  } catch (err) {
    showStatus(err.message || String(err), "error");
    $("#summaryCards").innerHTML = "";
    $("#userTableBody").innerHTML = `<tr><td colspan="9" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

function initSettings() {
  $("#inputBackend").value = localStorage.getItem(STORAGE_BACKEND) || "";
  $("#inputAdminUser").value = localStorage.getItem(STORAGE_ADMIN_USER) || "";

  if (!localStorage.getItem(STORAGE_BACKEND) && !location.pathname.startsWith("/admin")) {
    $("#settingsPanel").classList.remove("hidden");
  }
}

function bindEvents() {
  $("#btnSettings").addEventListener("click", () => {
    $("#settingsPanel").classList.toggle("hidden");
  });

  $("#btnCloseSettings").addEventListener("click", () => {
    $("#settingsPanel").classList.add("hidden");
  });

  $("#btnSaveSettings").addEventListener("click", () => {
    const backend = $("#inputBackend").value.trim().replace(/\/+$/, "");
    const adminUser = $("#inputAdminUser").value.trim();
    localStorage.setItem(STORAGE_BACKEND, backend);
    localStorage.setItem(STORAGE_ADMIN_USER, adminUser);
    $("#settingsPanel").classList.add("hidden");
    loadData();
  });

  $("#btnRefresh").addEventListener("click", loadData);

  $("#selectMonth").addEventListener("change", loadData);

  $("#inputSearch").addEventListener("input", () => renderTable(allUsers));

  document.querySelectorAll("th[data-sort]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === "asc" ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = key === "user" ? "asc" : "desc";
      }
      renderTable(allUsers);
    });
  });
}

initSettings();
bindEvents();
loadData();
