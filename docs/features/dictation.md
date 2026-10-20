# Dictation — nói thay vì gõ trong composer (FE-69)

Bấm 🎙 (hoặc ⌘⇧M) trong composer, nói, chữ hiện ra ngay trong ô nhập. ✓ giữ
chữ lại để sửa rồi gửi; ✕ bỏ đi. **Không bao giờ tự gửi**, không đọc câu trả lời
thành tiếng.

Chỉ macOS 26 trở lên. Nhận dạng chạy trên máy bằng Apple `DictationTranscriber`
— audio không rời khỏi Mac.

---

## Mục lục

1. [Các phần tham gia](#1--các-phần-tham-gia)
2. [Quy trình một lần đọc chính tả](#2--quy-trình-một-lần-đọc-chính-tả)
3. [Kết thúc: ✓, ✕ và các trường hợp khác](#3--kết-thúc--và-các-trường-hợp-khác)
4. [Giao thức helper ↔ main](#4--giao-thức-helper--main)
5. [Bảng sửa từ](#5--bảng-sửa-từ)
6. [Vì sao chọn engine của Apple](#6--vì-sao-chọn-engine-của-apple)
7. [Build và đóng gói](#7--build-và-đóng-gói)
8. [Phím tắt, giao diện và Dynamic Island](#8--phím-tắt-giao-diện-và-dynamic-island)
9. [Gỡ lỗi](#9--gỡ-lỗi)
10. [Giới hạn đã biết](#10--giới-hạn-đã-biết)

---

## 1 · Các phần tham gia

| Phần | File | Làm gì |
| --- | --- | --- |
| **Composer** (renderer) | `apps/desktop/src/components/shared/conversation/composer.tsx` | Nhớ vị trí con trỏ, hiển thị chữ live, khoá ô nhập khi đang nghe, Esc/Enter/⌘⇧M |
| | `…/conversation/composer.dictation.tsx` | Hook `useDictation` (giữ trạng thái một phiên, lọc sự kiện theo số phiên, áp bảng sửa từ), `DictationButton` (🎙 + ▾ chọn ngôn ngữ), `DictationBar` (sóng âm + ✕ ✓) |
| | `…/conversation/dictation-waveform.tsx` | Sóng âm dùng chung cho composer và island |
| **Dynamic Island** | `apps/desktop/src/components/features/shell/dictation-island.tsx` | Viên đen ở giữa phía trên: sóng âm đỏ, thời gian, nút stop |
| | `apps/desktop/src/stores/dictation.ts` | `useLiveDictation`: composer đang nghe ghi trạng thái vào đây, island đọc ra |
| **Hợp đồng chung** | `apps/desktop/shared/dictation.ts` | Kênh IPC, kiểu sự kiện, ngôn ngữ, bảng sửa từ mặc định, `applyCorrections`, `insertDictation` |
| **Preload** | `apps/desktop/electron/preload/index.ts` | Mở đúng 5 lệnh: `supported`, `start`, `stop`, `cancel`, `onEvent` |
| **Main** | `apps/desktop/electron/main/dictation/index.ts` | Kiểm tra máy và tham số, spawn/huỷ helper, chuyển dòng JSON thành sự kiện |
| **Helper Swift** | `apps/desktop/native/dictation/main.swift` → `dist/electron/bin/lanework-dictation` | Mở mic, gọi Apple `DictationTranscriber`, in kết quả ra stdout |
| **Settings** | `apps/desktop/src/components/features/settings/dictation-section.tsx` | Chọn ngôn ngữ, sửa bảng sửa từ |
| **Lưu tuỳ chọn** | `apps/desktop/src/stores/preferences.ts` | `dictationLocale`, `dictationCorrections` (localStorage, theo máy) |

---

## 2 · Quy trình một lần đọc chính tả

```
Anh bấm 🎙 / ⌘⇧M
   │
   ▼
① Composer ghi nhớ vị trí con trỏ (hoặc đoạn đang bôi đen)
   → gọi start("vi_VN", các từ đúng trong bảng sửa từ)
   │
   ▼
② Main kiểm tra: macOS ≥ 26? có helper? ngôn ngữ hợp lệ? hints hợp lệ?
   → spawn helper (đang có phiên cũ thì huỷ phiên cũ trước)
   → trả về số phiên
   │
   ▼
③ Helper:
   - xin quyền mic (chỉ lần đầu — macOS hiện hộp thoại)
   - máy chưa có model tiếng Việt → tải về             → "preparing"
   - mở mic                                              → "listening"
   - ~20 lần/giây: độ to của giọng (0…1)                → "level"
   - nghe tới đâu gửi chữ tới đó                        → "text"
       final    = phần Apple đã chốt, không đổi nữa
       volatile = phần đang nghe dở, còn có thể đổi
   │  (mỗi sự kiện là một dòng JSON trên stdout)
   ▼
④ Main đọc từng dòng, kiểm tra kiểu, kẹp giá trị level vào 0…1,
   gắn số phiên rồi gửi về renderer
   │
   ▼
⑤ Composer:
   - bỏ qua sự kiện không đúng số phiên hiện tại
   - chạy bảng sửa từ ("thai check" → "typecheck")
   - hiển thị: chữ cũ + chữ đang nghe chèn đúng chỗ con trỏ
     (xám nghiêng; ô nhập readOnly để không gõ lẫn vào)
```

Chữ đang nghe **chỉ được hiển thị**, chưa ghi vào draft. Draft trong ô nhập
chỉ đổi khi anh bấm ✓.

---

## 3 · Kết thúc: ✓, ✕ và các trường hợp khác

| Hành động | Điều gì xảy ra |
| --- | --- |
| **✓ / Enter** | Composer gửi `stop` → helper tắt mic, đợi Apple chốt phần cuối → `done` kèm cả câu → composer áp bảng sửa từ lần cuối, chèn vào ô nhập, con trỏ đặt ngay sau chữ vừa chèn. Anh sửa rồi tự gửi. |
| **✕ / Esc** | Main kill helper ngay. Ô nhập trở về y như trước khi bấm mic. |
| **✕ khi helper còn đang khởi động** | Composer nhớ là đã huỷ; main trả số phiên về thì huỷ luôn phiên đó. |
| **Bấm mic ở composer khác** | Main huỷ phiên cũ trước khi mở phiên mới — chỉ một mic mở tại một thời điểm. |
| **Rời conversation / đóng view** | Composer unmount → huỷ phiên → helper bị kill, mic được nhả. |
| **Thoát app** | `will-quit` kill helper còn chạy. |
| **Main chết** | stdin của helper bị đóng (EOF) → helper tự thoát. |
| **Helper crash không kịp báo** | Main thấy process thoát mà chưa có `done`/`error` → gửi lỗi `exited` ("Dictation stopped unexpectedly."). |
| **Từ chối quyền mic** | Helper gửi `microphone-denied` → composer hiện hướng dẫn mở System Settings › Privacy & Security › Microphone. |

---

## 4 · Giao thức helper ↔ main

Gọi: `lanework-dictation --locale vi_VN [--hint từ]... [--file bản-ghi.wav]`

`--file` đọc file ghi âm thay cho mic — dùng để tự kiểm tra mà không cần nói:

```bash
sleep 20 | apps/desktop/dist/electron/bin/lanework-dictation --locale vi_VN --file sample.wav
```

(`sleep 20 |` giữ stdin mở; stdin đóng là helper thoát.)

**stdout** — một object JSON mỗi dòng:

| `type` | Trường | Khi nào |
| --- | --- | --- |
| `preparing` | — | Đang tải model ngôn ngữ (lần đầu) |
| `listening` | — | Mic đã mở |
| `level` | `value` 0…1 | ~20 lần/giây |
| `text` | `final`, `volatile` | Mỗi lần nghe thêm được chữ |
| `done` | `text` | Sau lệnh `stop`, rồi thoát với mã 0 |
| `error` | `code`, `message` | Rồi thoát với mã 1 |

Mã lỗi: `microphone-denied`, `microphone`, `unsupported`, `assets`, `engine`,
`usage`; main thêm `spawn` (không chạy được helper) và `exited` (helper chết im lặng).

**stdin** — một lệnh mỗi dòng: `stop` (chốt và trả kết quả) hoặc `cancel` (thoát ngay).

Main **không tin** helper hay renderer: ngôn ngữ phải nằm trong
`DICTATION_LOCALES`; hints tối đa `HINT_MAX` (100) từ, mỗi từ tối đa
`HINT_LENGTH_MAX` (60) ký tự; mọi IPC đi qua `handle()` kiểm tra người gửi.

---

## 5 · Bảng sửa từ

Apple nghe tiếng Anh chen trong câu tiếng Việt thành chữ Việt ("thai check",
"còn beat"), và **bỏ qua** danh sách thuật ngữ gợi ý (`contextualStrings`).
Nên sau khi nhận dạng, chữ đi qua bảng sửa từ.

**Sửa ở:** Settings → Dictation → Corrections. Mỗi dòng một quy tắc:

```
thai check, ti te check, type check → typecheck
còn beat, cơm mít → commit
```

`->` và `=>` cũng dùng được thay cho `→`. Dòng không có mũi tên bị bỏ qua.

**Quy tắc khớp** (`applyCorrections` trong `shared/dictation.ts`):

- Khớp **nguyên từ**: "bấp" được sửa, "bấpbênh" thì không.
- Không phân biệt hoa thường; nhiều khoảng trắng coi như một.
- Cụm dài được áp trước, nên "ti te check" thắng "ti te".
- Áp cho cả chữ đang hiển thị live lẫn câu cuối cùng.

**Mặc định:** chưa sửa lần nào thì dùng `DEFAULT_CORRECTIONS` — và bộ mặc định
có thay đổi ở bản sau thì anh cũng nhận được. Đã sửa thì app lưu bảng của anh;
nút **Reset** quay về theo bộ mặc định.

Các từ đúng (vế phải) vẫn được truyền cho Apple làm `contextualStrings`, phòng
khi macOS sau này dùng tới.

---

## 6 · Vì sao chọn engine của Apple

Spike ngày 2026-10-20 (M1 16GB, macOS 27), so trên giọng thật của anh:

| Câu | Apple DictationTranscriber | Whisper large-v3-turbo + gợi ý | PhoWhisper medium |
| --- | --- | --- | --- |
| "Em đọc lại phần đăng nhập rồi giải thích cho anh luồng xử lý nhé" | **đúng hết**, 0.9s | sai 1 từ ("luôn"), ~3.9s | sai 1 từ ("năng nhập"), 5.1s |
| "Sửa bug trong auth client, chạy typecheck rồi commit với push lên branch main" | sai thuật ngữ ("thai check", "còn beat"…) | **đúng thuật ngữ** | sai nhiều ("ukraine", "premier league") |
| "alô 1234" ×2 | đúng | sai ("12.4") | đúng |

- `SpeechTranscriber` (engine monocode dùng) **không có tiếng Việt**.
- `SFSpeechRecognizer` tiếng Việt chỉ chạy qua server Apple → loại.
- Whisper chỉ thắng nhờ gợi ý thuật ngữ, nhưng chạy theo lô — không có chữ live
  mượt — và cần tải model 550MB.

Chọn **chỉ Apple** (FE-69/D2): nhanh, on-device, có chữ live, không phải tải gì;
điểm yếu về thuật ngữ được bù bằng bảng sửa từ.

---

## 7 · Build và đóng gói

- `scripts/build-dictation.mjs` build helper bằng `xcrun swiftc` vào
  `dist/electron/bin/lanework-dictation`. Được gọi từ `build-electron.mjs`
  (`bun run build`) và `dev.mjs` (`bun run dev`).
- Chỉ build lại khi `main.swift` mới hơn file đã build.
- Không có `swiftc` hoặc không phải macOS → bỏ qua kèm cảnh báo, **không lỗi**.
  App vẫn chạy, chỉ là composer không có nút mic.
- `electron-builder.yml`:
  - `asarUnpack: dist/electron/bin/**` — file thực thi nằm trong `app.asar`
    thì không spawn được; main tự đổi đường dẫn sang `app.asar.unpacked`.
  - `mac.extendInfo` thêm `NSMicrophoneUsageDescription` và
    `NSSpeechRecognitionUsageDescription` — macOS hiện câu này khi xin quyền.
- Bản dev chạy bằng Electron đổi tên thành "Lanework" nên hộp thoại xin quyền
  hiện câu mặc định của Electron ("This app needs access to the microphone").
- Khi build có cảnh báo `installTap(...)` bị deprecated trên macOS 27 — không
  ảnh hưởng, vẫn chạy trên 26 và 27.

---

## 8 · Phím tắt, giao diện và Dynamic Island

| Phím | Khi nào | Tác dụng |
| --- | --- | --- |
| ⌘⇧M | Ô nhập có focus, hoặc không ô nào có focus | Bắt đầu nghe; đang nghe thì = ✓ |
| Enter | Đang nghe | ✓ (không gửi tin nhắn) |
| Esc | Đang nghe | ✕ |

Khi đang nghe:

- Placeholder là "Listening…" (hoặc "Downloading the speech model…" lúc tải model lần đầu).
- Chip model và permission ẩn đi; thanh sóng âm cùng ✕ ✓ thay chỗ nút gửi.
- Ô nhập readOnly, chữ xám nghiêng.

Menu ▾ cạnh mic và Settings → Dictation cùng đổi một tuỳ chọn ngôn ngữ
(Tiếng Việt / English, mặc định Tiếng Việt).

**Dynamic Island.** Suốt lúc mic mở, một viên đen hiện ở giữa phía trên cửa
sổ — cùng chỗ với các island khác (cập nhật CLI, thông báo board, đăng nhập MCP):

```
╭────────────────────────────────────────────╮
│  ···▌▍▊▌█▋▍█▌▊···········   01:15   (■)    │
╰────────────────────────────────────────────╯
   sóng âm đỏ (chấm xám = im lặng)   thời gian   stop
```

- Thời gian đếm từ lúc mic thực sự mở; lúc tải model thì hiện "Preparing…".
- **Stop (■) = ✓**: tắt mic và **giữ** chữ. Muốn bỏ thì ✕ hoặc Esc trong composer.
- Island này **ưu tiên cao nhất**: đang nghe thì island cập nhật CLI, đăng nhập
  MCP và thông báo board tạm nhường chỗ, hết nghe thì chúng hiện lại. Mic đang
  mở là thứ phải luôn thấy được.
- Đang nghe ở composer nào thì chỉ composer đó điều khiển island; composer khác
  đóng lại cũng không làm island biến mất.

---

## 9 · Gỡ lỗi

| Triệu chứng | Kiểm tra |
| --- | --- |
| Không thấy nút mic | macOS < 26, hoặc chưa có `dist/electron/bin/lanework-dictation` (xem log build có cảnh báo `lanework-dictation was not built`) |
| Báo không dùng được mic | System Settings › Privacy & Security › Microphone → bật Lanework |
| Lần đầu đứng ở "Downloading the speech model…" lâu | Đang tải model tiếng Việt của Apple — cần mạng, chỉ một lần |
| Một từ hay bị nghe sai | Thêm quy tắc vào Settings → Dictation |
| Muốn thử engine không qua app | `sleep 20 \| …/lanework-dictation --locale vi_VN --file <file.wav>` |
| Muốn thử từ console của renderer | `await window.desktop.dictation.supported()` |

---

## 10 · Giới hạn đã biết

- Chỉ macOS 26+. Windows/Linux: nút mic ẩn.
- Thuật ngữ tiếng Anh chỉ đúng khi có trong bảng sửa từ.
- Nếu hai composer cùng mở một lúc, ⌘⇧M (khi không ô nào có focus) có thể bật
  mic ở cả hai. Phiên sau sẽ huỷ phiên trước, nên mic không bị mở hai lần.
- Chưa có: dictation trong comment box của PR/issue, đọc câu trả lời thành
  tiếng, engine cloud. Mỗi thứ cần một card riêng.
