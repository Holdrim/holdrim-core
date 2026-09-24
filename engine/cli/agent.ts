import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ofProject } from './pages.ts';
import { impactOf, formatWhen, mustBeQueued } from './requests.ts';
import type { Source } from './remote.ts';

/**
 * The bridge between an approved request and the agent that applies it.
 *
 * The engine calls no model. Decision of 2026-09-22: what applies a request is the CLI the person
 * already has on their machine and already pays for — Claude Code, Codex, Gemini, whichever — with
 * the account that is logged into it. No API key ever passes through Holdrim, and nothing here runs
 * unattended: it is always a person, at their own computer, starting their own tool. A service
 * running around the clock on somebody's subscription would be a different product, and a
 * different conversation with each vendor's terms.
 *
 * So this file does two small things. It writes the BRIEF — everything the agent needs to act on
 * one request, in plain text — and, when asked, hands that brief to the agent's command. The
 * brief is the contract; the command is a convenience.
 */

/** The CLIs this tool knows how to call. Each one takes a prompt as its last argument. */
export const KNOWN_AGENTS: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude', '-p'],
  codex: ['codex', 'exec'],
  gemini: ['gemini', '-p'],
};

/**
 * Which command runs the agent, in order of who gets to decide:
 *   1. `--agent`, on the command line: a known name, or a whole command with its arguments
 *   2. `agent.command` in `holdrim.json`
 *   3. the first known CLI on the PATH
 *
 * ⚠️ It never picks a vendor for the person. With nothing configured and nothing installed it
 * says so and names the three ways out, rather than defaulting to any one company's tool: the
 * whole point of this bridge is that the choice of agent is the person's, not the engine's.
 */
export function resolveAgent(
  asked: string | undefined,
  configured: readonly string[] | undefined,
  installed: (binary: string) => boolean,
): string[] {
  if (asked) {
    const known = KNOWN_AGENTS[asked];
    if (known) return [...known];
    return asked.split(/\s+/).filter(Boolean);
  }
  if (configured?.length) return [...configured];
  for (const [name, command] of Object.entries(KNOWN_AGENTS)) {
    if (installed(name)) return [...command];
  }
  throw new Error(
    'no agent to hand the request to.\n' +
    '  Pass one:            holdrim apply <id> --agent claude  (or codex, gemini, or a whole command)\n' +
    '  Or configure one:    "agent": { "command": ["claude", "-p"] }   in holdrim.json\n' +
    '  Or install one of:   ' + Object.keys(KNOWN_AGENTS).join(', '));
}

/** Is there an executable by this name on the PATH? Cheap, and honest about Windows. */
export function onPath(binary: string, env: Record<string, string | undefined> = process.env): boolean {
  const path = env.PATH ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of path.split(separator).filter(Boolean)) {
    for (const suffix of suffixes) {
      try {
        readFileSync(`${dir}/${binary}${suffix}`);
        return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

/**
 * Everything the agent needs to apply ONE request, as text it can read whole.
 *
 * The brief repeats the rules that are not up for negotiation — impact before change, validated
 * blocks need the owner, the commit carries the trailers, the request is closed with the tool —
 * because the agent reading it may have no other context: a fresh session in a fresh checkout.
 */
export async function brief(root: string, source: Pick<Source, 'events'>, prefix: string): Promise<string> {
  const { request: r, terms } = await impactOf(root, source, prefix, []);
  // Before a line is written: the first thing the brief tells the agent is that the owner approved.
  mustBeQueued(r);
  const lines: string[] = [];
  lines.push(`# Holdrim request ${r.id}`);
  lines.push('');
  lines.push('You are applying ONE change request to reviewable documentation. The request was');
  lines.push('approved by the owner; your job is to make exactly this change, in the content, and');
  lines.push('nothing else.');
  lines.push('');
  lines.push(`State:   ${r.state}`);
  lines.push(`Who:     ${r.author}  ·  ${formatWhen(r.when)}`);
  lines.push(`Where:   ${r.block ?? r.page}${r.data?.category ? `  ·  category: ${String(r.data.category)}` : ''}`);
  lines.push('');
  lines.push('## Asked for');
  lines.push('');
  lines.push((r.text ?? '').trim());
  if (r.data?.category === 'page') {
    // The one request whose answer is not on disk yet. Everything the agent needs to know about the
    // shape of a page is already in a page — so it is pointed at the one the request was asked
    // near, rather than handed a second description of the page contract that could drift from
    // the README's.
    const { sheetFolders } = ofProject(root);
    lines.push('');
    lines.push('## This asks for a NEW page');
    lines.push('');
    lines.push(`Nothing written yet answers it. Write ONE new page, in ${sheetFolders[0] ?? 'pages'}/, next to ${r.page}:`);
    lines.push(`- copy the shape of ${r.page}'s file: the same head, stylesheet and panel, a .doc-title__code`);
    lines.push('  with the new page\'s code (the next free one in the same series), a <main>, and every block');
    lines.push('  with a data-id and a data-code;');
    lines.push('- write what the request asks for and nothing more, in the plain words the rest of the');
    lines.push('  documentation uses;');
    lines.push('- mark nothing as validated: a new page starts ⚪, and only the owner\'s ✓ makes it trusted.');
  }
  if (r.snapshot) {
    lines.push('');
    lines.push('## The block, as it read when they asked');
    lines.push('');
    lines.push(r.snapshot.trim());
  }
  for (const { term, hits } of terms) {
    lines.push('');
    lines.push(`## Where "${term}" also shows up (${hits.length} block(s))`);
    lines.push('');
    if (!hits.length) lines.push('nowhere else.');
    for (const b of hits.slice(0, 25)) {
      lines.push(`- ${b.id} (${b.file})${b.validated ? ' — VALIDATED, needs the owner to change' : ''}: ${b.text.slice(0, 120)}`);
    }
    if (hits.length > 25) lines.push(`- … and ${hits.length - 25} more`);
  }
  if (r.history.length) {
    lines.push('');
    lines.push('## Thread');
    lines.push('');
    for (const e of r.history) {
      lines.push(`- ${formatWhen(e.when)} ${e.author}: ${e.type === 'supplement' ? 'added more' : String(e.data?.state ?? e.type)}${e.text ? ` — ${e.text.replace(/\n/g, ' ')}` : ''}`);
    }
  }
  lines.push('');
  lines.push('## The rules');
  lines.push('');
  lines.push('1. Change only what the request asks. Anything else is a new request.');
  lines.push('2. A VALIDATED block does not change without the owner: say so and stop.');
  lines.push('3. Do not touch data-validated, data-validated-fingerprint or data-depended-on attributes.');
  lines.push(`4. Commit with the trailer  Request: ${r.id}`);
  lines.push(`5. Then close it:  holdrim state ${r.id.slice(0, 8)} applied "what you did" --commit <sha>`);
  lines.push('6. If anything is ambiguous, ask instead of guessing. A misread request becomes two.');
  lines.push('');
  return lines.join('\n');
}

/**
 * Hands the brief to the agent's command and waits for it. The brief goes as the LAST argument,
 * which is how the three known CLIs take a prompt; a custom command gets it the same way.
 *
 * Returns the agent's exit code, which becomes ours: a person watching the terminal already saw
 * what happened, and a script wrapping this needs the number.
 */
export async function apply(
  root: string, source: Pick<Source, 'events'>, prefix: string,
  options: { agent?: string; dryRun?: boolean } = {},
): Promise<number> {
  const text = await brief(root, source, prefix);
  if (options.dryRun) { console.log(text); return 0; }

  const configured = ofProject(root)
    .agentCommand;
  const [command, ...args] = resolveAgent(options.agent, configured, onPath);
  console.error(`→ ${[command, ...args].join(' ')} <brief>`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, text], { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
