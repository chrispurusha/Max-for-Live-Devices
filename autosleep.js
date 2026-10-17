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
// first note. A device whose name starts with "!" is left alone.
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
// Buttons:  sleepnow (switch off and stay off, ignoring clips), wakenow (on, back to automatic).
// Messages (from the Max editor, for troubleshooting): show (list controlled devices in the
//           Max Window), debug <0|1> (print the meter, slot state and busy reasons).
// ---------------------------------------------------------------------------

autowatch = 1;
inlets  = 1;
outlets = 1;

var g = {
    enabled:   1,
    keepAwake: 0,
    holdMs:    4000,
    threshold: 0.01
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
    if (g.enabled) { rebuild(); }
    wake("load");
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
    else if (args[0] == "devices")            { if (g.enabled) { later(rebuild); } return; }
    else { return; }
    if (debugOn) { post("autosleep: " + args[0] + " " + args[1] + "\n"); }
    if (clipActive() && !awake && !manualOff) { later(function () { wake("clip"); }); }
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
    if (!track || !g.enabled || manualOff) { return; }
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
function setAll(v) {
    var api = null;
    for (var i = 0; i < remotes.length; i++) {
        if (remotes[i].direct) {
            if (!api) { api = new LiveAPI("this_device"); }
            api.id = remotes[i].paramId;
            api.set("value", v);
        } else {
            messnamed(remotes[i].valueRx, v);
        }
    }
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

function rebuild() {
    if (!track) { return; }
    releaseAll(false);
    var dev = new LiveAPI("this_device");
    var deviceIds = ids(track.get("devices"));
    for (var i = 0; i < deviceIds.length; i++) {
        if (deviceIds[i] == thisId) { continue; }
        dev.id = deviceIds[i];
        if (parseInt(dev.id) != deviceIds[i]) { post("autosleep: could not reach device " + deviceIds[i] + "\n"); continue; }
        var name = String(dev.get("name"));
        if (name.charAt(0) == "!") { continue; }
        var params = ids(dev.get("parameters"));
        if (params.length) { addRemote(params[0], name); }          // parameter 0 is Device On
    }
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
    var state = !g.enabled ? "off" : (manualOff ? "held off" : (g.keepAwake ? "held on" : (awake ? "awake" : "asleep")));
    outlet(0, remotes.length == 1 ? [state, "-", remotes[0].name] : [state, "-", remotes.length, "devices"]);
}

// ---------------------------------------------------------------------------
// parameter setters (from live.* -> [prepend <name>] -> js) and messages
// ---------------------------------------------------------------------------
function enabled(v) {
    g.enabled = (v ? 1 : 0);
    if (!track) { return; }
    if (g.enabled) { rebuild(); wake("enabled"); }
    else           { releaseAll(false); awake = true; manualOff = false; status(); }
}

function keepawake(v) { g.keepAwake = (v ? 1 : 0); if (g.keepAwake) { manualOff = false; } if (g.keepAwake && track && g.enabled) { wake("held"); } else { status(); } }
function hold(v)      { g.holdMs = Math.max(0.5, v) * 1000; }
function thresh(v)    { g.threshold = Math.max(0, v); }
function allon()      { keepawake(1); }
function auto()       { keepawake(0); }
function debug(v)     { debugOn = (v != 0); }

function sleepnow() {
    if (!track || !g.enabled) { post("autosleep: sleep needs Enable on\n"); return; }
    manualOff = true;
    sleep();
}
function wakenow() {
    manualOff = false;
    if (track && g.enabled) { wake("manual"); }
}

function show() {
    for (var i = 0; i < remotes.length; i++) { post("autosleep: controls " + remotes[i].name + "\n"); }
}

function notifydeleted() {
    if (poll) { poll.cancel(); }
    releaseAll(true);   // the patcher is being freed: switch everything on, leave the objects
}
