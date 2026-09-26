/**
 * The review panel, in React. It is the window that opens when someone clicks a block's number.
 *
 * What it does NOT do, and that is the point: it does not compute the request cycle. `status`
 * arrives ready from the server, and `status.triage` is the list of allowed destinations — that
 * list is what decides which buttons exist. When the front end computed this, it and the server
 * disagreed about the same request.
 */
import { useEffect, useRef, useState } from 'react';
import { blockState, byWhen, day } from './state.js';
// The cycle's own table, bundled in. The source wrote the state labels and the categories out here
// by hand, a second copy of cycle.json that only a test could keep honest. The bundle can carry the
// real one, so there is nothing to keep in step.
import cycle from '../../cycle.json';
import { t } from './i18n.js';

// `own`, never a raw address compared against one the panel was handed separately: the server
// already answers "is this the viewer's own event" (docs/ROLES.md, "The front end obeys the
// server"), and `author` on an event nobody wrote themselves is not necessarily an e-mail at all —
// it is whatever the project's `people.show` says this reader may see (a name, a role, an opaque
// id), and a panel that went on comparing it to `me` would break the day a project turned that
// setting away from "email".
const who = (own, author) => (own ? t('panel.you') : author);
// Names from the dictionaries, in the reader's language; which states and categories exist, and in
// what order, from the cycle's own table.
const labelOf = (state) => t(`cycle.${state}`);
/**
 * Which categories a request may pick from: every one `cycle.json` names, minus whichever of
 * `bug`/`page` this project's `features.bugCategory`/`features.pageRequests` has turned off
 * (docs/ROLES.md, section 7). `features` comes from `/api/me`, by way of `entry.jsx` — the panel
 * never decides a toggle's state on its own, only draws what the server already answered. Missing a
 * key reads as ON: a caller from before this toggle existed, and today's default, both see every
 * category, exactly as before.
 *
 * A function, not a constant: a constant is translated when the module loads, before the server
 * has said which language this person reads, and stays in that one while the rest follows.
 */
const categoriesOf = (features) => Object.keys(cycle.request_categories)
  .filter((key) => (key !== 'bug' || features.bugCategory !== false) && (key !== 'page' || features.pageRequests !== false))
  .map((key) => [key, t(`cycle.category.${key}`)]);

function Badge({ situation, validatedOn, broken }) {
  // A green "validated" over a red explanation is two answers to one question; the red one is true.
  if (validatedOn && broken) {
    return <b className="rv-badge rv-badge--warning">{t('panel.badge.validatedBefore', { day: day(validatedOn) })}</b>;
  }
  if (validatedOn) return <b className="rv-badge rv-badge--repo">{t('panel.badge.validated', { day: day(validatedOn) })}</b>;
  if (situation.approved) return <b className="rv-badge rv-badge--ok">{t('panel.badge.approved')}</b>;
  if (situation.seconded.length) return <b className="rv-badge">{t('panel.badge.seconded')}</b>;
  if (situation.expired.length) {
    return <b className="rv-badge rv-badge--warning">{t('panel.badge.changed')}</b>;
  }
  if (situation.open.length) {
    return <b className="rv-badge rv-badge--request">{t('panel.badge.requests', { n: situation.open.length })}</b>;
  }
  return null;
}

/**
 * The owner's triage: deciding where a request someone filed goes next.
 *
 * The buttons come from `status.triage`, which the SERVER computes — not a list written here.
 * That is what keeps the front end and the server from disagreeing: on an already approved request
 * the triage arrives empty, and the "Approve" button simply does not exist, instead of existing and
 * failing on click.
 */
function Triage({ request, onDecide }) {
  const [target, setTarget] = useState(null);
  const [reason, setReason] = useState('');
  const [going, setGoing] = useState(false);
  const [error, setError] = useState('');

  const s = request.status ?? {};
  const targets = s.triage ?? [];
  if (!targets.length) return null;

  const needsReason = target && (s.requiresReason ?? []).includes(target);

  async function decide() {
    if (needsReason && !reason.trim()) { setError(t('panel.triage.needReason')); return; }
    setGoing(true); setError('');
    try {
      await onDecide({
        type: 'request_state', page: request.page, block: request.block,
        text: reason.trim() || null,
        data: { request: request.id, state: target },
      });
      setTarget(null); setReason('');
    } catch (e) {
      setError(String(e.message ?? e));
    } finally {
      setGoing(false);
    }
  }

  return (
    <div className="rv-triage">
      {targets.map((to) => (
        <button key={to} type="button" data-target={to}
                className={target === to ? 'rv-active' : ''}
                onClick={() => setTarget(target === to ? null : to)}>
          {labelOf(to)}
        </button>
      ))}
      {target ? (
        <div className="rv-form">
          {needsReason ? (
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
                      placeholder={target === 'question' ? t('panel.triage.ask') : t('panel.triage.why')} />
          ) : null}
          <button type="button" className="rv-submit" onClick={decide} disabled={going}>
            {going ? t('panel.recording') : t('panel.triage.confirm', { state: labelOf(target) })}
          </button>
        </div>
      ) : null}
      {error ? <p className="rv-notice">{error}</p> : null}
    </div>
  );
}

/**
 * "Add details": the requester's answer to a question or a refusal, or a precision while it waits.
 * It goes back to triage in the same thread — the alternative, a new request, loses the thread and
 * makes the owner decide the same thing twice. Offered exactly when the server says it is accepted.
 */
function AddDetails({ request, onRecord }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  // The one submit button that had no guard: a double click sent the same details twice.
  const [sending, setSending] = useState(false);

  async function add() {
    if (!text.trim()) { setError(t('panel.details.need')); return; }
    setSending(true); setError('');
    try {
      await onRecord({ type: 'supplement', page: request.page, block: request.block, text: text.trim(),
        data: { request: request.id } });
      setText(''); setOpen(false);
    } catch (e) {
      setError(String(e.message ?? e));
    } finally {
      setSending(false);
    }
  }

  if (!open) return <button type="button" className="rv-link" onClick={() => setOpen(true)}>{t('panel.details.open')}</button>;
  return (
    <div className="rv-form">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
                placeholder={t('panel.details.placeholder')} />
      <button type="button" className="rv-submit" onClick={add} disabled={sending}>
        {sending ? t('panel.sending') : t('panel.details.add')}
      </button>
      {error ? <p className="rv-notice">{error}</p> : null}
    </div>
  );
}

/**
 * What the server said this reader may do on `block` — `POST /api/here`'s answer, for this page.
 * A block it does not name reads as "nothing": a button the server did not say yes to is not drawn.
 */
const mayOn = (here, block) => here?.blocks?.[block] ?? {};

/**
 * One request on this block, for whoever is looking: its state, always — the person who filed it is
 * the one who most needs to know where it stands — then what that person may do about it. Triage is
 * drawn from `status.triage` alone, which the server sends empty to anyone who may not triage this
 * request; adding details, from `here`, for the one block the request is on.
 */
function Request({ request, here, onRecord }) {
  const s = request.status ?? {};
  return (
    <div className="rv-request" data-request={request.id}>
      <p>
        {t('panel.request.from', { who: who(request.own, request.author) })} <em className={`rv-state rv-state--${s.state}`}>{labelOf(s.state)}</em>
      </p>
      <Triage request={request} onDecide={onRecord} />
      {(request.own || mayOn(here, request.block).approve) && s.acceptsSupplement
        ? <AddDetails request={request} onRecord={onRecord} />
        : null}
    </div>
  );
}

/**
 * A translated sentence with block ids set as code where `{name}` stands. The ids are data, not
 * words, so they stay out of the dictionaries — and a translation is free to put them anywhere.
 */
function withCode(sentence, name, ids) {
  const [before, after = ''] = sentence.split(`{${name}}`);
  return <>{before}{ids.map((c, i) => <span key={c}>{i ? ', ' : ''}<code>{c}</code></span>)}{after}</>;
}

// `tamper_acknowledged` is written on the tampered event's own page and block (engine/api/tamper.ts),
// so it lands in that block's history; named here, the owner's acknowledgement reads as a sentence
// rather than as the contract value it is stored under.
const DID = { approval: 'panel.did.approval', request: 'panel.did.request', comment: 'panel.did.comment',
  tamper_acknowledged: 'panel.did.tamperAcknowledged' };

function History({ events }) {
  if (!events.length) return null;
  return (
    <div className="rv-history">
      <h4 className="rv-history-title">{t('panel.history.title')}</h4>
      {[...events].sort(byWhen).map((e) => (
        <p key={e.id} className={`rv-h rv-h--${e.type === 'approval' ? 'approval' : 'request'}`}>
          <span className="rv-state">{day(e.when)}</span> {who(e.own, e.author)}
          {' '}{DID[e.type] ? t(DID[e.type]) : e.type}
          {e.text ? <>: {e.text}</> : null}
          {e.snapshot ? (
            <details className="rv-snapshot">
              <summary>{t('panel.history.snapshot')}</summary>
              <p>{e.snapshot}</p>
            </details>
          ) : null}
        </p>
      ))}
    </div>
  );
}

export default function Panel({ block, here, features = {}, events, radiusElsewhere, onRecord, onClose }) {
  const dlg = useRef(null);
  const [tab, setTab] = useState(null);
  const [text, setText] = useState('');
  const [category, setCategory] = useState(Object.keys(cycle.request_categories)[0]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (block && !dlg.current?.open) dlg.current?.showModal();
    if (!block && dlg.current?.open) dlg.current?.close();
    setTab(null); setText(''); setError('');
  }, [block]);

  if (!block) return <dialog className="rv-panel" data-review-ui ref={dlg} />;

  // A draft belongs to the form it was written in: carried from "Request a change" into "Comment",
  // a request's text would be sent as a remark nobody triages.
  const choose = (next) => { setTab(tab === next ? null : next); setText(''); setError(''); };

  const situation = blockState(events, block.id, block.fingerprint);

  async function send(type) {
    if (type === 'request' && !text.trim()) { setError(t('panel.request.need')); return; }
    if (type === 'comment' && !text.trim()) { setError(t('panel.comment.need')); return; }
    setSending(true); setError('');
    try {
      await onRecord({
        type, page: block.page, block: block.id, fingerprint: block.fingerprint,
        text: text.trim() || null,
        // The snapshot is the text at the instant of recording, and it has to be THE SAME text the
        // fingerprint looked at. Otherwise the history shows one thing and the fingerprint talks
        // about another.
        snapshot: block.text,
        data: type === 'request' ? { category } : null,
      });
      setText(''); setTab(null);
    } catch (e) {
      setError(String(e.message ?? e));
    } finally {
      setSending(false);
    }
  }

  return (
    <dialog className="rv-panel" data-review-ui ref={dlg} onClose={onClose}>
      <header className="rv-head">
        <h3>{t('panel.block', { code: block.code })}</h3>
        <button type="button" className="rv-close" onClick={onClose} aria-label={t('panel.close')}>✕</button>
      </header>

      <p className="rv-summary">{block.summary}</p>
      <p className="rv-status"><Badge situation={situation} validatedOn={block.validated} broken={block.light?.color === 'broken'} /></p>

      {/* The blocks lit on the page ARE the radius that lives here; the ones elsewhere have no
          element to light, so without this line they would simply be invisible — which for a block
          whose only dependents are on other pages would read as "nothing depends on this" and is
          the opposite of true. */}
      {radiusElsewhere > 0 ? <p className="rv-radius-note">{t('panel.radius.elsewhere', { n: radiusElsewhere })}</p> : null}

      {/* Red with no reason makes a person re-approve out of fright — which is exactly what the lock
          exists to prevent. So the panel says WHAT changed, and sends them to look there before
          deciding here. */}
      {block.light?.color === 'broken' ? (
        <div className="rv-broken">
          <b>{t('panel.broken.title')}</b>
          {' '}{withCode(t('panel.broken.body'), 'list', block.light.culprits)}
        </div>
      ) : null}

      <div className="rv-actions">
        {/* Not twice by the same person: an admin's ✓ does not turn the block green, and a button still
            on offer after it reads as "it did not take". */}
        {mayOn(here, block.id).approve && !situation.approved && !situation.seconded.some((e) => e.own) ? (
          <button type="button" onClick={() => send('approval')} disabled={sending}>
            {t('panel.approve')}
          </button>
        ) : null}
        <button type="button" className={tab === 'request' ? 'rv-active' : ''}
                onClick={() => choose('request')}>
          {t('panel.request.open')}
        </button>
        {/* A remark that asks for nothing: a question, a note for the next reader. It is kept in
            the block's history like everything else, and changes no state — a request would put
            it in the owner's queue, which is exactly what a remark should not do. Hidden, not
            merely disabled, when `features.comments` is off: an offered control that then 403s
            reads as broken, and the panel draws only what the server would still accept. */}
        {features.comments !== false ? (
          <button type="button" className={tab === 'comment' ? 'rv-active' : ''}
                  onClick={() => choose('comment')}>
            {t('panel.comment.open')}
          </button>
        ) : null}
      </div>

      {tab === 'request' ? (
        <div className="rv-form">
          <label>
            {t('panel.request.kind')}
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {categoriesOf(features).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
                    placeholder={t('panel.request.placeholder')} />
          <button type="button" className="rv-submit" onClick={() => send('request')} disabled={sending}>
            {sending ? t('panel.sending') : t('panel.request.send')}
          </button>
        </div>
      ) : null}

      {tab === 'comment' ? (
        <div className="rv-form">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
                    placeholder={t('panel.comment.placeholder')} />
          <button type="button" className="rv-submit" onClick={() => send('comment')} disabled={sending}>
            {sending ? t('panel.sending') : t('panel.comment.open')}
          </button>
        </div>
      ) : null}

      {error ? <p className="rv-notice">{error}</p> : null}

      {/* Every request's state for everyone; triage only for whoever can triage, and only while the
          request still has a destination. */}
      {situation.requests.map((r) => (
        <Request key={r.id} request={r} here={here} onRecord={onRecord} />
      ))}

      <History events={situation.history} />

      {/* Said where the person decides, because it is what makes a ✓ worth giving: it is theirs, by
          name, for good. */}
      <p className="rv-footer">{t('panel.footer')}</p>
    </dialog>
  );
}
