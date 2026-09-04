---
name: sync-upstream-kiro
kind: playbook
description: >
  Use when user asks to sync/port upstream changes from mikeyobrien/pi-provider-kiro,
  update kiro-core against upstream, check for a new upstream release, review what
  changed upstream, or runs //sync-upstream. Repo này là port ngữ nghĩa của upstream,
  không phải fork — merge/rebase/cherry-pick không dùng được.
---

# Skill: sync-upstream-kiro

Đưa thay đổi mới của [mikeyobrien/pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro)
vào repo này, bằng cách **port có ngữ nghĩa** chứ không merge.

## Vì sao không merge được

`ns-kiro-provider` không chia sẻ git history với upstream. Commit đầu tiên là một
bản import squash. Kiến trúc cũng đã khác:

| | upstream | repo này |
| --- | --- | --- |
| Layout | một package phẳng, `src/` ở root | pnpm workspace, `packages/{kiro-core,omp-provider-kiro,dsh-llm-kiro}` |
| Vocabulary | message/event type của `@earendil-works/pi-ai` | type host-neutral trong `packages/kiro-core/src/types.ts` |
| Host | chỉ pi/OMP | OMP **và** DeepSeek Harness |
| Login | PKCE browser flow tự chạy (`login.ts`, `login-ui.ts`) | đọc lại session `kiro-cli` / Kiro IDE, cộng API key |

Nên `git merge upstream/main`, `git rebase`, `git cherry-pick` đều **cấm**. Mỗi
hunk upstream phải được đọc, hiểu, rồi viết lại vào file tương ứng của repo này.

## Các lớp công cụ

| Lớp | Vai trò |
| --- | --- |
| **Skill này** | Playbook: xác định range → đánh giá → port → verify → cập nhật baseline |
| **`scripts/upstream-status.mjs`** | Bước đánh giá tự động: fetch, lọc nhiễu, phân loại từng file mỗi commit chạm |
| **Git remote `upstream`** | Nguồn diff chính. Fetch-only, `tagOpt=--no-tags`, `pushurl` đã bị vô hiệu hóa |
| **GitHub MCP** (`.mcp.json` → `.claude/mcp/github-readonly.sh`) | Ngữ cảnh *vì sao* upstream đổi: mô tả PR, review comment, release note. Read-only, token lấy từ keyring `gh` lúc chạy |
| **`gh` CLI** | Fallback khi docker chưa chạy: `gh pr view <n> --repo mikeyobrien/pi-provider-kiro --comments` |
| **`.upstream-sync.json`** | Baseline: commit đã sync tới, path mapping, danh sách không port |

Tool MCP hay dùng: `list_commits`, `get_commit`, `pull_request_read`, `list_releases`,
`get_file_contents`, `search_code` — tất cả trên `mikeyobrien/pi-provider-kiro`.
Server chạy với `GITHUB_READ_ONLY=1`, không có tool ghi nào được nạp.

## Mutate policy

| Hành động | Cần user duyệt? |
| --- | --- |
| `git fetch upstream`, đọc log/diff/PR (read-only) | Không |
| Báo cáo "có N commit mới, đây là phân loại" | Không |
| Port thay đổi vào `packages/**` | **Có** — trình bảng triage trước, chờ duyệt |
| Đổi public export surface của package core (`packages/kiro-core`) | **Có** — nêu rõ ai đang import |
| Commit / push / mở PR | **Có** |
| `git merge` / `rebase` / `cherry-pick` từ upstream | **Không bao giờ** |

---

## Quy trình

### 0. Đảm bảo remote đúng cấu hình

```bash
git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/mikeyobrien/pi-provider-kiro.git
git config remote.upstream.tagOpt --no-tags
git fetch upstream
```

`--no-tags` là bắt buộc: tag của upstream (`v0.10.x`) sẽ đè lên namespace tag của
repo này, vốn version độc lập ở `0.1.0`. Nếu lỡ kéo về, xóa bằng
`git tag -l | xargs git tag -d` — kiểm tra `git tag --merged main` rỗng trước đã.

### 1. Đánh giá khoảng cách — một lệnh

```bash
node .claude/skills/sync-upstream-kiro/scripts/upstream-status.mjs
```

Script này chỉ đọc. Nó fetch, đọc baseline từ `.upstream-sync.json`, bỏ commit
release và đường dẫn `notPorted`, rồi với mỗi commit còn lại in ra từng file kèm
phân loại `neutral` / `PI-COUPLED` / `SKIP` / `MỚI` và đường dẫn đích trong
`packages/`. Độ coupling được tính động bằng cách grep import `pi-` trong file
upstream tại tip, nên nó không lỗi thời khi upstream đổi.

Không có commit nào → báo "đã ngang bằng upstream `<tag>`" và dừng.

Truyền một sha làm tham số để dry-run từ baseline khác:
`… upstream-status.mjs 2315aaa`.

### 2. Đọc ngữ cảnh trước khi mở diff

Script trả lời *cái gì đổi*. Trước khi port, cần biết *vì sao*:

- `git show upstream/main:CHANGELOG.md` — upstream tự mô tả từng thay đổi.
- Với commit có số PR trong subject, đọc mô tả và review comment qua MCP
  (`pull_request_read`) hoặc `gh pr view <n> --repo mikeyobrien/pi-provider-kiro --comments`.
  Phần lớn fix protocol của upstream có một dòng giải thích trigger thực tế — dòng
  đó quyết định bản port có cần đúng hành vi ấy hay không.
- Bug chỉ tồn tại vì cách pi cấu trúc message thì **không** port. Bug ở tầng wire
  của Kiro thì **luôn** port.

### 3. Triage từng commit

Đối chiếu output của script với bảng dưới, rồi quyết định port / bỏ / hoãn cho từng commit:

| Nhóm | File upstream | Cách port |
| --- | --- | --- |
| **Neutral** | `bracket-tool-parser` `debug` `endpoints` `event-parser` `history` `history-validator` `invoke-tool-parser` `kiro-cli` `kiro-ide` `management` `retry` `token-type` `tokenizer` | Không import `pi-ai`. Thường áp diff gần như nguyên văn vào `packages/kiro-core/src/<tên>.ts` |
| **Pi-coupled** | `effort` `models` `oauth` `stream` `thinking-parser` `transform` `truncation` `usage` `index` | Có import `@earendil-works/pi-ai`. Phải dịch vocabulary — xem bảng dưới |
| **Ngoài phạm vi** | `login-ui` và phần PKCE của `login` | Bỏ qua, trừ khi chạm tới primitive trong `oauth.ts`. Login của repo này nằm ở `packages/omp-provider-kiro/src/auth.ts` |

Kiểm tra nhanh một file upstream có coupled hay không:

```bash
git show upstream/main:src/<file>.ts | grep -n "pi-ai\|pi-tui\|pi-coding-agent"
```

Trình bảng triage cho user và **dừng chờ duyệt** trước khi sửa code.

### 4. Dịch vocabulary khi port file pi-coupled

| Khái niệm upstream (`pi-ai`) | Tương đương trong repo này |
| --- | --- |
| `Message`, `UserMessage`, `AssistantMessage` | `KiroMessage`, `KiroUserMessage`, `KiroAssistantMessage` — `types.ts` |
| content block của pi | `KiroTextContent`, `KiroImageContent`, `KiroThinkingContent`, `KiroToolCallContent` |
| tool result | `KiroToolResultMessage` (`role: "toolResult"`, có `toolCallId`/`toolName`/`isError`) |
| stop reason của pi | `KiroStopReason`: `stop` \| `length` \| `toolUse` \| `error` \| `aborted` |
| `Model`, `ThinkingLevelMap` | catalog type trong `models.ts` + `KiroEffort` / `KIRO_EFFORT_ORDER` |
| `OAuthCredentials` | `KiroCredentials` (`oauth.ts`) |
| `Tool` | `KiroTool` (`name` / `description` / `parameters`) |
| emit event trực tiếp cho host | `KiroBlockBuffer` trong `blocks.ts` cấp phát block index và emit `KiroStreamEvent` |

Nguyên tắc: **hành vi protocol là của upstream, kiểu dữ liệu là của repo này.** Nếu
một hunk upstream chỉ tồn tại để chiều type của pi-ai, nó không cần port.

Ngược lại, khi hành vi mới cần dữ liệu mà `types.ts` chưa có, mở rộng `types.ts`
trước — đừng lôi type của pi-ai vào `packages/kiro-core`. Package này không được phép
depend vào bất kỳ host nào.

### 5. Kiểm tra adapter phía dưới

Sau khi sửa `packages/kiro-core`, xem thay đổi có chạm export surface không:

```bash
git diff packages/kiro-core/src/index.ts
rg -n "<symbol vừa đổi>" packages/omp-provider-kiro/src packages/dsh-llm-kiro/src
```

Đổi contract nội bộ là được phép (xem workflow `execution` trong `~/.claude/CLAUDE.md`),
nhưng phải cập nhật cả hai adapter trong cùng lần thay đổi, không để lệch.

Lưu ý: OMP local dùng `@oh-my-pi/pi-ai`, upstream đã đổi sang `@earendil-works/pi-ai`.
Đây là hai tên của cùng một package sau khi pi đổi tên — đừng port cái rename này
vào `packages/omp-provider-kiro` trừ khi OMP 18.x thật sự đã chuyển.

### 6. Port test

Test upstream ánh xạ 1:1 sang `packages/kiro-core/test/`, trừ các mục trong
`notPorted`. Cạm bẫy đáng chú ý:

- **`test/stream.test.ts` không port 1:1.** `packages/kiro-core/test/stream.test.ts`
  là bộ test độc lập theo vocabulary neutral, không cùng cấu trúc với upstream
  (~4400 dòng, bám vào `Context`/`AssistantMessageEvent` của pi, và dùng event
  `error` trong khi bản port `throw`). Khi upstream đụng `src/stream.ts`: đọc test
  upstream để lấy *ý định*, rồi thêm case tương ứng vào bộ local. Chạy
  `npx vitest run packages/kiro-core/test/stream.test.ts` sau mỗi lần port.
- `test/registration.test.ts` và `test/packaging.test.ts` của upstream kiểm tra
  đăng ký extension của pi; phần tương đương nằm ở `packages/omp-provider-kiro/test/packaging.test.ts`
  và `packages/dsh-llm-kiro/test/packaging.test.ts`, hình dạng đã khác.

### 7. Verify

```bash
pnpm lint
pnpm -r build
pnpm -r check
pnpm test
```

Đúng thứ tự này — `check` typecheck dựa trên declaration đã build, nên build phải
chạy trước (xem `.github/workflows/ci.yml`).

### 8. Cập nhật baseline và commit

Sửa `.upstream-sync.json`: `syncedCommit` = `git rev-parse upstream/main`,
`syncedTag`, `syncedAt`. Nếu có file upstream mới chưa từng thấy, thêm nó vào
`pathMapping` hoặc `notPorted` kèm lý do.

Commit mang trailer để truy được nguồn gốc:

```
Upstream-Sync: <sha upstream>
```

Chỉ sync một phần range thì `syncedCommit` phải trỏ đúng commit cuối cùng đã port,
**không** trỏ tới tip. Ghi thẳng phần còn bỏ dở vào báo cáo.

---

## Cạm bẫy

- **Đừng để tag upstream lọt vào repo.** `git tag --merged main` phải luôn rỗng
  đối với tag của upstream.
- **Đừng port CHANGELOG hay số version của upstream.** Package ở đây version độc lập.
- **Đừng port thẳng `src/index.ts`.** Export surface của `packages/kiro-core` rộng hơn (nó
  còn phục vụ dsh) và có type riêng. Chỉ lấy phần export mới thật sự tương ứng.
- **`NOTICE` là ràng buộc pháp lý.** Nếu bản port bắt đầu phủ vùng code mới của
  upstream, cập nhật đoạn mô tả trong `NOTICE`.
- **Không đọc/ghi `docs/`** (quy ước chung của user).
