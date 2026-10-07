/**
 * Saved conversations with Ask Terra, kept in this browser.
 *
 * Each chat is `{ id, title, preview, updated, turns }`, where the turns are
 * the conversation as data — questions, answers and the ids of the needs they
 * showed, ministries opened — not the DOM, so a chat reopened next week is
 * drawn from the network as it is then. Newest first, at most MAX of them.
 *
 * Browser storage can be missing or full (a private window, a quota); every
 * read and write survives that, and the conversation in hand never depends
 * on it.
 */
const KEY = "terra.chats.v1";
const MAX = 50;

function readAll() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((c) => c && typeof c.id === "string" && Array.isArray(c.turns)) : [];
  } catch {
    return [];
  }
}

function writeAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    // Full or blocked: the chat goes unsaved, nothing else is affected.
  }
}

export const newChatId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Every saved chat, newest first. */
export function listChats() {
  return readAll().sort((a, b) => b.updated - a.updated);
}

export function getChat(id) {
  return readAll().find((c) => c.id === id) ?? null;
}

/** Saves (or replaces) one chat and moves it to the top. */
export function saveChat(chat) {
  writeAll([chat, ...readAll().filter((c) => c.id !== chat.id)].sort((a, b) => b.updated - a.updated));
}

export function deleteChat(id) {
  writeAll(readAll().filter((c) => c.id !== id));
}

export function clearChats() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
