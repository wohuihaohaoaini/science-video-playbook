# 科普视频制作手册 · Science Video Playbook

**一支几分钟的知识类科普视频，如何从选题做到发布。** 这是一套可以照着做的方法，附带一个完整实例和一套配套工具。

实例：《抗氰呼吸：植物为什么会发热？》，4 分 08 秒，1920×1080 / 30 fps，中文配音和字幕，瑞士国际主义风格，片尾附期刊参考文献。由 Claude（设计）、Codex（工程）、Antigravity（配音）协作完成。

---

## 制作十一步

| # | 步骤 | 要点 | 本例 |
|---|---|---|---|
| 1 | **选题** | 把知识点倒推成一个“反常”的现象，开头 20 秒内抛出问题 | 零下的雪地里，花序 20 °C |
| 2 | **核实** | 需求和常识都要查一手来源，发现错误要指出来 | “高原湿地臭菘”→ 实际生于海拔 300 m 以下 |
| 3 | **文献** | 先定证据再写台本；DOI 逐项核对；台本每句标出依据 | 5 篇放片尾，3 篇延伸阅读 |
| 4 | **台本** | 一句一个信息点，每秒约 4.6 字；钩子→铺垫→冲突→机制→回到现象→拓展→收束 | 31 句，约 970 字 |
| 5 | **分镜** | 一场一个视觉主角；同一张图持续演变；动画挂在旁白上 | 电子传递链：正常→阻断→长出支路 |
| 6 | **视觉风格** | 先定一张风格卡：网格、四种颜色、字体、动画语法 | 12 栏网格，黑白灰加红 |
| 7 | **配音** | 逐句生成，先测时长，画面跟着配音走 | edge-tts，31 个文件 |
| 8 | **声音** | 配乐给人声让路；用声音表现概念（阻断时脉冲停一拍） | −16 LUFS，有旁白时配乐降 8 dB |
| 9 | **片尾文献** | 15–16 秒，分 2 屏，大字，不滚动，不朗读 | 每屏 8 秒，30 px |
| 10 | **验收** | 先出一张图→10 秒样片→全片；全尺寸放大看；用数据检查 | 修了 6 处问题 |
| 11 | **发布** | 封面一个问题加一个大字；标题是“现象 + 术语”；简介附章节时间点和 DOI | 见 [briefs/07](docs/briefs/07_封面标题简介.md) |

👉 **每一步的详细做法、标准和实例：[docs/GUIDE.md](docs/GUIDE.md)**

## 怎么避免出错

👉 **[docs/CHECKLIST.md](docs/CHECKLIST.md)**：按阶段排列的错误检验清单（环境、事实、时间线、画面、渲染、声音、成片）。每项写明查什么、怎么查、不过关时什么现象。

👉 **[docs/LESSONS.md](docs/LESSONS.md)**：这次实际踩过的 12 个坑，以及怎么解决、以后怎么防。

## 多 Agent 协作

| 角色 | 负责 |
|---|---|
| Claude（设计负责人） | 选题、核实、文献、台本、分镜、全部动画代码、声音设计、封面与简介、验收 |
| Codex（工程负责人） | 渲染管线、并行渲染、编码、素材采集、配乐合成、混音、自检 |
| Antigravity（配音） | 逐句合成旁白 |

三方通过文件交接：设计负责人写任务书，执行方写汇报，设计负责人验收。流程和命令见 [docs/WORKFLOW.md](docs/WORKFLOW.md)；这次的全部任务书原件在 [docs/briefs/](docs/briefs/)；新项目用的空白模板在 [templates/](templates/)。

---

## 配套工具（可选）

画面用代码绘制（Canvas 2D），每一帧由时间唯一决定，所以可以并行渲染、反复重渲，换配音也会自动重新对轴。

```bash
make setup             # Python 虚拟环境（不改系统，不下载 Chromium，需已装 Google Chrome）
make assets            # 开源字体 + 示例照片
make voice             # 合成旁白
make refs              # 用 Crossref 核对 DOI
make preflight         # 检查 Chrome、显卡编码、字体、照片、音频
make prepare           # 导出时间线 + 封面 + 配乐
make preview           # 在浏览器里拖动预览：/scenes/index.html?preview=1
make still T=75        # 渲染一张图
make sample SCENE=S3   # 10 秒样片，并估算全片耗时
make full mix check    # 全片、混音、成片自检（样片验收通过后）
```

```
project.json        参数：尺寸、帧率、时长下限、渲染、配音、混音、配乐
script/             台本 narration.json、文献 references.json
scenes/film.js      全部画面（时间线、字幕、转场、各场动画、封面）
pipeline/           render / music / mix / check / serve
tools/              preflight / verify_doi / vo_durations / tts_edge / fetch_assets
scripts/handoff.sh  把任务书交给 Codex 或 Antigravity
```

> ⚠️ `scripts/handoff.sh codex` 会用 `--dangerously-bypass-approvals-and-sandbox` 运行 Codex。原因是在它的默认沙盒里，Chrome 无法启动、显卡编码不可用，只能写代码、渲不出帧（见 [LESSONS #1](docs/LESSONS.md)）。请只在可信的机器和项目上使用。

## 许可

文字与代码：MIT。字体：SIL OFL（通过 `make assets` 下载）。示例照片：各自的 CC 协议，见 [assets/photos/CREDITS.md](assets/photos/CREDITS.md)，不随仓库分发。参考文献只列出处。
