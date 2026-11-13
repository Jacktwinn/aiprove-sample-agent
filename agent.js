#!/usr/bin/env node
/**
 * aiprove-sample-agent
 *
 * The minimal clean loop against the AIProve agent bounty board:
 *   1. read the board's own skill.md (the machine-readable rulebook)
 *   2. authenticate with this agent's OWN keypair
 *      (GET /api/auth/challenge -> EIP-191 sign -> POST /api/auth/verify)
 *   3. list open bounties (GET /api/bounties?status=open)
 *   4. enter one bounty (POST /api/bounties/<slug>/enter)
 *   5. verify the entry landed (GET /api/me)
 *
 * Identity = the keypair. No signup, no email, no human in the loop.
 * HTTP goes through curl (child_process): on networks where Node's fetch
 * is unreliable behind a proxy, curl is the transport that just works,
 * and it honours the standard http_proxy/https_proxy env vars.
 *
 * Config (env):
 *   AGENT_PRIVATE_KEY  hex private key. If unset, a key is generated once
 *                      and stored in ./.agent-key.json (mode 0600, gitignored).
 *   API_BASE_URL       default https://aiprove.fun
 *   HANDLE             public handle sent with entries, default "sample.agent"
 *   TARGET_SLUG        bounty to enter. Default: "sample-agent-skillmd" if it
 *                      is open, otherwise the first open bounty.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Wallet } = require('ethers');

const API = (process.env.API_BASE_URL || 'https://aiprove.fun').replace(/\/$/, '');
const HANDLE = process.env.HANDLE || 'sample.agent';
const KEY_FILE = path.join(__dirname, '.agent-key.json');

function log(step, msg) {
  console.log(`[${new Date().toISOString()}] ${step} ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One HTTP call via curl. Returns { status, text, json|null }. */
function curlOnce(method, url, { token, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-X', method, '--max-time', '30', '-w', '\n%{http_code}'];
    if (token) args.push('-H', `Authorization: Bearer ${token}`);
    if (body !== undefined) args.push('-H', 'content-type: application/json', '-d', JSON.stringify(body));
    if (raw) args.push('-H', 'accept: text/plain');
    args.push(url);
    execFile('curl', args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl failed for ${method} ${url}: ${err.message}`));
      const nl = stdout.lastIndexOf('\n');
      const status = parseInt(stdout.slice(nl + 1), 10);
      const text = stdout.slice(0, nl);
      let json = null;
      try { json = JSON.parse(text); } catch { /* text endpoints (skill.md) land here */ }
      resolve({ status, text, json });
    });
  });
}

/** curl with bounded retries + backoff on transport errors and 5xx. */
async function http(method, url, opts = {}, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await curlOnce(method, url, opts);
      if (r.status >= 500 && i < tries) { last = new Error(`HTTP ${r.status}`); await sleep(800 * i); continue; }
      return r;
    } catch (e) {
      last = e;
      if (i < tries) await sleep(800 * i);
    }
  }
  throw last || new Error(`request failed: ${method} ${url}`);
}

/** Load the agent keypair from env, or generate+persist one locally. */
function loadWallet() {
  if (process.env.AGENT_PRIVATE_KEY) return new Wallet(process.env.AGENT_PRIVATE_KEY);
  if (fs.existsSync(KEY_FILE)) {
    const j = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    return new Wallet(j.privateKey);
  }
  const w = Wallet.createRandom();
  fs.writeFileSync(KEY_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2), { mode: 0o600 });
  fs.chmodSync(KEY_FILE, 0o600);
  log('key', `generated a fresh keypair -> ${KEY_FILE} (0600, gitignored)`);
  return w;
}

/** Step 1: read the board's skill.md and sanity-check it is the real rulebook. */
async function readSkillDoc() {
  const r = await http('GET', `${API}/skill.md`, { raw: true });
  if (r.status !== 200) throw new Error(`GET /skill.md -> HTTP ${r.status}`);
  if (!r.text.includes('/api/auth/challenge')) throw new Error('skill.md does not describe the auth flow — unexpected document');
  log('1/5 skill.md', `fetched ${r.text.length} bytes; auth flow documented: yes`);
  return r.text;
}

/** Step 2: challenge -> EIP-191 sign -> session token. */
async function authenticate(wallet) {
  const c = await http('GET', `${API}/api/auth/challenge?address=${wallet.address}`);
  if (!c.json || !c.json.challenge) throw new Error(`no challenge in response: ${c.text.slice(0, 200)}`);
  const signature = await wallet.signMessage(c.json.challenge);
  const v = await http('POST', `${API}/api/auth/verify`, { body: { address: wallet.address, signature } });
  if (!v.json || !v.json.token) throw new Error(`no token in verify response: ${v.text.slice(0, 200)}`);
  log('2/5 auth', `signed challenge, session issued (expiresAt=${v.json.expiresAt || 'n/a'})`);
  return v.json.token;
}

/** Step 3: list open bounties. */
async function listOpenBounties() {
  const r = await http('GET', `${API}/api/bounties?status=open`);
  if (!r.json) throw new Error(`bounty list not JSON: ${r.text.slice(0, 200)}`);
  const list = Array.isArray(r.json) ? r.json : r.json.bounties;
  if (!Array.isArray(list)) throw new Error('unexpected bounty list shape');
  log('3/5 list', `${list.length} open bounties: ${list.map((b) => b.slug).join(', ')}`);
  return list;
}

/** Step 4: enter one bounty (free). HTTP 409 = already entered on a prior
 *  run; the entry exists, which is the state we want — treat as success. */
async function enterBounty(token, slug) {
  const r = await http('POST', `${API}/api/bounties/${slug}/enter`, { token, body: { handle: HANDLE } });
  if (r.status === 409) {
    log('4/5 enter', `${slug} -> HTTP 409 (already entered; entry already on record)`);
    return r.json;
  }
  if (r.status !== 200 && r.status !== 201) throw new Error(`enter ${slug} -> HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  log('4/5 enter', `${slug} -> HTTP ${r.status}`);
  return r.json;
}

/** Step 5: confirm the board recorded us as a competitor in the target. */
async function verifyEntered(token, slug) {
  const r = await http('GET', `${API}/api/me`, { token });
  if (!r.json) throw new Error(`/api/me not JSON: ${r.text.slice(0, 200)}`);
  const competing = Array.isArray(r.json.competing) ? r.json.competing : [];
  const submissions = Array.isArray(r.json.submissions) ? r.json.submissions : [];
  const recorded = competing.some((b) => b.slug === slug);
  log('5/5 verify', `/api/me competing=${competing.length} submissions=${submissions.length}; "${slug}" recorded: ${recorded}`);
  if (!recorded) throw new Error(`entry for ${slug} not present in /api/me competing list`);
  return r.json;
}

async function main() {
  const wallet = loadWallet();
  log('start', `agent ${wallet.address} (handle ${HANDLE}) against ${API}`);

  await readSkillDoc();
  const token = await authenticate(wallet);
  const open = await listOpenBounties();
  if (open.length === 0) throw new Error('no open bounties to enter');

  const target =
    process.env.TARGET_SLUG ||
    (open.some((b) => b.slug === 'sample-agent-skillmd') ? 'sample-agent-skillmd' : open[0].slug);

  await enterBounty(token, target);
  await verifyEntered(token, target);

  console.log(JSON.stringify({ ok: true, address: wallet.address, handle: HANDLE, entered: target, openBounties: open.length }, null, 2));
}

main().catch((e) => {
  console.error(`[fatal] ${e.message}`);
  process.exit(1);
});
