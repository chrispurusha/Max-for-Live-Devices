// debouncer.js — MIDI CC debouncer for Max for Live
//
// Copyright (C) 2026 Chris Turner <chris_purusha@icloud.com>
//
// This program is free software: you can redistribute it and/or modify it under
// the terms of the GNU General Public License as published by the Free Software
// Foundation, either version 3 of the License, or (at your option) any later
// version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License along with
// this program. If not, see <https://www.gnu.org/licenses/>.
// ---------------------------------------------------------------------------
// Patch wiring:   [midiin]  ->  [js debouncer.js]  ->  [midiout]
//
// A plain MIDI-input debouncer: it collapses a burst of a chosen CC into a single
// settled value. Every matching CC restarts a timer; once the input goes quiet for
// `time` ms, the last value is emitted. All other MIDI passes through byte-exact.
//
// Parameters come in as messages from live.* UI objects (see the build recipe):
//     cc <0-127>          target CC number
//     channel <0-16>      0 = Any, else 1..16
//     time <1-5000>       settle window in ms (quiet time before the value is sent)
//     enabled <0|1>       0 = pass the target CC through untouched
//
// Timing uses Max's scheduler (Task) — no OS timers/threads.
// ---------------------------------------------------------------------------

autowatch = 1;
inlets  = 1;
outlets = 1;

// ---- parameters (defaults; overwritten by the live.* objects on load) -------
var g = {
    enabled: 1,
    ccNum:   64,
    channel: 0,     // 0 = Any, else 1..16
    timeMs:  500
};

// ---- raw-MIDI parser state --------------------------------------------------
var runStatus  = 0;      // current running status byte (channel-voice), 0 = none
var dataNeeded = 0;
var dataGot    = 0;
var d0 = 0, d1 = 0;
var inSysex    = false;

// ---- settle state -----------------------------------------------------------
var settleTask  = null;
var pendingStat = 0;     // full status byte (carries channel) of the held CC
var pendingVal  = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { v = Math.round(v); return v < lo ? lo : (v > hi ? hi : v); }

function emit1(a)       { outlet(0, a); }
function emit2(a, b)    { outlet(0, a); outlet(0, b); }
function emit3(a, b, c) { outlet(0, a); outlet(0, b); outlet(0, c); }

function dataBytesFor(st) {
    var hi = st & 0xF0;
    return (hi === 0xC0 || hi === 0xD0) ? 1 : 2; // ProgChange / ChanPressure = 1, else 2
}

function forward(st, n, b0, b1) { if (n === 1) emit2(st, b0); else emit3(st, b0, b1); }

// re-emit the target CC using the received status byte (preserves channel)
function sendCC(st, value) { emit3(st, g.ccNum, value); }

// ---------------------------------------------------------------------------
// MIDI input — [midiin] streams raw bytes as ints (list handler defends against
// grouped delivery). Everything except the selected CC is passed through byte-
// exact; realtime and SysEx are never disturbed.
// ---------------------------------------------------------------------------
function list() { for (var i = 0; i < arguments.length; i++) { msg_int(arguments[i]); } }

function msg_int(v) {
    v = v & 0xFF;

    if (v >= 0xF8) { emit1(v); return; }                 // system realtime
    if (inSysex) { emit1(v); if (v === 0xF7) { inSysex = false; } return; }
    if (v === 0xF0) { inSysex = true; emit1(v); runStatus = 0; dataGot = 0; return; }
    if (v >= 0xF1 && v <= 0xF7) { emit1(v); runStatus = 0; dataGot = 0; return; }

    if (v >= 0x80) {                                     // channel-voice status byte
        runStatus  = v;
        dataNeeded = dataBytesFor(v);
        dataGot    = 0;
        return;
    }

    if (runStatus === 0) { return; }                     // no status yet
    if (dataGot === 0)      { d0 = v; dataGot = 1; }
    else if (dataGot === 1) { d1 = v; dataGot = 2; }

    if (dataGot >= dataNeeded) {
        handleMessage(runStatus, d0, (dataNeeded === 2) ? d1 : 0, dataNeeded);
        dataGot = 0;                                     // keep runStatus for running-status streams
    }
}

function handleMessage(st, b0, b1, n) {
    var hi = st & 0xF0;
    var ch = (st & 0x0F) + 1;                            // 1..16

    var isTargetCC = (hi === 0xB0) && (b0 === g.ccNum) &&
                     (g.channel === 0 || g.channel === ch);

    if (isTargetCC && g.enabled) {
        // Settle: hold the latest value, (re)start the timer, emit once quiet.
        pendingStat = st;
        pendingVal  = b1;
        if (settleTask) { settleTask.cancel(); }
        settleTask = new Task(settleFire, this);
        settleTask.schedule(g.timeMs);
    } else {
        forward(st, n, b0, b1);
    }
}

function settleFire() { sendCC(pendingStat, pendingVal); }

// ---------------------------------------------------------------------------
// parameter setters (from live.* -> [prepend <name>] -> js)
// ---------------------------------------------------------------------------
function cc(v)      { g.ccNum   = clamp(v, 0, 127); }
function channel(v) { g.channel = clamp(v, 0, 16); }     // 0 = Any
function time(v)    { g.timeMs  = clamp(v, 1, 5000); }
function enabled(v) {
    g.enabled = (v ? 1 : 0);
    if (!g.enabled) { flush(); }                         // stop affecting the stream immediately
}

// clear any held value AND reset the MIDI parser (on disable, device unload)
function flush() {
    if (settleTask) { settleTask.cancel(); }
    runStatus = 0;
    dataGot   = 0;
    inSysex   = false;
}

function notifydeleted() { flush(); }
