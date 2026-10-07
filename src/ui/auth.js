/**
 * The sign-in gate.
 *
 * It is a sheet over the globe rather than a route of its own, because the
 * globe is the argument for signing in: a page that replaces it with a form
 * has thrown away the only thing on screen explaining what this is for.
 *
 * Three ways in, and the project's own settings decide which of them actually
 * work — so the screen reports what happened rather than assuming. A signup
 * that returns no session means confirmation is required, and it says so
 * instead of leaving someone staring at a form that looked like it worked.
 *
 * `inline` builds the same card with no sheet round it, for a host to place
 * (Ask Terra puts it in the conversation); closing it calls `onClose`.
 * `route(mode, intent)` lets the app take an open() elsewhere: returning
 * true means it was handled there.
 */
import { h, add, clear, icons, svg } from "./dom.js";
import { pullToClose } from "./swipe.js";
import { signIn, signUp, sendMagicLink } from "../lib/api.js";

const ENVELOPE = '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m3.8 7 7.1 5.3a2 2 0 0 0 2.2 0L20.2 7"/>';
const HAND = '<path d="M7.5 12.8V6.3a1.8 1.8 0 0 1 3.6 0v4.8m0 0V4.5a1.8 1.8 0 0 1 3.6 0v6.9m0 0V6.9a1.8 1.8 0 0 1 3.6 0v7.8c0 3.6-2.6 6.3-6.3 6.3s-6.3-2.7-6.3-6.3l-2.1-2.1"/>';
const BUILDING = '<path d="M4 20.5V6.2a1.7 1.7 0 0 1 1.7-1.7h7.1a1.7 1.7 0 0 1 1.7 1.7v14.3M14.5 20.5V11h3.8a1.7 1.7 0 0 1 1.7 1.7v7.8M2.5 20.5h19M7.4 8.3h3.7M7.4 11.9h3.7M7.4 15.5h3.7"/>';

export class AuthGate {
  constructor({ onSignedIn, onSkip, inline = false, onClose } = {}) {
    this.onSignedIn = onSignedIn;
    this.onSkip = onSkip;
    this.inline = inline;
    this.onClose = onClose;
    this.route = null;
    this.mode = "signin";      // signin | signup | magic
    this.role = "volunteer";
    this.busy = false;
    this.sent = null;

    // Two boxes, not one: the shell carries the wash and the rounded edge and
    // never scrolls, the body scrolls inside it. A single scrolling box put
    // its own padding and its painted ground on the move together, so on a
    // short window the card's tint slid up past its corner.
    this.body = h("div", { class: "gate__body" });
    if (inline) {
      this.card = h("div", { class: "gate__card gate__card--inline", "aria-label": "Sign in to Terra" }, this.body);
      return;
    }
    this.card = h(
      "div",
      { class: "gate__card", role: "dialog", "aria-modal": "true", "aria-label": "Sign in to Terra" },
      // The same way out every dialog has; on a phone the card fills the
      // screen and there is no scrim left to tap.
      h("button", { class: "modal__x gate__x", type: "button", "aria-label": "Close", onclick: () => this.skip() }, icons.close()),
      this.body,
    );
    this.el = h(
      "div",
      { class: "gate", hidden: true },
      h("div", { class: "gate__scrim", onclick: () => this.skip() }),
      // The real lockup, where it sits on every other screen: top left.
      h(
        "div",
        { class: "brand gate__brand", "aria-hidden": "true" },
        h("img", { class: "brand__logo", src: "/brand/terra-logo-480.png", alt: "Terra", width: 480, height: 248 }),
      ),
      this.card,
    );
    document.body.appendChild(this.el);
    // On a phone the card is a bottom sheet, and pulls down like the rest.
    this.card.prepend(h("div", { class: "modal__grab gate__grab", "aria-hidden": "true" }));
    pullToClose(this.card, { onClose: () => this.skip(), scrim: this.el.querySelector(".gate__scrim") });

    this.onKey = (e) => {
      if (e.key === "Escape" && this.isOpen) this.skip();
    };
  }

  get isOpen() {
    return this.inline ? !!this.card.isConnected : this.el.classList.contains("is-open");
  }

  /**
   * `intent` reshapes the screen for the linked-accounts flows:
   *   { role, title, sub, email, onCancel } — the role is fixed (no picker),
   *   the headline explains what is being linked, and the email may be filled.
   */
  open(mode = "signin", intent = null) {
    if (this.route?.(mode, intent)) return;
    this.mode = mode;
    this.intent = intent;
    if (intent?.role) this.role = intent.role;
    this.sent = null;
    this.error = null;
    if (this.inline) return this.render();
    this.el.hidden = false;
    this.render();
    // One frame, so the transition has a from-state to animate out of.
    requestAnimationFrame(() => this.el.classList.add("is-open"));
    window.addEventListener("keydown", this.onKey);
    // Not on a phone, where it would open the keyboard over the card.
    if (!window.matchMedia("(max-width: 720px)").matches) {
      setTimeout(() => this.card.querySelector("input")?.focus(), 240);
    }
  }

  close() {
    if (this.inline) return this.onClose?.();
    this.el.classList.remove("is-open");
    window.removeEventListener("keydown", this.onKey);
    setTimeout(() => { if (!this.isOpen) this.el.hidden = true; }, 460);
  }

  skip() {
    this.close();
    if (this.intent?.onCancel) this.intent.onCancel();
    else this.onSkip?.();
    this.intent = null;
  }

  /* ------------------------------------------------------------- render */

  render() {
    clear(this.body);
    if (this.sent) return this.renderSent();

    const isSignup = this.mode === "signup";
    const isMagic = this.mode === "magic";

    const seg = (id, label) =>
      h("button", {
        type: "button",
        class: this.mode === id ? "is-on" : "",
        onclick: () => { this.mode = id; this.error = null; this.render(); },
      }, label);

    const field = (label, attrs) =>
      h("div", { class: "gate__field" },
        h("label", { class: "gate__label", for: attrs.id, text: label }),
        h("input", { class: "gate__input", ...attrs }),
      );

    const role = (id, icon, title, note) =>
      h("button", {
        type: "button",
        class: `gate__role${this.role === id ? " is-on" : ""}`,
        onclick: () => { this.role = id; this.render(); },
      },
        svg("0 0 24 24", icon, ""),
        h("div", {}, h("b", { text: title }), h("span", { text: note })),
      );

    const form = h("form", { onsubmit: (e) => { e.preventDefault(); this.submit(); } });

    if (isSignup) {
      add(form, [
        field("Your name", { id: "gate-name", name: "name", autocomplete: "name", placeholder: "Your full name", required: true }),
      ]);
    }

    add(form, [
      field("Email", { id: "gate-email", name: "email", type: "email", autocomplete: "email", placeholder: "you@example.org", required: true, value: this.intent?.email ?? "" }),
      !isMagic && field("Password", {
        id: "gate-pass", name: "password", type: "password",
        autocomplete: isSignup ? "new-password" : "current-password",
        placeholder: isSignup ? "At least 8 characters" : "••••••••",
        minlength: 8, required: true,
      }),
    ]);

    if (isSignup && !this.intent?.role) {
      add(form, [
        h("div", { class: "gate__label", style: { marginTop: "16px" }, text: "I am here to" }),
        h("div", { class: "gate__roles" },
          role("volunteer", HAND, "Offer help", "Answer five questions and we will suggest needs that fit you."),
          role("ministry", BUILDING, "Post what we need", "Put your ministry on the map and get help online."),
        ),
      ]);
    }

    add(form, [
      h("button", {
        class: "gate__go", type: "submit", disabled: this.busy,
        text: this.busy ? "One moment…" : isMagic ? "Email me a link" : isSignup ? "Create account" : "Sign in",
      }),
    ]);

    add(this.body, [
      h("h2", { class: "gate__title", text: this.intent?.title ?? (isSignup ? "Join Terra" : isMagic ? "Sign in without a password" : "Welcome back") }),
      h("p", { class: "gate__sub", text: this.intent?.sub ? this.intent.sub : isSignup
        ? "Help ministries online, or post what yours needs."
        : isMagic
        ? "We will email you a link that signs you in. No password to remember."
        : "Sign in to offer your skills, or to post what your ministry needs." }),
      h("div", { class: "gate__seg" }, seg("signin", "Sign in"), seg("signup", "Create account"), seg("magic", "Email link")),
      form,
      this.error && h("div", { class: "gate__msg gate__msg--bad", text: this.error }),
      h("div", { class: "gate__alt" },
        isSignup
          ? [ "Already have an account? ", h("button", { type: "button", onclick: () => { this.mode = "signin"; this.render(); } }, "Sign in") ]
          : [ "New here? ", h("button", { type: "button", onclick: () => { this.mode = "signup"; this.render(); } }, "Create an account") ],
      ),
      h("button", { class: "gate__skip", type: "button", onclick: () => this.skip(), text: this.intent || this.inline ? "Not now" : "Look around without an account" }),
    ]);
  }

  renderSent() {
    add(this.body, [
      h("div", { class: "gate__sent" },
        svg("0 0 24 24", ENVELOPE, ""),
        h("h2", { class: "gate__title", text: "Check your email" }),
        h("p", { class: "gate__sub", text: this.sent.message }),
        h("button", {
          class: "gate__go", type: "button", text: "Back",
          onclick: () => { this.sent = null; this.render(); },
        }),
        h("button", { class: "gate__skip", type: "button", onclick: () => this.skip(), text: "Look around meanwhile" }),
      ),
    ]);
  }

  /* ------------------------------------------------------------- submit */

  async submit() {
    if (this.busy) return;
    const get = (n) => this.card.querySelector(`[name="${n}"]`)?.value.trim() ?? "";
    const email = get("email");
    const password = get("password");
    const fullName = get("name");

    this.busy = true;
    this.error = null;
    this.render();

    try {
      if (this.mode === "magic") {
        await sendMagicLink({ email, fullName, role: this.role });
        this.sent = { message: `A sign-in link is on its way to ${email}. It is good for an hour.` };
      } else if (this.mode === "signup") {
        const { needsConfirmation } = await signUp({ email, password, fullName, role: this.role });
        if (needsConfirmation) {
          this.sent = { message: `Confirm your address at ${email} and you are in. The link is good for an hour.` };
        } else {
          this.close();
          this.onSignedIn?.();
          return;
        }
      } else {
        await signIn({ email, password });
        this.close();
        this.onSignedIn?.();
        return;
      }
    } catch (err) {
      this.error = friendly(err);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

/**
 * Supabase's messages are accurate and unkind. These are the four a person
 * actually hits; everything else is passed through rather than swallowed,
 * because a wrong guess at what went wrong is worse than the raw text.
 */
function friendly(err) {
  const m = String(err?.message ?? err);
  if (/invalid login credentials/i.test(m)) return "That email and password do not match an account.";
  if (/email not confirmed/i.test(m)) return "Confirm your email address first — check your inbox for the link we sent.";
  if (/already registered|already exists/i.test(m)) return "There is already an account with that email. Try signing in.";
  if (/rate limit|too many/i.test(m)) return "Too many emails from this project just now. Wait a few minutes and try again.";
  if (/password/i.test(m) && /short|least/i.test(m)) return "Use a password of at least eight characters.";
  return m;
}
