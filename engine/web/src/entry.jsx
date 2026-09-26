/**
 * The bridge between a documentation page (HTML from any project) and the React panel.
 *
 * The contract with the page is written in the README ("What your page needs"), and has to stay so:
 * `.doc-title__code` holding the page code, blocks with `data-id` and `data-code` inside `<main>`,
 * and — the rule that knocks down the most approvals when forgotten — `data-review-ui` on
 * everything JavaScript injects.
 *
 * Each block's button is created here, in the page's own DOM, not by React: the page belongs to
 * whoever adopts the method, and React does not own it. React mounts only the dialog.
 */
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import Panel from './Panel.jsx';
import TamperBanner from './Tamper.jsx';
import {
  whoAmI, eventsOfPage, record, fingerprintOf, fingerprintsOf, impactRadiusOf, textOf, tamperedFindings, acknowledgeFinding,
} from './api.js';
import { HOME_SCREEN } from '../../core/screens.js';
import { blockState, trafficLightOf, foreignDependencies, summaryOf } from './state.js';
import { t, speak } from './i18n.js';

const page = (document.querySelector('.doc-title__code')?.textContent ?? '').trim();

function summaryOfBlock(el) {
  const target = el.querySelector('h3, b, p, summary, th') ?? el;
  return summaryOf(target.textContent ?? '');
}

/**
 * `data-depended-on` is written when an approval is marked (`mark` in engine/cli/validation.ts); a
 * hand-edited page can carry anything in it.
 */
function dependedOnOf(el) {
  try {
    const parsed = JSON.parse(el.getAttribute('data-depended-on') || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // Unreadable is treated as "no snapshot", which paints green rather than red. A broken
    // attribute must not take the whole panel down with it: it is a defect in one block.
    console.warn(`[holdrim] ${el.getAttribute('data-id')}: data-depended-on is not JSON`);
    return {};
  }
}

function App({ blocks, elsewhere, who }) {
  const [opened, setOpened] = useState(null);
  // What this person may do on this page and on each block drawn on it, as the server answered it
  // (`/api/me?page=&blocks=`). A block the answer does not name gets no ✓: the panel draws only what
  // the server said yes to.
  const here = who.here ?? { may: {}, blocks: {} };
  // Which of the panel's own controls this project has turned off (docs/ROLES.md, section 7),
  // as `/api/me` sent them. A caller from before this toggle existed sends no `features` at all,
  // and `Panel.jsx` reads a missing key as on — so `{}` here changes nothing for it.
  const features = who.features ?? {};
  const [events, setEvents] = useState([]);
  // How many of the selected block's dependents live on OTHER pages, where there is no element to
  // light. The count still says something happened; a silent zero would read as "nothing depends on
  // this", which for a block with only foreign dependents is the opposite of true.
  const [radiusElsewhere, setRadiusElsewhere] = useState(0);

  async function reload() {
    setEvents(await eventsOfPage(page));
    // A refresh that works makes "could not load" false: left up, it would tell the reader the
    // page is behind while it shows the current state.
    unwarn(t('panel.unavailable'));
  }

  useEffect(() => {
    (async () => {
      // A session and no events IS a failure, and it has to say so. Switched off in silence, the
      // page reads exactly like one nobody ever reviewed — in a product whose premise is
      // traceability, the costliest thing it can show.
      try { await reload(); } catch (e) {
        switchOff(e);
        return warn(t('panel.unavailable'));
      }
      openFromAddress(blocks, setOpened);
    })();
  }, []);

  // Each block's number becomes a button, and the TRAFFIC LIGHT paints it: ⚪ 🟢 🟡 🔴.
  useEffect(() => {
    const fingerprintsNow = new Map([...Object.entries(elsewhere), ...blocks.map((b) => [b.id, b.fingerprint])]);
    for (const b of blocks) {
      const situation = blockState(events, b.id, b.fingerprint);
      const { color, culprits } = trafficLightOf(b, situation, fingerprintsNow);
      b.light = { color, culprits };
      b.button.className = 'rv-num'
        + (color === 'valid' ? ' rv-num--ok' : '')
        + (color === 'stale' ? ' rv-num--stale' : '')
        + (color === 'broken' ? ' rv-num--broken' : '')
        + (situation.open.length ? ' rv-num--request' : '');
      b.button.title = color === 'broken'
        ? t('panel.moved', { list: culprits.join(', ') })
        : '';
      b.button.onclick = () => setOpened(b);
    }
  }, [events, blocks, elsewhere]);

  // The impact radius: selecting a block lights every block that depends on it, directly or through
  // another one (docs/IMPACT.md, "Impact radius"). Computed on the server (`radiusOf`, the same
  // function `holdrim if-i-touch` is built on) and not here, because this page's DOM is not the
  // whole documentation — a dependent on another page has no element for this effect to find.
  useEffect(() => {
    // Cleared FIRST, unconditionally: a block closed, or a second click landing before the first
    // fetch answers, must not leave a stale light lit on a block the reader is no longer looking at.
    for (const b of blocks) b.button.classList.remove('rv-num--radius');
    setRadiusElsewhere(0);
    if (!opened) return;

    let current = true;
    (async () => {
      let ids;
      try { ids = await impactRadiusOf(opened.id); } catch (e) {
        // Read-only and decorative: a reviewer can still approve, request or comment with no radius
        // drawn, so this degrades quietly rather than switching the whole panel off.
        console.warn('[holdrim] impact radius unavailable:', e);
        return;
      }
      if (!current) return;
      let elsewhere = 0;
      for (const id of ids) {
        const dependent = blocks.find((b) => b.id === id);
        if (dependent) dependent.button.classList.add('rv-num--radius');
        else elsewhere++;
      }
      setRadiusElsewhere(elsewhere);
    })();
    return () => { current = false; };
  }, [opened, blocks]);

  return (
    <Panel
      block={opened}
      here={here}
      features={features}
      events={events}
      radiusElsewhere={radiusElsewhere}
      onRecord={async (e) => {
        await record(e);
        // Recorded is recorded. When only the refresh after it fails, throwing like a failed POST
        // would keep the form's draft and say it went wrong, and the person would send it again —
        // a second request in the owner's queue, a second comment in a history nobody erases.
        // The event the POST returned is NOT put on screen instead: a request's state is the
        // server's to compute, on the refresh that just failed, and a request drawn without it
        // offers no triage and counts as nothing open. So the panel closes on a page that says it
        // is behind, and the reason goes to the console, as it does when the first load fails.
        try { await reload(); } catch (failure) {
          console.warn('[holdrim] recorded, but the refresh after it failed:', failure);
          setOpened(null);
          warn(t('panel.unavailable'));
        }
      }}
      onClose={() => setOpened(null)}
    />
  );
}

/**
 * The tampered-text banner, fed by the server: which findings are open, and whether this reader may
 * acknowledge one. After an acknowledgement it asks again rather than dropping the line itself — the
 * server decides what is open, and a line the panel removed on its own would be a banner the panel,
 * not the owner's recorded acknowledgement, had quieted.
 */
function Tampered({ first }) {
  const [state, setState] = useState(first);
  return (
    <TamperBanner findings={state.findings} canAcknowledge={Boolean(state.canAcknowledge)}
                  onAcknowledge={async (finding) => {
                    await acknowledgeFinding(finding);
                    setState(await tamperedFindings());
                  }} />
  );
}

/**
 * Draws the banner at the top of the page — before the blocks are even looked for, so a page with
 * none still says it. A check that could not run says so too: silence here would read as "nothing is
 * tampered", which is the one reading a failed check cannot back.
 */
async function drawTampered() {
  let first;
  try { first = await tamperedFindings(); } catch (e) {
    console.warn('[holdrim] tampered texts unavailable:', e);
    return warn(t('panel.tamper.unavailable'));
  }
  const host = document.createElement('div');
  host.className = 'rv-tamper-host';
  host.setAttribute('data-review-ui', '');
  document.body.prepend(host);
  createRoot(host).render(<Tampered first={first} />);
}

/**
 * A link can open a block: `#A01.1.2`, which is how the project home links a request to its block.
 * Only once the events are in — a panel opened before them shows a block with no history.
 */
function openFromAddress(blocks, setOpened) {
  const id = decodeURIComponent(location.hash.replace(/^#/, ''));
  const target = id && blocks.find((b) => b.id === id);
  if (!target) return;
  target.el.scrollIntoView({ block: 'center' });
  setOpened(target);
}

const alertsSaying = (text) => [...document.querySelectorAll('.rv-alert')].filter((n) => n.textContent === text);

/**
 * A warning at the top of the page, marked as review UI so it never enters a fingerprint. Once per
 * sentence: a refresh that keeps failing would otherwise stack the same line on every send.
 */
function warn(text) {
  if (alertsSaying(text).length) return;
  const note = document.createElement('p');
  note.className = 'rv-alert';
  note.setAttribute('role', 'alert');
  note.setAttribute('data-review-ui', '');
  note.textContent = text;
  document.body.prepend(note);
}

/** Takes a warning down once what it said stops being true. */
function unwarn(text) {
  for (const note of alertsSaying(text)) note.remove();
}

/**
 * No API, no session, or an error: the page falls back to static, whole and readable.
 *
 * The `reason` argument is not decoration. A `.catch(() => switchOff())` would swallow everything
 * — the panel would simply not appear, without a line in the console, and there would be no way to
 * find out why other than reading the code.
 */
function switchOff(reason) {
  if (reason) console.warn('[holdrim] panel switched off:', reason);
  document.body.classList.remove('rv-on');
  // All but the tampered-text banner: a panel that cannot load a page's events is still a panel whose
  // server said a text reads as tampered, and only the owner's acknowledgement takes a line of that
  // down — never an unrelated fetch failing.
  document.querySelectorAll('[data-review-ui]:not(.rv-tamper-host)').forEach((x) => x.remove());
}

/** The elements that get a button: every block in `main` numbered "section.n" — headings and
 *  subheadings get none. One list, read before `/api/me` is asked about their ids and again to draw. */
const reviewable = () => [...document.querySelectorAll('main [data-id][data-code]')]
  .filter((el) => /^\d+\.\d/.test(el.getAttribute('data-code')));

async function start() {
  if (!page || location.protocol === 'file:') return;

  // Who is reading comes first: with no session the page is simply read, not reviewed, and nothing
  // of the panel is drawn; with one, the server's answer carries the language to draw it in, and what
  // this person may do on each block about to be drawn.
  let who;
  try { who = await whoAmI(page, reviewable().map((el) => el.getAttribute('data-id'))); } catch (e) { return switchOff(e); }
  await speak(who.language);
  await drawTampered();

  const blocks = [];
  for (const el of reviewable()) {
    const code = el.getAttribute('data-code');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rv-num';
    button.textContent = code;
    button.setAttribute('data-review-ui', '');          // ⚠️ without this the fingerprint moves
                                                       //    and every approval falls
    button.setAttribute('aria-label', t('panel.open', { code }));
    el.appendChild(button);

    blocks.push({
      el, button, code, page,
      id: el.getAttribute('data-id'),
      validated: el.getAttribute('data-validated'),
      depends: (el.getAttribute('data-depends') ?? '').split(/\s+/).filter(Boolean),
      validatedFingerprint: el.getAttribute('data-validated-fingerprint'),
      // The snapshot of the dependencies at the moment of the ✓, written into the HTML on mark.
      dependedOn: dependedOnOf(el),
      summary: summaryOfBlock(el),
      text: await textOf(el),
      fingerprint: await fingerprintOf(el),
    });
  }
  if (!blocks.length) return;

  // Asked once, before the first paint: a light that starts red and turns green a moment later
  // teaches people to ignore red.
  const foreign = foreignDependencies(blocks);
  const elsewhere = foreign.length ? await fingerprintsOf(foreign) : {};

  // The way back to the project's home, from every page the panel runs on. Drawn here and not
  // written into the pages: an exported page has no engine behind it, and would link to nothing.
  // It is the screen the engine's own menu calls "Project", not `content.home`: that one says
  // where `/` leads, and a project may point it at a page of its own, which is not this list.
  const back = document.createElement('a');
  back.className = 'rv-back';
  back.href = HOME_SCREEN;
  back.textContent = `← ${t('nav.home')}`;
  back.setAttribute('data-review-ui', '');
  document.body.prepend(back);

  document.body.classList.add('rv-on');
  const where = document.createElement('div');
  where.setAttribute('data-review-ui', '');
  document.body.appendChild(where);
  createRoot(where).render(<App blocks={blocks} elsewhere={elsewhere} who={who} />);
}

start().catch((e) => switchOff(e));
