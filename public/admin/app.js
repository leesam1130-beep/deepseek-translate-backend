const STORAGE_BACKEND = "sema_admin_backend";
const STORAGE_ADMIN_USER = "sema_admin_user";

const $ = (sel) => document.querySelector(sel);

let allUsers = [];
let sortKey = "totalTokens";
let sortDir = "desc";
let selectedMonth = "";
let editingUser = null;

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

function adminHeaders(json = false) {
  const headers = {};
  const adminUser = getAdminUser();
  if (adminUser) headers["X-SEMA-User"] = adminUser;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

function friendlyApiError(data) {
  const hint = data.hint ? `（${data.hint}）` : "";
  if (data.error === "ADMIN_REQUIRED") return `需要管理员身份${hint}`;
  if (data.error === "USERNAME_REQUIRED") return `缺少用户名${hint}`;
  return `${data.error || "请求失败"}${hint}`;
}

const EMPTY_HINT =
  "暂无用户。白名单用户（SEMA_ALLOWED_USERS）会显示在此；或扩展填用户名后翻译几次。";

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

async function adminFetch(path, { method = "GET", body } = {}) {
  const base = getBackendBase();
  if (!base) throw new Error("请先填写后端地址（连接设置）");

  const url = new URL(path, base);
  const res = await fetch(url.toString(), {
    method,
    headers: adminHeaders(!!body),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(friendlyApiError(data) || data.error || res.statusText);
  return data;
}

async function fetchUsage(month) {
  const url = `/api/admin/usage${month ? `?month=${encodeURIComponent(month)}` : ""}`;
  return adminFetch(url);
}

async function setQuota(user, payload) {
  return adminFetch(`/api/admin/users/${encodeURIComponent(user)}/quota`, {
    method: "PATCH",
    body: payload
  });
}

async function adjustQuota(user, delta) {
  return adminFetch(`/api/admin/users/${encodeURIComponent(user)}/quota/adjust`, {
    method: "POST",
    body: { delta }
  });
}

async function resetUsage(user, month) {
  return adminFetch(`/api/admin/users/${encodeURIComponent(user)}/usage/reset`, {
    method: "POST",
    body: month ? { month } : {}
  });
}

function renderSummary(overview) {
  const cards = [
    { label: "用户数", value: overview.userCount },
    { label: "活跃用户", value: overview.activeUserCount },
    { label: "白名单", value: overview.whitelistedCount ?? "—" },
    { label: "总请求", value: overview.requests },
    { label: "总 Token", value: overview.totalTokens },
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
  if (user.unlimited || !user.quota || user.quota <= 0) return null;
  return Math.min(100, Math.round((user.totalTokens / user.quota) * 100));
}

function quotaSourceLabel(source) {
  if (source === "panel") return '<span class="badge badge-info">面板</span>';
  if (source === "env") return '<span class="badge badge-warn">环境变量</span>';
  return "";
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
  if (user.unlimited) return '<span class="badge badge-muted">无限制</span>';
  const pct = quotaPercent(user);
  if (pct == null) return "—";
  const cls = pct >= 100 ? "over" : pct >= 80 ? "warn" : "";
  return `
    <div>
      <span class="quota-bar"><span class="quota-bar-fill ${cls}" style="width:${pct}%"></span></span>
      ${pct}%
    </div>`;
}

function renderQuotaDisplay(user) {
  const src = quotaSourceLabel(user.quotaSource);
  if (user.unlimited) return `∞ ${src}`;
  return `${fmt(user.quota)} ${src}`;
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
    $("#userTableBody").innerHTML = `<tr><td colspan="10" class="empty">${EMPTY_HINT}</td></tr>`;
    return;
  }

  $("#userTableBody").innerHTML = sorted
    .map((u) => {
      const exceeded = u.quotaExceeded ? '<span class="badge badge-danger">超额</span>' : "";
      const whitelist = u.whitelisted && !u.requests
        ? '<span class="badge badge-info">白名单</span>'
        : "";
      const userEnc = encodeURIComponent(u.user);
      return `
      <tr data-user="${escapeHtml(u.user)}">
        <td class="user-cell">${escapeHtml(u.user)}${exceeded}${whitelist}</td>
        <td class="num">${fmt(u.requests)}</td>
        <td class="num">${fmt(u.inputTokens)}</td>
        <td class="num">${fmt(u.outputTokens)}</td>
        <td class="num">${fmt(u.totalTokens)}</td>
        <td class="num">${renderQuotaDisplay(u)}</td>
        <td>${renderQuotaCell(u)}</td>
        <td>${renderRouteTags(u.byRoute)}</td>
        <td class="time-cell">${fmtTime(u.updatedAt)}</td>
        <td>
          <div class="action-btns">
            <button type="button" class="btn-sm" data-action="edit" data-user="${userEnc}">配额</button>
            <button type="button" class="btn-sm" data-action="adjust" data-user="${userEnc}">±充值</button>
            <button type="button" class="btn-sm danger" data-action="reset" data-user="${userEnc}">重置</button>
          </div>
        </td>
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
  $("#userTableBody").innerHTML = '<tr><td colspan="10" class="empty">正在加载…</td></tr>';

  try {
    const month = $("#selectMonth").value || selectedMonth || currentMonthKey();
    const data = await fetchUsage(month);
    allUsers = data.users || [];
    selectedMonth = data.month;
    fillMonthSelect(data.availableMonths || [], data.month);
    renderSummary(data.overview || {});
    renderTable(allUsers);
    $("#lastUpdated").textContent = `更新于 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
  } catch (err) {
    showStatus(err.message || String(err), "error");
    $("#summaryCards").innerHTML = "";
    $("#userTableBody").innerHTML = `<tr><td colspan="10" class="empty">${escapeHtml(err.message)}</td></tr>`;
  }
}

function openQuotaDialog(user) {
  editingUser = user;
  $("#quotaDialogUser").textContent = `用户：${user}`;
  $("#quotaUnlimited").checked = !!user.unlimited;
  $("#quotaInput").value = user.unlimited ? "" : user.quota || "";
  $("#quotaInput").disabled = !!user.unlimited;

  const hints = {
    panel: "当前配额来自面板设置（quotas.json）",
    env: "当前配额来自环境变量 SEMA_USER_QUOTAS；保存后将由面板覆盖",
    none: "当前无限制；保存后可设上限"
  };
  $("#quotaSourceHint").textContent = hints[user.quotaSource] || "";

  $("#quotaDialog").showModal();
}

function openAdjustDialog(userName) {
  editingUser = userName;
  $("#adjustDialogUser").textContent = `用户：${userName}`;
  $("#adjustDelta").value = "100000";
  $("#adjustDialog").showModal();
}

function bindTableActions() {
  $("#userTableBody").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.dataset.action;
    const userName = decodeURIComponent(btn.dataset.user || "");
    const userRow = allUsers.find((u) => u.user === userName);

    if (action === "edit") {
      openQuotaDialog(userRow || { user: userName, unlimited: true, quotaSource: "none" });
      return;
    }

    if (action === "adjust") {
      openAdjustDialog(userName);
      return;
    }

    if (action === "reset") {
      const month = selectedMonth || currentMonthKey();
      if (!confirm(`确定重置「${userName}」在 ${month} 的用量？配额不变。`)) return;
      try {
        await resetUsage(userName, month);
        showStatus(`已重置 ${userName} 本月用量`, "success");
        await loadData();
      } catch (err) {
        showStatus(err.message, "error");
      }
    }
  });
}

function bindDialogs() {
  $("#quotaUnlimited").addEventListener("change", (e) => {
    $("#quotaInput").disabled = e.target.checked;
  });

  $("#btnCancelQuota").addEventListener("click", () => $("#quotaDialog").close());
  $("#btnCancelAdjust").addEventListener("click", () => $("#adjustDialog").close());

  $("#quotaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!editingUser) return;
    const userName = typeof editingUser === "string" ? editingUser : editingUser.user;
    try {
      if ($("#quotaUnlimited").checked) {
        await setQuota(userName, { unlimited: true });
      } else {
        const q = Number($("#quotaInput").value);
        if (!Number.isFinite(q) || q <= 0) {
          showStatus("请输入大于 0 的配额，或勾选无限制", "error");
          return;
        }
        await setQuota(userName, { quota: q });
      }
      $("#quotaDialog").close();
      showStatus(`已更新 ${userName} 的配额`, "success");
      await loadData();
    } catch (err) {
      showStatus(err.message, "error");
    }
  });

  $("#btnClearQuotaOverride").addEventListener("click", async () => {
    if (!editingUser) return;
    const userName = typeof editingUser === "string" ? editingUser : editingUser.user;
    if (!confirm(`恢复「${userName}」为环境变量配额（删除面板覆盖）？`)) return;
    try {
      await setQuota(userName, { clearOverride: true });
      $("#quotaDialog").close();
      showStatus(`已恢复 ${userName} 的环境变量配额`, "success");
      await loadData();
    } catch (err) {
      showStatus(err.message, "error");
    }
  });

  $("#adjustForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!editingUser) return;
    const userName = typeof editingUser === "string" ? editingUser : editingUser.user;
    const delta = Number($("#adjustDelta").value);
    try {
      await adjustQuota(userName, delta);
      $("#adjustDialog").close();
      showStatus(`已${delta > 0 ? "充值" : "减配"} ${userName}：${delta > 0 ? "+" : ""}${fmt(delta)}`, "success");
      await loadData();
    } catch (err) {
      showStatus(err.message, "error");
    }
  });
}

function initSettings() {
  $("#inputBackend").value = localStorage.getItem(STORAGE_BACKEND) || "";
  $("#inputAdminUser").value = localStorage.getItem(STORAGE_ADMIN_USER) || "";

  if (!localStorage.getItem(STORAGE_BACKEND) && !location.pathname.startsWith("/admin")) {
    $("#settingsPanel").classList.remove("hidden");
  } else if (!getAdminUser()) {
    showStatus("提示：若 Railway 设置了 SEMA_ADMIN_USERS，请在「连接设置」填写相同的管理员用户名。", "success");
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
bindTableActions();
bindDialogs();
loadData();
