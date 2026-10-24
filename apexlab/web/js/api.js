/* HTTP client with a tiny in-memory cache for lap packs. */

async function request(path, { method = "GET", body } = {}) {
  const options = { method, cache: "no-store" };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    throw new Error("Сервер не отвечает. Запусти run.bat заново.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-json error body */
  }
  if (!res.ok) throw new Error(data?.error || `Ошибка ${res.status}`);
  return data;
}

const metaCache = new Map();
const packCache = new Map();
const MAX_PACKS = 28;

function remember(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  if (limit && map.size > limit) map.delete(map.keys().next().value);
}

export const api = {
  state: () => request("/api/state"),
  settings: () => request("/api/settings"),
  saveSettings: (patch) => request("/api/settings", { method: "PATCH", body: patch }),

  async session(sid) {
    if (metaCache.has(sid)) return metaCache.get(sid);
    const promise = request(`/api/session/${encodeURIComponent(sid)}`).catch((err) => {
      metaCache.delete(sid);
      throw err;
    });
    remember(metaCache, sid, promise);
    return promise;
  },

  lap(sid, index) {
    const key = `${sid}:${index}`;
    if (packCache.has(key)) {
      const cached = packCache.get(key);
      remember(packCache, key, cached, MAX_PACKS);
      return cached;
    }
    const promise = request(`/api/session/${encodeURIComponent(sid)}/lap/${index}`).catch((err) => {
      packCache.delete(key);
      throw err;
    });
    remember(packCache, key, promise, MAX_PACKS);
    return promise;
  },

  updateSession: (sid, patch) =>
    request(`/api/session/${encodeURIComponent(sid)}`, { method: "PATCH", body: patch }).then((data) => {
      metaCache.delete(sid);
      return data;
    }),

  deleteSession: (sid) =>
    request(`/api/session/${encodeURIComponent(sid)}`, { method: "DELETE" }).then((data) => {
      metaCache.delete(sid);
      for (const key of [...packCache.keys()]) {
        if (key.startsWith(`${sid}:`)) packCache.delete(key);
      }
      return data;
    }),

  scan: (folder) => request(`/api/scan?path=${encodeURIComponent(folder || "")}`),
  importFiles: (paths, driver, reference = false) =>
    request("/api/import", { method: "POST", body: { paths, driver, reference } }),

  coach: (session, ref) =>
    request(`/api/coach?session=${encodeURIComponent(session)}&ref=${encodeURIComponent(ref || "")}`),
  series: (session) =>
    request(`/api/series?session=${encodeURIComponent(session)}`),
  learning: () => request("/api/learning"),
  rebuildLearning: () => request("/api/learning", { method: "POST" }),

  markReference: (sid, reference) =>
    request(`/api/session/${encodeURIComponent(sid)}`, { method: "PATCH", body: { reference } })
      .then((data) => {
        metaCache.delete(sid);
        return data;
      }),

  setups: (car, track) =>
    request(`/api/setups?car=${encodeURIComponent(car || "")}&track=${encodeURIComponent(track || "")}`),
  importSetup: (session, filename, content) =>
    request("/api/setups/import", { method: "POST", body: { session, filename, content } }),
  setup: (path) => request(`/api/setup?path=${encodeURIComponent(path || "")}`),
  recommend: (session, setup) =>
    request("/api/recommend", { method: "POST", body: { session, setup: setup || "" } }),
  trajectory: (session, lap, ref) =>
    request(`/api/trajectory?session=${encodeURIComponent(session)}&lap=${encodeURIComponent(lap)}&ref=${encodeURIComponent(ref || "")}`),

  renameDriver: (from, to) =>
    request("/api/driver", { method: "POST", body: { from, to } }),

  reveal: (path) => request("/api/reveal", { method: "POST", body: { path } }),
};

export function clearSessionCache(sid) {
  metaCache.delete(sid);
}
