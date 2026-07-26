// scenemover.js — footswitch -> debounced -> advance & fire Session scene (M4L)
//
// Copyright (C) 2026 Chris Purusha
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
// A purpose-built companion to debouncer.js. Takes a (possibly chattery) foot-
// switch, recognises ONE press per physical action (leading edge + lockout), and
// on each recognised press advances the Session selection to the next scene and
// fires it — via the Live API, no IAC/loopback. Non-footswitch MIDI passes through
// untouched; the footswitch CC itself is consumed (it drives scenes, not MIDI).
//
// Two input paths (use either):
//   [midiin] -> [js] -> [midiout]   filtered by cc/channel
//   "Footswitch In" param           MIDI-map the footswitch to it (bypasses a
//                                   control surface that would eat the CC)
//
// Parameters (from live.* UI -> prepend <name> -> js):
//     cc <0-127>          target CC number (midiin path)
//     channel <0-16>      0 = Any, else 1..16
//     time <1-5000>       lockout / debounce window in ms
//     threshold <1-127>   value >= threshold counts as a "press"
//     polarity <0|1>      1 = invert incoming value (0 <-> 127); picks press vs release
//     wrap <0|1>          1 = wrap to the first scene after the last (else stay)
//     enabled <0|1>       0 = ignore the footswitch (pass everything through)
//     remotein <0-127>    value from the MIDI-mapped "Footswitch In" param
// ---------------------------------------------------------------------------

autowatch = 1;
inlets  = 1;
outlets = 1;

// ---- parameters (defaults; overwritten by the live.* objects on load) -------
var g = {
    enabled:   1,
    ccNum:     64,
    channel:   0,   // 0 = Any, else 1..16
    timeMs:    500,
    threshold: 64,  // value >= threshold => "press"
    polarity:  0,   // 1 = invert incoming switch value (0 <-> 127) on entry
    wrap:      0    // 1 = wrap to first scene after the last
};

// ---- raw-MIDI parser state --------------------------------------------------
var runStatus  = 0;      // current running status byte (channel-voice), 0 = none
var dataNeeded = 0;
var dataGot    = 0;
var d0 = 0, d1 = 0;
var inSysex    = false;

// ---- lockout state ----------------------------------------------------------
var locked   = false;
var lockTask = null;

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

// ---------------------------------------------------------------------------
// MIDI input — raw bytes as ints. Everything except the target footswitch CC is
// passed through byte-exact; realtime and SysEx are never disturbed.
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
        dataGot = 0;
    }
}

function handleMessage(st, b0, b1, n) {
    var hi = st & 0xF0;
    var ch = (st & 0x0F) + 1;                            // 1..16

    var isTargetCC = (hi === 0xB0) && (b0 === g.ccNum) &&
                     (g.channel === 0 || g.channel === ch);

    if (isTargetCC && g.enabled) {
        processFootswitch(b1);                           // consume it (drives scenes)
    } else {
        forward(st, n, b0, b1);                          // everything else passes through
    }
}

// Alternative input: the MIDI-mapped "Footswitch In" parameter (see header).
function remotein(v) {
    if (!g.enabled) { return; }
    processFootswitch(v & 0x7F);
}

// ---------------------------------------------------------------------------
// leading-edge press recognition + lockout
// ---------------------------------------------------------------------------
function processFootswitch(value) {
    if (g.polarity) { value = 127 - value; }             // reverse switch sense on entry
    if (value !== 0 && value !== 127) { return; }        // binary switch: ignore noise

    var down = (value >= g.threshold);
    if (down && !locked) {                               // one press per physical action
        advanceAndFire();
        locked = true;
        if (lockTask) { lockTask.cancel(); }
        lockTask = new Task(function () { locked = false; }, this);
        lockTask.schedule(g.timeMs);
    }                                                    // release, or locked = ignore
}

// ---------------------------------------------------------------------------
// Advance the Session selection to the next scene, then fire it (Live API).
// LiveAPI fire() doesn't honour "Select Next Scene on Launch", so we move the
// selection ourselves; advancing before firing means the new scene is the one
// that plays. `wrap` controls end-of-list behaviour.
// ---------------------------------------------------------------------------
function advanceAndFire() {
    try {
        var view = new LiveAPI("live_set view");
        var sel  = new LiveAPI("live_set view selected_scene");
        if (sel.id == 0) { return; }

        var count = parseInt(new LiveAPI("live_set").getcount("scenes"));
        var curId = sel.id, idx = -1;
        for (var i = 0; i < count; i++) {
            if (new LiveAPI("live_set scenes " + i).id == curId) { idx = i; break; }
        }
        if (idx < 0) { return; }

        var target;
        if (idx + 1 < count) { target = idx + 1; }
        else                 { target = g.wrap ? 0 : idx; }   // wrap or stay at last

        var tgt = new LiveAPI("live_set scenes " + target);
        view.set("selected_scene", "id " + tgt.id);
        tgt.call("fire");
    } catch (e) {}
}

// ---------------------------------------------------------------------------
// parameter setters (from live.* -> [prepend <name>] -> js)
// ---------------------------------------------------------------------------
function cc(v)        { g.ccNum     = clamp(v, 0, 127); }
function channel(v)   { g.channel   = clamp(v, 0, 16); }     // 0 = Any
function time(v)      { g.timeMs    = clamp(v, 1, 5000); }
function threshold(v) { g.threshold = clamp(v, 1, 127); resetLockout(); }
function polarity(v)  { g.polarity  = (v ? 1 : 0);   resetLockout(); }
function wrap(v)      { g.wrap      = (v ? 1 : 0); }
function enabled(v)   { g.enabled   = (v ? 1 : 0); if (!g.enabled) { flush(); } }

function resetLockout() {
    if (lockTask) { lockTask.cancel(); }
    locked = false;
}

function flush() {
    resetLockout();
    runStatus = 0;
    dataGot   = 0;
    inSysex   = false;
}

function notifydeleted() { flush(); }
