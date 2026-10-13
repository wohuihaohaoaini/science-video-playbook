# Codex 工程任务书

项目根目录：____
先读：docs/WORKFLOW.md、docs/CHECKLIST.md、scenes/film.js 文件头

## 0. 边界
- 只能写 `pipeline/`、`build/`、`out/`、`docs/reports/`；不能改 `script/`、`scenes/`、`audio/vo/`、`docs/briefs/`。发现画面 bug 时写进汇报，不要自己改。
- 依赖只装进 `.venv`。
- **第一步运行 `make preflight`**，任何一项 FAIL 都先写进汇报。

## 1. 任务
- [ ] 字体与照片：`make assets`；照片授权写进 CREDITS.md
- [ ] `make prepare`：确认 timeline.json 里有 `source=chrome-filmReady`
- [ ] `make still T=__`，`make sample SCENE=__`：抽帧后**停下**，等设计负责人验收
- [ ] 收到“样片通过”后：`make full mix check`

## 2. 汇报（docs/reports/codex_report.md）
做了什么、文件清单、实测耗时（帧/秒）、preflight 结果、需要设计负责人拍板的事项。
