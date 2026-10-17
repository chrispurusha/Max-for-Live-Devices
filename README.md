# Max-for-Live-Devices

Various tools for Max for Live.

## Devices

- **MIDI CC Debouncer** (`MidiCCDebouncer.amxd` + `debouncer.js`) — cleans a noisy
  CC (e.g. a chattery footswitch); MIDI in → clean MIDI out. Modes: Settle,
  Lockout, Trigger.
- **Scene Mover** (`SceneMover.amxd` + `scenemover.js`) — a footswitch, debounced,
  advances and fires the next Session scene via the Live API.
- **AutoSleep** (`AutoSleep.amxd` + `autosleep.js`) — switches a track's plug-ins and
  devices off while it is idle, and back on as soon as one of its clips is launched,
  to save CPU in large sets.

Each `.amxd` loads its `.js` by name, so keep each device's two files together.
See [BUILD.md](BUILD.md) for full parameter details and setup notes.

## Support

Since I'm now incurring costs (I recently started using LLMs) which would be good to
at least cover, I now have a Buy Me a Coffee page:

https://buymeacoffee.com/chrispurusha

Thanks for any donations!

## License

Copyright (C) 2026 Chris Turner <chris_purusha@icloud.com>

This project is free software, licensed under the **GNU General Public License
v3.0 or later**. See [LICENSE](LICENSE) for the full text. Each source file carries
the standard GPLv3 header.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE.
