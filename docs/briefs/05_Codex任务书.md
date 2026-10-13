# Codex 工程任务书 v1

发件：克拉克（设计负责人）
收件：Codex（工程负责人）
项目根目录：仓库根目录

先读：`docs/03_分镜与视觉规范.md`、`docs/04_声音设计.md`、`scenes/film.js` 文件头注释。

## 0. 边界

- 不要修改 `script/`、`scenes/`、`audio/vo/`，也不要改 `docs/` 下除 `docs/reports/` 以外的文件。所有画面和动画都由我在 `scenes/film.js` 里负责。如果发现画面 bug，写进汇报，不要自己改。
- Python 依赖只装在项目的 `.venv` 里（已存在，Python 3.14）。可以装 numpy、scipy、Pillow、mutagen、requests 这类纯 Python 或 wheel 包。
- **v2 更新（用户已同意）**：B 阶段的依赖用 pip 装进 `.venv`：`imageio-ffmpeg`（用它自带的静态 ffmpeg，路径用 `imageio_ffmpeg.get_ffmpeg_exe()` 获取）和 `playwright`。浏览器用系统里的 Google Chrome（`channel="chrome"`）。**不要**执行 `playwright install`，不要下载 Chromium，也不要动系统环境。没有 ffprobe 时，用 `ffmpeg -i` 解析信息代替。
- 先检查这个 ffmpeg 是否支持 `h264_videotoolbox`（`-encoders`）。不支持就改用 `libx264 -preset medium -crf 16`，并在汇报里说明。
- 你写的代码都放在 `pipeline/` 下，中间产物放在 `build/`，成片放在 `out/`。

## A 阶段（现在就能做）

### A1 字体采集

下载到 `assets/fonts/`，文件名必须与 `scenes/index.html` 里的 @font-face 一致：
- `Inter-Regular.ttf`、`Inter-Medium.ttf`、`Inter-Bold.ttf`、`Inter-Black.ttf`：从 Inter 官方 GitHub release（rsms/inter）获取静态 TTF。
- `NotoSansSC-Regular.otf`、`NotoSansSC-Medium.otf`、`NotoSansSC-Bold.otf`、`NotoSansSC-Black.otf`：从 notofonts/noto-cjk 的 GitHub（Sans/SubsetOTF/SC）获取。
- 每个字体的许可证（OFL）文本一起放进 `assets/fonts/LICENSES/`。

### A2 照片采集

按 `docs/03` 第 3 节的清单，从 Wikimedia Commons 下载 4 张照片到 `assets/photos/`：
- 选 CC BY / CC BY-SA / CC0 / 公有领域的照片；物种必须正确，以 Commons 分类页 `Category:<学名>` 为准。
- 长边缩到 2400 px，保存为 JPEG（质量 90）。彩色原图即可，灰度化由画面代码完成。
- 构图优先：花序清楚、主体居中、背景简洁。`skunk_snow.jpg` 尽量选有雪或早春湿地背景的照片。
- 把每张照片的标题、作者、许可证、Commons 页面链接写进 `assets/photos/CREDITS.md`。

### A3 旁白时长与时间线

- 用 mutagen 精确测出 `audio/vo/L01–L31.mp3` 的时长，写入 `build/vo_durations.json`（我已经放了一个初版，请覆盖）。
- 时间线不要自己算。用 Chrome 打开 `scenes/index.html`，`await filmReady()` 之后读 `window.TIMELINE`、`window.SCENES`、`getSfxCues()` 和 `FILM.duration`，保存为 `build/timeline.json`。这一步需要 Playwright，可以放到 B 阶段开头做。A 阶段先用 Python 复刻 `buildTimeline()` 的规则生成一份预估版也可以。
- 总时长由时间线决定（约 248 秒，不少于 240 秒），不要强行压到 240 秒。

### A4 配乐与音效合成

- 按 `docs/04_声音设计.md` 用 numpy/scipy 程序合成，写一个 `pipeline/music.py`。
- 产出：`build/music.wav`（全长、48 kHz 立体声，尚未做 ducking）、`build/sfx.wav`（按 cue 表放好音效）。
- 段落强度跟着 `SCENES` 的场边界走；配乐要在 `FILM.duration` 处自然结束。

## B 阶段（依赖装好后）

### B1 渲染管线 `pipeline/render.py`

- 用 `python3 -m http.server` 在项目根目录起本地服务，Playwright 打开 `http://127.0.0.1:<port>/scenes/index.html`，视口 1920×1080，`deviceScaleFactor=1`。优先用系统已装的 Google Chrome（`channel="chrome"`）。
- 逐帧调用 `renderFrame(t)`，读取 canvas 像素。用 `canvas.toBlob` 或 CDP 截图都可以，以速度快、颜色不偏为准。
- **运动模糊**：每帧取 4 个子帧做时间平均，子帧时间为 `t + k/(4*30)*0.5`，k = 0..3（快门 180°），均值在 numpy 里算。
- **胶片颗粒**：可选。如果加，用确定性种子的单色高斯噪声，σ ≤ 2.0（0–255 刻度），纸白区域不能看出脏。
- **并行**：10 核 M5，开 6–8 个浏览器 worker，按帧区间切分；各段输出 raw 帧，通过管道交给 ffmpeg。
- **编码**：`h264_videotoolbox`，码率约 16 Mbps，`-pix_fmt yuv420p`，BT.709 色彩标记，30 fps 恒定帧率。分段编码后用 concat 无损拼接。
- 先渲一版 **10 秒样片**（从 S3 开始），抽帧检查后再全片渲染。

### B2 旁白对齐与混音 `pipeline/mix.py`

- 每句旁白放在 `timeline.json` 的 `start` 处；`tempo` 为 1 时不做变速。
- 对配乐做 sidechain ducking（−8 dB，attack 60 ms，release 400 ms），音效比旁白低 10–14 dB。
- 总响度 −16 LUFS，峰值 ≤ −1 dBTP（用 ffmpeg `loudnorm` 两遍法）。
- 输出 AAC 320 kbps，48 kHz 立体声，和视频封装到 `out/抗氰呼吸_1080p30.mp4`。

### B3 字幕

- 字幕已经由 `film.js` 画进画面（烧录），样式是我定的，不要再叠一层。
- 另外导出 `out/抗氰呼吸.srt`，时间来自 `timeline.json`，供平台挂外挂字幕用。

### B4 自检

- `ffprobe`：1920×1080、30 fps、时长与 `FILM.duration` 的误差不超过 1 帧，音轨存在。
- 抽帧：在每场中点和参考文献两屏中点各抽一帧，保存到 `build/check/*.png`。
- 片尾参考文献：确认两屏各停留约 8 秒、文字锐利，没有被运动模糊或颗粒弄糊（静止画面的子帧完全相同，应该是锐利的）。
- 用 `ebur128` 测成片响度，写进汇报。

## B5 封面

- 页面上调用 `await filmReady(); renderCover();`，把 canvas 导出为 `out/cover.png`（1920×1080，无损 PNG）。

## 汇报

每个阶段完成后，更新 `docs/reports/codex_report.md`：做了什么、文件清单、渲染耗时、遇到的问题，以及需要设计负责人决定的事项。
