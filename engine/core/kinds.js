/**
 * The catalogue of content kinds. Every validatable piece of documentation is of ONE kind, and
 * each kind knows what it demands of itself.
 *
 * Why type content at all, instead of "a block is a block": because the question *"is this good?"*
 * is not the same for a heading and for a diagram. A diagram has to be text to enter the
 * fingerprint. An image has to carry a description, or it does not exist for anyone using a screen
 * reader. A decision without an owner is not a pending decision — it is a lost one.
 *
 * Without kinds, those rules become spoken convention, and spoken convention dies with the third
 * person who joins the project.
 *
 * ⚠️ A kind does NOT change who approves, nor how the fingerprint is computed. It changes **what is
 * demanded** before a block counts as ready for approval. There is still only one lock.
 * @module
 */

/**
 * How much a change **here** disturbs whatever stands on it.
 * @typedef {'cosmetic'|'substantive'|'binding'} Gravity
 */

/**
 * How easily a block of this kind is disturbed by a change **underneath** it.
 * @typedef {'robust'|'normal'|'brittle'} Sensitivity
 */

/**
 * Which of the two documentations a kind belongs to. See `docs/LAYERS.md`: the Fundamental is the
 * blueprint — rules, contracts, the data model, configuration — and the Application is the house
 * built from it. A `data-depends` edge may run from the Application into the Fundamental, or
 * within a layer, but never from the Fundamental into the Application.
 * @typedef {'fundamental'|'application'} Layer
 */

/**
 * @typedef {{
 *   name: string,
 *   description: string,
 *   numbered: boolean,
 *   gravity: Gravity,
 *   sensitivity: Sensitivity,
 *   layer: Layer,
 *   entails: string[],
 *   demands?: (block: {text: string, html: string, attributes: Record<string,string>}) => string[],
 * }} Kind
 */

/**
 * The vocabularies, exported so nobody spells a weight wrong in a new kind and finds out in
 * production. Words and not numbers on purpose: a scale of 1 to 5 invites averaging, and the
 * average of invented numbers is an invented number with a decimal point. Words you can argue
 * about in a pull request.
 */
export const GRAVITIES = /** @type {Gravity[]} */ (['cosmetic', 'substantive', 'binding']);
export const SENSITIVITIES = /** @type {Sensitivity[]} */ (['robust', 'normal', 'brittle']);
export const LAYERS = /** @type {Layer[]} */ (['fundamental', 'application']);

/**
 * `gravity` and `sensitivity` are NOT the same property, and reading them as one is the mistake
 * this comment exists to prevent. `colors` is cosmetic and robust — change the hex, little moves,
 * and little moves it. `contract` is the opposite on both: it promised something to somebody
 * else's system, and it breaks when the ground shifts. The pair becomes a severity in
 * `engine/core/impact.js`.
 *
 * `entails` is a third thing: not how loud the change is, but **what work it creates**. A
 * `model` changing means a migration whether or not anyone is disturbed by it. It stays on the
 * kind for the same reason `demands` does — the kind declares it, nobody guesses it, and it is one
 * file to argue about instead of a convention that dies with the third person to join.
 *
 * `layer` looks redundant next to `gravity`: fourteen of the fifteen kinds below have `layer:
 * 'fundamental'` exactly where `gravity === 'binding'`, and it is tempting to compute one from the
 * other and delete a field. Do not — `decision` is `binding` (an open decision binds the project's
 * future once it lands) but `layer: 'application'`, because a decision is a placeholder for a
 * blueprint fact, not one itself. Fourteen right answers out of fifteen are worse than a flat
 * declaration: they make the fifteenth look checked when it was only guessed. See
 * `docs/LAYERS.md`, section 2.
 */

/** A failed demand returns the sentence of what to do, not the name of the rule. */
const nothing = () => [];

/** @type {Record<string, Kind>} */
export const KINDS = {
  // ---------------------------------------------------------------- structure
  title: {
    name: 'heading',
    description: 'the title of a page or a section. Shows no number, but IS locked: changing a '
      + 'heading changes the meaning of everything under it.',
    numbered: false,
    gravity: 'substantive',
    sensitivity: 'normal',
    layer: 'application',
    entails: [],
    demands: ({ text }) => text.trim().length > 80
      ? ['heading longer than 80 characters — probably a paragraph in disguise'] : [],
  },
  subtitle: {
    name: 'subheading',
    description: 'the one line that explains the section, right under the heading.',
    numbered: false,
    gravity: 'cosmetic',
    sensitivity: 'robust',
    layer: 'application',
    entails: [],
    demands: nothing,
  },

  // ---------------------------------------------------------------- text
  text: {
    name: 'text',
    description: 'a paragraph. The most common kind, and the default for anything undeclared.',
    numbered: true,
    gravity: 'substantive',
    sensitivity: 'normal',
    layer: 'application',
    entails: [],
    demands: nothing,
  },
  list: {
    name: 'list',
    description: 'items in sequence. A one-item list is a paragraph in bad clothing.',
    numbered: true,
    gravity: 'substantive',
    sensitivity: 'normal',
    layer: 'application',
    entails: [],
    demands: ({ html }) => (html.match(/<li\b/g) ?? []).length < 2
      ? ['list with fewer than two items — either make it a paragraph, or add the rest'] : [],
  },
  box: {
    name: 'callout',
    description: 'a warning, a caveat, a note. It has to say which it is — info, warning, ban — '
      + 'otherwise it is just a paragraph with a border, and the colour means nothing.',
    numbered: true,
    gravity: 'substantive',
    sensitivity: 'normal',
    layer: 'application',
    entails: [],
    demands: ({ attributes }) => attributes['data-box'] ? []
      : ['callout without data-box: say whether it is info, warning, ok or forbidden'],
  },
  table: {
    name: 'table',
    description: 'data in rows and columns. Every table needs a header row — without it, nobody '
      + 'using a screen reader knows what each cell means.',
    numbered: true,
    gravity: 'substantive',
    sensitivity: 'normal',
    layer: 'application',
    entails: [],
    demands: ({ html }) => /<th\b/.test(html) ? []
      : ['table without <th>: with no header, the table is unreadable by a screen reader'],
  },

  // ---------------------------------------------------------------- visual
  image: {
    name: 'image',
    description: 'a figure. ⚠️ Text INSIDE an image does not enter the fingerprint — swapping the '
      + 'image does not change the block fingerprint, which is why the description is mandatory: '
      + 'it is the only reviewable part of it.',
    numbered: true,
    gravity: 'cosmetic',
    sensitivity: 'robust',
    layer: 'application',
    entails: [],
    demands: ({ html }) => {
      const missing = [];
      if (/<img\b/.test(html) && !/\balt="[^"]+"/.test(html)) {
        missing.push('image without alt: describe what it shows — it is the only part of it under the lock');
      }
      return missing;
    },
  },
  diagram: {
    name: 'diagram',
    description: 'a flow, a model, an architecture — AS TEXT (Mermaid, PlantUML). A diagram as an '
      + 'image has no useful fingerprint: recompressing changes the bytes without changing the '
      + 'meaning, and changing the meaning does not show up in a diff.',
    numbered: true,
    gravity: 'substantive',
    sensitivity: 'normal',
    layer: 'application',
    entails: [],
    demands: ({ html }) => /<img\b/.test(html)
      ? ['diagram as an image: use Mermaid or PlantUML inside <code>, so it comes under the lock']
      : [],
  },
  colors: {
    name: 'palette',
    description: 'brand colours, with the value next to them. "Primary blue" is not a value; '
      + '"#2E6E5B" is.',
    numbered: true,
    gravity: 'cosmetic',
    sensitivity: 'robust',
    layer: 'application',
    entails: [],
    demands: ({ text }) => /#[0-9a-fA-F]{3,8}\b|\b(rgb|hsl|oklch)\(/.test(text) ? []
      : ['palette with no colour value: write the hex, not just the name'],
  },

  // ---------------------------------------------------------------- technical
  config: {
    name: 'configuration',
    description: 'a variable, a parameter, a value that differs per environment.',
    numbered: true,
    gravity: 'binding',
    sensitivity: 'brittle',
    layer: 'fundamental',
    entails: ['a deploy'],
    demands: nothing,
  },
  contract: {
    name: 'contract',
    description: 'a route, an event, a payload. It is a public promise: breaking it here breaks '
      + "somebody else's system.",
    numbered: true,
    gravity: 'binding',
    sensitivity: 'brittle',
    layer: 'fundamental',
    entails: ['whoever consumes it has to be told', 'a version'],
    demands: nothing,
  },
  model: {
    name: 'data model',
    description: 'an entity, a relationship, a field of the data dictionary.',
    numbered: true,
    gravity: 'binding',
    sensitivity: 'brittle',
    layer: 'fundamental',
    entails: ['a migration'],
    demands: nothing,
  },

  // ---------------------------------------------------------------- domain
  // Its own section, and not "technical", on purpose. `config`, `contract` and `model` are all
  // artefacts of a built system — an environment, an interface, a schema. A domain rule is true
  // before anybody writes code and stays true if the code is thrown away. Filing it next to them
  // would suggest it can be changed by changing the system, which is the exact confusion this
  // kind exists to prevent.
  rule: {
    name: 'domain rule',
    description: 'what has to hold regardless of how the system is built — a deadline, a limit, a '
      + "right, an obligation. Not a `contract`, which is a promise made to somebody else's "
      + 'system and can be renegotiated with them; not a `model`, which is the shape the data '
      + 'takes to store it. Change the database, change the API: the rule stands.',
    numbered: true,
    gravity: 'binding',
    sensitivity: 'brittle',
    layer: 'fundamental',
    entails: ['the tests that prove it have to be re-run, and probably rewritten'],
    // A rule nobody proved is a rule nobody can check. `data-proof` points at the test that
    // defends it, which is what turns "this may mean redoing the tests" from a warning into a
    // check: the rule changed in this commit range and its proof did not.
    demands: ({ attributes }) => attributes['data-proof'] ? []
      : ['rule without data-proof: which test defends this rule?'],
  },

  // ---------------------------------------------------------------- decision
  rationale: {
    name: 'rationale',
    description: 'why it was done this way, and what was rejected. The rejected alternative is the '
      + 'part that pays: it proves there was a choice, and not just inertia.',
    numbered: true,
    gravity: 'substantive',
    sensitivity: 'robust',
    layer: 'application',
    entails: [],
    demands: nothing,
  },
  decision: {
    name: 'open decision',
    description: 'what is still undecided. With no owner and no deadline it is not a pending '
      + 'decision — it is a lost one.',
    numbered: true,
    gravity: 'binding',
    sensitivity: 'normal',
    layer: 'application',
    entails: [],
    demands: ({ attributes }) => {
      const missing = [];
      if (!attributes['data-owner']) missing.push('decision without data-owner: who decides this?');
      if (!attributes['data-deadline']) missing.push('decision without data-deadline: by when?');
      return missing;
    },
  },
};

export const DEFAULT_KIND = 'text';

/**
 * The kind of a block: what it declares, or what can be inferred from how it was written.
 *
 * Inference exists so the method does not start by demanding: documentation that already exists
 * gets kinds without anyone rewriting anything, and whoever wants precision declares it.
 *
 * @param {{ attributes: Record<string,string>, classes: string[], tag: string, html: string }} b
 */
export function kindOf(b) {
  const declared = b.attributes['data-kind'];
  if (declared && KINDS[declared]) return declared;
  if (declared) return DEFAULT_KIND;               // made-up kind: falls back, and the lint reports

  const code = b.attributes['data-code'] ?? '';
  if (/\.title$/.test(code) || /^h[1-3]$/.test(b.tag)) return 'title';
  if (/\.sub$/.test(code) || b.classes.includes('section-lead')) return 'subtitle';

  if (/class="mermaid"|<pre\b/.test(b.html)) return 'diagram';
  if (/<table\b/.test(b.html)) return 'table';
  if (/<img\b/.test(b.html)) return 'image';
  if (/<[uo]l\b/.test(b.html)) return 'list';
  if (b.classes.some((c) => c.startsWith('box'))) return 'box';

  // `rule` is deliberately absent from this list. Everything inferred above is read off markup
  // that documentation already has for other reasons — a <table> is a table whoever wrote it. A
  // domain rule reads exactly like a paragraph, and the only attribute that hints at one,
  // `data-proof`, exists solely because this engine invented it: guessing from it would be
  // reading back a declaration and calling it inference. Worse, it would silently promote a
  // paragraph to binding/brittle. So `rule` is declared, `data-kind="rule"`, or it is not a rule.
  return DEFAULT_KIND;
}

/** What this block is still missing before it is ready for approval. */
export function whatIsMissing(kind, block) {
  const k = KINDS[kind];
  if (!k) return [`unknown kind: "${kind}" — see engine/core/kinds.js`];
  return k.demands ? k.demands(block) : [];
}

/**
 * The layer of a kind, or `null` for one that is not in the catalogue.
 *
 * `null` and not a default: a made-up or newer-engine kind has no declared layer, and guessing one
 * — say, `application`, the larger group — would let it silently pass or fail the downward-edge
 * check on a rule nobody wrote for it. `null` pushes that decision to the caller, and the only
 * caller (`upwardDependencies` in `engine/cli/validation.ts`) refuses to accuse when either side
 * is `null`, the same posture `whatIsMissing` takes towards an unknown kind's demands.
 */
export function layerOf(kind) {
  return KINDS[kind]?.layer ?? null;
}

/** Every kind there is, for the catalogue and for `holdrim kinds`. */
export const catalogue = () =>
  Object.entries(KINDS).map(([id, k]) => ({ id, ...k, demands: undefined }));
