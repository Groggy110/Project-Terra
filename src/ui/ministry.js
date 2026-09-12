/**
 * The two things a ministry does: put itself on the map, and say what it needs.
 *
 * Posting goes through the edge function and can come back held for review, so
 * the confirmation has two shapes. The held one says so plainly and gives the
 * model's reason — a ministry that cannot see why it was held will assume the
 * site is broken and not come back.
 */
import { add, clear, h, icons } from "./dom.js";
import { FOCUS_AREAS, NEED_TYPES, URGENCIES } from "../data/taxonomy.js";
import { createMinistry, postNeed } from "../lib/api.js";

const field = (label, control, note) =>
  h("div", { class: "field" },
    h("span", { class: "ml", text: label }),
    control,
    note && h("span", { class: "field__note", text: note }),
  );

/* -------------------------------------------------- put a ministry on the map */

export function ministryModal(layer, { onCreated } = {}) {
  return layer.show((close) => {
    const name = h("input", { class: "input", placeholder: "Mathare Hope Collective", "data-autofocus": true });
    const city = h("input", { class: "input", placeholder: "Nairobi" });
    const country = h("input", { class: "input", placeholder: "Kenya" });
    const lat = h("input", { class: "input", type: "number", step: "any", placeholder: "-1.2864" });
    const lon = h("input", { class: "input", type: "number", step: "any", placeholder: "36.8172" });
    const blurb = h("textarea", { class: "area", rows: 3, placeholder: "What you do, in a sentence or two." });
    const contact = h("input", { class: "input", type: "email", placeholder: "hello@your-ministry.org" });
    const focusWrap = h("div", { class: "quiz__chips" });
    const chosen = [];
    for (const f of FOCUS_AREAS) {
      const b = h("button", { type: "button", class: "quiz__chip", text: f.label, onclick: () => {
        const i = chosen.indexOf(f.id);
        if (i < 0) chosen.push(f.id); else chosen.splice(i, 1);
        b.classList.toggle("is-on", chosen.includes(f.id));
      } });
      focusWrap.appendChild(b);
    }

    const err = h("span", { class: "modal__note", style: { color: "var(--urgent)" } });
    const go = h("button", { class: "btn btn--accent" }, "Put us on the map");

    go.addEventListener("click", async () => {
      const la = Number(lat.value), lo = Number(lon.value);
      if (!name.value.trim() || !city.value.trim() || !country.value.trim()) {
        err.textContent = "Name, city and country are needed."; return;
      }
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
        err.textContent = "A pin needs real coordinates — latitude −90 to 90, longitude −180 to 180."; return;
      }
      go.disabled = true; go.textContent = "Saving…"; err.textContent = "";
      try {
        const m = await createMinistry({
          name: name.value.trim(), city: city.value.trim(), country: country.value.trim(),
          lat: la, lon: lo, focus: chosen, blurb: blurb.value.trim(), contact: contact.value.trim(),
        });
        close();
        onCreated?.(m);
      } catch (e) {
        err.textContent = String(e.message ?? e);
        go.disabled = false; go.textContent = "Put us on the map";
      }
    });

    return h("div", {},
      h("h2", { class: "modal__title", text: "Put your ministry on the map" }),
      h("p", { class: "modal__lede", text: "This is the pin people will see. The coordinates decide where it lands, so take them from a map of the place you actually work." }),
      field("Ministry name", name),
      h("div", { class: "row2" }, field("City", city), field("Country", country)),
      h("div", { class: "row2" },
        field("Latitude", lat, "Right-click the spot in Google Maps to copy both"),
        field("Longitude", lon),
      ),
      field("What you do", blurb),
      field("Contact email", contact),
      field("Focus areas", focusWrap),
      h("div", { class: "modal__foot" }, err, go),
    );
  }, { width: 600 });
}

/* --------------------------------------------------------------- post a need */

export function postNeedModal(layer, { ministry, onPosted } = {}) {
  return layer.show((close) => {
    const title = h("input", { class: "input", placeholder: "Clinic nurse (6 months)", "data-autofocus": true });
    const type = h("select", { class: "select" }, NEED_TYPES.map((t) => h("option", { value: t.id }, t.label)));
    const urgency = h("select", { class: "select" }, URGENCIES.map((u) => h("option", { value: u.id, selected: u.id === "soon" }, u.label)));
    const focus = h("select", { class: "select" }, FOCUS_AREAS.map((f) => h("option", { value: f.id }, f.label)));
    const people = h("input", { class: "input", type: "number", min: "0", max: "500", value: "1" });
    const commitment = h("input", { class: "input", placeholder: "full time · 6 months" });
    const skills = h("input", { class: "input", placeholder: "Nursing, Registration" });
    const detail = h("textarea", { class: "area", rows: 4, placeholder: "What the work involves and why it matters." });
    const remote = h("input", { type: "checkbox" });

    const err = h("span", { class: "modal__note", style: { color: "var(--urgent)" } });
    const go = h("button", { class: "btn btn--accent" }, "Post this need");

    go.addEventListener("click", async () => {
      if (!title.value.trim()) { err.textContent = "Give the need a title first."; return; }
      go.disabled = true; go.textContent = "Checking…"; err.textContent = "";
      try {
        const res = await postNeed({
          ministry_id: ministry.id,
          title: title.value.trim(),
          type: type.value,
          urgency: urgency.value,
          focus: focus.value,
          people: Math.max(0, Number(people.value) || 0),
          remote: remote.checked,
          commitment: commitment.value.trim(),
          skills: skills.value.split(",").map((s) => s.trim()).filter(Boolean),
          detail: detail.value.trim(),
        });
        showResult(res);
      } catch (e) {
        err.textContent = String(e.message ?? e);
        go.disabled = false; go.textContent = "Post this need";
      }
    });

    const card = h("div", {},
      h("h2", { class: "modal__title", text: "What do you need?" }),
      h("p", { class: "modal__lede", text: `Posting for ${ministry.name} — ${ministry.city}. Everything posted is checked before it appears on the globe.` }),
      field("Title", title),
      h("div", { class: "row2" }, field("Type", type), field("Urgency", urgency)),
      h("div", { class: "row2" }, field("Focus area", focus), field("People wanted", people, "0 for goods, funding or a partner")),
      field("Commitment", commitment),
      field("Skills wanted", skills, "Comma separated"),
      field("Detail", detail),
      h("label", { class: "check" }, remote, h("span", { text: "This can be done remotely" })),
      h("div", { class: "modal__foot" }, err, go),
    );

    function showResult(res) {
      clear(card);
      const held = res.status !== "live";
      add(card, [
        h("div", { class: `post-done${held ? " is-held" : ""}` },
          held ? icons.pin() : icons.check(),
          h("h2", { class: "modal__title", text: held ? "Posted for review" : "It is on the globe" }),
          h("p", { class: "modal__lede", text: res.message }),
          res.reason && h("p", { class: "post-done__why", text: res.reason }),
          held && h("p", { class: "modal__note", text: "You can see it in your own list meanwhile — it is only hidden from the public globe." }),
          h("button", { class: "btn btn--accent", onclick: () => { close(); onPosted?.(res); } }, "Done"),
        ),
      ]);
    }

    return card;
  }, { width: 600 });
}
