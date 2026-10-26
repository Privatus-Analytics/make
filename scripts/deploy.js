#!/usr/bin/env node
'use strict';

// Deploys src/ to a Make custom app through Make's Custom Apps API.
//
//   MAKE_APP=privatus-analytics-midypx node scripts/deploy.js [--check]
//
// The API token is read from .secrets/apikey (scopes sdk-apps:read and
// sdk-apps:write) and never printed. The zone and the app come from
// origins[0] of src/makecomapp.json (baseUrl, appId, appVersion), or from
// MAKE_BASE_URL and MAKE_APP. Create the app first (POST /sdk/apps): Make
// adds a random suffix to its name.
//
// It is safe to run again: what exists is updated, what is missing is
// created. Connections and webhooks are matched by label, because Make
// names them itself. With --check it changes nothing and compares the app
// in Make with src/.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'makecomapp.json'), 'utf8'));
const origin = manifest.origins[0];
const API = `${process.env.MAKE_BASE_URL || origin.baseUrl}/v2`;
const APP = process.env.MAKE_APP || origin.appId;
const VERSION = process.env.MAKE_VERSION || origin.appVersion || 1;
const TOKEN = fs.readFileSync(path.join(SRC, origin.apikeyFile || '../.secrets/apikey'), 'utf8').trim();
const CHECK = process.argv.includes('--check');

const TYPE = { action: 4, search: 9, trigger: 1, instant_trigger: 10, universal: 12 };
const CRUD = new Set(['create', 'read', 'update', 'delete']);
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const errors = [];

async function call(method, url, body, type = 'application/json') {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { Authorization: `Token ${TOKEN}`, ...(body !== undefined ? { 'Content-Type': type } : {}) },
    body: body === undefined ? undefined : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${method} ${url}: ${res.status} ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 600)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const attempt = async (label, fn) => {
  try { return await fn(); } catch (e) { errors.push(`${label}: ${e.message}`); console.error(`  FAILED ${label}: ${e.message}`); return undefined; }
};

const section = (url, rel) => attempt(`${url}`, () => call('PUT', url, read(rel), 'application/jsonc'));

const app = `/sdk/apps/${APP}/${VERSION}`;

async function deploy() {
  const c = manifest.components;
  const general = manifest.generalCodeFiles;
  console.log(`Deploying to ${APP} version ${VERSION}`);

  console.log('Base, docs, icon');
  await section(`${app}/base`, general.base);
  await attempt('readme', () => call('PUT', `${app}/readme`, read(general.readme), 'text/markdown'));
  await attempt('icon', () => call('PUT', `${app}/icon`, fs.readFileSync(path.join(SRC, 'general/logo.png')), 'image/png'));

  console.log('Connection');
  const connNames = {};
  const remoteConns = (await call('GET', `/sdk/apps/${APP}/connections`)).appConnections || [];
  for (const [id, conn] of Object.entries(c.connection)) {
    let remote = remoteConns.find((r) => r.label === conn.label);
    if (!remote) remote = (await call('POST', `/sdk/apps/${APP}/connections`, { type: conn.type, label: conn.label })).appConnection;
    connNames[id] = remote.name;
    await section(`/sdk/apps/connections/${remote.name}/api`, conn.codeFiles.communication);
    await section(`/sdk/apps/connections/${remote.name}/parameters`, conn.codeFiles.params);
    console.log(`  ${id} -> ${remote.name}`);
  }

  console.log('Webhooks');
  const hookNames = {};
  const remoteHooks = (await call('GET', `/sdk/apps/${APP}/webhooks`)).appWebhooks || [];
  for (const [id, hook] of Object.entries(c.webhook)) {
    let remote = remoteHooks.find((r) => r.label === hook.label);
    if (!remote) remote = (await call('POST', `/sdk/apps/${APP}/webhooks`, { type: hook.type, label: hook.label, connection: connNames[hook.connection] })).appWebhook;
    hookNames[id] = remote.name;
    for (const [sec, key] of [['api', 'communication'], ['parameters', 'params'], ['attach', 'attach'], ['detach', 'detach']]) {
      await section(`/sdk/apps/webhooks/${remote.name}/${sec}`, hook.codeFiles[key]);
    }
    console.log(`  ${id} -> ${remote.name}`);
  }

  console.log('RPCs');
  const remoteRpcs = new Set(((await call('GET', `${app}/rpcs`)).appRpcs || []).map((r) => r.name));
  for (const [id, rpc] of Object.entries(c.rpc)) {
    if (!remoteRpcs.has(id)) await attempt(`create rpc ${id}`, () => call('POST', `${app}/rpcs`, { name: id, label: rpc.label, connection: connNames[rpc.connection] }));
    await section(`${app}/rpcs/${id}/api`, rpc.codeFiles.communication);
    await section(`${app}/rpcs/${id}/parameters`, rpc.codeFiles.params);
  }
  console.log(`  ${Object.keys(c.rpc).length}`);

  console.log('Modules');
  const remoteModules = new Set(((await call('GET', `${app}/modules`)).appModules || []).map((m) => m.name));
  for (const [id, m] of Object.entries(c.module)) {
    const meta = { label: m.label, description: m.description, connection: connNames[m.connection] || null };
    if (!remoteModules.has(id)) {
      const ok = await attempt(`create module ${id}`, () => call('POST', `${app}/modules`, {
        name: id,
        typeId: TYPE[m.moduleType],
        ...meta,
        webhook: m.webhook ? hookNames[m.webhook] : null,
        crud: CRUD.has(m.actionCrud) ? m.actionCrud : null,
      }));
      if (!ok) continue;
    } else {
      await attempt(`patch module ${id}`, () => call('PATCH', `${app}/modules/${id}`, meta));
    }
    for (const [sec, key] of [['api', 'communication'], ['parameters', 'staticParams'], ['expect', 'mappableParams'], ['interface', 'interface'], ['samples', 'samples']]) {
      await section(`${app}/modules/${id}/${sec}`, m.codeFiles[key]);
    }
    process.stdout.write('.');
  }
  console.log(`\n  ${Object.keys(c.module).length}`);

  console.log('Functions');
  for (const [id, fn] of Object.entries(c.function || {})) {
    await attempt(`create function ${id}`, () => call('POST', `${app}/functions`, { name: id }));
    await attempt(`function ${id} code`, () => call('PUT', `${app}/functions/${id}/code`, read(fn.codeFiles.code), 'application/javascript'));
  }
  console.log(`  ${Object.keys(c.function || {}).length}`);

  console.log('Groups');
  await section(`${app}/groups`, general.groups);
}

// ---------- Check: read the app back and compare with src/ ----------

const canon = (v) => JSON.stringify(v, Object.keys(flatKeys(v)).sort());
function flatKeys(v, acc = {}) {
  if (v && typeof v === 'object') for (const k of Object.keys(v)) { acc[k] = 1; flatKeys(v[k], acc); }
  return acc;
}
const same = (remote, rel) => {
  const local = JSON.parse(read(rel));
  const r = typeof remote === 'string' ? JSON.parse(remote) : remote;
  return canon(local) === canon(r);
};

async function check() {
  const c = manifest.components;
  const general = manifest.generalCodeFiles;
  const mismatch = (what) => { errors.push(`mismatch: ${what}`); console.error(`  MISMATCH ${what}`); };
  const appData = (await call('GET', `${app}?cols[]=base&cols[]=groups&cols[]=docs`)).app;
  if (!same(appData.base, general.base)) mismatch('base');
  if (!same(appData.groups, general.groups)) mismatch('groups');
  if ((appData.docs || '').trim() !== read(general.readme).trim()) mismatch('readme');

  const conns = (await call('GET', `/sdk/apps/${APP}/connections`)).appConnections || [];
  const connByLabel = Object.fromEntries(conns.map((r) => [r.label, r.name]));
  for (const conn of Object.values(c.connection)) {
    const name = connByLabel[conn.label];
    if (!name) { mismatch(`connection ${conn.label} missing`); continue; }
    if (!same(await call('GET', `/sdk/apps/connections/${name}/api`), conn.codeFiles.communication)) mismatch(`connection ${name} api`);
    if (!same(await call('GET', `/sdk/apps/connections/${name}/parameters`), conn.codeFiles.params)) mismatch(`connection ${name} parameters`);
  }

  const hooks = (await call('GET', `/sdk/apps/${APP}/webhooks`)).appWebhooks || [];
  const hookByLabel = Object.fromEntries(hooks.map((r) => [r.label, r.name]));
  for (const [id, hook] of Object.entries(c.webhook)) {
    const name = hookByLabel[hook.label];
    if (!name) { mismatch(`webhook ${id} missing`); continue; }
    const remote = (await call('GET', `/sdk/apps/webhooks/${name}`)).appWebhook || {};
    if (remote.connection !== connByLabel[c.connection[hook.connection].label]) mismatch(`webhook ${id} connection ${remote.connection}`);
    for (const [sec, key] of [['api', 'communication'], ['parameters', 'params'], ['attach', 'attach'], ['detach', 'detach']]) {
      if (!same(await call('GET', `/sdk/apps/webhooks/${name}/${sec}`), hook.codeFiles[key])) mismatch(`webhook ${id} ${sec}`);
    }
  }

  const rpcs = new Set(((await call('GET', `${app}/rpcs`)).appRpcs || []).map((r) => r.name));
  for (const [id, rpc] of Object.entries(c.rpc)) {
    if (!rpcs.has(id)) { mismatch(`rpc ${id} missing`); continue; }
    if (!same(await call('GET', `${app}/rpcs/${id}/api`), rpc.codeFiles.communication)) mismatch(`rpc ${id} api`);
    if (!same(await call('GET', `${app}/rpcs/${id}/parameters`), rpc.codeFiles.params)) mismatch(`rpc ${id} parameters`);
  }

  const mods = Object.fromEntries(((await call('GET', `${app}/modules`)).appModules || []).map((m) => [m.name, m]));
  for (const [id, m] of Object.entries(c.module)) {
    const r = mods[id];
    if (!r) { mismatch(`module ${id} missing`); continue; }
    if (r.typeId !== TYPE[m.moduleType]) mismatch(`module ${id} type ${r.typeId}`);
    if (r.label !== m.label) mismatch(`module ${id} label`);
    if (r.connection !== connByLabel[c.connection[m.connection].label]) mismatch(`module ${id} connection ${r.connection}`);
    if (CRUD.has(m.actionCrud) && r.crud !== m.actionCrud) mismatch(`module ${id} crud ${r.crud}`);
    if (m.webhook) {
      // The module list leaves the webhook out, so read the module itself.
      const { webhook } = (await call('GET', `${app}/modules/${id}`)).appModule;
      if (webhook !== hookByLabel[c.webhook[m.webhook].label]) mismatch(`module ${id} webhook ${webhook}`);
    }
    for (const [sec, key] of [['api', 'communication'], ['parameters', 'staticParams'], ['expect', 'mappableParams'], ['interface', 'interface'], ['samples', 'samples']]) {
      if (!same(await call('GET', `${app}/modules/${id}/${sec}`), m.codeFiles[key])) mismatch(`module ${id} ${sec}`);
    }
  }
  const extra = Object.keys(mods).filter((n) => !c.module[n]);
  if (extra.length) mismatch(`modules in Make but not in src: ${extra.join(', ')}`);
  console.log(`Checked: ${Object.keys(mods).length} modules, ${conns.length} connections, ${hooks.length} webhooks, ${rpcs.size} RPCs in Make.`);
}

(CHECK ? check() : deploy())
  .then(() => {
    if (errors.length) { console.error(`\n${errors.length} problem(s).`); process.exit(1); }
    console.log('OK');
  })
  .catch((e) => { console.error(e.message); process.exit(1); });
