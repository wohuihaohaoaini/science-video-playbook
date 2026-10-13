#!/usr/bin/env bash
# Hand a written brief to an agent and capture its log.
#
#   scripts/handoff.sh codex docs/briefs/05_Codex任务书.md        # engineering
#   scripts/handoff.sh voice docs/briefs/06_配音任务书_Antigravity.md   # voice-over via Antigravity (agy)
#
# Codex runs WITHOUT its sandbox: inside `-s workspace-write`, headless Chrome aborts (SIGABRT in
# TransformProcessType) and h264_videotoolbox fails with -12903, so it can write the pipeline but never
# render a frame. Only use the bypass on a machine/project you trust; the brief still limits which files
# it may touch.
set -euo pipefail
cd "$(dirname "$0")/.."
who="${1:?codex|voice}"; brief="${2:?path to brief}"
mkdir -p build docs/reports
stamp=$(date +%Y%m%d-%H%M%S)
case "$who" in
  codex)
    codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox \
      -c model_reasoning_effort="high" -C "$PWD" -o "build/codex_last_$stamp.md" \
      "你是本项目的工程负责人。阅读并执行 $brief，严格遵守其中的文件边界。开工前先运行 make preflight，任一 FAIL 先在汇报中说明。完成后更新 docs/reports/codex_report.md。" \
      2>&1 | tee "build/codex_$stamp.log"
    ;;
  voice)
    agy -p "请阅读并执行 $brief 中的配音任务，按其中要求完成并写汇报。" \
      --dangerously-skip-permissions --print-timeout 1500s 2>&1 | tee "build/agy_$stamp.log"
    ;;
  *) echo "unknown agent: $who" >&2; exit 2 ;;
esac
