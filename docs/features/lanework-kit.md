# lanework-kit — MCP board, MCP tìm code và `lwk` (FE-152)

Lanework cho agent (Claude Code, Codex, OpenCode) hai nhóm công cụ:

- **Quản lý board**: MCP `lanework`, bản local và bản cloud dùng chung một hợp
  đồng, chỉ khác chỗ lưu dữ liệu.
- **Tìm code nhanh**: lõi kit (ripgrep, fff, ast-grep, transcripts), đi vào
  bằng MCP `lanework-kit` hoặc lệnh `lwk`. Chỉ có khi cài app.

Hướng dẫn cho agent (khi nào dùng, cú pháp từng lệnh):
[docs/agents/lanework-kit.md](../agents/lanework-kit.md).

---

## Mục lục

1. [Sơ đồ](#1--sơ-đồ)
2. [Board: một hợp đồng, hai nơi lưu](#2--board-một-hợp-đồng-hai-nơi-lưu)
3. [Lõi kit: năm công cụ tìm kiếm](#3--lõi-kit-năm-công-cụ-tìm-kiếm)
4. [Hai lối vào: MCP lanework-kit và lwk](#4--hai-lối-vào-mcp-lanework-kit-và-lwk)
5. [App bật hay tắt](#5--app-bật-hay-tắt)
6. [Hook tự sửa lệnh (mặc định tắt)](#6--hook-tự-sửa-lệnh-mặc-định-tắt)
7. [Mã nguồn ở đâu](#7--mã-nguồn-ở-đâu)

---

## 1 · Sơ đồ

```
                    Agent (Claude Code / Codex / OpenCode)
                 ┌───────────────┼──────────────────────────┐
                 │               │                          │
         (1) quản lý board   (2) tìm code (MCP)        (3) tìm code (bash)
                 │               │                          │
                 ▼               ▼                          ▼
        ┌────────────────┐ ┌───────────────────┐   ┌──────────────────────┐
        │ MCP "lanework" │ │ MCP "lanework-kit"│   │ lwk  (Rust, vài MB)  │
        │ 14 tool board  │ │ 5 tool tìm kiếm   │   │ find/grep/sg/ls/     │
        └───────┬────────┘ └────────┬──────────┘   │ sessions             │
                │                   │              │ lệnh khác ──► chạy   │
     ┌──────────┴─────────┐         │              │ thẳng lệnh gốc       │
     ▼                    ▼         │              └──────────┬───────────┘
 ┌────────┐         ┌──────────┐    │                         │
 │ Local  │         │  Cloud   │    └───────────┬─────────────┘
 │ SQLite │         │ mcp.     │                ▼
 │~/.lanew│         │lanework. │       app đang chạy?
 └────────┘         │  dev     │       ┌── có ─────────────┐   ┌── không ─────────┐
     ▲              └──────────┘       ▼                   │   ▼                  │
     │                   ▲     ┌───────────────────────┐   │   chạy độc lập       │
     └── cùng HỢP ĐỒNG ──┘     │ App Lanework          │   │   (binary app chế độ │
     (lanework-dev/contracts,       │ socket ~/.lanew/run/  │   │    Node, ~0,1 s)     │
      script parity trong      │        kit.sock       │   │                      │
      gate kiểm tra)           │ index fff luôn sẵn    │   │                      │
                               └───────────┬───────────┘   └──────────┬───────────┘
                                           └──────────────┬───────────┘
                                                          ▼
                                          ┌───────────────────────────────┐
                                          │ LÕI KIT (dùng chung 1 code)   │
                                          │ find_files      → fff (fuzzy) │
                                          │ search_text     → ripgrep     │
                                          │ search_structural → ast-grep  │
                                          │ list_files      → rg / fdir   │
                                          │ search_sessions → transcripts │
                                          │ chỉ trong folder project      │
                                          └───────────────────────────────┘
```

---

## 2 · Board: một hợp đồng, hai nơi lưu

Mỗi agent có **một** mục MCP tên `lanework` trong config. App ghi mục đó trỏ
tới **một** trong hai bản, tuỳ chế độ:

| Chế độ app | Mục `lanework` | Dữ liệu |
| --- | --- | --- |
| Local (chưa đăng nhập) | stdio, chạy `dist/electron/mcp-local/server.cjs` | SQLite trong `~/.lanew` |
| Cloud (đã đăng nhập) | http, `https://mcp.lanework.dev/v1` | trên server |

Cả hai có cùng 14 tool (`list_boards`, `create_review`, `checkpoint`,
`lifecycle_status`…). Tên, mô tả, schema đầu vào và dạng kết quả nằm trong
**một hợp đồng chung** ở `lanework-dev/contracts (src/tools/)`. Bản local dựng
`tools/list` từ hợp đồng; `scripts/mcp-parity.mjs` chạy trong `bun run gate`
kiểm tra bản local khớp hợp đồng (từng trường của từng kết quả). Bản cloud
dùng chung hợp đồng ở repo lanework-cloud (card riêng).

---

## 3 · Lõi kit: năm công cụ tìm kiếm

| Tool | Làm gì | Dựa trên |
| --- | --- | --- |
| `find_files` | Tìm file theo tên, chịu được gõ sai và viết tắt (`convview` → `conversation-view.tsx`) | fff, dự phòng rg/fdir |
| `search_text` | Tìm chữ trong file, tôn trọng `.gitignore` | ripgrep |
| `search_structural` | Tìm code theo hình dạng, ví dụ `useEffect($A, [])` | ast-grep |
| `list_files` | Liệt kê file dưới một folder, tôn trọng `.gitignore` | rg / fdir |
| `search_sessions` | Tìm chat cũ (Claude Code, Codex, OpenCode) theo nội dung | transcripts |

**Phạm vi:** chỉ tìm trong folder agent đang chạy (project) hoặc folder con
của nó. Đường dẫn ra ngoài, `../`, symlink trỏ ra ngoài, hay chạy từ `$HOME`
hoặc `/` đều bị từ chối.

`search_sessions` trước đây nằm trong MCP board; FE-152 chuyển nó sang kit để
MCP board chỉ còn việc quản lý board, giống hệt bản cloud.

---

## 4 · Hai lối vào: MCP lanework-kit và lwk

- **MCP `lanework-kit`**: mục thứ hai trong config của agent, luôn là stdio,
  không phụ thuộc chế độ local/cloud của board. Bật/tắt từng harness ở
  **Settings → Harness → Lanework**; mặc định tắt.
- **`lwk`** ở `~/.lanew/bin/lwk`, viết bằng Rust (vài MB, khởi động vài ms):
  - `lwk find`, `lwk grep`, `lwk sg`, `lwk ls`, `lwk sessions` (thêm `--json`
    để ra cùng dạng kết quả với MCP).
  - Lệnh nào khác thì **chạy thẳng lệnh gốc**: `lwk git status` chính là
    `git status`, cùng output, cùng exit code.

Vì sao Rust: bản `bun --compile` thử trước chạy tốt nhưng mỗi binary
~100 MB (nhúng cả runtime Bun), làm app nặng thêm ~200 MB.

---

## 5 · App bật hay tắt

- **App đang chạy**: MCP `lanework-kit` và `lwk` hỏi app qua socket
  `~/.lanew/run/kit.sock` (quyền 0600). App giữ index fff luôn sẵn nên tìm
  file gần như tức thì.
- **App tắt** (hoặc socket bận): tự chạy lõi kit độc lập bằng binary của app ở
  chế độ Node, chậm hơn khoảng 0,1 giây mỗi lệnh.

---

## 6 · Hook tự sửa lệnh (mặc định tắt)

`lwk hook on` thêm một hook `PreToolUse` cho Claude Code: lệnh
`grep -rn "chuỗi thường" dir` được đổi thành `lwk grep -F … dir`. Chỉ đổi
lệnh hiểu hết từng phần; mọi thứ khác giữ nguyên: escape regex kiểu `a\|b`,
cờ lạ, pipe, chuyển hướng, biến, `cd … &&`. Không bọc lệnh hai lần, không tự
duyệt quyền (luật permission của bạn vẫn áp dụng). `lwk hook off` gỡ;
`lwk hook status` cho biết đang bật hay tắt.

Vì sao mặc định tắt: tự sửa lệnh âm thầm làm đổi nghĩa lệnh khi hai công cụ
hiểu khác nhau (regex của grep khác ripgrep), và agent không biết vì sao lệnh
của mình hỏng. Bài học từ `rtk` (đã gỡ khỏi máy, 2026-11-17).

---

## 7 · Mã nguồn ở đâu

| Phần | Đường dẫn |
| --- | --- |
| Hợp đồng tool | `lanework-dev/contracts (src/tools/)` |
| Kiểm tra parity | `apps/desktop/scripts/mcp-parity.mjs` |
| MCP board local | `apps/desktop/electron/mcp-local/` |
| Lõi kit | `apps/desktop/electron/kit/` |
| Socket trong app | `apps/desktop/electron/main/kit-socket.ts` |
| MCP `lanework-kit` | `apps/desktop/electron/mcp-kit/` |
| Ghi config agent | `apps/desktop/electron/main/agent-setup/mcp-entry.ts` |
| `lwk` (Rust) | `apps/desktop/lwk/` |
| `lwk` chạy độc lập (JS) | `apps/desktop/electron/lwk/` |
