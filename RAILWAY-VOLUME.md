# Railway 持久化卷配置（用量数据不丢）

用量统计写在 `usage.json`。Railway 默认容器文件系统是**临时的**，每次 redeploy 可能清空。挂载 Volume 后，数据会永久保留。

---

## 一、在 Railway 控制台操作（约 3 分钟）

### 1. 打开你的后端服务

登录 [Railway](https://railway.com) → 进入项目 → 点击 **deepseek-translate-backend** 服务。

### 2. 添加 Volume

1. 顶部切到 **Volumes** 标签（或在 Settings 里找 **Volume**）
2. 点击 **+ Add Volume** / **Create Volume**
3. 填写：
   - **Mount Path（挂载路径）**：`/app/data`
   - **Size（大小）**：`1 GB` 足够（`usage.json` 通常只有几 KB～几 MB）

> **为什么必须是 `/app/data`？**  
> Railway 用 Nixpacks 构建时，代码在容器内的 `/app` 目录。本后端默认把用量写到 `/app/data/usage.json`。挂载路径必须一致，卷才会盖住这个目录。

4. 确认挂载到 **deepseek-translate-backend** 服务（不是别的服务）
5. 保存

### 3. 触发一次重新部署

Volume 只在**运行时**挂载，添加后建议手动 **Redeploy** 一次：

**Deployments** → 最新部署 → **Redeploy**

### 4. 验证是否成功

部署完成后，浏览器打开：

```
https://deepseek-translate-backend-production.up.railway.app/api/health
```

在返回 JSON 里找 `usageStorage`，应类似：

```json
"usageStorage": {
  "dir": "/app/data",
  "file": "/app/data/usage.json",
  "persistent": true,
  "volumeMounted": true,
  "volumeName": "你的卷名"
}
```

| 字段 | 成功 | 失败（未挂卷） |
|---|---|---|
| `volumeMounted` | `true` | `false` |
| `persistent` | `true` | `false` |
| `dir` | `/app/data` | `/app/data`（但 redeploy 会丢） |

也可在 **Deployments → View Logs** 里搜：

```
[sema-backend] usage storage: /app/data (Railway volume: ...)
```

看到 `(Railway volume: ...)` 即表示卷已生效。

---

## 二、代码如何识别卷（无需手填环境变量）

后端已自动处理，**不要**在 Variables 里手动添加 `RAILWAY_VOLUME_MOUNT_PATH`（Railway 会自动注入）。

优先级：

1. `SEMA_USAGE_DIR`（手动指定，一般不需要）
2. `RAILWAY_VOLUME_MOUNT_PATH`（挂卷后 Railway 自动提供）
3. 本地默认 `./data`

---

## 三、挂卷后的使用建议

1. **Chrome 扩展填用户名** — 便于在 `/admin` 按人查看；不填则归到 `_default`
2. **翻译 1～2 次** — 生成初始 `usage.json`
3. **再 redeploy 一次** — 验证数据仍在（管理页用户数 / Token 不应归零）

---

## 四、常见问题

### Q: 挂卷之前的数据能找回吗？
不能。卷是空的，只能从挂卷之后的翻译开始累计。

### Q: 需要改 SEMA_USAGE_DIR 吗？
不需要。挂到 `/app/data` 后代码会自动用卷。

### Q: 卷要多少钱？
Railway 按卷容量计费，1 GB 对个人用量管理通常足够且便宜。详见 Railway Pricing。

### Q: 多环境（staging / production）怎么办？
每个环境的服务需要**各自**挂一个 Volume，互不影响。

---

## 五、可选：Railway CLI

若已安装 [Railway CLI](https://docs.railway.com/develop/cli)：

```bash
railway link
railway volume add --mount-path /app/data
railway redeploy
```

---

配置完成后，用量数据会 survive 每次 git push 和 redeploy。
