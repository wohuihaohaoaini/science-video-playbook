# 配音任务书（交给 Antigravity）

发件：克拉克（设计负责人）
收件：Antigravity agent
项目目录：仓库根目录

## 任务

把 `script/narration.json` 里的 30 句中文旁白逐句合成为语音，每句一个文件。

## 方案（按优先级）

1. 如果你能调用 Gemini 的 TTS 模型（如 Gemini Flash TTS），优先用它，选一个沉稳清晰的中文声音。
2. 否则用 `edge-tts`（微软在线神经网络语音）：
   - 只装在项目虚拟环境里：`python3 -m venv .venv && .venv/bin/pip install edge-tts`，不要动系统 Python。
   - 声音：`zh-CN-YunxiNeural`；语速 `--rate=+6%`；音量、音调保持默认。
   - 示例：`.venv/bin/edge-tts --voice zh-CN-YunxiNeural --rate=+6% --text "<句子>" --write-media audio/vo/L01.mp3`
3. 两者都不行时，停下来在汇报里说明原因，不要改用 macOS `say`。

## 要求

- 文本逐字照读 `text` 字段，不增删字。英文缩写读法：NADH 读字母，ATP 读字母，AOX 读字母。
- 输出：`audio/vo/L01.mp3` … `audio/vo/L30.mp3`（Gemini 输出 wav 也可以，扩展名照实写）。
- 句首句尾不要额外留长静音。
- 不要修改 `script/` 下的任何文件。

## 汇报

完成后写 `docs/reports/voice_report.md`：用了哪个引擎和声音、每个文件的时长（秒，可用 `edge-tts` 或 Python 的 `mutagen` 读）、总时长、遇到的问题。
