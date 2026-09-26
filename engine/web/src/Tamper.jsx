/**
 * The tampered-text banner (issue #107): one line per finding the server says is open, at the top of
 * every page the panel runs on, for everybody signed in.
 *
 * It has NO control that hides it. A security alert a reader can close is one nobody has to read, so
 * the only way a line goes away is the one the server decides: the owner acknowledges that finding,
 * the server records it as an event, and the next answer no longer lists it. Whoever may acknowledge
 * is the server's to say too (`canAcknowledge`); the panel draws the button, it decides nothing.
 *
 * Everything the server sends is a key or an id, never a sentence: the words are the reader's, from
 * the dictionaries, and the ids are data, set as code.
 */
import { useState } from 'react';
import { t } from './i18n.js';

function Line({ finding, canAcknowledge, onAcknowledge }) {
  const [going, setGoing] = useState(false);
  const [error, setError] = useState('');

  async function acknowledge() {
    setGoing(true); setError('');
    try {
      await onAcknowledge(finding.finding);
    } catch (e) {
      setError(String(e.message ?? e));
      setGoing(false);
    }
  }

  // `{page}` and `{event}` are data, not words, so they are filled in as code and a translation is
  // free to put them anywhere in its sentence — the same rule `withCode` follows in Panel.jsx.
  const sentence = t(finding.key, { field: t(finding.fieldKey) });
  const parts = sentence.split(/(\{page\}|\{event\})/);
  return (
    <li className="rv-tamper-line" data-finding={finding.finding}>
      {parts.map((part, i) => (part === '{page}' ? <code key={i}>{finding.page}</code>
        : part === '{event}' ? <code key={i}>{finding.event}</code> : part))}
      {canAcknowledge ? (
        <button type="button" className="rv-tamper-ack" onClick={acknowledge} disabled={going}>
          {t('panel.tamper.acknowledge')}
        </button>
      ) : null}
      {error ? <span className="rv-tamper-error">{error}</span> : null}
    </li>
  );
}

export default function TamperBanner({ findings, canAcknowledge, onAcknowledge }) {
  if (!findings.length) return null;
  return (
    <section className="rv-tamper" role="alert">
      <p className="rv-tamper-title">{t('panel.tamper.title')}</p>
      <ul className="rv-tamper-list">
        {findings.map((f) => (
          <Line key={f.finding} finding={f} canAcknowledge={canAcknowledge} onAcknowledge={onAcknowledge} />
        ))}
      </ul>
      {canAcknowledge ? <p className="rv-tamper-note">{t('panel.tamper.note')}</p> : null}
    </section>
  );
}
