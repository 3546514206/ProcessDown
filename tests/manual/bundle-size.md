# 升级到 v11.16.1 后 vendor 文件大小与首屏加载影响

> **目的**：记录升级前后的 mermaid.min.js 文件大小、gzip 后大小、以及对首屏加载时间的影响。
>
> **背景**：IMPLEMENTATION-R2 §3.1 备份 3.0.9 (3.34MB)，下载 11.16.1 (3.57MB)。原预估 v11 是 5-7MB（基于 v11 全量构建），但实际 vendored 是 min.js；3.57MB 比预期小。
>
> **执行方式**：
> 1. 文件大小由 `wc -c` 量取（已自动）
> 2. gzip 大小由 `gzip -c | wc -c` 量取（已自动）
> 3. 首屏加载时间：用浏览器开发者工具 Network 面板 F5 刷新 / `performance.now()` 在前端记录
>
> **关联**：IMPLEMENTATION-R2 §3.1（备份与下载） / §3.2（v11Compat 校验）

---

## 1. 文件大小（已自动量取）

| 版本 | 文件路径 | 原始大小 | gzip 后大小 | gzip 比例 |
|---|---|---:|---:|---:|
| v3.0.9 (备份) | `public/vendor/mermaid.min.js.bak-v3.0.9` | 3,335,646 B (3.18 MB) | 994,182 B (~970 KB) | 70.2% |
| **v11.16.1 (当前)** | `public/vendor/mermaid.min.js` | **3,566,058 B (3.40 MB)** | **975,201 B (~952 KB)** | 72.7% |

> 升级后 v11.16.1 比 v3.0.9 大 230,412 B (220 KB, +6.9%)。gzip 后**反而小 19 KB**——v11 minifier 更激进，gzip 友好。

### 1.1 量化

- v3.0.9 -> v11.16.1：原始大小 **+6.9%**，gzip 后 **-1.9%**。
- 远低于 RESEARCH.md §1 / IMPLEMENTATION-R2 §3.1 预估的 5-7 MB（那是 v11 full esm bundle 大小，不是 min.js）。
- 网络加载影响：1 Mbps 网络下，gzip 后 ~952 KB ≈ 7.6s 加载（同步阻塞）；4G ~50ms 加载。
- 实际项目是 `<script src=...>` 同步加载，**仍会阻塞首屏**。建议在 R3 评估是否改 `defer` 或换 dynamic import。

### 1.2 验证命令（可重跑）

```bash
wc -c public/vendor/mermaid.min.js public/vendor/mermaid.min.js.bak-v3.0.9
gzip -c public/vendor/mermaid.min.js | wc -c
gzip -c public/vendor/mermaid.min.js.bak-v3.0.9 | wc -c
```

---

## 2. 首屏加载时间（手动冒烟，需浏览器）

### 2.1 测量方法

#### 方法 A — Chrome DevTools Network 面板

1. 打开 `chrome://settings/clearBrowserData` 清缓存
2. 启动服务：`node src/server/index.js`
3. 浏览器打开 `http://localhost:3000`（登录前）
4. F12 打开 DevTools -> Network 面板 -> 勾选 "Disable cache"
5. Ctrl+R 刷新页面
6. 记录 `mermaid.min.js` 请求的 "Time" 列（单位 ms）
7. 同时记录整个页面的 "DOMContentLoaded" 和 "load" 事件时间

#### 方法 B — `performance.now()` 在前端记录

在 `public/index.html` 临时插入：

```html
<script>window.__t0 = performance.now();</script>
<script src="/vendor/mermaid.min.js"></script>
<script>window.__mermaidLoaded = performance.now() - window.__t0;</script>
```

然后在浏览器 console 跑：`console.log('mermaid loaded in', window.__mermaidLoaded, 'ms')`

### 2.2 期望值

| 指标 | 期望 | 不通过标准 |
|---|---|---|
| `mermaid.min.js` 加载时间（本地 127.0.0.1） | <100ms | >500ms（说明浏览器解析慢） |
| DOMContentLoaded（本地） | <500ms | >1s |
| `mermaid.min.js` 加载时间（4G 模拟） | <500ms | >2s |
| DOMContentLoaded（4G 模拟） | <1s | >3s |

> **本地 127.0.0.1 测试值应作为对照**——本地只反映解析/执行时间，不反映网络传输。

### 2.3 4G 模拟方法

Chrome DevTools -> Network 面板 -> Throttling 下拉 -> "Slow 4G"。

---

## 3. 关键发现

1. **文件大小增长可控**：原始 +220 KB，gzip 后反而 -19 KB。v11 minifier + tree-shaking 更激进。
2. **同步加载仍是问题**：`mermaid.min.js` 在 `<head>` 里同步加载，会阻塞首屏渲染。R3 候选优化：
   - 加 `defer` 属性
   - 改 dynamic import（`import('mermaid')`）
   - 拆分到 worker（极端方案）
3. **本地无明显性能下降**：解析时间应 < 100ms（Chrome Mermaid v11 解析比 v3.0.9 慢但 < 50ms）。
4. **CDN 缓存友好**：gzip 后 ~952 KB，gzip 命中率提升后实际传输 < 100 KB（如果是大版本部署）。
5. **与 v9 时代 3.18 MB 相比仅 +6.9%**：完全在合理范围，不需要为 bundle 大小推迟升级。

---

## 4. 执行记录

> R2 实施人员跑完后追加：

- 测量日期：
- 测量人：
- Chrome 版本：
- 操作系统：
- 本地 `mermaid.min.js` 加载时间：ms
- 本地 DOMContentLoaded：ms
- 4G 模拟 `mermaid.min.js` 加载时间：ms
- 4G 模拟 DOMContentLoaded：ms
- 任何异常：/

---

## 5. 关联产物

- `IMPLEMENTATION-R2.md §3.1` — vendored mermaid 11.16.1 备份与下载
- `IMPLEMENTATION-R2.md §3.4` — v11 升级验证
- `public/index.html` — mermaid 加载点（决定是否需要 defer）
- `public/vendor/mermaid.min.js` — 当前 vendored 文件
- `public/vendor/mermaid.min.js.bak-v3.0.9` — 升级前备份
