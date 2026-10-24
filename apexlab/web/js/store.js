import { api } from "./api.js";
import { dateValue } from "./util.js";

function sessionDate(s) {
  const d = dateValue(s?.date);
  const t = String(s?.time || "").match(/(\d{1,2}):(\d{2})/);
  return d * 10000 + (t ? +t[1] * 100 + +t[2] : 0);
}

export const store = {
  sessions: [],
  references: [],
  series: [],
  drivers: [],
  settings: {},
  stats: {},
  folders: [],
  version: 3,
  appVersion: "2.0.0",
  channel: "release",
  loaded: false,

  async load(force = false) {
    if (this.loaded && !force) return this;
    const data = await api.state();
    this.sessions = data.sessions || [];
    this.references = data.references || [];
    this.series = data.series || [];
    this.drivers = data.drivers || [];
    this.settings = data.settings || {};
    this.stats = data.stats || {};
    this.folders = data.folders || [];
    this.version = data.version || 3;
    this.appVersion = data.app_version || "2.0.0";
    this.channel = data.channel || "release";
    this.loaded = true;
    return this;
  },

  invalidate() {
    this.loaded = false;
  },

  session(id) {
    return this.sessions.find((s) => s.id === id)
      || this.references.find((s) => s.id === id);
  },

  allSessions() {
    return [...this.sessions, ...this.references];
  },

  seriesFor(id) {
    return this.series.find((g) => (g.sessions || []).includes(id)) || null;
  },

  sorted() {
    return [...this.sessions].sort((a, b) => sessionDate(b) - sessionDate(a) || b.built - a.built);
  },

  tracks() {
    const map = new Map();
    for (const s of this.sessions) {
      const key = s.track_id || s.track;
      const t = map.get(key) || {
        key, name: s.track, count: 0, laps: 0, clean: 0, best: null, cars: new Set(),
      };
      t.count += 1;
      t.laps += (s.laps || []).length;
      t.clean += Number(s.clean_laps || 0);
      t.cars.add(s.car);
      if (s.report?.clean && s.best_time) {
        t.best = t.best == null ? s.best_time : Math.min(t.best, s.best_time);
      }
      map.set(key, t);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  },

  cars() {
    return [...new Set(this.sessions.map((s) => s.car))].sort((a, b) => a.localeCompare(b, "ru"));
  },

  lapsForTrack(trackKey) {
    const rows = [];
    for (const s of this.sessions) {
      if (trackKey && (s.track_id || s.track) !== trackKey) continue;
      for (const lap of s.laps || []) {
        rows.push({
          sid: s.id,
          driver: s.driver,
          track: s.track,
          car: s.car,
          date: s.date,
          index: lap.index,
          time: lap.time,
          distance: lap.distance,
          valid: lap.valid,
          tags: lap.tags || [],
          best: lap.index === s.best_index,
        });
      }
    }
    return rows.sort((a, b) => (b.valid - a.valid) || a.time - b.time);
  },

  latestSession() {
    return this.sorted()[0] || null;
  },

  sessionsOf(driverName) {
    return this.sorted().filter((s) => (s.driver || "Пилот") === driverName);
  },
};
