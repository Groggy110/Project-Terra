/**
 * Everything the visitor contributes lives in this browser and nowhere else:
 * needs they post and needs they offer to pick up. There is no server.
 */
const KEY = "terra.v1";

const EMPTY = { posted: [], interests: {}, seen: false, tips: {} };

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    return { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    // Private windows and blocked site data both land here; the app is fully
    // usable without persistence, so this is not worth surfacing.
    return { ...EMPTY };
  }
}

function write(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* nothing to do */
  }
}

export const store = {
  state: read(),

  save() {
    write(this.state);
  },

  get posted() {
    return this.state.posted;
  },

  addPosted(need) {
    this.state.posted.unshift(need);
    this.save();
  },

  removePosted(id) {
    this.state.posted = this.state.posted.filter((n) => n.id !== id);
    this.save();
  },

  interestIn(id) {
    return !!this.state.interests[id];
  },

  /** `application` is the answers only — file names, never the files. */
  toggleInterest(id, application = {}) {
    if (this.state.interests[id]) delete this.state.interests[id];
    else this.state.interests[id] = { at: new Date().toISOString(), ...application };
    this.save();
    return this.interestIn(id);
  },

  get interestCount() {
    return Object.keys(this.state.interests).length;
  },

  get seen() {
    return this.state.seen;
  },

  markSeen() {
    this.state.seen = true;
    this.save();
  },

  /** A tip the visitor has closed, or has shown they no longer need. */
  tipDone(id) {
    return !!this.state.tips?.[id];
  },

  retireTip(id) {
    this.state.tips = { ...(this.state.tips ?? {}), [id]: true };
    this.save();
  },
};
