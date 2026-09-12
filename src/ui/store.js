/**
 * Everything the visitor contributes lives in this browser and nowhere else:
 * needs they post and needs they offer to pick up. There is no server.
 */
const KEY = "terra.v1";

const EMPTY = { posted: [], interests: {}, theme: null, seen: false };

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

  toggleInterest(id, note = "") {
    if (this.state.interests[id]) delete this.state.interests[id];
    else this.state.interests[id] = { at: new Date().toISOString(), note };
    this.save();
    return this.interestIn(id);
  },

  get interestCount() {
    return Object.keys(this.state.interests).length;
  },

  get theme() {
    return this.state.theme;
  },

  setTheme(name) {
    this.state.theme = name;
    this.save();
  },

  get seen() {
    return this.state.seen;
  },

  markSeen() {
    this.state.seen = true;
    this.save();
  },
};
