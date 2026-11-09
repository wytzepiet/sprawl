"""Energy by rail from a phone's Perfetto trace, per bench phase.

python3 -I bench/power.py <trace.pftrace> <perf url> <tab>
The trace's power_rails packets (TracePacket field 40) give cumulative energy per
rail (uWs); its clock snapshots tie boot time to wall time; the game's /perf
reports give each phase's wall-clock span. Prints mean mW per phase, by rail and
in total.
"""
import json, sys, urllib.request, datetime


def varint(b, i):
    v = s = 0
    while True:
        c = b[i]; i += 1
        v |= (c & 0x7F) << s; s += 7
        if c < 0x80: return v, i


def fields(b):
    i = 0
    while i < len(b):
        key, i = varint(b, i)
        f, t = key >> 3, key & 7
        if t == 0: v, i = varint(b, i)
        elif t == 1: v = b[i:i + 8]; i += 8
        elif t == 2:
            n, i = varint(b, i); v = b[i:i + n]; i += n
        elif t == 5: v = b[i:i + 4]; i += 4
        else: raise ValueError(t)
        yield f, v


def read(path):
    names, samples, offset = {}, [], None
    for f, packet in fields(open(path, "rb").read()):
        if f != 1: continue
        for pf, v in fields(packet):
            if pf == 6:  # clock snapshot: realtime (1) minus boottime (6)
                clocks = {}
                for cf, c in fields(v):
                    if cf == 1:
                        d = dict(fields(c)); clocks[d.get(1)] = d.get(2)
                if 1 in clocks and 6 in clocks: offset = clocks[1] - clocks[6]
            if pf == 40:
                for rf, r in fields(v):
                    d = dict(fields(r))
                    if rf == 1: names[d.get(1, 0)] = d.get(2, b"").decode()
                    if rf == 2: samples.append((d.get(1, 0), d.get(2, 0), d.get(3, 0)))
    return names, samples, offset


def main():
    path, url, tab = sys.argv[1:4]
    names, samples, offset = read(path)
    reports = [json.loads(l) for l in urllib.request.urlopen(f"{url}/perf?tab={tab}").read().decode().splitlines() if l.strip()]
    reports = [r for r in reports if r.get("tab") == tab]
    spans = {}
    for r in reports:
        end = datetime.datetime.fromisoformat(r["at"].replace("Z", "+00:00")).timestamp() * 1000
        a, b = spans.get(r["phase"], (end - 5000, end))
        spans[r["phase"]] = (min(a, end - 5000), max(b, end))
    by = {}
    for idx, ms, e in samples:
        by.setdefault(idx, []).append(((ms * 1e6 + offset) / 1e6 if offset is not None else ms, e))
    print(f"{'phase':8}" + "".join(f"{names.get(i, i)[:10]:>11}" for i in sorted(by)) + f"{'total':>9}")
    for phase, (a, b) in spans.items():
        if phase == "settle": continue
        row, total = [], 0
        for i in sorted(by):
            s = [p for p in by[i] if a + 5000 <= p[0] <= b - 2000]  # skip the turn
            mw = (s[-1][1] - s[0][1]) / (s[-1][0] - s[0][0]) if len(s) > 1 else float("nan")
            row.append(mw); total += mw
        print(f"{phase:8}" + "".join(f"{v:11.0f}" for v in row) + f"{total:9.0f}")


main()
