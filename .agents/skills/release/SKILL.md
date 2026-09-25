---
name: release
kind: playbook
description: >
  Use when user asks to cut/publish a release, bump package versions, push a
  version tag, create a GitHub Release, or runs //release. Publish đi qua
  tag-push + GitHub Actions OIDC; GitHub Release tạo thủ công sau khi npm
  xác nhận.
---

# Skill: release

Phát hành `ns-kiro-core`, `ns-omp-provider-kiro`, `ns-dsh-llm-kiro` lên npm.
Ba package **luôn cùng một version** — adapter pin exact `ns-kiro-core` qua
`workspace:*` (resolve lúc `pnpm pack`, không cần sửa tay).

Cơ chế: push tag `vX.Y.Z` → `.github/workflows/publish.yml` chạy trên
self-hosted `macmini`, publish bằng OIDC trusted publishing (không có npm
token, không 2FA prompt). Tag phải khớp version của cả 3 `package.json`,
workflow tự refuse nếu lệch.

## Mutate policy

| Hành động | Cần user duyệt? |
| --- | --- |
| `git pull`, đọc log/tag/npm registry (read-only) | Không |
| Bump version, commit trên `main` | Không nếu user đã nói release — repo rule: chỉ làm trên `main`, không tạo branch |
| Push `main`, push tag `vX.Y.Z` | Không nếu user đã nói release — tag push là trigger publish, coi như đã duyệt |
| `gh release create` | Không — là bước cuối của release |
| Re-release vì npm rớt một package | **Có** nếu phải skip version; không nếu chỉ là propagation chậm (xem Cạm bẫy) |
| Sửa `publish.yml` / trusted publisher trên npmjs.com | **Có** — luôn hỏi |

## Quy trình

### 0. Precondition

```bash
git pull              # main, working tree clean
git tag -l | tail -5  # xem tag mới nhất
```

### 1. Chọn version

Conventional commits từ tag trước tới HEAD: `fix:` → patch, `feat:` → minor.
`git log --oneline <tag-trước>..HEAD`.

### 2. Bump cả 3 package.json

```bash
for p in packages/kiro-core packages/omp-provider-kiro packages/dsh-llm-kiro; do
  sed -i '' "s/\"version\": \"<cũ>\"/\"version\": \"<mới>\"/" "$p/package.json"
done
```

### 3. Commit, tag, push

```bash
git add packages/*/package.json
git commit -m "chore: bump all three packages to X.Y.Z"
git tag vX.Y.Z
git push origin main vX.Y.Z
```

### 4. Watch workflow

```bash
gh run list -R ngosangns/ns-kiro-provider --workflow=publish.yml --limit 1
gh run watch -R ngosangns/ns-kiro-provider <run-id> --exit-status
```

**Bắt buộc `-R ngosangns/ns-kiro-provider`** — `gh` trong repo này mặc định
resolve sang upstream `mikeyobrien/pi-provider-kiro`, sẽ show nhầm run.

Job mất ~1m40s–4m: lint → build → check → test → verify tag → pack → publish.
Thứ tự publish: `ns-kiro-core` trước (adapter pin exact version của nó).

### 5. Verify npm — bằng registry API, đừng tin `npm view`

```bash
for n in ns-kiro-core ns-omp-provider-kiro ns-dsh-llm-kiro; do
  curl -s https://registry.npmjs.org/$n | node -p \
    "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); '$n ' + d['dist-tags'].latest"
done
```

`npm publish` trả `+ pkg@ver` rồi **"being processed"** — registry xử lý async.
`ns-kiro-core`/`ns-dsh-llm-kiro` lên trong ~2–4 phút. **`ns-omp-provider-kiro`
chậm ~40 phút** (bundle 1.3MB) — đây là bình thường, đã xảy ra và xác nhận ở
v0.3.1/v0.3.2. Kiểm tra `d.versions['X.Y.Z']` để biết version đã land chưa khi
`latest` chưa nhảy.

### 6. GitHub Release — thủ công, publish.yml không tự tạo

```bash
gh release create vX.Y.Z -R ngosangns/ns-kiro-provider --title vX.Y.Z --latest --notes "..."
```

Style notes theo release cũ (`gh release view v0.2.3 ... --json body`): đoạn
mở đầu một câu, section `## Changed`/`## Fixed`, section `## Packages` link
tới npmjs.com. **Đừng** ghi "published with provenance" — provenance đã bị
bỏ từ v0.3.1 (self-hosted runner không được sigstore hỗ trợ).

Nếu bỏ lỡ GitHub Release của tag cũ thì tạo bù luôn, chỉ tag mới nhất `--latest`.

## Cạm bẫy

- **`gh` resolve nhầm repo.** Luôn `-R ngosangns/ns-kiro-provider` trong mọi lệnh `gh`.
- **npm "being processed" ≠ fail.** Một package thiếu trên registry ngay sau
  publish thường chỉ là đang xử lý — chờ và poll trước khi kết luận rớt.
- **Re-publish cùng version không đi qua workflow.** `npm publish` version đã tồn tại
  fail, và step chạy `bash -e` nên hỏng ở package đầu → các package sau không được
  retry. Nếu một package thật sự bị npm drop (không xuất hiện sau >1 giờ), cách
  duy nhất là **bump patch mới** và release lại cả ba — không re-run tag cũ.
- **Tag phải khớp version cả 3 package**, workflow refuse ngược lại.
- **`workflow_dispatch` có input `dry-run`** để kiểm tra pack output mà không publish.
- **`NOTICE` là ràng buộc pháp lý** nếu release mang code upstream mới — xem skill
  `sync-upstream-kiro`.
- **Không đọc/ghi `docs/`** (quy ước chung của user).
