# Max-for-Live-Devices

Various tools for Max for Live.

## Devices

- **MIDI CC Debouncer** (`MidiCCDebouncer.amxd` + `debouncer.js`) — cleans a noisy
  CC (e.g. a chattery footswitch); MIDI in → clean MIDI out. Modes: Settle,
  Lockout, Trigger.
- **Scene Mover** (`SceneMover.amxd` + `scenemover.js`) — a footswitch, debounced,
  advances and fires the next Session scene via the Live API.

Each `.amxd` loads its `.js` by name, so keep each device's two files together.
See [BUILD.md](BUILD.md) for full parameter details and setup notes.

## License

Copyright (C) 2026 Chris Purusha

This project is free software, licensed under the **GNU General Public License
v3.0 or later**. See [LICENSE](LICENSE) for the full text. Each source file carries
the standard GPLv3 header.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE.
