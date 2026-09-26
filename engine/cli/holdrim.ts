#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { statSync } from 'node:fs';
import { exportSite } from './export.ts';
import { ofProject } from './pages.ts';
import { Source } from './remote.ts';
import * as requests from './requests.ts';
import * as validation from './validation.ts';
import * as graph from './graph.ts';
import * as agent from './agent.ts';

/**
 * The agent's tool for the Holdrim method.
 *
 * One command: `holdrim <command>`. It reads the requests reviewers made on the site, shows the
 * context, measures the impact before changing anything, and brings into the repository the ✓ the
 * owner gave. It NEVER changes content on its own: the change is the agent's, in a commit.
 *
 * It uses the SAME core (engine/core/) as the server and the browser: the request cycle and the
 * text fingerprint are one single file, not three implementations that have to stay identical.
 */

const HELP = `
holdrim — the agent's tool for the Holdrim method

  Review (what came in from the site)
    list [--all] [--json]       requests the owner APPROVED, waiting to be applied (or all)
    show <id>                   the request, the block's text then and now, and the thread
    impact <id> [--term x]      where else the subject shows up, and what is validated
    summary                     approvals and requests, per page
    state <id> <new> "msg"      records progress (whoever asked sees it in the panel)
                                  --commit <sha>    required for "applied"
                                  --blocks A01.1.4,A02.3.1
    apply <id> [--agent x]      hands the request to YOUR agent CLI (claude, codex, gemini, or a
                                  whole command); --dry-run prints the brief instead

  The validation lock (the human ✓)
    sync                        pulls in the ✓ the owner gave on the site
    check                       a validated block that changed, a ✓ with no trail, and a
                                  data-proof pointing at a file that is not on disk
    index                       rebuilds the index: kinds, dependencies, what is missing
    kinds                       the catalogue of content kinds
    lights [--only red]         the state of the whole documentation: 🟢 🟡 🔴 ⚪
    restamp                     writes into the HTML what the registry already knows, so the
                                  browser can paint 🟡 — for approvals older than the attributes
    if-i-touch <id>             what else needs checking if I edit this
    graph --json|--mermaid|--dot
                                 the dependency graph the traffic light reads, for a script or a
                                  diagram — exactly one format, never a guessed default

  Publishing
    export <folder>             the documentation as static pages, without the panel, for anyone
                                  to read — a new or empty folder; nothing is ever deleted

  Options
    --local                     talk to the local server instead of the cloud
    --root <path>               the project root (default: the current directory)
    --db <file>                 read the events from a SQLite file (the no-cloud mode)

  Variables
    HOLDRIM_OWNER               who approves; it is THEIR ✓ that becomes a lock. Required by
                                  every command that asks who the owner is, and read from here
                                  only — holdrim.json may not name it, as on the server
    HOLDRIM_ADMINS              the admins, comma separated: their requests need no triage
    HOLDRIM_AGENTS              the agents' addresses, ";" separated: never triage, a ✓, a lock or
                                  people, and every command refuses if a grant names one
    HOLDRIM_AGENT_TOKEN         the token the owner issued this agent on the people screen; every
                                  write (state) goes through the server with it, never with --local
    HOLDRIM_URL                 the server those writes go to, when not --local (https://…, or
                                  http:// to this machine only)
    HOLDRIM_PROJECT             the Firestore project, read in the cloud
    HOLDRIM_ACCOUNT             pins the gcloud account the cloud is read with (default: the first
                                  one to issue a token)
    HOLDRIM_EVENTS_PATH         the SQLite events file, when there is no cloud
    HOLDRIM_LOCAL_URL           the local server (default: http://localhost:8095)
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      local: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      mermaid: { type: 'boolean', default: false },
      dot: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      term: { type: 'string', multiple: true },
      root: { type: 'string' },
      commit: { type: 'string' },
      blocks: { type: 'string' },
      db: { type: 'string' },
      only: { type: 'string' },
      agent: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const [command, arg] = positionals;
  if (values.help || !command) { console.log(HELP.trim()); return 0; }

  const root = values.root ?? process.cwd();
  // Without this, a mistyped --root reads as an empty documentation: "0 block(s)", exit 0, and
  // `check` passing over nothing. A folder that is not there is an error, said as one.
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`no such folder: ${root}`);
    return 2;
  }
  // The project configuration (name, cloud project) comes from the holdrim.json at the root, and
  // reading it refuses a file that names an owner, admins or lock-holders — before any command
  // runs, so none of them works on a project whose file claims an authority it cannot have. Each
  // command resolves the owner and the admins through `projectRoles`, the server's own resolution,
  // from HOLDRIM_OWNER and HOLDRIM_ADMINS alone.
  const projectConfig = ofProject(root);
  const source = new Source({
    local: values.local,
    project: projectConfig.project ?? undefined,
    account: projectConfig.account ?? undefined,
    db: values.db,
  });

  switch (command) {
    case 'list':       return (await requests.list(root, source, { all: values.all, json: values.json })) ? 1 : 0;
    case 'show':       await requests.show(root, source, requireArg(arg, 'show <id>')); return 0;
    case 'impact':     await requests.impact(root, source, requireArg(arg, 'impact <id>'), values.term ?? []); return 0;
    case 'summary':    await requests.summary(root, source); return 0;
    case 'state':      await requests.setState(root, source, requireArg(arg, 'state <id> <state> "message"'),
                         requireArg(positionals[2], 'state <id> <state> "message"'),
                         requireArg(positionals[3], 'state <id> <state> "message"'),
                         { commit: values.commit, blocks: values.blocks }); return 0;
    case 'apply':      return agent.apply(root, source, requireArg(arg, 'apply <id>'),
                         { agent: values.agent, dryRun: values['dry-run'] });
    case 'sync': {
      const r = await validation.sync(root, source);
      // A refused ✓ is an owner's approval the registry did not get: exiting 0 would let CI pass a
      // run that silently left a lock unrecorded (holdrim#135).
      return r.tampered || r.refused > 0 ? 1 : 0;
    }
    case 'check':      return (await validation.check(root)) ? 1 : 0;
    case 'index':      await validation.rebuildIndex(root, values.db); return 0;
    case 'kinds':      await validation.listKinds(); return 0;
    case 'lights':     return (await validation.showLights(root, { only: values.only })) ? 0 : 2;
    case 'restamp':    return (await validation.restamp(root)).refused > 0 ? 1 : 0;
    case 'if-i-touch': return validation.ifITouch(root, requireArg(arg, 'if-i-touch <id>'));
    case 'graph':      return graph.showGraph(root, { json: values.json, mermaid: values.mermaid, dot: values.dot,
                         enabled: projectConfig.features.graph });
    case 'export': {
      const out = requireArg(arg, 'export <folder>');
      const { pages, files } = exportSite(root, out);
      console.log(`✓ ${pages} page(s) and ${files} other file(s) in ${out} — plain files, no panel, ready for any static host`);
      return 0;
    }
    default:
      console.error(`unknown command: ${command}\n`);
      console.error(HELP.trim());
      return 2;
  }
}

function requireArg(value: string | undefined, usage: string): string {
  if (!value) { console.error(`missing argument. Usage: holdrim ${usage}`); process.exit(2); }
  return value;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('✗ ' + (error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
