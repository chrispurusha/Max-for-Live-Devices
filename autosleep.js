// autosleep.js — switch a track's devices off while it is idle, on again at clip launch (M4L)
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
// Sits first on a track. Every other device on the track (plug-ins, Live's own
// devices, Racks) is switched off once the track is idle — no clip fired or
// playing, no live input, output below a threshold for Hold seconds — and back on
// the moment a clip is FIRED, i.e. during the launch-quantization wait, before its
// first note. A device whose name starts with "!" is left alone. If, when it starts,
// some of the devices are off and some on, it takes no control and says which is off:
// those were switched off by hand. All off is a set saved asleep, and is switched on.
//
// Each device's "Device On" is driven by its own [live.remote~], created here by
// scripting, so switching never lands in Live's undo history (and the activator
// is greyed while controlled). MIDI passes through untouched.
//
// Parameters (from live.* UI -> prepend <name> -> js):
//     enabled <0|1>       0 = release every device, switched on
//     keepawake <0|1>     1 = hold everything on (also "allon"/"auto" via [r autosleep_all])
//     hold <0.5-60>       seconds of idle before sleeping
//     thresh <0-1>        output_meter_level counted as silence
//     stagger <0-500>     ms between switching each device ON at a wake (0 = all at once); sleep is never staggered
//     quiet <0-2000>      ms the track's volume is held at -inf after the last device is on (0 = off)
//     predelay <0-2000>   ms between deciding to wake and switching the first device on (the volume drops at once)
// Buttons:  sleepnow (switch off and stay off, ignoring clips), wakenow (on, back to automatic).
// Messages (from the Max editor, for troubleshooting): show (list controlled devices in the
//           Max Window), debug <0|1> (print the meter, slot state and busy reasons).
// ---------------------------------------------------------------------------

autowatch = 1;
inlets  = 1;
outlets = 2;            // 0: the status line, 1: the CPU readout beside the buttons

var g = {
    enabled:   1,
    keepAwake: 0,
    holdMs:    4000,
    threshold: 0.01,
    staggerMs: 20,         // the default until the device's Stagger parameter is set
    quietMs:   100,        // likewise Quiet
    preMs:     250         // and Pre-delay
};

var MIN_ON_MS  = 2000;      // never sleep sooner than this after waking
var POLL_MS    = 250;
var TMP_PREFIX = "astmp_";  // varname prefix of every object this script creates

var base     = TMP_PREFIX + Math.floor(Math.random() * 1e9);
var remotes  = [];          // { name, idRx, valueRx, objs }
var track    = null;
var thisId   = 0;
var observers = [];
var poll     = null;
var deferred = [];
var pat      = this.patcher;

var awake      = true;
var debugOn    = false;
var manualOff  = false;
var blocked    = null;      // names of devices found switched off by hand at start
var firedIdx   = -1;
var playingIdx = -1;
var lastActive = 0;
var wokeAt     = 0;
var tickCount  = 0;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function now()    { return new Date().getTime(); }
function first(v) { return (v instanceof Array) ? v[0] : v; }

function ids(list) {
    var out = [];
    if (!list) { return out; }
    for (var i = 0; i < list.length - 1; i++) {
        if (list[i] == "id") { out.push(parseInt(list[i + 1])); }
    }
    return out;
}

// a LiveAPI pointed at an object id (set .id: a path of "id N" is not followed)
function byId(n) {
    var api = new LiveAPI("this_device");
    api.id = n;
    return api;
}

// Live API notifications may not change the set; run the reaction just after
function later(fn) {
    var t = new Task(function () { deferred.splice(deferred.indexOf(t), 1); fn(); }, this);
    deferred.push(t);
    t.schedule(0);
}

// ---------------------------------------------------------------------------
// start-up — [live.thisdevice] bangs once the Live API is usable
// ---------------------------------------------------------------------------
function bang() {
    sweepOrphans();
    thisId = parseInt(new LiveAPI("this_device").id);
    track  = new LiveAPI("this_device canonical_parent");
    observers = [observe("fired_slot_index"), observe("playing_slot_index"), observe("devices")];
    if (g.enabled) { start("load"); }
    if (poll) { poll.cancel(); }
    poll = new Task(tick, this);
    poll.interval = POLL_MS;
    poll.repeat();
}

function observe(prop) {
    var api = new LiveAPI(onChange, "this_device canonical_parent");
    api.property = prop;
    return api;
}

function onChange(args) {
    if (!args || args.length < 2) { return; }
    if (args[0] == "fired_slot_index")        { firedIdx = args[1]; }
    else if (args[0] == "playing_slot_index") { playingIdx = args[1]; }
    else if (args[0] == "devices")            { later(rebuildIfRunning); return; }
    else { return; }
    if (debugOn) { post("autosleep: " + args[0] + " " + args[1] + "\n"); }
    if (clipActive() && !awake && !manualOff && !blocked) { later(function () { wake("clip"); }); }
    // THE CONTROL MEASUREMENT: a clip fired on a track already awake gets the same CPU watch, so a launch from sleep
    // can be compared with the same launch awake
    else if (args[0] == "fired_slot_index" && args[1] >= 0 && awake) { later(function () { cpuWatch(true); }); }
}

// ---------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------
function clipActive() { return firedIdx >= 0 || playingIdx >= 0; }   // -2 = stop button fired

function inputLive() {
    if (!first(track.get("can_be_armed"))) { return false; }
    var monitoring = first(track.get("current_monitoring_state"));  // 0 In, 1 Auto, 2 Off
    return monitoring == 0 || (monitoring == 1 && first(track.get("arm")) == 1);
}

function level() { return Number(first(track.get("output_meter_level"))) || 0; }

function tick() {
    if (!track || !g.enabled) { return; }
    if (blocked) { start("device switched on", true); return; }     // starts once nothing is off by hand
    if (manualOff) { return; }
    var t    = now();
    var lev  = level();
    var busy = g.keepAwake || clipActive() || inputLive() || lev > g.threshold;
    if (busy) { lastActive = t; }
    if (debugOn && (tickCount++ % 4) == 0) {
        post("autosleep: level " + lev.toFixed(4) + " fired " + firedIdx + " playing " + playingIdx +
             (awake ? " awake" : " asleep") + " busy:" + (g.keepAwake ? " keepawake" : "") +
             (clipActive() ? " clip" : "") + (inputLive() ? " input" : "") + (lev > g.threshold ? " level" : "") +
             " idle " + ((t - lastActive) / 1000).toFixed(1) + "s\n");
    }
    if (awake) {
        if (!busy && t - lastActive > g.holdMs && t - wokeAt > MIN_ON_MS) { sleep(); }
    } else if (busy) {
        wake("activity");
    }
}

function wake(why) {
    var wasAwake = awake;
    awake  = true;
    wokeAt = lastActive = now();
    setAll(1);
    if (!wasAwake || why == "load") { post("autosleep: wake (" + why + ", " + remotes.length + " devices)\n"); }
    status();
}

function sleep() {
    awake = false;
    setAll(0);
    post("autosleep: sleep (" + remotes.length + " devices)\n");
    status();
}

// ---------------------------------------------------------------------------
// the live.remote~ per device
// ---------------------------------------------------------------------------
function setOne(i, v) {
    if (i >= remotes.length) { return; }
    if (remotes[i].direct) {
        var api = new LiveAPI("this_device");
        api.id = remotes[i].paramId;
        api.set("value", v);
    } else {
        messnamed(remotes[i].valueRx, v);
    }
}

// WAKING MANY DEVICES AT ONCE GLITCHES THE AUDIO (owner, 2026-10-17): every plug-in switched on in the same
// instant does its activation work in the same audio block. So a wake switches them on one at a time,
// g.staggerMs apart. A sleep switches everything off at once - the track is silent by then - and cancels any
// stagger still under way, so a late "on" cannot land after it.
// THE QUIET PERIOD (owner, 2026-10-17: staggering alone did not hide the glitches). A plug-in switched on can
// click or burst as it starts. So a wake holds the track's volume at -inf through a live.remote~ (no undo
// entries) until quietMs after the last device is on, then puts back the exact value and lets go of the fader.
var quietRx = null, quietTask = null, quietSaved = null, quietParam = 0;

function quietObjects() {
    if (quietRx) { return; }
    quietRx = { id: base + "_qid", value: base + "_qv", objs: [] };
    var idIn    = pat.newdefault(400, 480, "receive", quietRx.id);
    var valueIn = pat.newdefault(520, 480, "receive", quietRx.value);
    var remote  = pat.newdefault(460, 493, "live.remote~");
    idIn.varname    = base + "_qa";
    valueIn.varname = base + "_qb";
    remote.varname  = base + "_qc";
    pat.connect(valueIn, 0, remote, 0);
    pat.connect(idIn, 0, remote, 1);
    quietRx.objs = [idIn, valueIn, remote];
}

function quietBegin(totalMs) {
    if (!track || g.quietMs <= 0) { return; }
    quietObjects();
    if (quietSaved === null) {
        var mixer = new LiveAPI(track.unquotedpath + " mixer_device volume");
        var now   = Number(first(mixer.get("value")));
        // FAIL SAFE: without a readable volume to put back, do not touch the fader at all
        if (!mixer.id || mixer.id == 0 || isNaN(now)) {
            post("autosleep: quiet period skipped - could not read the track volume\n");
            return;
        }
        quietParam = mixer.id;
        quietSaved = now;
        messnamed(quietRx.id, "id", quietParam);
        messnamed(quietRx.value, 0);
    }
    if (quietTask) { quietTask.cancel(); }
    quietTask = new Task(quietEnd, this);
    quietTask.schedule(totalMs + g.quietMs);
}

function quietEnd() {
    if (quietTask) { quietTask.cancel(); quietTask = null; }
    if (quietRx && quietSaved !== null) {
        messnamed(quietRx.value, quietSaved);
        messnamed(quietRx.id, "id", 0);
        if (debugOn) { post("autosleep: quiet period over, volume back to " + quietSaved + "\n"); }
    }
    quietSaved = null;
}

var staggerTasks = [];
function switchOnLater(index, value) {
    return function () { setOne(index, value); };
}

function cancelStagger() {
    for (var i = 0; i < staggerTasks.length; i++) { staggerTasks[i].cancel(); }
    staggerTasks = [];
}

function setAll(v) {
    cancelStagger();
    if (v && remotes.length) {
        // the volume drops NOW; the devices follow after the pre-delay, staggered
        var pre = Math.max(0, g.preMs);
        quietBegin(pre + (remotes.length - 1) * Math.max(0, g.staggerMs));
        cpuWatch();
        if (pre > 0) {
            var preTask = new Task(function () { switchOnAll(v); }, this);
            preTask.schedule(pre);
            staggerTasks.push(preTask);
            return;
        }
        switchOnAll(v);
        return;
    }
    for (var j = 0; j < remotes.length; j++) { setOne(j, v); }
    if (remotes.length) { verify(v); }
}

// the staggered switch-on itself, starting now
function switchOnAll(v) {
    if (g.staggerMs > 0 && remotes.length > 1) {
        setOne(0, v);
        for (var i = 1; i < remotes.length; i++) {
            // A CLOSURE, not new Task(setOne, this, i, v): Task passes on its arguments as ONE array, so the
            // separate i and v arrived as nothing and every device after the first got no "on".
            var t = new Task(switchOnLater(i, v), this);
            t.schedule(i * g.staggerMs);
            staggerTasks.push(t);
        }
        var done = new Task(function () { verify(v); }, this);
        done.schedule(remotes.length * g.staggerMs);
        staggerTasks.push(done);
        return;
    }
    for (var j = 0; j < remotes.length; j++) { setOne(j, v); }
    if (remotes.length) { verify(v); }
}

// read each Device On back after a switch, to tell a remote that never took hold
var verifyTask = null;
function verify(v) {
    if (verifyTask) { verifyTask.cancel(); }
    verifyTask = new Task(function () {
        var api = new LiveAPI("this_device");
        for (var i = 0; i < remotes.length; i++) {
            api.id = remotes[i].paramId;
            var got = Number(first(api.get("value")));
            if (got != v || debugOn) {
                post("autosleep: " + remotes[i].name + " Device On wanted " + v + " is " + got +
                     (remotes[i].direct ? " (direct)" : " (live.remote~)") + "\n");
            }
            // live.remote~ did not take: release it and set the parameter directly from now on
            // (that path adds an undo step per switch)
            if (got != v && !remotes[i].direct) {
                post("autosleep: live.remote~ did not switch " + remotes[i].name + " - falling back to direct set\n");
                messnamed(remotes[i].idRx, "id", 0);
                remotes[i].direct = true;
                api.set("value", v);
            }
        }
    }, this);
    verifyTask.schedule(300);
}

// the devices to control: every one on the track but this, and any named "!..."
function candidates() {
    var list = [];
    var dev = new LiveAPI("this_device");
    var deviceIds = ids(track.get("devices"));
    for (var i = 0; i < deviceIds.length; i++) {
        if (deviceIds[i] == thisId) { continue; }
        dev.id = deviceIds[i];
        if (parseInt(dev.id) != deviceIds[i]) { post("autosleep: could not reach device " + deviceIds[i] + "\n"); continue; }
        var name = String(dev.get("name"));
        if (name.charAt(0) == "!") { continue; }
        var params = ids(dev.get("parameters"));
        if (params.length) { list.push({ name: name, paramId: params[0] }); }   // parameter 0 is Device On
    }
    return list;
}

// take control, unless some devices are off and some on: those were switched off by hand.
// All off at load is a set saved asleep; all off on a re-check is the user's doing.
function start(why, recheck) {
    var list = candidates();
    var off = [];
    for (var i = 0; i < list.length; i++) {
        if (Number(first(byId(list[i].paramId).get("value"))) == 0) { off.push(list[i].name); }
    }
    if (off.length && (off.length < list.length || recheck)) {
        var changed = !blocked || blocked.join("\n") != off.join("\n");
        releaseAll(false);
        blocked = off;
        if (changed) {
            post("autosleep: not started - switched off: " + off.join(", ") +
                 ". Switch it on, remove it, or start its name with !\n");
            status();
        }
        return;
    }
    blocked = null;
    rebuild(list);
    wake(why);
}

// a device list change, judged when it is handled: start() may have refused control since
function rebuildIfRunning() {
    if (!g.enabled) { return; }
    if (blocked) { start("devices changed", true); } else { rebuild(); }
}

function rebuild(list) {
    if (!track) { return; }
    releaseAll(false);
    if (!list) { list = candidates(); }
    for (var i = 0; i < list.length; i++) { addRemote(list[i].paramId, list[i].name); }
    setAll(awake ? 1 : 0);
    status();
}

function addRemote(paramId, name) {
    var k = remotes.length;
    var y = 520 + k * 26;
    var r = { name: name, paramId: paramId, idRx: base + "_id" + k, valueRx: base + "_v" + k, objs: [] };
    var idIn    = pat.newdefault(400, y, "receive", r.idRx);
    var valueIn = pat.newdefault(520, y, "receive", r.valueRx);
    var remote  = pat.newdefault(460, y + 13, "live.remote~");
    idIn.varname    = base + "_o" + k + "a";
    valueIn.varname = base + "_o" + k + "b";
    remote.varname  = base + "_o" + k + "c";
    pat.connect(valueIn, 0, remote, 0);
    pat.connect(idIn, 0, remote, 1);
    r.objs = [idIn, valueIn, remote];
    remotes.push(r);
    messnamed(r.idRx, "id", paramId);
    var p = byId(paramId);
    post("autosleep: controlling " + name + " via parameter " + paramId + " '" + String(p.get("name")) +
         "' value " + first(p.get("value")) + "\n");
}

// every device left switched on and unlocked
function releaseAll(keepObjects) {
    quietEnd();
    for (var i = 0; i < remotes.length; i++) {
        if (remotes[i].direct) { byId(remotes[i].paramId).set("value", 1); }
        messnamed(remotes[i].valueRx, 1);
        messnamed(remotes[i].idRx, "id", 0);
        if (!keepObjects) {
            for (var j = 0; j < remotes[i].objs.length; j++) { pat.remove(remotes[i].objs[j]); }
        }
    }
    remotes = [];
}

// objects left by an earlier copy of this script (autowatch reload, or saved into the device)
function sweepOrphans() {
    var stale = [];
    pat.apply(function (o) {
        if (o.varname && o.varname.indexOf(TMP_PREFIX) == 0) { stale.push(o); }
        return true;
    });
    for (var i = 0; i < stale.length; i++) { pat.remove(stale[i]); }
}

function status() {
    if (g.enabled && blocked) {
        outlet(0, ["not", "started", "-", blocked[0], "is", "off"].concat(blocked.length > 1 ? ["+" + (blocked.length - 1)] : []));
        return;
    }
    var state = !g.enabled ? "off" : (manualOff ? "held off" : (g.keepAwake ? "held on" : (awake ? "awake" : "asleep")));
    outlet(0, remotes.length == 1 ? [state, "-", remotes[0].name] : [state, "-", remotes.length, "devices"]);
}

// ---------------------------------------------------------------------------
// parameter setters (from live.* -> [prepend <name>] -> js) and messages
// ---------------------------------------------------------------------------
function enabled(v) {
    g.enabled = (v ? 1 : 0);
    if (!track) { return; }
    if (g.enabled) { start("enabled"); }
    else           { releaseAll(false); awake = true; manualOff = false; blocked = null; status(); }
}

function keepawake(v) { g.keepAwake = (v ? 1 : 0); if (g.keepAwake) { manualOff = false; } if (g.keepAwake && track && g.enabled && !blocked) { wake("held"); } else { status(); } }
function hold(v)      { g.holdMs = Math.max(0.5, v) * 1000; }
function thresh(v)    { g.threshold = Math.max(0, v); }
function stagger(v)   { g.staggerMs = Math.max(0, Math.min(500, Math.round(v))); }
function quiet(v)     { g.quietMs = Math.max(0, Math.min(2000, Math.round(v))); }
function predelay(v)  { g.preMs = Math.max(0, Math.min(2000, Math.round(v))); }

// Live's own CPU meter around every wake: the peak sampled every 50 ms for 2 s, the highest shown on the device
// (outlet 1) and, with debug on, every sample in the Max Console - to see whether a glitch lines up with a load
// spike and how long it lasts. Live's API is assumed to offer the application's peak_process_usage; if it does
// not, the device says so.
var cpuTask = null, cpuSamples = [], cpuApi = null;
function cpuWatch(awakeAlready) {
    if (cpuTask) { cpuTask.cancel(); }
    cpuSamples = [];
    try { cpuApi = new LiveAPI("live_app"); } catch (e) { cpuApi = null; }
    // the windows of this wake, in ms from now: pre-delay, devices switching on, quiet, and after
    var preEnd   = Math.max(0, g.preMs);
    var onEnd    = preEnd + Math.max(1, remotes.length - 1) * Math.max(0, g.staggerMs) + 20;
    var quietEnd = onEnd + Math.max(0, g.quietMs);
    var span     = quietEnd + 500;
    // READ ONCE AND THROW IT AWAY: the peak is held since the last read, which may be long before this wake
    try { cpuApi.get("peak_process_usage"); } catch (e) { }
    var started = now();
    cpuTask = new Task(function () {
        var v = NaN;
        try { v = Number(first(cpuApi.get("peak_process_usage"))); } catch (e) { v = NaN; }
        if (isNaN(v)) {
            outlet(1, ["CPU:", "not", "available"]);
            if (debugOn) { post("autosleep: Live's API gave no peak_process_usage - CPU watch unavailable\n"); }
            cpuTask.cancel();
            return;
        }
        var t = now() - started;
        if (v > 1.5) { v = v / 100; }   // a percentage rather than a fraction - either way it reads as %
        cpuSamples.push({ t: t, v: v });
        if (t >= span) {
            cpuTask.cancel();
            var peak = [0, 0, 0, 0];      // pre, on, quiet, after
            for (var i = 0; i < cpuSamples.length; i++) {
                var s = cpuSamples[i], w = (s.t <= preEnd) ? 0 : ((s.t <= onEnd) ? 1 : ((s.t <= quietEnd) ? 2 : 3));
                peak[w] = Math.max(peak[w], s.v);
            }
            // WHICH DEVICE: each one's window runs from its switch-on to the next one's (the last to the end), so with
            // a long Stagger a start-up spike is credited to the device that caused it
            var worst = { v: -1, name: "", at: 0 }, perDevice = [];
            for (var d = 0; d < remotes.length; d++) {
                var from = preEnd + d * Math.max(0, g.staggerMs);
                var to   = (d + 1 < remotes.length) ? (preEnd + (d + 1) * Math.max(0, g.staggerMs)) : span;
                var top  = 0, topAt = 0;
                for (var k = 0; k < cpuSamples.length; k++) {
                    if (cpuSamples[k].t > from && cpuSamples[k].t <= to && cpuSamples[k].v > top) { top = cpuSamples[k].v; topAt = cpuSamples[k].t - from; }
                }
                perDevice.push(remotes[d].name + " " + Math.round(top * 100) + "%");
                if (top > worst.v) { worst = { v: top, name: remotes[d].name, at: topAt }; }
            }
            if (awakeAlready) {
                var all2 = 0;
                for (var q = 0; q < cpuSamples.length; q++) { all2 = Math.max(all2, cpuSamples[q].v); }
                outlet(1, ["CPU", "(awake)", Math.round(all2 * 100) + "%", "-", "a", "launch", "with", "no", "wake"]);
                post("autosleep: CPU around a launch while awake: peak " + Math.round(all2 * 100) + "%\n");
                return;
            }
            outlet(1, ["CPU", Math.round(worst.v * 100) + "%", "after", worst.name, "(+" + worst.at + "ms)", "|",
                       "pre", Math.round(peak[0] * 100) + "%", "quiet", Math.round(peak[2] * 100) + "%"]);
            post("autosleep: CPU after each device switched on: " + perDevice.join(", ") + "\n");
            if (debugOn) {
                var all = [];
                for (var j = 0; j < cpuSamples.length; j++) { all.push(cpuSamples[j].t + "ms:" + Math.round(cpuSamples[j].v * 100) + "%"); }
                post("autosleep: CPU around the wake (pre to " + preEnd + ", on to " + onEnd + ", quiet to " + quietEnd + " ms): " + all.join(" ") + "\n");
            }
        }
    }, this);
    cpuTask.interval = 25;
    cpuTask.repeat(Math.ceil(span / 25) + 2);
}
function allon()      { keepawake(1); }
function auto()       { keepawake(0); }
function debug(v)     { debugOn = (v != 0); }

function sleepnow() {
    if (!track || !g.enabled || blocked) { post("autosleep: sleep needs Enable on, and the device started\n"); return; }
    manualOff = true;
    sleep();
}
function wakenow() {
    manualOff = false;
    if (track && g.enabled && !blocked) { wake("manual"); }
}

function show() {
    for (var i = 0; i < remotes.length; i++) { post("autosleep: controls " + remotes[i].name + "\n"); }
}

function notifydeleted() {
    if (poll) { poll.cancel(); }
    releaseAll(true);   // the patcher is being freed: switch everything on, leave the objects
}
