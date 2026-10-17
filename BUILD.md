# Building the devices

How the `.amxd` files in this repository are made. To **use** the devices, see
[INSTRUCTIONS.md](INSTRUCTIONS.md).

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
