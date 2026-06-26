# SemaTranslate Web 管理台

查看后端每个用户的 Token 用量、配额与路由分布。

## 使用方式

### 方式一：跟随后端一起部署（推荐）

后端已配置静态目录，部署后访问：

```
https://你的后端域名/admin/
```

Railway 环境变量需设置：

```
SEMA_ADMIN_USERS=你的用户名
SEMA_ALLOWED_USERS=alice,bob,...   # 可选，用户白名单
SEMA_USER_QUOTAS=alice:500000,bob:200000   # 可选，月度配额
```

在管理台「连接设置」里填写**管理员用户名**（与 `SEMA_ADMIN_USERS` 一致），后端地址可留空（同域自动识别）。

### 方式二：本地单独打开

```bash
cd web-admin
npx serve .
```

浏览器打开提示的地址（如 `http://localhost:3000`），在「连接设置」填写：

- **后端地址**：如 `https://deepseek-translate-backend-production.up.railway.app`
- **管理员用户名**：`SEMA_ADMIN_USERS` 中的名字

## 数据来源

管理台调用后端 `GET /api/admin/usage`，数据来自 `deepseek-translate-backend/data/usage.json`（Railway 上为持久化卷或容器内文件）。

## 文件说明

| 文件 | 说明 |
|---|---|
| `index.html` | 页面结构 |
| `style.css` | 样式 |
| `app.js` | 拉取 API、渲染表格 |

修改后需同步到 `../deepseek-translate-backend/public/admin/` 再 push 部署：

```powershell
Copy-Item -Path ".\*" -Destination "..\deepseek-translate-backend\public\admin\" -Force
```
