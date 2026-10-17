# Max for Live devices

Max MIDI Effect devices, built from Live's stock template:

| Device | File(s) | Purpose |
|---|---|---|
| **MIDI CC Debouncer** | `MidiCCDebouncer.amxd` + `debouncer.js` | Settle a noisy CC to its final value; MIDI in → clean MIDI out |
| **Scene Mover** | `SceneMover.amxd` + `scenemover.js` | Footswitch → debounced → advance & fire the next Session scene |
| **AutoSleep** | `AutoSleep.amxd` + `autosleep.js` | Switch a track's devices off while idle, on again at clip launch |

Each `.amxd` loads its `.js` **by name**, so keep each device's two files together
(or put the `.js` on Max's search path). To make a device fully self-contained,
open it (**Edit**), click the **Freeze** snowflake, then **Save**.

---

## MIDI CC Debouncer

Drag `MidiCCDebouncer.amxd` onto a MIDI track. Cleans one CC and passes everything
else through untouched. Input is normal channel MIDI (`[midiin]`).

| Control | Meaning | Range | Default |
|---|---|---|---|
| Enable  | Off = pass the target CC through untouched | 0/1 | On |
| CC #    | Which CC to debounce | 0–127 | 64 |
| Channel | 0 = Any, else 1–16 | 0–16 | 0 (Any) |
| Time ms | Settle window — quiet time before the value is sent | 1–5000 | 500 |

**Behaviour (Settle):** every matching CC restarts the timer; once the input is
quiet for `Time` ms, the last value is emitted. This collapses a jittery burst to
its final settled value. (500 ms is a footswitch-oriented default — lower it, e.g.
30–100 ms, for a knob/expression control where you want less latency.)

---

## Scene Mover

Drag `SceneMover.amxd` onto a MIDI track. Each footswitch press advances the Session
selection to the next scene and fires it (via the Live API — no IAC/loopback). It
recognises one press per physical action (leading edge + lockout debounce). Non-
footswitch MIDI passes through; the footswitch CC itself is consumed.

| Control | Meaning | Range | Default |
|---|---|---|---|
| Enable    | Off = ignore the footswitch (pass everything through) | 0/1 | On |
| Polarity  | Inverted flips the value; picks press vs release as the trigger | Normal/Inverted | Normal |
| CC #      | Footswitch CC (midiin path) | 0–127 | 64 |
| Channel   | 0 = Any, else 1–16 | 0–16 | 0 (Any) |
| Time ms   | Lockout / debounce window | 1–5000 | 500 |
| Threshold | value ≥ this counts as a press | 1–127 | 64 |
| Wrap      | On = wrap to the first scene after the last (else stay) | 0/1 | Off |
| Fsw In    | Alternative input — MIDI-map the footswitch to it (see below) | 0–127 | — |

Advance-then-fire, so the newly selected scene is the one that plays. This moves
Live's selection; the APC40's hardware ring does **not** follow (its control-surface
script doesn't expose ring control via the API — ClyphX Pro is the route for that).

---

## AutoSleep

Saves CPU in a large Session View set. Synths on tracks that are not playing keep
using CPU in Live — even with the track switched off, which only mutes it. AutoSleep
switches a track's devices off while the track is idle, and back on as soon as one
of its clips is launched.

### Setting up

1. Drag `AutoSleep.amxd` into the **first** slot of each track whose synth you want
   to sleep (keep `autosleep.js` beside it, as with the other devices).
2. The status line shows what it is doing and what it controls: `awake - <device>`
   or `asleep - <device>` (or a count, when there is more than one).
3. Use launch quantization (the global setting, e.g. 1 Bar). The devices come back
   on when a clip is **fired**, during the quantization wait, so they are running
   before its first note. With quantization at None there is no warning.

Every other device on the track — plug-ins, Live's devices, Racks — is controlled.
To leave one alone, rename it so it starts with `!` (right-click > Rename). Do that
for anything that has to run with no notes, such as an LFO modulating another track.

### When it sleeps and wakes

A track is busy while any of these hold:

- a clip on it is fired or playing,
- it is taking live input — armed with monitoring on Auto, or monitoring set to In,
- its output meter is above `Silence`.

It sleeps once it has been idle for `Hold` seconds, so release and reverb tails ring
out first; any sound restarts the count. It never sleeps within 2 s of waking. It
wakes the moment a clip is fired, or the track is armed.

While asleep, the controlled devices' on/off buttons are greyed: AutoSleep holds
them. Switching never adds to Live's undo history. Turning `Enable` off, or deleting
the device, switches everything back on and hands the buttons back.

| Control | Meaning | Range | Default |
|---|---|---|---|
| Enable     | Off = every device switched on and released | 0/1 | On |
| Keep awake | Hold everything on | 0/1 | Off |
| Hold s     | Idle time before sleeping | 0.5–60 | 4 |
| Silence    | Output meter level counted as silence | 0–1 | 0.01 |
| sleepnow   | Switch off now, and stay off (clips ignored) until wakenow | — | — |
| wakenow    | Switch on, and back to automatic | — | — |

`Keep awake` is an ordinary Live parameter, so one controller button can be MIDI-
mapped (⌘M) to every instance's `Keep awake` at once, as a panic button.

### Limits

- **Session View only.** A clip playing from the Arrangement is not seen, so the
  track would go to sleep under it.
- **If a tail is cut off**, lower `Silence` or raise `Hold`.
- Some plug-ins may click or take a moment when switched back on — try each of
  yours by launching a clip with the track asleep.

### Troubleshooting

Open the device (**Edit**) and the Max Console. AutoSleep logs each device it takes
control of, and every sleep and wake. Two messages can be sent to the `[js]` from a
message box in the editor: `show` lists the devices it controls, and `debug 1`
prints the meter, the clip state and why the track counts as busy.

---

## "Footswitch In" — the control-surface workaround (Scene Mover)

If the footswitch is plugged into a controller whose port is owned by a **control
surface** (e.g. APC40, where the footswitch CC drives record-arm), the script
consumes the CC before any track sees it. Scene Mover has a **Fsw In** control for
this; workaround:

1. Press **⌘M** (MIDI Map mode).
2. Click the device's **Fsw In** control, then press the footswitch so Live learns it.
3. Exit **⌘M**.

The Remote mapping claims the CC (disabling the record-arm) and feeds the value
straight into the device — no `[midiin]` routing, no IAC. The `Fsw In` box also
doubles as an activity monitor (flips 0/127 on each press).

For a control surface that does **not** eat the CC (e.g. the footswitch on a Kronos),
just use the normal `[midiin]` path: set the track's input to that port, monitor In,
and set CC #/Channel to match.

---

## Rebuilding the .amxd files
All three are generated programmatically from Live's stock **Max MIDI Effect** template
(`…/App-Resources/Misc/Max Devices/Max MIDI Effect.amxd`): parse the `ptch` chunk's
patcher JSON, splice in `[js <file>]` + `live.*` params (each via `[prepend <name>]`)
+ a `[live.thisdevice]→[outputvalue]` load-time push, then re-wrap as
`ampf | mmmm | meta(0) | ptch(len) | <json>`. See the session builder script.

Notes:
- Integer Live params cap at 256 steps regardless of max, so `Time` is a **float**
  param (the js rounds it) to reach 5000.
- AutoSleep's `[live.remote~]` objects are created by the js at load (one per
  controlled device) and are not in the saved patch. Point a LiveAPI at an object
  with `api.id = N`: a path of `"id N"` is not followed, and the object silently
  stays where it was.
- AutoSleep's `[live.thisdevice]` goes through `[t b b]`: the right outlet pushes
  the parameters (`outputvalue`), then the left bangs the js, which starts the Live API work.
- `live.thisdevice` must be a `newobj` with text `live.thisdevice` (not a maxclass).
- Load-time value push uses the **`outputvalue`** message, not `bang`: a bang to a
  `live.toggle` *flips* it (Enable would come up off, Wrap on). `outputvalue` sends
  the current value without changing it (toggle/menu/numbox alike).
