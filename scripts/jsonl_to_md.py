"""Convert a Claude Code JSONL transcript to a human-readable Markdown file.

Keeps just user messages and assistant text replies. Drops:
- internal thinking blocks
- tool calls / tool results (the wall-of-noise from file edits, bash, etc.)
- system reminders
- sidechain (sub-agent) messages
- queue / title / system bookkeeping events

Pass the JSONL path as arg 1 and the output path as arg 2.
"""
import json
import re
import sys
from datetime import datetime

JSONL = sys.argv[1]
OUT = sys.argv[2]

SYS_REMINDER_RE = re.compile(r"<system-reminder>.*?</system-reminder>", re.DOTALL)


def clean(text: str) -> str:
    # Strip <system-reminder>...</system-reminder> blocks the harness injects.
    return SYS_REMINDER_RE.sub("", text).strip()


def extract_user_content(message: dict) -> str | None:
    content = message.get("content")
    if isinstance(content, str):
        return clean(content) or None
    if isinstance(content, list):
        # Skip user-role messages that are actually tool-results.
        parts = []
        for item in content:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "tool_result":
                return None  # Whole message is a tool result, drop it.
            if item.get("type") == "text":
                parts.append(item.get("text", ""))
        text = "\n".join(parts).strip()
        return clean(text) or None
    return None


def extract_assistant_text(message: dict) -> str | None:
    content = message.get("content")
    if not isinstance(content, list):
        return None
    parts = []
    for item in content:
        if not isinstance(item, dict):
            continue
        # Drop thinking and tool_use blocks; keep visible text only.
        if item.get("type") == "text":
            parts.append(item.get("text", ""))
    text = "\n".join(parts).strip()
    return clean(text) or None


def fmt_ts(ts: str | None) -> str:
    if not ts:
        return ""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return ts


turns = []
with open(JSONL, "r", encoding="utf-8") as f:
    for line in f:
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        t = obj.get("type")
        if t not in ("user", "assistant"):
            continue
        if obj.get("isSidechain"):
            continue
        msg = obj.get("message")
        if not isinstance(msg, dict):
            continue
        if t == "user":
            text = extract_user_content(msg)
            if text:
                turns.append(("user", fmt_ts(obj.get("timestamp")), text))
        else:
            text = extract_assistant_text(msg)
            if text:
                turns.append(("assistant", fmt_ts(obj.get("timestamp")), text))

with open(OUT, "w", encoding="utf-8") as f:
    f.write("# CommonCommunication build session\n\n")
    f.write(f"_{len(turns)} turns · exported {datetime.now().strftime('%Y-%m-%d %H:%M')}_\n\n")
    f.write("---\n\n")
    for role, ts, text in turns:
        label = "🧑 **You**" if role == "user" else "🤖 **Claude**"
        f.write(f"### {label}")
        if ts:
            f.write(f"  _<sub>{ts}</sub>_")
        f.write("\n\n")
        f.write(text)
        f.write("\n\n---\n\n")

print(f"Wrote {len(turns)} turns to {OUT}")
