# 工作流程

三个 Agent，一个人。全程通过**文件**交接：设计负责人写任务书（`docs/briefs/`），执行方写汇报（`docs/reports/`），设计负责人负责验收。

```
需求 ──▶ ① 核实与选题 ──▶ ② 台本 + 文献 ──▶ ③ 分镜 / 声音设计 ──▶ ④ 配音（Antigravity）
                                                                     │
         ⑨ 交付 ◀── ⑧ 成片验收 ◀── ⑦ 全片 + 混音 ◀── ⑥ 样片验收 ◀── ⑤ 动画代码 + 工程管线（Codex）
```

| 角色 | 负责 | 产出 |
|---|---|---|
| **Claude（设计负责人）** | 选题、事实核对、文献、台本、分镜、全部动画代码（`scenes/film.js`）、声音设计、封面/标题/简介、所有验收 | `docs/briefs/01–04, 07`、`scenes/`、`script/` |
| **Codex（工程负责人）** | 渲染管线、并行渲染、运动模糊、编码、字体与照片采集、配乐程序合成、混音、字幕导出、自检 | `pipeline/`、`build/`、`out/` |
| **Antigravity（配音）** | 按任务书逐句合成旁白 | `audio/vo/Lxx.mp3` |
| **用户** | 定需求、拍板取舍（时长理解、依赖安装、权限） | — |

---

## ① 核实与选题（Claude）
1. 盘点环境：`codex --version`、`agy models`、ffmpeg、Chrome、CPU/GPU。确认每个 Agent **实际**能做什么（例：Antigravity 没有 TTS 工具）。
2. 先把需求里的事实核实一遍，有问题当场提出来（例：“高原湿地臭菘”）。
3. 问清楚三件事：时长是上限还是下限、用什么配音引擎、能否安装依赖。

## ② 台本 + 文献（Claude）
- 文献：检索 → `script/references.json` → `make refs`（对照 Crossref）。不一致时再查 PubMed。
- 台本：`script/narration.json`，每句带 `id / scene / text`。按每秒约 4.6 字估算时长。
- 事实核对表：`docs/briefs/01_台本与事实核对.md`，**每句**标出依据。

## ③ 分镜与声音设计（Claude）
- `03_分镜与视觉规范.md`：风格卡（网格、色值、字体、动画语法）、逐场分镜、照片清单、**事实护栏**。
- `04_声音设计.md`：调性、速度、分层、段落强度、音效表、混音目标。

## ④ 配音（Antigravity）
```bash
scripts/handoff.sh voice docs/briefs/06_配音任务书_Antigravity.md
make durations
```
改台本后只补录改动的句子：`.venv/bin/python tools/tts_edge.py L22 L24`。

## ⑤ 动画代码（Claude）与工程管线（Codex）
- `scenes/film.js` 对管线的接口约定：
  - `filmReady()`：加载字体、照片、旁白时长，建立时间线
  - `renderFrame(t)`：纯函数，可以按任意顺序调用
  - `TIMELINE` / `SCENES` / `getSfxCues()` / `renderCover()`
- 时间线完全由旁白时长加停顿规则推出，画面里所有动画都挂在 `cue('Lxx')` 上，换配音也不会错位。
- 在浏览器里预览：`make preview`，打开 `/scenes/index.html?preview=1&t=75`。
- 工程：
```bash
scripts/handoff.sh codex docs/briefs/05_Codex任务书.md   # 已带 --dangerously-bypass-approvals-and-sandbox
```

## ⑥ 样片验收（Claude）
```bash
make preflight
make prepare           # 导出浏览器时间线 + 封面 + 配乐
make still T=75        # 先看一张图
make sample SCENE=S3   # 10 秒样片 + 抽帧；输出全片耗时估计
```
看 `build/sample_check/*.png`（**全尺寸**），通过后把 `build/sample_review.json` 的 status 改成 `"passed"`。

## ⑦ 全片 + 混音
```bash
make full mix
```
实测（Apple M5，7 个 worker，每帧 4 个子帧，VideoToolbox）：约 25–26 帧/秒，4 分钟的片子约 4.5–5 分钟渲完；混音约 11 秒。

## ⑧ 成片验收（Claude）
```bash
make check             # 规格、帧数、响度、每场抽帧 + contact.jpg
```
对照 `docs/CHECKLIST.md` 第 3、6 节目视检查。发现问题 → 改 `film.js` → `make full mix check`（约 5 分钟）。

## ⑨ 交付
`out/`：成片 mp4、`cover.png`、`.srt`、简介与参考文献（含章节时间点、DOI 链接、照片署名）。验收记录写进 `docs/briefs/08_验收记录.md`。
