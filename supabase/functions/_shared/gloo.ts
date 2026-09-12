/**
 * The Gloo call, and the JSON discipline around it.
 *
 * Terra reaches the model through Gloo's *guarded* endpoint rather than a
 * provider directly. That buys a second, independent alignment pass on exactly
 * the category of content this application has to judge, and it costs nothing
 * extra: gloo-anthropic-claude-opus-5 is billed at the same $5/$25 per million
 * as going to Anthropic.
 */

const ENDPOINT = "https://platform.ai.gloo.com/ai/v2/guarded/responses";

/**
 * Verified present in the live catalogue (GET /platform/v2/models).
 *
 * Sonnet rather than Opus: $2/$10 per million against $5/$25, for two jobs
 * that are judgement-light — a short classification and a ranking over a few
 * dozen short records. Both functions record the model they used in the row
 * they write, so a later disagreement about a verdict can be traced to what
 * actually decided it.
 */
export const MODEL = "gloo-anthropic-claude-sonnet-5";

export interface GlooResult<T> {
  ok: boolean;
  value: T | null;
  raw: string;
  error?: string;
}

/**
 * Asks for one JSON object and insists on getting one.
 *
 * Models are asked for JSON and mostly comply, but "mostly" is not a contract:
 * a stray sentence before the brace, or a ```json fence around it, is common
 * enough that parsing the whole response is the wrong move. So the first
 * balanced object in the text is extracted rather than assuming the text *is*
 * the object. Every failure path returns ok:false with the raw text kept, and
 * it is the caller's job to decide what a failure means — for moderation it
 * means "hold for review", never "allow".
 */
export async function askForJson<T>(
  apiKey: string,
  instructions: string,
  input: string,
): Promise<GlooResult<T>> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        instructions,
        input: [{ role: "user", content: input }],
      }),
    });
  } catch (e) {
    return { ok: false, value: null, raw: "", error: `network: ${e instanceof Error ? e.message : e}` };
  }

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, value: null, raw: body, error: `gloo ${res.status}` };
  }

  const payload = await res.json();
  // Shape confirmed against the live endpoint:
  // { output: [ { content: [ { type: "output_text", text } ] } ] }
  const text: string = payload?.output
    ?.flatMap((m: { content?: { text?: string }[] }) => m?.content ?? [])
    ?.map((c: { text?: string }) => c?.text ?? "")
    ?.join("")
    ?.trim() ?? "";

  const object = firstJsonObject(text);
  if (!object) return { ok: false, value: null, raw: text, error: "no JSON object in response" };

  try {
    return { ok: true, value: JSON.parse(object) as T, raw: text };
  } catch (e) {
    return { ok: false, value: null, raw: text, error: `parse: ${e instanceof Error ? e.message : e}` };
  }
}

/** First brace-balanced object in a string, ignoring braces inside strings. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
