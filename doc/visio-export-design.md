# Mermaid 导出 Visio（.vsdx）一期方案设计

> 状态：设计稿，待实现
> 日期：2026-08-26
> 前置调研结论：**可行**——不引入 npm 依赖，vendor 一个 24KB 零依赖库到本地（与 mermaid.min.js 同一模式）。

## 背景与调研结论

ProcessDown 现有导出能力：PNG（服务端 resvg-wasm，`src/services/export.js`）与 SVG（前端 Blob，`public/js/export.js`）。用户需要把 mermaid 图表带进 Visio 生态（单位办公环境），因此补一条 .vsdx 导出链路。

调研要点（详见调研记录）：

- **.vsdx 本质**是 OPC ZIP 包，9 个必备 XML part（`[Content_Types].xml`、`_rels/.rels`、`visio/document.xml`、`visio/_rels/document.xml.rels`、`visio/pages/pages.xml`、`visio/pages/_rels/pages.xml.rels`、`visio/pages/page1.xml` 等）；Masters 可省略，裸 Shape + 自带 Geometry 在 Visio 2016+ / Visio Online / LibreOffice 均可打开。
- **选定库**：`@klyratech/mermaid-to-visio`（MIT）。产物 `dist/index.js` 为 24KB 零依赖 ESM，API：`svgElementToVsdx(svgEl, opts) -> {bytes, stats}`。源码已人工审查：无网络请求、无 eval。它消费**渲染后的 SVG DOM**（因此对全部图表类型都能做几何级导出）。
- **被否决的路线**：draw.io（VSDX 导出已从菜单移除且 vendor 体积 15MB+ 不可行）、kroki/mermaid.live（不支持 vsdx）、mermaid2visio（依赖重且停更）、Windows COM 自动化（与纯前端架构不符）。
- **输出级别**：几何级——节点/连线/文字变成带 Geometry 的裸 Shape，Visio 里能开、能看、能改（改的是形状几何，不是"节点"语义）；拖动节点连线不跟随。

## 目标与范围

一期纯前端实现"导出 Visio"，**零 npm 依赖、零服务器改动、零鉴权清单改动**（不触碰 `PROTECTED_USER_ROUTES` 约束）。

明确不做（推给二期）：

- 拖动节点连线跟随（需 fork 库加 1-D 动态连接线 + Connects 胶合，或用 `mermaidAPI.getDiagramFromText()` + flowchart `db.getData()` 做语义级导出，约 500–800 行）；
- 图表类型置灰、导出进度条、样式映射微调。

## 改动清单（3 处）

### 1. Vendor 库 -> `public/vendor/`

从 npm tarball 取 `@klyratech/mermaid-to-visio` 的 `dist/index.js`，存为 `public/vendor/mermaid-to-visio.esm.js`，保留 MIT 头注释。

它是 ESM 格式，**不进 index.html**，在导出时动态加载（首次点击才拉这 24KB）：

```js
const { svgElementToVsdx } = await import('/vendor/mermaid-to-visio.esm.js?v=0.1.0');
```

走 `public/vendor/` 现有的 `?v=` 版本号强缓存约定（`max-age=86400`）。

### 2. `public/js/export.js` 新增 `exportVisio()`

菜单项加在现有导出菜单里（与"导出 PNG / 导出 SVG"并列），核心函数：

```js
async function exportVisio() {
  const code = getCurrentMermaidCode();           // 最新 diagram 源码
  const holder = document.createElement('div');   // 离屏容器
  holder.style.cssText = 'position:fixed;left:-99999px;top:0';  // 不能 display:none，getBBox 会全变 0
  document.body.appendChild(holder);
  try {
    const prev = mermaid.getConfig();             // 存全局配置
    mermaid.initialize({ htmlLabels: false, flowchart: { htmlLabels: false } });  // 关键一步
    const { svg } = await mermaid.render('vsdx-' + (++seq), code, holder);
    mermaid.initialize(prev);                     // 恢复，避免污染画布后续渲染
    const { bytes } = await svgElementToVsdx(holder.querySelector('svg'), { title: baseName });
    downloadBlob(new Blob([bytes], { type: 'application/vnd.ms-visio.drawing.12' }), baseName + '.vsdx');
  } finally {
    holder.remove();
  }
}
```

三个实现要点：

- **`htmlLabels: false` 是成败关键**。画布上现成的 SVG 不能直接用——默认 `htmlLabels: true` 把节点文字放进 `<foreignObject><div>`，库解析不了，导出的图**没有文字**。必须在隐藏容器里用关闭 htmlLabels 的配置重渲染一次，让文字变成 `<text>` 元素。副作用是文字换行方式可能与画布略有差异，可接受。
- **当前源码的取处**：不从画布 SVG 反推，直接取最新 diagram 源码（最新一轮代码面板 / `lastMermaid` 同源，即 diagram.json 的内容），和"查看此图"渲染的是同一份。
- **配置恢复**：`mermaid.initialize` 是全局单例深合并，改了不还就会污染后续画布渲染（主题等）。用 `getConfig()` 存、try/finally 里还；若 getConfig 路径有问题，退路是复用现有 `reinitMermaid` 的初始化参数（components.js 里主题切换已有同样先例）。

### 3. CLAUDE.md 补一段

记录 vendored 新文件、导出链路、以及"库只吃 htmlLabels:false 的 SVG"这个坑，防止将来有人直接把画布 SVG 喂进去。

## 技术要点与已知风险

| 点 | 说明 |
|---|---|
| 未在真实 Visio 验证 | 研究环境没有 Visio，库输出结构已人工核对过（9 个必备 XML part 齐全），但终验需在真实 MS Visio 上开一次 |
| 主题 | 重渲染时沿用当前站点主题（深/浅），导出配色与画布一致 |
| 图表类型 | 所有类型都能导（库只看 SVG 几何）；flowchart/state/class/er 效果最好，sequence/mindmap 可用，gantt/pie 几何上是文本堆，效果一般。一期不做类型置灰 |
| 流式期间 | 与现有导出按钮同一套禁用逻辑，不新增状态 |
| 浏览器兼容 | 动态 `import()` + 库本身要求现代浏览器；项目已用 fetch stream/AbortController，无回退负担 |

## 验证方案

1. 浏览器里导 3 张代表图：中文节点 flowchart、sequence、state；
2. `unzip -l` 检查 vsdx 内 9 个必备 part 齐全，`xmllint --noout` 校验 XML 合法；
3. 与调研时库自己生成的样本（`/tmp/vsdx-samples/klyra-lib-*.vsdx`）结构对比；
4. 本机若有 LibreOffice Draw 就开一次做低成本回归；
5. **终验**：在单位用真实 MS Visio 打开确认。

## 工作量

vendor 文件落位 + export.js 约 100 行 + CLAUDE.md 三行 + 浏览器端验证，一个会话内做完。

## 二期展望（不在本期内）

语义级导出：fork 该 MIT 库（或自研约 500–800 行），利用 vendored mermaid 11.16.1 内的 `mermaidAPI.getDiagramFromText()` 拿到 `{db, parser}`，flowchart 的 `db.getData()` 给出 nodes[]/edges[] 语义模型（注意：`db.getVertices()` 在 11.16.1 的 flowchart-v2 上已不可用，必须走 `getData()`；getter 在原型链上，`Object.keys()` 枚举不到）。输出带 1-D 动态连接线（BeginX/EndX + Connects 胶合段）的 vsdx，实现"拖动节点连线跟随"。
