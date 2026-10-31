#!/usr/bin/env bash
# kindle.sh — Send content to the operator's Kindle via the gog OAuth lane.
#
# Identity comes from the environment (set in opencode-serve.env or exported):
#   MADCAT_MAIL_SENDER   — From: address (also the gog account unless
#                          MADCAT_MAIL_ACCOUNT is set)
#   MADCAT_KINDLE_EMAIL  — Send-to-Kindle target address
#   MADCAT_MAIL_DISPLAY  — display name (default: madcat)

set -euo pipefail

# === Headless gog keyring — file backend, never macOS keychain ===
# Source the opencode-serve env file (populated from nani) so GOG_KEYRING_BACKEND
# and GOG_KEYRING_PASSWORD are set even when invoked outside the serve process.
_ENV_FILE="${OPENCODE_SERVE_ENV:-$HOME/.config/madcat/opencode-serve.env}"
if [ -f "$_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$_ENV_FILE"; set +a
fi
: "${GOG_KEYRING_BACKEND:=file}"
export GOG_KEYRING_BACKEND

# === Helpers ===
err() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[kindle] $*" >&2; }

# === Identity & lane ===
SENDER="${MADCAT_MAIL_SENDER:-}"
AUTH_ACCOUNT="${MADCAT_MAIL_ACCOUNT:-$SENDER}"
KINDLE_EMAIL="${MADCAT_KINDLE_EMAIL:-}"
SENDER_DISPLAY="${MADCAT_MAIL_DISPLAY:-madcat}"
[ -n "$SENDER" ] || err "MADCAT_MAIL_SENDER is not set"
[ -n "$KINDLE_EMAIL" ] || err "MADCAT_KINDLE_EMAIL is not set"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "Missing required command: $1"
}

usage() {
  cat <<EOF
kindle.sh — Send content to Pilot's Kindle

Subcommands:
  send-md <file.md> [--title T] [--author A]   Convert markdown → EPUB → send
  send-stdin --title T [--author A]             Read stdin as markdown → EPUB → send
  send-file <path>                              Send any file (PDF/EPUB/DOCX) as-is
  status                                        Show config + last 3 sends

Sender:    $SENDER ($SENDER_DISPLAY)
Auth:      $AUTH_ACCOUNT (gog OAuth)
Target:    $KINDLE_EMAIL
EOF
}

# === Subject + body builder ===
default_subject() {
  local title="${1:-untitled}"
  local datestamp
  datestamp=$(date '+%Y-%m-%d')
  echo "${title} — ${datestamp}"
}

default_body() {
  local title="${1:-untitled}"
  cat <<EOF
Kindle delivery via the MADCAT stack.

Title: ${title}
Issued: $(date '+%Y-%m-%d %H:%M %Z')
Sender: ${SENDER_DISPLAY} <${SENDER}>

Open in Kindle library when sync completes (typically within 1-5 minutes).

— BT
EOF
}

# === Send via gog ===
send_attachment() {
  local attachment="$1"
  local title="${2:-$(basename "$attachment")}"
  [ -f "$attachment" ] || err "Attachment not found: $attachment"

  require_cmd gog

  local subject body
  subject=$(default_subject "$title")
  body=$(default_body "$title")

  log "Sending: $attachment ($(du -h "$attachment" | cut -f1))"
  log "  From:    $SENDER ($SENDER_DISPLAY)"
  log "  To:      $KINDLE_EMAIL"
  log "  Subject: $subject"

  local result
  result=$(gog gmail send \
    --account "$AUTH_ACCOUNT" \
    --from "$SENDER" \
    --to "$KINDLE_EMAIL" \
    --subject "$subject" \
    --body "$body" \
    --attach "$attachment" 2>&1) || err "gog send failed: $result"

  echo "$result"
  log "Sent — sync to device typically 1-5 min"
}

# === Convert markdown → EPUB ===
md_to_epub() {
  local md_in="$1"
  local title="${2:-untitled}"
  local author="${3:-$SENDER_DISPLAY}"
  local epub_out
  epub_out=$(mktemp -t "kindle-XXXXXX").epub

  require_cmd pandoc

  log "Converting markdown → EPUB: $md_in → $epub_out"
  pandoc "$md_in" \
    -o "$epub_out" \
    --metadata title="$title" \
    --metadata author="$author" \
    --metadata lang=en \
    --toc --toc-depth=2 \
    >/dev/null 2>&1 || err "pandoc conversion failed"

  echo "$epub_out"
}

# === Subcommands ===
cmd_send_md() {
  local file="" title="" author="$SENDER_DISPLAY"
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --author) author="$2"; shift 2 ;;
      *) file="$1"; shift ;;
    esac
  done

  [ -n "$file" ] || err "Usage: send-md <file.md> [--title T] [--author A]"
  [ -f "$file" ] || err "File not found: $file"
  [ -z "$title" ] && title=$(basename "$file" .md)

  local epub
  epub=$(md_to_epub "$file" "$title" "$author")
  send_attachment "$epub" "$title"
}

cmd_send_stdin() {
  local title="" author="$SENDER_DISPLAY"
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) title="$2"; shift 2 ;;
      --author) author="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  [ -n "$title" ] || err "Usage: send-stdin --title T [--author A]  (markdown on stdin)"

  local md_tmp
  md_tmp=$(mktemp -t "kindle-XXXXXX").md
  cat > "$md_tmp"
  [ -s "$md_tmp" ] || err "stdin was empty"

  local epub
  epub=$(md_to_epub "$md_tmp" "$title" "$author")
  send_attachment "$epub" "$title"
}

cmd_send_file() {
  local file="$1"
  [ -f "$file" ] || err "File not found: $file"
  local title
  title=$(basename "$file")
  title="${title%.epub}"
  title="${title%.pdf}"
  title="${title%.mobi}"
  title="${title%.azw3}"
  title="${title%.docx}"
  send_attachment "$file" "$title"
}

cmd_status() {
  echo "=== Kindle Delivery Configuration ==="
  echo "Sender:    $SENDER ($SENDER_DISPLAY)"
  echo "Auth lane: $AUTH_ACCOUNT (OAuth via gog)"
  echo "Target:    $KINDLE_EMAIL"
  echo "Approved-senders gate: amazon.com/myk → Personal Document Settings"
  echo ""
  echo "=== Recent sends from $SENDER ==="
  if command -v gog >/dev/null 2>&1; then
    gog gmail search --account "$AUTH_ACCOUNT" "from:$SENDER to:$KINDLE_EMAIL" --max 3 2>&1 | head -10 \
      || echo "(no recent sends found)"
  else
    echo "(gog not available)"
  fi
}

# === Entry ===
case "${1:-}" in
  send-md)    shift; cmd_send_md "$@" ;;
  send-stdin) shift; cmd_send_stdin "$@" ;;
  send-file)  shift; cmd_send_file "$@" ;;
  status|"")  cmd_status ;;
  *)          usage; exit 1 ;;
esac
