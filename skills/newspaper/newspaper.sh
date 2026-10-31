#!/usr/bin/env bash
# newspaper.sh — Deliver a sequentially-numbered "Newspaper" issue to Pilot's Kindle.
# Content (magazine-style markdown) is supplied on stdin; the caller/LLM curates
# the articles, this script numbers, converts (md → EPUB via pandoc), and delivers
# through the same gog OAuth lane as kindle.sh.
#
# Identity comes from the environment, same variables as kindle.sh:
#   MADCAT_MAIL_SENDER, MADCAT_MAIL_ACCOUNT (optional), MADCAT_KINDLE_EMAIL,
#   MADCAT_MAIL_DISPLAY (default: madcat), MADCAT_NEWSPAPER_AUTHOR (default: display name)

set -euo pipefail

# Headless gog keyring + identity: source the opencode-serve env file so the
# MADCAT_* and GOG_* variables are set even when invoked outside the serve.
_ENV_FILE="${OPENCODE_SERVE_ENV:-$HOME/.config/madcat/opencode-serve.env}"
if [ -f "$_ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$_ENV_FILE"; set +a
fi
: "${GOG_KEYRING_BACKEND:=file}"
export GOG_KEYRING_BACKEND

# === Helpers ===
err() { echo "ERROR: $*" >&2; exit 1; }
log() { echo "[newspaper] $*" >&2; }

# === Identity & lane (mirrors kindle.sh) ===
SENDER="${MADCAT_MAIL_SENDER:-}"
AUTH_ACCOUNT="${MADCAT_MAIL_ACCOUNT:-$SENDER}"
KINDLE_EMAIL="${MADCAT_KINDLE_EMAIL:-}"
SENDER_DISPLAY="${MADCAT_MAIL_DISPLAY:-madcat}"
AUTHOR="${MADCAT_NEWSPAPER_AUTHOR:-$SENDER_DISPLAY}"
[ -n "$SENDER" ] || err "MADCAT_MAIL_SENDER is not set"
[ -n "$KINDLE_EMAIL" ] || err "MADCAT_KINDLE_EMAIL is not set"

# === Sequence counter state ===
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/madcat/newspaper"
SEQ_FILE="$STATE_DIR/sequence"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "Missing required command: $1"
}

# === Sequence management ===
read_current() {
  if [ -f "$SEQ_FILE" ]; then
    cat "$SEQ_FILE"
  else
    echo "0"
  fi
}

# Zero-padded 4-digit issue id for a given number.
fmt_seq() {
  printf '%04d' "$1"
}

peek_next() {
  local cur
  cur=$(read_current)
  fmt_seq $((cur + 1))
}

advance_seq() {
  local cur next
  cur=$(read_current)
  next=$((cur + 1))
  mkdir -p "$STATE_DIR"
  echo "$next" > "$SEQ_FILE"
  echo "$next"
}

# === Subject + body builder ===
issue_subject() {
  local issue_id="$1" issue_type="$2"
  local datestamp
  datestamp=$(date '+%Y-%m-%d')
  if [ -n "$issue_type" ]; then
    echo "Newspaper-${issue_id} (${issue_type}) — ${datestamp}"
  else
    echo "Newspaper-${issue_id} — ${datestamp}"
  fi
}

issue_body() {
  local issue_id="$1" issue_type="$2"
  local flavor="${issue_type:-standard}"
  cat <<EOF
MADCAT Newspaper — Issue ${issue_id} (${flavor})

Issued: $(date '+%Y-%m-%d %H:%M %Z')
Sender: ${SENDER_DISPLAY} <${SENDER}>

A curated reading issue. Open in your Kindle library once sync completes
(typically within 1-5 minutes).

— BT
EOF
}

# === Convert markdown → EPUB ===
md_to_epub() {
  local md_in="$1" title="$2"
  local epub_out
  epub_out=$(mktemp -t "newspaper-XXXXXX").epub

  require_cmd pandoc

  log "Converting markdown → EPUB: $md_in → $epub_out"
  pandoc "$md_in" \
    -o "$epub_out" \
    --metadata title="$title" \
    --metadata author="$AUTHOR" \
    --metadata lang=en \
    --toc --toc-depth=2 \
    --split-level=1 \
    >/dev/null 2>&1 || err "pandoc conversion failed"

  echo "$epub_out"
}

# === Send via gog (mirrors kindle.sh send lane) ===
send_attachment() {
  local attachment="$1" subject="$2" body="$3"
  [ -f "$attachment" ] || err "Attachment not found: $attachment"

  require_cmd gog

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

# === Subcommands ===

# send [topic_count] [issue_type] [--dry]
# Issue markdown is read from stdin. topic_count is accepted for interface
# compatibility (the caller curates the actual article count); issue_type is a
# flavor label carried into the subject/body. --dry converts + reports without
# sending, and does NOT advance the sequence counter.
cmd_send() {
  local issue_type="" dry=0
  local positional=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry|--dry-run) dry=1; shift ;;
      *) positional+=("$1"); shift ;;
    esac
  done

  # positional[0] = topic_count (numeric, optional, informational)
  # positional[1] = issue_type (optional). Also accept a lone non-numeric
  # first positional as the issue_type for flexibility.
  if [ "${#positional[@]}" -ge 1 ]; then
    if [[ "${positional[0]}" =~ ^[0-9]+$ ]]; then
      [ "${#positional[@]}" -ge 2 ] && issue_type="${positional[1]}"
    else
      issue_type="${positional[0]}"
    fi
  fi

  # Read issue markdown from stdin.
  local md_tmp
  md_tmp=$(mktemp -t "newspaper-XXXXXX").md
  cat > "$md_tmp"
  [ -s "$md_tmp" ] || err "stdin was empty — pipe the issue markdown into 'send'"

  local issue_id
  if [ "$dry" -eq 1 ]; then
    issue_id=$(peek_next)   # preview number, do not advance
  else
    issue_id=$(fmt_seq "$(advance_seq)")
  fi

  local title subject body epub
  title="Newspaper-${issue_id}"
  subject=$(issue_subject "$issue_id" "$issue_type")
  body=$(issue_body "$issue_id" "$issue_type")
  epub=$(md_to_epub "$md_tmp" "$title")

  if [ "$dry" -eq 1 ]; then
    log "DRY RUN — not sending. Would deliver issue $issue_id."
    log "  Subject: $subject"
    log "  EPUB:    $epub ($(du -h "$epub" | cut -f1))"
    echo "DRY: Newspaper-${issue_id} prepared (not sent, counter unchanged): $epub"
    return 0
  fi

  send_attachment "$epub" "$subject" "$body"
  echo "Newspaper-${issue_id} sent to ${KINDLE_EMAIL}"
}

cmd_next() {
  peek_next
}

cmd_current() {
  local cur
  cur=$(read_current)
  if [ "$cur" -eq 0 ]; then
    echo "none"
  else
    fmt_seq "$cur"
  fi
}

usage() {
  cat <<EOF
newspaper.sh — Deliver a numbered Newspaper issue to Pilot's Kindle

Subcommands:
  send [topic_count] [issue_type] [--dry]   Read issue markdown on stdin →
                                            number → EPUB → send. --dry previews
                                            without sending (counter unchanged).
  next                                      Print next issue number (zero-padded)
  current                                   Print last issued number, or 'none'

Sender:    $SENDER ($SENDER_DISPLAY)
Auth:      $AUTH_ACCOUNT (gog OAuth)
Target:    $KINDLE_EMAIL
State:     $SEQ_FILE
EOF
}

# === Entry ===
case "${1:-}" in
  send)    shift; cmd_send "$@" ;;
  next)    cmd_next ;;
  current) cmd_current ;;
  ""|-h|--help|help) usage ;;
  *)       usage; exit 1 ;;
esac
