/**
 * A ministry's own needs, and the people who answered them.
 *
 * One dialog in the same UI as everything else, not a separate admin area:
 * each need with its status, the volunteers who offered to help (with what
 * they told us about themselves and how to reach them), and any calls booked.
 * A need can be marked filled, which takes it off the globe, and reopened.
 */
import { h, plural, since } from "./dom.js";

const STATUS = {
  live: { label: "Live", cls: "is-live" },
  pending_review: { label: "Under review", cls: "is-review" },
  rejected: { label: "Not published", cls: "is-off" },
  filled: { label: "Filled", cls: "is-off" },
};

export function dashboardModal(layer, { load, onSetStatus, onPost, onShowNeed }) {
  return layer.show((close) => {
    const list = h("div", { class: "dash" }, h("p", { class: "modal__lede", text: "Loading your needs…" }));
    const summary = h("p", { class: "modal__lede" });

    // What they wrote when they picked the need up, and the work they shared.
    const answers = (a) => {
      const work = [
        ...a.links.map((url) => h("a", { class: "work__item", href: url, target: "_blank", rel: "noopener" },
          h("span", { class: "work__kind", text: "Link" }),
          h("span", { class: "work__name", text: url.replace(/^https?:\/\//, "") }),
        )),
        ...a.files.map((f) => h(f.url ? "a" : "div", { class: "work__item", href: f.url, target: "_blank", rel: "noopener" },
          h("span", { class: "work__kind", text: "File" }),
          h("span", { class: "work__name", text: f.name }),
        )),
      ];
      if (!a.why && !a.qualifications && !work.length) return null;
      return h("div", { class: "applicant__answers" },
        a.why ? h("div", {}, h("span", { class: "ml", text: "Why" }), h("p", { text: a.why })) : null,
        a.qualifications ? h("div", {}, h("span", { class: "ml", text: "Qualifications" }), h("p", { text: a.qualifications })) : null,
        work.length ? h("div", {}, h("span", { class: "ml", text: "Previous work" }), h("div", { class: "work__items" }, work)) : null,
      );
    };

    const person = (p, extra) =>
      h("div", { class: "applicant" },
        h("div", { class: "applicant__head" },
          h("span", { class: "applicant__dot", text: (p.name || "?").trim().charAt(0).toUpperCase() }),
          h("div", {},
            h("b", { text: p.name }),
            h("span", { text: [p.email, extra].filter(Boolean).join(" · ") }),
          ),
          p.email ? h("a", { class: "btn btn--soft btn--sm", href: `mailto:${p.email}` }, "Email") : null,
        ),
        p.application ? answers(p.application) : null,
        p.skills?.length ? h("div", { class: "tags" }, p.skills.slice(0, 6).map((s) => h("span", { class: "tag", text: s }))) : null,
        p.experience ? h("p", { class: "applicant__about", text: p.experience }) : null,
        p.availability || p.languages?.length || p.portfolio
          ? h("div", { class: "applicant__meta" },
              p.availability ? h("span", { text: p.availability }) : null,
              p.languages?.length ? h("span", { text: p.languages.join(", ") }) : null,
              p.portfolio ? h("a", { href: p.portfolio, target: "_blank", rel: "noopener", text: "Portfolio" }) : null,
            )
          : null,
      );

    const needBlock = (n) => {
      const st = STATUS[n.status] ?? STATUS.live;
      const open = h("div", { class: "dash__people" });
      const count = n.applicants.length + n.calls.length;
      const toggle = h("button", { class: "dash__count", disabled: !count },
        count ? `${plural(n.applicants.length, "person", "people")} interested · ${plural(n.calls.length, "call", "calls")} booked` : "No responses yet");
      toggle.addEventListener("click", () => block.classList.toggle("is-open"));

      for (const c of n.calls) {
        const when = new Date(c.startsAt).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
        open.appendChild(
          h("div", { class: "dash__call" },
            h("span", { class: "ml", text: "Call booked" }),
            h("b", { text: `${when} · ${c.minutes} min` }),
            c.meetUrl ? h("a", { class: "btn btn--accent btn--sm", href: c.meetUrl, target: "_blank", rel: "noopener" }, "Join Meet") : null,
            person(c.person, c.note ? `“${c.note}”` : null),
          ),
        );
      }
      for (const a of n.applicants) open.appendChild(person(a, `interested ${since(a.at)}`));

      const actions = h("div", { class: "dash__actions" });
      if (n.status === "live") {
        actions.append(
          h("button", { class: "btn btn--soft btn--sm", onclick: () => { close(); onShowNeed(n.id); } }, "View on map"),
          h("button", { class: "btn btn--soft btn--sm", onclick: () => setStatus(n, "filled") }, "Mark filled"),
        );
      } else if (n.status === "filled") {
        actions.append(h("button", { class: "btn btn--soft btn--sm", onclick: () => setStatus(n, "live") }, "Reopen"));
      }

      const block = h("div", { class: "dash__need" },
        h("div", { class: "dash__top" },
          h("span", { class: `dash__status ${st.cls}`, text: st.label }),
          h("span", { class: "dash__when", text: `posted ${since(n.posted)}` }),
        ),
        h("b", { class: "dash__title", text: n.title }),
        n.reason ? h("p", { class: "dash__reason", text: n.reason }) : null,
        h("div", { class: "dash__row" }, toggle, actions),
        open,
      );
      if (count) block.classList.add("is-open");
      return block;
    };

    const render = (data) => {
      const needs = data.needs ?? [];
      const people = needs.reduce((s, n) => s + n.applicants.length, 0);
      const calls = needs.reduce((s, n) => s + n.calls.length, 0);
      summary.textContent = needs.length
        ? `${plural(needs.length, "need", "needs")} · ${plural(people, "person", "people")} interested · ${plural(calls, "call", "calls")} booked`
        : "You have not posted anything yet.";
      list.replaceChildren(...(needs.length ? needs.map(needBlock) : [h("p", { class: "modal__lede", text: "Post your first need and it will show up here, with everyone who offers to help." })]));
    };

    const refresh = () => load().then(render, (e) => list.replaceChildren(h("p", { class: "modal__lede", text: e.message })));

    async function setStatus(n, status) {
      try {
        await onSetStatus(n.id, status);
        refresh();
      } catch (e) {
        list.prepend(h("p", { class: "modal__note", style: { color: "var(--urgent)" }, text: e.message }));
      }
    }

    refresh();
    return h("div", { class: "modal__inner" },
      h("div", { class: "modal__body scroll" },
        h("div", { class: "modal__eyebrow", text: "Your ministry" }),
        h("h2", { class: "modal__title", text: "Your needs" }),
        summary,
        list,
      ),
      h("div", { class: "modal__foot" },
        h("button", { class: "btn btn--accent", onclick: () => { close(); onPost(); } }, "Post a need"),
        h("button", { class: "btn btn--soft", onclick: close }, "Done"),
      ),
    );
  }, { width: 680 });
}
