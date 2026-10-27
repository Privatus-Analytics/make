#!/usr/bin/env node
'use strict';

// Builds and runs the review scenarios (SUBMISSION.md step 12) through Make's API.
//
//   node scripts/scenarios.js                                   create or update every scenario (inactive)
//   node scripts/scenarios.js --token-file .secrets/test-token  also make the connection, find the ids it
//                                                               needs in the test workspace and the webhooks
//   node scripts/scenarios.js --token-file ... --prep           also create the test alert and status page
//   node scripts/scenarios.js --run C                           switch one scenario on, run it, switch it off
//   node scripts/scenarios.js --run A05 [--wait 600]            switch a trigger scenario on and wait for a delivery
//   node scripts/scenarios.js --logs C                          print the last run of a scenario
//
// Make token: .secrets/apikey-scenarios (scopes scenarios:read, scenarios:write, scenarios:run,
// connections:read, connections:write, and hooks:read, hooks:write for the instant triggers).
// The Privatus Analytics token must belong to a test workspace with demo data. The script refuses
// the workspaces in REFUSED_WORKSPACES. No token is ever printed.
//
// Every scenario stays inactive with on-demand scheduling, so the Free plan limit of 2 active
// scenarios is never reached. A scenario is matched by its name and updated in place.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'makecomapp.json'), 'utf8'));
const origin = manifest.origins[0];
const MAKE = `${process.env.MAKE_BASE_URL || origin.baseUrl}/v2`;
const APP = process.env.MAKE_APP || origin.appId;
const PKG = `app#${APP}`;
const ORG = Number(process.env.MAKE_ORG || 5282296);
const PA = 'https://privatusanalytics.com';
const PREFIX = 'Privatus Analytics review';
// James's own production workspace. Its data must never reach Make logs.
const REFUSED_WORKSPACES = ['ws_FB6X4OKLJS'];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] || true) : undefined; };
const readSecret = (rel) => fs.readFileSync(path.resolve(ROOT, rel), 'utf8').trim();
const MAKE_TOKEN = readSecret('.secrets/apikey-scenarios');
const SDK_TOKEN = readSecret('.secrets/apikey');

async function http(base, auth, method, url, body, tries = 0) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { Authorization: auth, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (res.status === 429 && tries < 5) {
    // The Free plan allows 60 Make API requests a minute.
    await new Promise((r) => setTimeout(r, 20000));
    return http(base, auth, method, url, body, tries + 1);
  }
  if (!res.ok) {
    const err = new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data).slice(0, 500)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
const make = (m, u, b) => http(MAKE, `Token ${MAKE_TOKEN}`, m, u, b);
const sdk = (m, u, b) => http(MAKE, `Token ${SDK_TOKEN}`, m, u, b);
let PA_TOKEN;
const pa = (m, u, b) => http(PA, `Bearer ${PA_TOKEN}`, m, u, b);

const day = (offset = 0) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// ---------- Context: the Privatus Analytics test workspace ----------

async function context() {
  const ctx = { siteId: '', workspaceId: '', alertId: '', statusPageId: '', requestSiteId: '', requestId: '', connectionId: null };
  if (!opt('token-file')) return ctx;
  PA_TOKEN = readSecret(opt('token-file'));
  const ws = (await pa('GET', '/workspaces.json')).data[0];
  if (!ws || REFUSED_WORKSPACES.includes(ws.id)) throw new Error('This token belongs to a refused workspace (real data). Use a test workspace token.');
  ctx.workspaceId = ws.id;
  const sites = (await pa('GET', `/workspaces/${ws.id}/sites.json?per_page=100`)).data;
  const site = sites.find((s) => s.id === opt('site')) || sites.find((s) => s.last_event_at) || sites[0];
  if (!site) throw new Error('The test workspace has no site.');
  ctx.siteId = site.id;
  console.log(`Test workspace ${ws.id}, site ${site.id} (${sites.length} sites)`);

  const alerts = (await pa('GET', `/workspaces/${ws.id}/alerts.json?per_page=100`)).data;
  let alert = alerts.find((a) => a.name === 'Make review test alert');
  if (!alert && opt('prep')) {
    // Visitors of 0 or more in a day is always true, so it fires at the next check (every 5 minutes).
    alert = (await pa('POST', `/workspaces/${ws.id}/alerts.json`, {
      name: 'Make review test alert', kind: 'threshold', site_id: site.id, metric: 'visitors', operator: 'gte', threshold: 0, window_minutes: 1440,
    })).data;
    console.log(`Created alert ${alert.id}`);
  }
  ctx.alertId = alert ? alert.id : '';

  const pages = (await pa('GET', `/workspaces/${ws.id}/status_pages.json`)).data;
  let page = pages.find((p) => p.name === 'Make Review Test Status Page');
  if (!page && opt('prep')) {
    page = (await pa('POST', `/workspaces/${ws.id}/status_pages.json`, {
      name: 'Make Review Test Status Page', slug: `make-review-test-${Date.now().toString(36)}`, published: false,
    })).data;
    console.log(`Created status page ${page.id}`);
  }
  ctx.statusPageId = page ? page.id : '';

  for (const s of sites) {
    const reqs = (await pa('GET', `/sites/${s.id}/testimonials/requests.json?per_page=5`).catch(() => ({ data: [] }))).data;
    if (reqs.length) { ctx.requestSiteId = s.id; ctx.requestId = reqs[0].id; break; }
  }

  const conns = (await make('GET', `/connections?teamId=${await teamId()}`)).connections;
  let conn = conns.find((c) => [APP, PKG].includes(c.accountName) && c.metadata && c.metadata.value === ws.name);
  if (!conn) {
    conn = (await make('POST', `/connections?teamId=${await teamId()}`, { accountName: `${APP}`, accountType: PKG, apiToken: PA_TOKEN })).connection;
    console.log(`Created connection ${conn.id}`);
  }
  ctx.connectionId = conn.id;
  for (const k of ['alertId', 'statusPageId', 'requestId']) if (!ctx[k]) console.log(`  missing ${k}: the modules that need it stay empty (run with --prep, or add a testimonial request)`);
  return ctx;
}

let TEAM;
async function teamId() {
  if (!TEAM) TEAM = (await make('GET', `/teams?organizationId=${ORG}`)).teams[0].id;
  return TEAM;
}

// ---------- Blueprints ----------

let nextX = 0;
const mod = (id, name, mapper, parameters = {}) => ({ id, module: name.includes(':') ? name : `${PKG}:${name}`, version: 1, parameters, mapper, metadata: { designer: { x: (nextX += 300), y: 0 } } });
const conn = (ctx) => (ctx.connectionId ? { __IMTCONN__: ctx.connectionId } : {});
const blueprint = (name, flow) => ({
  name,
  flow,
  metadata: {
    version: 1,
    scenario: { roundtrips: 1, maxErrors: 3, autoCommit: true, autoCommitTriggerLast: true, sequential: false, confidential: false, dataloss: false, dlq: false, freshVariables: false },
    designer: { orphans: [] },
  },
});

function triggerScenarios(ctx, hooks) {
  const modules = Object.entries(manifest.components.module).filter(([, m]) => m.moduleType === 'instant_trigger');
  return modules.map(([id, m], i) => {
    nextX = 0;
    const key = `A${String(i + 1).padStart(2, '0')}`;
    const hook = hooks[m.webhook];
    return {
      key,
      name: `${PREFIX} ${key}: ${m.label}`,
      webhook: m.webhook,
      blueprint: blueprint(`${PREFIX} ${key}: ${m.label}`, [
        mod(1, id, {}, hook ? { __IMTHOOK__: hook } : {}),
        mod(2, 'util:SetVariable2', { name: 'event', scope: 'roundtrip', value: '{{1.event}}' }),
      ]),
    };
  });
}

function searchScenario(ctx) {
  nextX = 0;
  const c = conn(ctx);
  const s = ctx.siteId;
  const searches = [
    ['searchSites', {}],
    ['searchGoals', { site_id: s, status: 'all', period: '12mo' }],
    ['searchChartNotes', { site_id: s }],
    ['searchAlertRules', {}],
    ['searchAlertIncidents', { id: ctx.alertId, open: false }],
    ['searchUptimeChecks', { site_id: s }],
    ['searchExperiments', { site_id: s, status: 'all' }],
    ['searchSiteAudits', { site_id: s }],
    ['searchExports', {}],
    ['searchMembers', {}],
    ['searchTestimonials', { site_id: s, sort: 'received_desc' }],
    ['searchTestimonialPeople', { site_id: s, sort: 'name' }],
    ['searchTestimonialForms', { site_id: s, sort: 'name' }],
    ['searchTestimonialRequests', { site_id: s }],
    ['searchTopValues', { site_id: s, dimension: 'page', period: '12mo', compare: 'none' }],
    ['searchDailyStats', { site_id: s, period: '12mo', compare: 'none', interval: 'day' }],
  ];
  const start = mod(1, 'util:SetVariable2', { name: 'started', scope: 'roundtrip', value: '{{now}}' });
  const router = { id: 2, module: 'builtin:BasicRouter', version: 1, mapper: null, metadata: { designer: { x: 600, y: 0 } }, routes: [] };
  searches.forEach(([name, mapper], i) => {
    const m = mod(3 + i, name, { ...mapper, limit: 150 }, c);
    m.metadata.designer = { x: 900, y: i * 150 };
    router.routes.push({ flow: [m] });
  });
  return { key: 'B', name: `${PREFIX} B: every search, Limit 150`, blueprint: blueprint(`${PREFIX} B: every search, Limit 150`, [start, router]) };
}

function actionScenario(ctx) {
  nextX = 0;
  const c = conn(ctx);
  const stamp = Date.now().toString(36);
  const flow = [
    mod(1, 'createSite', { domain: `make-review-${stamp}.example.com`, name: 'Make Review Test Site', timezone: 'UTC', currency: 'USD' }, c),
    mod(2, 'getSite', { id: '{{1.id}}' }, c),
    mod(3, 'createGoal', { site_id: '{{1.id}}', name: 'Test Signup', kind: 'page', match_type: 'exact', pattern: '/signup', value_mode: 'none', count_mode: 'once_per_visit' }, c),
    mod(4, 'createChartNote', { site_id: '{{1.id}}', date: day(), title: 'Test note from Make', color: 'blue', source: 'manual' }, c),
    mod(5, 'createWorkspaceChartNote', { date: day(), title: 'Workspace test note from Make', color: 'neutral', source: 'manual' }, c),
    mod(6, 'createCampaignLink', { site_id: '{{1.id}}', name: 'Test Campaign Link', destination: `https://make-review-${stamp}.example.com/pricing`, utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'make_review' }, c),
    mod(7, 'addCampaignCost', { site_id: '{{1.id}}', campaign: 'make_review', month: `${day().slice(0, 7)}-01`, amount: 12.5, currency: 'USD' }, c),
    mod(8, 'createUptimeCheck', { site_id: '{{1.id}}', name: 'Test Uptime Check', kind: 'http', url: 'https://example.com', expected_status: 200, http_method: 'GET', interval_seconds: 300, timeout_seconds: 20, public: false }, c),
    mod(9, 'pauseUptimeCheck', { site_id: '{{1.id}}', id: '{{8.id}}' }, c),
    mod(10, 'resumeUptimeCheck', { site_id: '{{1.id}}', id: '{{8.id}}' }, c),
    mod(11, 'createTestimonial', { site_id: '{{1.id}}', body: 'Setup took five minutes and the numbers are easy to read.', person_name: 'Test Person', person_email: 'test.person@example.com', person_company: 'Example Co', rating: 5, title: 'Easy to set up', status: 'pending', pinned: false, allow_duplicate: false }, c),
    mod(12, 'getTestimonial', { site_id: '{{1.id}}', id: '{{11.id}}' }, c),
    mod(13, 'updateTestimonial', { site_id: '{{1.id}}', id: '{{11.id}}', highlight: 'five minutes', edit_note: 'Tidied up by a Make test' }, c),
    mod(14, 'approveTestimonial', { site_id: '{{1.id}}', id: '{{11.id}}' }, c),
    mod(15, 'pinTestimonial', { site_id: '{{1.id}}', id: '{{11.id}}', pinned: true }, c),
    mod(16, 'pendTestimonial', { site_id: '{{1.id}}', id: '{{11.id}}' }, c),
    mod(17, 'rejectTestimonial', { site_id: '{{1.id}}', id: '{{11.id}}' }, c),
    mod(18, 'createTestimonialPerson', { site_id: '{{1.id}}', name: 'Test Person Two', email: 'test.person2@example.com', company: 'Example Co', title: 'Owner' }, c),
    mod(19, 'askForTestimonial', { site_id: ctx.requestSiteId, request_id: ctx.requestId, email: 'test.person@example.com', name: 'Test Person' }, c),
    mod(20, 'postStatusPageUpdate', { status_page_id: ctx.statusPageId, title: 'Test update from Make', body: 'This is a test post. Everything works.', status: 'resolved', notify: false }, c),
    mod(21, 'inviteMember', { emails: ['test.member@example.com'], role: 'viewer', all_sites: true }, c),
    mod(22, 'runSiteAudit', { site_id: '{{1.id}}' }, c),
    // No module creates an experiment, so the universal module makes a draft for the next three.
    mod(23, 'makeApiCall', {
      url: '/sites/{{1.id}}/experiments.json',
      method: 'POST',
      body: { name: 'Test Experiment', path: '/pricing', goal_id: '{{3.id}}', variants: [{ name: 'Original' }, { name: 'Variant B', path: '/pricing-b' }] },
    }, c),
    mod(24, 'startExperiment', { site_id: '{{1.id}}', id: '{{23.body.data.id}}' }, c),
    mod(25, 'pauseExperiment', { site_id: '{{1.id}}', id: '{{23.body.data.id}}' }, c),
    mod(26, 'endExperiment', { site_id: '{{1.id}}', id: '{{23.body.data.id}}' }, c),
    mod(27, 'createExport', { site_id: ctx.siteId, kind: 'aggregated', file_format: 'csv', from: day(-30), to: day(-1), grouping: 'day' }, c),
    mod(28, 'getLiveVisitors', { site_id: ctx.siteId }, c),
    mod(29, 'getSiteStats', { site_id: ctx.siteId, period: '30d', compare: 'none' }, c),
    // Last, because acknowledging needs an incident that is not yet acknowledged.
    mod(30, 'muteAlert', { id: ctx.alertId, minutes: 60 }, c),
    mod(31, 'acknowledgeAlert', { id: ctx.alertId }, c),
  ];
  return { key: 'C', name: `${PREFIX} C: every action`, blueprint: blueprint(`${PREFIX} C: every action`, flow) };
}

function errorScenario(ctx) {
  nextX = 0;
  // A single space passes Make's required check, and the API refuses it as blank with a 422.
  return { key: 'D', name: `${PREFIX} D: error from the API (422)`, blueprint: blueprint(`${PREFIX} D: error from the API (422)`, [
    mod(1, 'createGoal', { site_id: ctx.siteId, name: ' ', kind: 'page', match_type: 'exact', pattern: '/signup' }, conn(ctx)),
  ]) };
}

function universalScenario(ctx) {
  nextX = 0;
  const url = ctx.workspaceId ? `/workspaces/${ctx.workspaceId}/sites.json` : '/workspaces.json';
  return { key: 'E', name: `${PREFIX} E: Make an API Call`, blueprint: blueprint(`${PREFIX} E: Make an API Call`, [
    mod(1, 'makeApiCall', { url, method: 'GET' }, conn(ctx)),
  ]) };
}

// ---------- Webhooks (instant triggers) ----------

async function hooks(ctx) {
  const out = {};
  if (!ctx.connectionId) return out;
  const team = await teamId();
  let existing;
  try { existing = (await make('GET', `/hooks?teamId=${team}`)).hooks || []; } catch (e) {
    console.log(`  Webhooks skipped (${e.status === 401 ? 'the Make token needs hooks:read and hooks:write' : e.message}). Add each one in the editor instead.`);
    return out;
  }
  const appHooks = (await sdk('GET', `/sdk/apps/${APP}/webhooks`)).appWebhooks || [];
  for (const [id, h] of Object.entries(manifest.components.webhook)) {
    const remote = appHooks.find((r) => r.label === h.label);
    if (!remote) continue;
    const name = `${PREFIX}: ${h.label}`;
    let hook = existing.find((x) => x.name === name);
    if (!hook) {
      hook = (await make('POST', '/hooks', { name, teamId: team, typeName: `${PKG}:${remote.name}`, __IMTCONN__: ctx.connectionId, siteId: '' }).catch((e) => {
        console.log(`  hook ${id}: ${e.message}`);
        return {};
      })).hook;
    }
    if (hook) out[id] = hook.id;
  }
  return out;
}

// ---------- Create, run, read ----------

async function upsert(team, s, existing) {
  const body = { blueprint: JSON.stringify(s.blueprint), scheduling: JSON.stringify({ type: 'on-demand' }) };
  const found = existing.find((x) => x.name === s.name);
  const r = found
    ? await make('PATCH', `/scenarios/${found.id}?confirmed=true`, body)
    : await make('POST', '/scenarios?confirmed=true', { teamId: team, ...body });
  return r.scenario;
}

async function listScenarios(team) {
  return (await make('GET', `/scenarios?teamId=${team}&pg[limit]=500`)).scenarios.filter((s) => s.name.startsWith(PREFIX));
}

async function findScenario(key) {
  const all = await listScenarios(await teamId());
  const s = all.find((x) => x.name.startsWith(`${PREFIX} ${key}:`));
  if (!s) throw new Error(`No scenario ${key}. Create them first.`);
  return s;
}

async function executions(s) {
  const logs = (await make('GET', `/scenarios/${s.id}/logs?pg[limit]=20&pg[sortDir]=desc`)).scenarioLogs || [];
  return logs.filter((l) => l.status !== undefined && l.type !== 'modify');
}

async function printLog(s, executionId) {
  const runs = await executions(s);
  const log = runs.find((l) => l.id === executionId || l.imtId === executionId) || runs[0];
  if (!log) { console.log('No run yet.'); return; }
  const status = { 1: 'success', 2: 'warning', 3: 'error' }[log.status] || log.status;
  console.log(`${s.name}: ${status}, ${log.operations ?? '?'} operations, execution ${log.imtId || log.id}`);
  if (log.error) console.log(`  ${JSON.stringify(log.error).slice(0, 800)}`);
}

// Make only runs an active scenario. The Free plan allows 2 active ones, so each run
// switches its scenario on, runs it (or waits for a webhook) and switches it off again.
async function run(key) {
  const s = await findScenario(key);
  const instant = key.startsWith('A');
  const before = new Set((await executions(s)).map((l) => l.imtId || l.id));
  await make('POST', `/scenarios/${s.id}/start`);
  try {
    if (!instant) {
      const r = await make('POST', `/scenarios/${s.id}/run`, { responsive: true });
      console.log(`Run ${r.executionId}: ${r.status}`);
      await printLog(s, r.executionId);
      return;
    }
    const wait = Number(opt('wait') || 600) * 1000;
    console.log(`Active. Cause the event now, waiting up to ${wait / 1000} s for a delivery...`);
    for (const end = Date.now() + wait; Date.now() < end;) {
      await new Promise((r) => setTimeout(r, 10000));
      const fresh = (await executions(s)).find((l) => !before.has(l.imtId || l.id));
      if (fresh) { await printLog(s, fresh.imtId || fresh.id); return; }
    }
    console.log('No delivery arrived.');
  } finally {
    await make('POST', `/scenarios/${s.id}/stop`).catch((e) => console.error(`Could not switch it off: ${e.message}`));
  }
}

async function main() {
  if (opt('run') || opt('logs')) {
    if (opt('run')) await run(opt('run'));
    else await printLog(await findScenario(opt('logs')));
    return;
  }
  const team = await teamId();
  const ctx = await context();
  const hookIds = await hooks(ctx);
  const all = [...triggerScenarios(ctx, hookIds), searchScenario(ctx), actionScenario(ctx), errorScenario(ctx), universalScenario(ctx)];
  const existing = await listScenarios(team);
  const zone = MAKE.replace(/\/api\/v2$/, '');
  for (const s of all) {
    const r = await upsert(team, s, existing);
    console.log(`${s.key.padEnd(4)} ${r.id}  ${zone}/${team}/scenarios/${r.id}/edit  ${s.name}`);
  }
  if (!ctx.connectionId) console.log('\nNo --token-file: the scenarios have no connection and no ids yet. Run again with a test workspace token.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
