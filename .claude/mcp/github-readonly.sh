#!/usr/bin/env bash
# ABOUTME: Read-only GitHub MCP server, dùng để đọc ngữ cảnh upstream khi sync.
# ABOUTME: Token lấy trực tiếp từ keyring của gh CLI — không có secret nào nằm trong repo.
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "github-readonly: cần gh CLI (brew install gh)." >&2
  exit 1
fi
if ! token=$(gh auth token 2>/dev/null) || [ -z "$token" ]; then
  echo "github-readonly: gh chưa đăng nhập. Chạy 'gh auth login'." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "github-readonly: docker daemon chưa chạy." >&2
  exit 1
fi

exec docker run -i --rm \
  -e GITHUB_PERSONAL_ACCESS_TOKEN="$token" \
  -e GITHUB_TOOLSETS=repos,pull_requests,issues \
  -e GITHUB_READ_ONLY=1 \
  ghcr.io/github/github-mcp-server
