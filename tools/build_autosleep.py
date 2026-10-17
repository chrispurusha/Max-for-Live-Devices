# Builds AutoSleep.amxd from Live's stock Max MIDI Effect template (BUILD.md).
# usage: /usr/bin/python3 tools/build_autosleep.py AutoSleep.amxd
import json, struct, sys
TEMPLATE = "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Misc/Max Devices/Max MIDI Effect.amxd"
OUT = sys.argv[1]
d = open(TEMPLATE, 'rb').read()
assert d[:4] == b'ampf' and d[24:28] == b'ptch'
n = struct.unpack('<I', d[28:32])[0]
p = json.loads(d[32:32+n].rstrip(b'\0'))
pt = p['patcher']
pt['openinpresentation'] = 1
boxes, lines = pt['boxes'], pt['lines']
F = {"fontname": "Arial Bold", "fontsize": 10.0}
ids = {b['box']['text']: b['box']['id'] for b in boxes if b['box'].get('maxclass') == 'newobj'}
midiin, midiout = ids['midiin'], ids['midiout']
def add(b): boxes.append({"box": b})
def line(a, ao, b, bi): lines.append({"patchline": {"source": [a, ao], "destination": [b, bi]}})

add(dict(id="obj-js", maxclass="newobj", text="js autosleep.js", numinlets=1, numoutlets=2, outlettype=["", ""], patching_rect=[360.0, 200.0, 110.0, 20.0], **F))
add(dict(id="obj-thd", maxclass="newobj", text="live.thisdevice", numinlets=1, numoutlets=3, outlettype=["bang","int","int"], patching_rect=[360.0, 34.0, 100.0, 20.0], **F))
add(dict(id="obj-tbb", maxclass="newobj", text="t b b", numinlets=1, numoutlets=2, outlettype=["bang","bang"], patching_rect=[360.0, 60.0, 40.0, 20.0], **F))
add(dict(id="obj-msg", maxclass="message", text="outputvalue", numinlets=2, numoutlets=1, outlettype=[""], patching_rect=[420.0, 90.0, 90.0, 20.0]))
add(dict(id="obj-rx", maxclass="newobj", text="r autosleep_all", numinlets=0, numoutlets=1, outlettype=[""], patching_rect=[500.0, 160.0, 90.0, 20.0], **F))
add(dict(id="obj-pre", maxclass="newobj", text="prepend set", numinlets=2, numoutlets=1, outlettype=[""], patching_rect=[360.0, 230.0, 70.0, 20.0], **F))
add(dict(id="obj-status", maxclass="message", text="", numinlets=2, numoutlets=1, outlettype=[""], patching_rect=[360.0, 260.0, 150.0, 20.0], presentation=1, presentation_rect=[8.0, 116.0, 230.0, 20.0]))
add(dict(id="obj-off", maxclass="message", text="sleepnow", numinlets=2, numoutlets=1, outlettype=[""], patching_rect=[650.0, 200.0, 55.0, 20.0], presentation=1, presentation_rect=[8.0, 143.0, 56.0, 18.0]))
add(dict(id="obj-on", maxclass="message", text="wakenow", numinlets=2, numoutlets=1, outlettype=[""], patching_rect=[710.0, 200.0, 55.0, 20.0], presentation=1, presentation_rect=[70.0, 143.0, 56.0, 18.0]))
line("obj-off", 0, "obj-js", 0); line("obj-on", 0, "obj-js", 0)
# the CPU readout after each wake, beside the buttons (autosleep.js, cpuWatch)
add(dict(id="obj-cpupre", maxclass="newobj", text="prepend set", numinlets=2, numoutlets=1, outlettype=[""], patching_rect=[480.0, 230.0, 70.0, 20.0], **F))
add(dict(id="obj-cpu", maxclass="message", text="", numinlets=2, numoutlets=1, outlettype=[""], patching_rect=[480.0, 260.0, 150.0, 20.0], presentation=1, presentation_rect=[132.0, 143.0, 330.0, 18.0]))

params = [
  ("toggle", "Enabled", "On", "Enable", "enabled", dict(parameter_type=2, parameter_initial=[1], parameter_enum=["off","on"], parameter_mmax=1)),
  ("toggle", "Keep Awake", "Awake", "Keep awake", "keepawake", dict(parameter_type=2, parameter_initial=[0], parameter_enum=["off","on"], parameter_mmax=1)),
  ("numbox", "Hold (s)", "Hold", "Hold Secs", "hold", dict(parameter_type=0, parameter_initial=[4.0], parameter_mmin=0.5, parameter_mmax=60.0, parameter_unitstyle=1)),
  ("numbox", "Threshold", "Thr", "Silence Thresh", "thresh", dict(parameter_type=0, parameter_initial=[0.01], parameter_mmin=0.0, parameter_mmax=1.0, parameter_unitstyle=1)),
  # the second column: a wake switches devices on this many ms apart (autosleep.js, setAll)
  ("numbox", "Stagger (ms)", "Stagger", "Stagger ms", "stagger", dict(parameter_type=0, parameter_initial=[20.0], parameter_mmin=0.0, parameter_mmax=500.0, parameter_unitstyle=2)),
  # ...and the track's volume held at -inf until this long after the last device is on (autosleep.js, quietBegin)
  ("numbox", "Quiet (ms)", "Quiet", "Quiet ms", "quiet", dict(parameter_type=0, parameter_initial=[100.0], parameter_mmin=0.0, parameter_mmax=2000.0, parameter_unitstyle=2)),
  # ...and the wait between deciding to wake and the first device going on (autosleep.js, setAll)
  ("numbox", "Pre-delay (ms)", "PreDly", "Pre-delay ms", "predelay", dict(parameter_type=0, parameter_initial=[250.0], parameter_mmin=0.0, parameter_mmax=2000.0, parameter_unitstyle=2)),
]
COLUMN2 = {4: (170.0, 8.0), 5: (170.0, 35.0), 6: (170.0, 62.0)}     # parameter index -> presentation x, y of its label
for i, (kind, longname, short, label, msg, attrs) in enumerate(params):
    lx, y = COLUMN2.get(i, (8.0, 8.0 + 27.0 * i))
    va = dict(parameter_longname=longname, parameter_shortname=short, parameter_initial_enable=1, parameter_modmode=0, **attrs)
    common = dict(id=f"obj-p{i}", parameter_enable=1, patching_rect=[20.0, 200.0 + 46*i, 50.0, 20.0], presentation=1,
                  saved_attribute_attributes={"valueof": va}, varname=longname, numinlets=1)
    if kind == "toggle":
        add(dict(maxclass="live.toggle", numoutlets=1, outlettype=[""], presentation_rect=[lx + 102.0, y, 18.0, 18.0], **common))
    else:
        add(dict(maxclass="live.numbox", numoutlets=2, outlettype=["", "float"], presentation_rect=[lx + 102.0, y, 50.0, 18.0], **common))
    add(dict(id=f"obj-pc{i}", maxclass="live.comment", numinlets=1, numoutlets=0, text=label, patching_rect=[120.0, 200.0 + 46*i, 80.0, 18.0], presentation=1, presentation_rect=[lx, y, 98.0, 18.0]))
    add(dict(id=f"obj-pp{i}", maxclass="newobj", text=f"prepend {msg}", numinlets=2, numoutlets=1, outlettype=[""], patching_rect=[20.0, 222.0 + 46*i, 100.0, 20.0], **F))
    line(f"obj-p{i}", 0, f"obj-pp{i}", 0); line(f"obj-pp{i}", 0, "obj-js", 0); line("obj-msg", 0, f"obj-p{i}", 0)

# MIDI passes straight through; the template's midiin -> midiout line stays
if not any(l['patchline']['source'][0] == midiin and l['patchline']['destination'][0] == midiout for l in lines):
    line(midiin, 0, midiout, 0)
line("obj-thd", 0, "obj-tbb", 0)
line("obj-tbb", 1, "obj-msg", 0)      # parameters first...
line("obj-tbb", 0, "obj-js", 0)       # ...then the js starts
line("obj-rx", 0, "obj-js", 0)
line("obj-js", 0, "obj-pre", 0); line("obj-pre", 0, "obj-status", 0)
line("obj-js", 1, "obj-cpupre", 0); line("obj-cpupre", 0, "obj-cpu", 0)

pt['title'] = 'AutoSleep'
body = json.dumps(p, indent=1).encode() + b'\0'
out = d[:28] + struct.pack('<I', len(body)) + body
open(OUT, 'wb').write(out)
print(len(out), [b['box'].get('text') for b in boxes if b['box'].get('maxclass') == 'newobj'])
print([ (l['patchline']['source'], l['patchline']['destination']) for l in lines if midiin in l['patchline']['source'] ])
