# 参与贡献 / Contributing

欢迎提 Issue 和 Pull Request：bug、新的工作流模板、界面改进、文档都可以。

## 开发环境

需要 Node.js 22+ 和一个能访问的 ComfyUI。

```bash
npm install
npm run dev          # 前端 http://localhost:5173 + 后端 http://127.0.0.1:8787
npm run typecheck    # 提交前请确保没有类型错误
npm test             # 单元测试：合并、布局、工作流映射、许可证，以及用 pi 的假模型跑画布助手（不需要 ComfyUI 和 API key）
npm run build && npm run smoke   # 和 CI 一样：构建，再检查后端在没有 ComfyUI 时能否正常启动
```

每个 Pull Request 都会自动运行 CI：在 Node 22 / 24 / 26 上做类型检查、构建和启动检查。CI 不连 ComfyUI，改了生成逻辑请自己在真实的 ComfyUI 上跑一遍，并在 PR 里写明。

## 代码结构

```
src/                 前端（React + Zustand）
  canvas/            无限画布：渲染、拖拽、缩放、连线、工具栏
  editors/           局部重绘 / 扩图编辑器
  ui/                输入框、顶栏、模板库、工作流管理与映射编辑器
  lib/               API 封装、生成动作、几何计算
server/              后端（Hono）
  workflows/         内置工具的 ComfyUI 工作流、导入工作流的识别与运行
  tasks.ts           任务队列、进度跟踪（ComfyUI WebSocket）、结果下载
shared/types.ts      前后端共享的类型
shared/locales/en.ts 英文界面的词典
presets/             官方模板转换来的预设（由脚本生成，不要手改）
scripts/             建 SSH 隧道、测试工作流、生成预设
```

## 界面文字和翻译

界面上的文字直接写中文，用 `t()` 包起来：前端从 `src/i18n.ts` 引入，后端从 `server/i18n.ts` 引入，例如 `t('{n} 个节点', { n })`。然后在 `shared/locales/en.ts` 里加上英文，以中文原文为键；数量用 `{n}` 并写成 `['单数', '复数']`。只在定义处标记、到显示时才翻译的文字（比如存进数据里的标签）用 `msg()`。`npm test` 会检查界面里有没有漏掉的中文、词典里有没有缺的或多余的词条。画布助手的提示词和工具说明是写给模型看的，保持中文，不用翻译。

## 新增官方模板预设

1. 在 `scripts/preset-sources.ts` 里加一项：模板名、中文名称、分类，需要的话设置开关值和要暴露的参数；名称和说明的英文加进 `shared/locales/en.ts`
2. 确保本机能连上一个装了官方模板包的 ComfyUI，并安装了 Google Chrome
3. 运行 `npm run build:presets -- <预设 id>`，检查 `presets/<id>.json` 的输入映射是否合理
4. 最好在真实的 ComfyUI 上跑一次

## 新增内置工具

内置工具的工作流在 `server/workflows/image.ts` / `video.ts`，模型文件名在 `server/workflows/models.ts`（写常见文件名 + 匹配规则，不同精度都能找到）。可以用下面的命令单独测试工作流：

```bash
npm run test:wf -- '{"op":"image.generate","model":"zimage","prompt":"a cat","aspect":"1:1","quality":"1k"}'
```

## 贡献授权

本项目采用 [MIT 许可证](LICENSE)。提交 Pull Request 即表示你确认这份贡献是你本人的原创，或你有权提交它，并同意它按 MIT 许可证发布。

---

**English summary:** Issues and PRs are welcome. Interface text is written in Chinese inside `t()` with its English in `shared/locales/en.ts` (keyed by the Chinese); `npm test` fails on untranslated text. Run `npm run typecheck` and `npm test` before submitting; CI runs typecheck, build, the unit tests (including the canvas assistant on pi's faux model) and a startup smoke test (`npm run smoke`) on Node 22, 24 and 26 for every PR. By submitting a pull request you confirm the contribution is yours to submit and agree that it is released under the MIT License.
