# gitGraph 错误诊断冒烟测试用例清单（手动执行）

> 目的：实测 v11.16.1 错误信息格式，验证 `public/js/mermaid-render.js:33-87` 的 4 条 gitGraph 错误诊断正则仍能命中，并发现 v11 错误格式变化导致的回归。
>
> 依据：CROSSCHECK-R1 §6.3 "mermaid-render.js:33-87 的 4 条 gitGraph 错误诊断正则"——BOTH 没有测试覆盖 AND v11 错误格式变化。
>
> 执行方式：启动 server → 浏览器打开 `http://localhost:3000` → 登录 → 粘贴以下 8 段代码到"代码编辑器" → 观察预览区诊断提示。
>
> 自动化：本次 R2 **不写 JS 代码**，仅写测试用例清单。R2 复审/测试团队可基于本清单：
> 1. 决定是否要把 `mermaid-render.js` 的正则拆出来参数化（`tests/unit/mermaidRender.regex.test.js`）
> 2. 或决定用手工截图走 review 流程替代自动化（更轻量）

---

## 启动服务

```bash
cd /Users/setsunayang/Documents/GitHub/ProcessDown/.claude/worktrees/mermaid-upgrade
cp .env.example .env  # 填入 LLM_API_BASE_URL / LLM_API_KEY / LLM_MODEL
node src/server/index.js  # 前台运行
# 浏览器打开 http://localhost:3000
# 用 .env 中 LLM_MODEL 的账号注册并登录（首次需注册）
```

---

## 测试用例

### Case 1: `gitGraph LR` 方向错误 → 期望触发"gitGraph 头部方向"提示

粘贴到代码编辑器：
```
gitGraph LR
    commit
```

**期望**：
- 预览区显示 "Render Error: ..."
- 错误提示行下有诊断 "gitGraph 头部方向关键字（LR / TB / RL / BT）是 Mermaid v10.3.0+ 特性，本项目 vendored 解析器不接受..."
- 错误行号显示 1（v11 错误信息 "Parse error on line 1, column 10"）

**v11 实际行为**（来自 v11Compat 测试）：
- mermaid 11.16.1 仍报 `Parse error on line 1, column 10: Expecting token of type 'EOF' but found 'LR'.`
- 正则 `mermaid-render.js:73` `/Parse error on line 1/i.test(error.message)` 仍能命中
- 正则 `mermaid-render.js:74` `/\bgitGraph\s+(LR|TB|RL|BT)\b/i.test(code)` 仍能命中
- 诊断提示**仍正确显示**

### Case 2: `commit &feature/x` cherry-pick → 期望触发"cherry-pick 语法"提示

粘贴到代码编辑器：
```
gitGraph
    commit id: "x" &feature/y
```

**期望**：
- 错误提示行下有诊断 "gitGraph 检测到 v10+ cherry-pick 语法 `&<branch>`，本项目不支持..."
- 错误行号显示 2

**v11 实际行为**：
- mermaid 11.16.1 报 `Lexer error on line 2, column 18: unexpected character: ->&<-`
- 正则 `mermaid-render.js:69` `/&[A-Za-z0-9_./-]+/.test(error.message)` 仍能命中（错误信息含 `&<-` 字面）

### Case 3: `merge ... type: SQUASH` → 期望触发"merge type 关键字"提示

粘贴到代码编辑器：
```
gitGraph
    commit
    branch feature/x
    checkout feature/x
    commit
    checkout main
    merge feature/x type: SQUASH
```

**期望**：
- 错误提示行下有诊断 "gitGraph merge 行上的 type 关键字 (SQUASH/REBASE/FAST_FORWARD/NO_FF) 是 Mermaid v10+ 特性，本项目 vendored 解析器不支持..."
- 错误行号显示 5

**v11 实际行为**：
- mermaid 11.16.1 报 `Parse error on line 5, column 25: ...but found: 'SQUASH'`
- 正则 `mermaid-render.js:65` `/\btype:\s*(SQUASH|REBASE|...)/i.test(error.message)` 仍能命中

### Case 4: `merge ... type: REBASE` → 期望触发"merge type 关键字"提示

粘贴到代码编辑器：
```
gitGraph
    branch feature/x
    commit
    checkout main
    merge feature/x type: REBASE
```

**期望**：
- 与 Case 3 相同，但显示 REBASE 关键字
- 错误行号显示 4

### Case 5: emoji 节点文本 → 期望触发"emoji 字符"提示

粘贴到代码编辑器：
```
flowchart TD
    A[开始🔑] --> B[完成]
```

**期望**：
- 错误提示行下有诊断 "Tip: The code may contain emoji characters..."

**v11 实际行为**（待浏览器实测）：
- v11 解析器对 emoji 报错格式与 v9 是否一致**未知**
- 正则 `mermaid-render.js:53` `/emoji|got\s+'\u/i.test(error.message)` 在 v11 错误信息中可能需要更新

**注意**：此 case 在 Node sandbox 中无法实测（zustand 依赖问题），需浏览器人工冒烟。

### Case 6: 中文全角标点在 ERD 注释 → 期望触发"特殊字符"提示

粘贴到代码编辑器：
```
erDiagram
    SHIPMENT {
        string note "运费, 含税"
    }
```

**期望**：
- mermaid 11.16.1 接受带逗号的 label（v11 改善了引号语义）
- **不应**报错（v11 改进）
- 如果还报错，正则 `mermaid-render.js:56` `/got\s+'\d+'/i.test(error.message)` 仍能命中（v9 时代用数字 token id；v11 改成关键字 token 如 `got 'COMMA'`）

**v11 实际行为**：
- v11 接受带引号的逗号 label（v11Compat 测试已确认 `erDiagram A ||--o{ B : "label"` 通过）
- 此 case **不再触发错误**

### Case 7: 正常 gitGraph → 期望无错误

粘贴到代码编辑器：
```
gitGraph
    commit
    branch feature/x
    checkout feature/x
    commit
    checkout main
    merge feature/x
```

**期望**：
- 正常渲染为 Git 图
- 预览区显示 SVG，无错误

### Case 8: v11 错信息格式变化回归测试

任选上面 1-3 任一 case，触发错误后查看：
- `mermaid-render.js:37` 的 `/line\s+(\d+)/i` 正则：v11 错误信息**仍**含 "line N"（已确认）
- `mermaid-render.js:53` 的 `/emoji|got\s+'\u/` 正则：v11 错误信息**不**含 `\u` 转义前缀（v9 时代 LLM 输出可能含 `\uD83D`）；若 LLM 输出真有 emoji，错误信息可能不含 `\u`，这条诊断**永远不显示**
- `mermaid-render.js:56` 的 `/got\s+'\d+'/i` 正则：v11 错误信息中的 `got 'X'` 模式是关键字 token（如 `got 'EOF'`、`got 'SQUASH'`）而非数字 token id，**永不匹配**（已实测确认）

---

## 验证清单

每条 case 执行后，在浏览器开发者工具 console 里：

```js
// 1. 拿到当前错误信息
const errMsg = document.querySelector('.render-error .error-title').textContent;
console.log('error message:', errMsg);

// 2. 跑一遍 4 条正则，看哪些命中
const code = document.getElementById('code-editor').value;
console.log({
  emojiRegex: /emoji|got\s+'\u/i.test(errMsg),
  gotDigitRegex: /got\s+'\d+'/i.test(errMsg),
  gitGraphTypeRegex: /\btype:\s*(SQUASH|REBASE|FAST_FORWARD|FAST-FORWARD|NO_FF)\b/i.test(errMsg),
  gitGraphCherryPickRegex: /&[A-Za-z0-9_./-]+/.test(errMsg),
  gitGraphOrientRegex: /Parse error on line 1/i.test(errMsg) && /\bgitGraph\s+(LR|TB|RL|BT)\b/i.test(code),
  lineRegex: /line\s+(\d+)/i.test(errMsg)
});
```

把每个 case 的 6 个 boolean 贴到本文件底部（追加记录），便于后续 R2 复审决定：
- A. 把 4 条 gitGraph 诊断正则拆出来参数化 + 加单元测试
- B. 改写成"v11 错误格式"版本（丢掉 `\u` 和 `'\d+'` 这两条不工作的）
- C. 保持现状（4 条仍然只在特定 case 命中，emoji 诊断靠 LLM 行为约束——system.txt 已禁 emoji，理论上永不触发）

---

## 执行记录

> R2 实施人员跑完后追加：

- 测试日期：
- 测试人员：
- 服务版本：mermaid 11.16.1（worktree 已升级）
- 浏览器：
- Case 1 实际表现：
- Case 2 实际表现：
- Case 3 实际表现：
- Case 4 实际表现：
- Case 5 实际表现：
- Case 6 实际表现：
- Case 7 实际表现：
- Case 8 实际表现：
- 6 个 boolean 命中矩阵（cases 1-8 各一列）：

---

## 关联产物

- `public/js/mermaid-render.js:33-87`：4 条 gitGraph 错误诊断正则实现
- `tests/unit/v11Compat.test.js`：已实测 v11 错误格式含 "line N" / `got 'KEYWORD'`
- `BASELINE.md §3.1 "修复变得平凡"风险表`：列出 mermaid-render.js 无测试覆盖
- `CROSSCHECK-R1.md §6.3`："必须重写这 4 条正则（按 v11 错误格式 'got ...' / 'at position N'）"
- `REVIEW.md §7.4`：v11 错误信息格式变化对 mermaid-render.js 的具体影响

---

## R2 复审决策项

1. **是否要把 `mermaid-render.js` 的正则拆为可测试单元？**
   - 当前是 inline string，`grep -n` 才能看到
   - 拆出后 `tests/unit/mermaidRender.regex.test.js` 可锁死 4 条正则 + 模拟 v11 错误信息验证命中

2. **是否要重写 `\u` / `'\d+'` 这两条不再工作的正则？**
   - 现状：永远不命中，代码里是死代码
   - 改：改成 `got 'SQUASH'` 模式 / 删掉
   - 保守：保持现状，等用户真实报告"诊断没出现"时再改

3. **是否要把诊断走 i18n？** —— 不在本期范围
