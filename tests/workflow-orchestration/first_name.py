#!/usr/bin/env python3
"""Print the `name` of the first result in `swamp data query --json` output.

Tolerates NDJSON status lines that swamp may prefix before the JSON object.
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


rows = last_json(sys.stdin.read()).get("results", [])
print(rows[0]["name"] if rows else "")
