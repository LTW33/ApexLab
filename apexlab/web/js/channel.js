/* Release / beta channel.
   Release: only fixes and polish, experiments hidden.
   Beta: new ideas, opt-in per install via the settings switch or ?beta=1. */

const KEY = "apex.channel";

function query() {
  return new URLSearchParams(location.search).get("beta");
}

function read() {
  try {
    return localStorage.getItem(KEY);
  } catch (err) {
    return null;
  }
}

export const channel = {
  /** "beta" | "release" — as resolved right now. */
  current() {
    return document.documentElement.classList.contains("beta") ? "beta" : "release";
  },

  isBeta() {
    return this.current() === "beta";
  },

  /** Enable/disable experiments and remember the choice. */
  set(beta) {
    const value = beta ? "beta" : "release";
    try {
      localStorage.setItem(KEY, value);
    } catch (err) {
      /* storage may be unavailable, the flag still applies to this page */
    }
    document.documentElement.classList.toggle("beta", !!beta);
    window.dispatchEvent(new CustomEvent("apex:channel", { detail: { channel: value } }));
    return value;
  },

  /** Follow the build channel again (removes the local override). */
  reset() {
    try {
      localStorage.removeItem(KEY);
    } catch (err) {
      /* ignore */
    }
    return this.init(globalThis.APEX_BUILD_CHANNEL === "beta");
  },

  /** Resolve the effective channel: query > saved choice > build default. */
  init(buildBeta = false) {
    let beta;
    const forced = query();
    if (forced === "1" || forced === "true") beta = true;
    else if (forced === "0" || forced === "false") beta = false;
    else {
      const saved = read();
      beta = saved ? saved === "beta" : !!buildBeta;
    }
    if (forced !== null) this.set(beta);
    else document.documentElement.classList.toggle("beta", beta);
    return beta ? "beta" : "release";
  },
};
