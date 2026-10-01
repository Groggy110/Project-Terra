/**
 * A verse for the loading screen — always one about serving.
 *
 * The references are chosen here, not by an API: YouVersion's verse of the
 * day is their own curated pick with no way to ask for a theme, and this
 * screen wants the ones about being sent, about gifts used for others, about
 * the harvest and the labourers. Every one of them is about ministry.
 *
 * The *text* comes from the YouVersion Platform API when an app key is set
 * (VITE_YOUVERSION_APP_KEY, from platform.youversion.com), in the version
 * VITE_YOUVERSION_BIBLE_ID names — 3034, the Berean Standard Bible, unless
 * told otherwise. Without a key, or if the request is slow or refused, the
 * bundled King James text is used: it is public domain, so it can ship in the
 * bundle, and the loading screen never waits on the network for a verse.
 * A fetched text is remembered, so the next visit shows it at once.
 */

const env = import.meta.env ?? {};
const KEY = env.VITE_YOUVERSION_APP_KEY || "";
const BIBLE = env.VITE_YOUVERSION_BIBLE_ID || "3034";
const VERSION = env.VITE_YOUVERSION_VERSION || "BSB";
const API = "https://api.youversion.com/v1";
const STORE = "terra.verses.v1";

/** `usfm` is the passage id the API takes; `kjv` is the fallback text. */
export const VERSES = [
  { ref: "Isaiah 6:8", usfm: "ISA.6.8", kjv: "Also I heard the voice of the Lord, saying, Whom shall I send, and who will go for us? Then said I, Here am I; send me." },
  { ref: "1 Peter 4:10", usfm: "1PE.4.10", kjv: "As every man hath received the gift, even so minister the same one to another, as good stewards of the manifold grace of God." },
  { ref: "Galatians 6:2", usfm: "GAL.6.2", kjv: "Bear ye one another's burdens, and so fulfil the law of Christ." },
  { ref: "Mark 10:45", usfm: "MRK.10.45", kjv: "For even the Son of man came not to be ministered unto, but to minister, and to give his life a ransom for many." },
  { ref: "Matthew 9:37–38", usfm: "MAT.9.37-38", kjv: "Then saith he unto his disciples, The harvest truly is plenteous, but the labourers are few; Pray ye therefore the Lord of the harvest, that he will send forth labourers into his harvest." },
  { ref: "Galatians 6:9", usfm: "GAL.6.9", kjv: "And let us not be weary in well doing: for in due season we shall reap, if we faint not." },
  { ref: "Matthew 25:40", usfm: "MAT.25.40", kjv: "And the King shall answer and say unto them, Verily I say unto you, Inasmuch as ye have done it unto one of the least of these my brethren, ye have done it unto me." },
  { ref: "Romans 10:15", usfm: "ROM.10.15", kjv: "And how shall they preach, except they be sent? as it is written, How beautiful are the feet of them that preach the gospel of peace, and bring glad tidings of good things!" },
  { ref: "2 Corinthians 5:20", usfm: "2CO.5.20", kjv: "Now then we are ambassadors for Christ, as though God did beseech you by us: we pray you in Christ's stead, be ye reconciled to God." },
  { ref: "Hebrews 6:10", usfm: "HEB.6.10", kjv: "For God is not unrighteous to forget your work and labour of love, which ye have shewed toward his name, in that ye have ministered to the saints, and do minister." },
  { ref: "Acts 20:24", usfm: "ACT.20.24", kjv: "But none of these things move me, neither count I my life dear unto myself, so that I might finish my course with joy, and the ministry, which I have received of the Lord Jesus, to testify the gospel of the grace of God." },
  { ref: "1 Corinthians 15:58", usfm: "1CO.15.58", kjv: "Therefore, my beloved brethren, be ye stedfast, unmoveable, always abounding in the work of the Lord, forasmuch as ye know that your labour is not in vain in the Lord." },
  { ref: "Matthew 5:16", usfm: "MAT.5.16", kjv: "Let your light so shine before men, that they may see your good works, and glorify your Father which is in heaven." },
  { ref: "2 Timothy 4:5", usfm: "2TI.4.5", kjv: "But watch thou in all things, endure afflictions, do the work of an evangelist, make full proof of thy ministry." },
  { ref: "Acts 1:8", usfm: "ACT.1.8", kjv: "But ye shall receive power, after that the Holy Ghost is come upon you: and ye shall be witnesses unto me both in Jerusalem, and in all Judaea, and in Samaria, and unto the uttermost part of the earth." },
  { ref: "Mark 16:15", usfm: "MRK.16.15", kjv: "And he said unto them, Go ye into all the world, and preach the gospel to every creature." },
  { ref: "James 2:17", usfm: "JAS.2.17", kjv: "Even so faith, if it hath not works, is dead, being alone." },
  { ref: "1 John 3:18", usfm: "1JN.3.18", kjv: "My little children, let us not love in word, neither in tongue; but in deed and in truth." },
  { ref: "Proverbs 3:27", usfm: "PRO.3.27", kjv: "Withhold not good from them to whom it is due, when it is in the power of thine hand to do it." },
  { ref: "John 13:14", usfm: "JHN.13.14", kjv: "If I then, your Lord and Master, have washed your feet; ye also ought to wash one another's feet." },
  { ref: "Philippians 2:4", usfm: "PHP.2.4", kjv: "Look not every man on his own things, but every man also on the things of others." },
];

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "{}");
  } catch {
    return {};
  }
}

function save(state) {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch {
    // Private window or storage off: the verse still shows, it just is not remembered.
  }
}

/** A different verse from the one shown last time. */
export function pickVerse() {
  const state = load();
  let i = Math.floor(Math.random() * VERSES.length);
  if (VERSES.length > 1 && VERSES[i].usfm === state.last) i = (i + 1) % VERSES.length;
  state.last = VERSES[i].usfm;
  save(state);
  return VERSES[i];
}

/**
 * The verse's text and the version it is in. Resolves within `timeout`
 * whatever the network does: to YouVersion's text if it came back in time or
 * is remembered from before, otherwise to the bundled KJV.
 */
export async function verseText(verse, { timeout = 900 } = {}) {
  const fallback = { text: verse.kjv, version: "KJV" };
  if (!KEY) return fallback;

  const state = load();
  const id = `${BIBLE}:${verse.usfm}`;
  const remembered = state.text?.[id];
  const request = fetchText(verse)
    .then((text) => {
      if (!text) return null;
      const next = load();
      next.text = { ...(next.text ?? {}), [id]: text };
      save(next);
      return { text, version: VERSION };
    })
    .catch(() => null);

  if (remembered) return { text: remembered, version: VERSION };
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeout));
  return (await Promise.race([request, timer])) ?? fallback;
}

async function fetchText(verse) {
  const res = await fetch(`${API}/bibles/${BIBLE}/passages/${verse.usfm}?format=text`, {
    headers: { "X-YVP-App-Key": KEY, Accept: "application/json" },
  });
  if (!res.ok) return null;
  const body = await res.json();
  const text = String(body?.content ?? body?.data?.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
