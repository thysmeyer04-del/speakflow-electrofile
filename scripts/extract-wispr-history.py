#!/usr/bin/env python3
"""Extract Wispr Flow transcript history to JSON for one-off migration into
Speakflow's RAG memory.

Usage:
  python scripts/extract-wispr-history.py [SRC_SQLITE] [OUT_JSON]

Defaults:
  SRC: %APPDATA%\\Wispr Flow\\flow.sqlite
  OUT: %APPDATA%\\speakflow-desktop\\wispr-import.json

The script reads in read-only mode; it never writes to the source DB.
Per-row text precedence: editedText > formattedText > asrText.
Archived rows and empty rows are skipped.
"""
import sqlite3
import json
import os
import sys
import datetime


def appdata_path(*parts: str) -> str:
    base = os.environ.get('APPDATA') or os.path.expanduser('~/AppData/Roaming')
    return os.path.join(base, *parts)


def default_src() -> str:
    return appdata_path('Wispr Flow', 'flow.sqlite')


def default_out() -> str:
    return appdata_path('speakflow-desktop', 'wispr-import.json')


def main() -> int:
    src = sys.argv[1] if len(sys.argv) > 1 else default_src()
    out = sys.argv[2] if len(sys.argv) > 2 else default_out()

    if not os.path.exists(src):
        print(f"ERROR: Wispr Flow DB not found at {src}", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(out), exist_ok=True)

    # Read-only open. Use URI form so the DB stays usable by Wispr Flow if open.
    uri = 'file:' + src.replace('\\', '/') + '?mode=ro&immutable=1'
    conn = sqlite3.connect(uri, uri=True, timeout=10)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT
            transcriptEntityId,
            asrText,
            formattedText,
            editedText,
            timestamp,
            app,
            numWords,
            duration,
            language,
            isArchived
        FROM History
        WHERE COALESCE(editedText, formattedText, asrText) IS NOT NULL
          AND TRIM(COALESCE(editedText, formattedText, asrText)) != ''
          AND (isArchived IS NULL OR isArchived = 0)
        ORDER BY timestamp ASC
        """
    )

    transcripts = []
    total_words = 0
    for row in cur.fetchall():
        (wid, asr, formatted, edited, ts, app, nwords, dur, lang, archived) = row
        text = (edited or formatted or asr or '').strip()
        if not text:
            continue
        word_count = nwords or len(text.split())
        transcripts.append({
            'wisprId': wid,
            'text': text,
            'timestamp': ts,
            'app': app,
            'numWords': word_count,
            'duration': dur,
            'language': lang,
        })
        total_words += word_count

    conn.close()

    payload = {
        'source': 'wispr-flow',
        'extractedAt': datetime.datetime.utcnow().isoformat() + 'Z',
        'sourcePath': src,
        'count': len(transcripts),
        'totalWords': total_words,
        'transcripts': transcripts,
    }

    with open(out, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(
        f"OK extracted {len(transcripts)} transcripts ({total_words:,} words) -> {out}",
        file=sys.stderr,
    )
    return 0


if __name__ == '__main__':
    sys.exit(main())
