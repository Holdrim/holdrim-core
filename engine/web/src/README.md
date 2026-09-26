# The panel, in React

The review panel, written in React. `engine/web/panel-react.js` is the bundled result, and it is
**committed on purpose**: this project promises "clone and run", and a bundle that only exists after
`npm install` would break that promise.

    npm run build:web      # produces engine/web/panel-react.js

CI checks the built file is not stale, and so does the pre-commit hook. Touch anything here — or
`engine/locales/en.json`, which the bundle carries — run it and commit the result.

## What lives where

| File | What it is |
|---|---|
| `entry.jsx` | the bridge to the page: finds the blocks, creates the buttons, mounts React |
| `Panel.jsx` | the dialog: badge, actions, request form, triage, history |
| `Tamper.jsx` | the tampered-text banner: one line per finding the server says is open, and no close control |
| `api.js` | the API routes the panel calls, and the fingerprint (which comes from the core, not a copy) |
| `state.js` | a block's state and traffic light, derived from the events — pure, tested without a browser |

The state labels and the request categories are read from `engine/cycle.json`, bundled in. There is
no second list of them here to keep in step.

## Two rules that do not bend

**React does not own the page.** The buttons are created in the page's own DOM, not by a component:
the page belongs to whoever adopts the method, and it may be HTML, Astro, Jekyll or anything else.
React mounts only the dialog, in a `<div>` at the end of `<body>`.

**Everything entering `<main>` carries `data-review-ui`.** Injected text enters the fingerprint, and
the fingerprint is what decides whether a human approval still holds. Forgetting it knocks down
every approval on the page at once, with no error at all.

## Triage, and why the buttons are not listed here

Whoever can triage sees, on each request, the possible destinations — and that list comes from
`status.triage`, computed by the SERVER. There is no list of states written in the front end.

That is what keeps the two from disagreeing: on an already-approved request the triage list comes
back empty, and the "Approve" button simply does not exist, instead of existing and failing on
click. A request made by the owner is born approved — they do not triage themselves — so no triage
appears at all.

Rejecting and asking require a reason (`status.requiresReason`), and the panel blocks before calling
the API.

## What it does not do yet

Nothing is missing from the loop. Every open request in the project is also listed on the home
(`/engine/home`), where whoever may decide can decide it, or follow the link to its block — this
panel opens on the block the link names.

It is the only panel, on purpose: keeping two would mean proving both, and explaining to every
adopter which to pick.
