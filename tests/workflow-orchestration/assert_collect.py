#!/usr/bin/env python3
"""Assert the COLLECT step's task artifact proves durable completion.

Reads `swamp data get ... --json` output on stdin (which swamp may prefix with
NDJSON status lines) and verifies the durable task reached state=completed with
a result combining the checkpointed greeting and the emitted approval.

Usage: assert_collect.py <expected-name> <expected-approver> < data-get-json
"""
import json
import sys


def last_json(buf: str):
    dec = json.JSONDecoder()
    objs = []
    i = 0
    while i < len(buf):
        if buf[i] == "{":
            try:
                obj, end = dec.raw_decode(buf, i)
                objs.append(obj)
                i = end
                continue
            except ValueError:
                pass
        i += 1
    return objs[-1] if objs else {}


def main() -> int:
    expected_name = sys.argv[1]
    expected_approver = sys.argv[2]
    d = last_json(sys.stdin.read())
    content = d.get("content") or d.get("attributes") or {}
    if isinstance(content, str):
        content = json.loads(content)

    state = content.get("state")
    if state != "completed":
        print(f"FAIL: state={state!r} (expected completed)")
        return 1

    result = content.get("result") or {}
    greeting = result.get("greeting")
    if greeting != f"hello {expected_name}":
        print(f"FAIL: greeting={greeting!r}")
        return 1

    approver = (result.get("approval") or {}).get("approver")
    if approver != expected_approver:
        print(f"FAIL: approver={approver!r}")
        return 1

    print(f"OK: state=completed greeting={greeting!r} approval={result.get('approval')!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
