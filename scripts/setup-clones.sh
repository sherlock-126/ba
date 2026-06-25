#!/usr/bin/env bash
# Clone lần đầu 2 repo vào thư mục service quản lý (clones/). Shallow để nhẹ.
# Dùng remote URL từ thư mục dev hiện có (để lấy đúng credential nếu repo private).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p clones

ERP_BRANCH="${ERP_BRANCH:-master}"
MARKETING_BRANCH="${MARKETING_BRANCH:-develop}"
ERP_SRC="${ERP_SRC:-/root/.vibedev/repos/ERP Kiến Trẻ}"
MKT_SRC="${MKT_SRC:-/root/.vibedev/repos/kientre_marketing}"

clone_one() {
  local dest="$1" branch="$2" src="$3"
  if [ -d "clones/$dest/.git" ]; then echo "clones/$dest đã có, bỏ qua."; return; fi
  local url; url="$(git -C "$src" remote get-url origin)"
  echo "Cloning $dest ($branch)…"
  git clone --depth 1 --branch "$branch" "$url" "clones/$dest" >/dev/null 2>&1
  echo "  done: $(du -sh "clones/$dest" | cut -f1)"
}

clone_one erp "$ERP_BRANCH" "$ERP_SRC"
clone_one marketing "$MARKETING_BRANCH" "$MKT_SRC"
# Hệ thống bổ sung (chỉ admin dùng).
clone_one dhco "${DHCO_BRANCH:-main}" "${DHCO_SRC:-/root/.vibedev/repos/dhco}"
clone_one thghub "${THGHUB_BRANCH:-main}" "${THGHUB_SRC:-/root/.vibedev/repos/thghub}"
clone_one ecount-integration "${ECOUNT_BRANCH:-main}" "${ECOUNT_SRC:-/root/.vibedev/repos/ecount-integration}"
# Side projects (nhóm "labs") — chỉ admin, hỏi-đáp code.
clone_one video_ai "${VIDEO_AI_BRANCH:-main}" "/root/.vibedev/repos/video_ai"
clone_one adg_database "${ADG_BRANCH:-main}" "/root/.vibedev/repos/adg_database"
clone_one auto_facebook "${AUTO_FB_BRANCH:-productize-nextclaw}" "/root/.vibedev/repos/auto_facebook"
clone_one design_printposs "${PRINTPOSS_BRANCH:-main}" "/root/.vibedev/repos/design_printposs"
echo "Xong."
