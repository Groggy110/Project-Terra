/**
 * The ministry's inbox: who applied to which need, and what they sent.
 *
 * Two steps in one dialog. First the needs that have applicants, each with
 * its people listed, newest first and unopened ones marked; then one
 * person's application in full — why, qualifications, previous work, and
 * their profile. Opening an application marks it seen, which is what clears
 * the count on the account chip.
 */
import { h, icons, plural, since } from "./dom.js";
import { person } from "./dashboard.js";

export function applicationsModal(layer, { load, onSeen }) {
  return layer.show((close) => {
    const body = h("div", { class: "modal__body scroll" });
    let data = null;

    const newCount = (n) => n.applicants.filter((a) => !a.seen).length;

    const showList = () => {
      const needs = (data?.needs ?? [])
        .filter((n) => n.applicants.length)
        .map((n) => ({ ...n, applicants: [...n.applicants].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) }));
      const fresh = needs.reduce((s, n) => s + newCount(n), 0);
      const total = needs.reduce((s, n) => s + n.applicants.length, 0);

      body.replaceChildren(
        h("div", { class: "modal__eyebrow", text: "Your ministry" }),
        h("h2", { class: "modal__title", text: "Applications" }),
        h("p", {
          class: "modal__lede",
          text: !total
            ? "No one has applied yet. When someone offers to serve on one of your needs, they show up here."
            : `${plural(total, "application")} across ${plural(needs.length, "need")}${fresh ? ` · ${fresh} new` : ""}`,
        }),
        h("div", { class: "inbox" },
          needs.map((n) =>
            h("section", { class: "inbox__need" },
              h("div", { class: "inbox__head" },
                h("b", { text: n.title }),
                h("span", { text: [plural(n.applicants.length, "applicant"), newCount(n) ? `${newCount(n)} new` : null].filter(Boolean).join(" · ") }),
              ),
              h("div", { class: "inbox__people" },
                n.applicants.map((a) =>
                  h("button", { class: `inbox__row${a.seen ? "" : " is-new"}`, onclick: () => showOne(n, a) },
                    h("span", { class: "applicant__dot", text: (a.name || "?").trim().charAt(0).toUpperCase() }),
                    h("span", { class: "inbox__who" },
                      h("b", { text: a.name }),
                      h("span", { text: summary(a) }),
                    ),
                    a.seen ? null : h("span", { class: "new-pill", text: "New" }),
                    icons.arrow(),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      body.scrollTop = 0;
    };

    const showOne = (need, a) => {
      body.replaceChildren(
        h("button", { class: "inbox__back", onclick: showList }, icons.back(), "All applications"),
        h("div", { class: "modal__eyebrow", text: `Applied for · ${need.title}` }),
        h("h2", { class: "modal__title", text: a.name }),
        h("p", { class: "modal__lede", text: `Applied ${since(a.at)}` }),
        h("div", { class: "inbox__detail" }, person({ ...a, seen: true }, null)),
      );
      body.scrollTop = 0;
      if (!a.seen) {
        a.seen = true;
        onSeen(need.id, a.id);
      }
    };

    body.append(h("p", { class: "modal__lede", text: "Loading applications…" }));
    load().then(
      (d) => { data = d; showList(); },
      (e) => body.replaceChildren(h("p", { class: "modal__lede", text: e.message })),
    );

    return h("div", { class: "modal__inner" },
      body,
      h("div", { class: "modal__foot" },
        h("button", { class: "btn btn--soft", onclick: close }, "Done"),
      ),
    );
  }, { width: 640 });
}

/** One line under the name: when, and what they sent. */
function summary(a) {
  const app = a.application ?? {};
  const work = (app.links?.length ?? 0) + (app.files?.length ?? 0);
  return [since(a.at), work ? plural(work, "piece of work", "pieces of work") : null].filter(Boolean).join(" · ");
}
