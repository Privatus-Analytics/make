'use strict';

// Runs the generated IML against sample parameters and responses and checks
// the requests it would make. Needs src/ (run `npm run generate` first).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const lib = require('../scripts/lib');
const events = require('../scripts/events.json');
const spec = require('../scripts/spec.json');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const mod = (name) => ({
  comm: read(`modules/${name}/${name}.communication.iml.json`),
  params: read(`modules/${name}/${name}.mappable-params.iml.json`),
  iface: read(`modules/${name}/${name}.interface.iml.json`),
});
const connection = { workspaceId: 'ws_5N8D2WLE4C', apiToken: 'pat_x' };

/** The request a module would send for these parameters. */
const request = (name, parameters, extra = {}) => {
  const { comm } = mod(name);
  const scope = { parameters, connection, ...extra };
  const req = { method: comm.method, url: lib.evalString(comm.url, scope) };
  if (comm.qs) req.qs = lib.evalDeep(comm.qs, scope);
  if (comm.body) req.body = lib.evalDeep(comm.body, scope);
  return req;
};
const fullUrl = (req) => {
  const q = lib.queryString(req.qs);
  return q ? `${req.url}?${q}` : req.url;
};

test('create goal sends only what is filled in, typed', () => {
  const req = request('createGoal', { site_id: 'pa_AAA', name: 'Signed up', kind: 'event', event_name: 'Signup', pattern: '', conditions: '[{"key":"plan","operator":"is","value":"pro"}]', scroll_threshold: 50, fixed_value: 49.5 });
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/sites/pa_AAA/goals.json');
  assert.deepEqual(req.body, { name: 'Signed up', kind: 'event', event_name: 'Signup', conditions: [{ key: 'plan', operator: 'is', value: 'pro' }], scroll_threshold: 50, fixed_value: 49.5 });
});

test('create site uses the connection workspace', () => {
  const req = request('createSite', { domain: 'example.com' });
  assert.equal(req.url, '/workspaces/ws_5N8D2WLE4C/sites.json');
  assert.deepEqual(req.body, { domain: 'example.com' });
});

test('dates are formatted for the API', () => {
  const cost = request('addCampaignCost', { site_id: 'pa_AAA', campaign: 'spring', month: '2026-10-17T09:00:00.000Z', amount: 120.5 });
  assert.deepEqual(cost.body, { campaign: 'spring', month: '2026-10', amount: 120.5 });
  const exp = request('createExport', { site_id: 'pa_AAA', from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z', filters: '[["country","is","US"]]' });
  assert.equal(exp.url, '/workspaces/ws_5N8D2WLE4C/exports.json');
  assert.equal(exp.body.from, '2026-09-01');
  assert.equal(exp.body.to, '2026-09-30');
  assert.deepEqual(exp.body.filters, [['country', 'is', 'US']]);
});

test('search lists go as Rails arrays (status[]=a&status[]=b) with page and per_page', () => {
  const req = request('searchTestimonials', { site_id: 'pa_AAA', status: ['approved', 'pending'], rating: ['4', '5'], q: 'great', limit: 250, tag_id: [] }, { pagination: { page: 1 } });
  assert.equal(req.url, '/sites/pa_AAA/testimonials.json');
  assert.equal(fullUrl(req), '/sites/pa_AAA/testimonials.json?q=great&status%5B%5D=approved&status%5B%5D=pending&rating%5B%5D=4&rating%5B%5D=5&per_page=100');
  assert.equal(decodeURIComponent(fullUrl(req)).includes('tag_id'), false);
});

test('a small limit asks for a small page', () => {
  const req = request('searchGoals', { site_id: 'pa_AAA', status: 'active', period: '30d', limit: 5, filters: '[["country","is","US"]]' });
  assert.equal(req.qs.per_page, 5);
  assert.equal(req.qs.filters, '[["country","is","US"]]');
  assert.equal(req.qs.period, '30d');
});

test('pagination keeps going while pages remain, and stops after the last', () => {
  const { comm } = mod('searchSites');
  const cond = (page, total) => lib.evalString(comm.pagination.condition, { body: { meta: { page: page - 1, total_pages: total } }, pagination: { page } });
  assert.equal(cond(2, 3), true);
  assert.equal(cond(3, 3), true);
  assert.equal(cond(4, 3), false);
  assert.equal(lib.evalString(comm.pagination.qs.page, { pagination: { page: 2 } }), 2);
  assert.equal(comm.response.limit, '{{parameters.limit}}');
});

test('top values pages with has_more and builds the property path', () => {
  const plain = request('searchTopValues', { site_id: 'pa_AAA', dimension: 'country', period: '7d', limit: 10 });
  assert.equal(plain.url, '/sites/pa_AAA/breakdown/country.json');
  const prop = request('searchTopValues', { site_id: 'pa_AAA', dimension: 'page', custom_property: 'plan', period: '7d', limit: 10 });
  assert.equal(prop.url, '/sites/pa_AAA/breakdown/prop:plan.json');
  const { comm } = mod('searchTopValues');
  assert.equal(lib.evalString(comm.pagination.condition, { body: { data: { has_more: true } } }), true);
  assert.equal(request('searchTopValues', { site_id: 'pa_AAA', dimension: 'page', period: '7d', limit: 500 }).qs.limit, 100);
});

test('ask for a testimonial builds one recipient', () => {
  const req = request('askForTestimonial', { site_id: 'pa_AAA', request_id: 'req_1', email: 'a@example.com', name: 'Ada', company: '', properties: '{"plan":"pro"}' });
  assert.equal(req.url, '/sites/pa_AAA/testimonials/requests/req_1/recipients.json');
  assert.deepEqual(req.body, { recipients: [{ email: 'a@example.com', name: 'Ada', properties: { plan: 'pro' } }] });
});

test('create testimonial is always a text testimonial', () => {
  const req = request('createTestimonial', { site_id: 'pa_AAA', body: 'Great', person_name: 'Ada', tags: ['vip'], collection_ids: [], rating: 5 });
  assert.equal(req.body.kind, 'text');
  assert.deepEqual(req.body.tags, ['vip']);
  assert.equal('collection_ids' in req.body, false);
});

test('moderation modules hit the right endpoints', () => {
  assert.equal(request('approveTestimonial', { site_id: 'pa_A', id: 'tm_1' }).url, '/sites/pa_A/testimonials/tm_1/approve.json');
  assert.equal(request('pinTestimonial', { site_id: 'pa_A', id: 'tm_1', pinned: false }).body.pinned, false);
  assert.equal(request('muteAlert', { id: 'alr_1', minutes: 60 }).body.minutes, 60);
});

test('make an API call stays on the Privatus Analytics host and cannot delete', () => {
  const { comm, params } = mod('makeApiCall');
  const url = (u) => lib.evalString(comm.url, { parameters: { url: u } });
  // Always a relative path, so the base puts the Privatus Analytics host in front.
  assert.equal(url('/sites.json'), '/sites.json');
  assert.equal(url('sites.json'), '/sites.json');
  assert.equal(url('https://evil.example/x'), '/https://evil.example/x');
  assert.deepEqual(params.find((p) => p.name === 'method').options.map((o) => o.value), ['GET', 'POST', 'PATCH', 'PUT']);
  assert.equal(new RegExp(params.find((p) => p.name === 'url').validate.pattern).test('//evil.example'), false);
  assert.deepEqual(lib.evalString(comm.qs, { parameters: { qs: [{ key: 'period', value: '30d' }] } }), { period: '30d' });
});

test('the connection test accepts a workspace and rejects errors', () => {
  const comm = read('connections/privatusAnalytics/privatusAnalytics.communication.iml.json');
  const ok = { statusCode: 200, body: { data: [{ id: 'ws_5N8D2WLE4C', name: 'Acme' }] } };
  assert.equal(lib.evalString(comm.response.valid, ok), true);
  assert.equal(lib.evalString(comm.response.data.workspaceId, ok), 'ws_5N8D2WLE4C');
  assert.equal(lib.evalString(comm.response.metadata.value, ok), 'Acme');
  assert.equal(lib.evalString(comm.response.valid, { statusCode: 401, body: { error: { message: 'Invalid token' } } }), false);
  assert.equal(lib.evalString(comm.response.valid, { statusCode: 200, body: { data: [] } }), false);
});

test('every event has a webhook that registers it and deletes it again', () => {
  assert.equal(events.length, 25);
  events.forEach((e) => {
    const name = `${e.key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}Hook`;
    const attach = read(`webhooks/${name}/${name}.attach.iml.json`);
    const detach = read(`webhooks/${name}/${name}.detach.iml.json`);
    const req = lib.evalDeep({ url: attach.url, body: attach.body }, { connection, webhook: { url: 'https://hook.eu1.make.com/abc' } });
    assert.equal(req.url, '/workspaces/ws_5N8D2WLE4C/webhooks.json');
    assert.deepEqual(req.body, { url: 'https://hook.eu1.make.com/abc', events: [e.event], enabled: true });
    const stored = lib.evalDeep(attach.response.data, { connection, body: { data: { id: 'whk_1', secret: 's' } } });
    assert.deepEqual(stored, { webhookId: 'whk_1', workspaceId: 'ws_5N8D2WLE4C' });
    assert.equal(lib.evalString(detach.url, { webhook: stored }), '/workspaces/ws_5N8D2WLE4C/webhooks/whk_1.json');
    assert.equal(detach.method, 'DELETE');
    assert.equal(spec.webhooks_create.inputs.some((i) => i.name === 'events'), true);
  });
});

test('a webhook runs only for its event and its site filter', () => {
  events.forEach((e) => {
    const name = `${e.key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())}Hook`;
    const comm = read(`webhooks/${name}/${name}.communication.iml.json`);
    const body = { id: 'whd_1', event: e.event, created_at: '2026-10-20T10:00:00Z', workspace_id: 'ws_5N8D2WLE4C', data: e.sample };
    assert.equal(lib.evalString(comm.condition, { body, parameters: {} }), true, `${e.event} runs without a filter`);
    assert.equal(lib.evalString(comm.condition, { body: { ...body, event: 'other.event' }, parameters: {} }), false);
    const out = lib.evalDeep(comm.output, { body });
    assert.equal(out.event, e.event);
    assert.deepEqual(out.data, e.sample);
    if (e.siteFilter) {
      const siteId = e.sample.site_id || e.sample.check.site_id;
      assert.equal(lib.evalString(comm.condition, { body, parameters: { siteId } }), true, `${e.event} matches its site`);
      assert.equal(lib.evalString(comm.condition, { body, parameters: { siteId: 'pa_OTHER' } }), false, `${e.event} skips other sites`);
    }
  });
});

test('field help texts are the API docs', () => {
  const goal = mod('createGoal').params.find((p) => p.name === 'kind');
  assert.equal(goal.help, spec.goals_create.inputs.find((i) => i.name === 'kind').description.replace(/\s+/g, ' ').trim());
  assert.deepEqual(goal.options.map((o) => o.value), spec.goals_create.inputs.find((i) => i.name === 'kind').enum);
  assert.equal(goal.required, true);
});

test('interfaces come from the documented outputs', () => {
  const { iface } = mod('createGoal');
  assert.deepEqual(iface.map((f) => f.name), spec.goals_create.outputs.map((o) => o.name));
  assert.equal(iface.find((f) => f.name === 'archived_at').type, 'date');
});

test('no module sends events or deletes', () => {
  const manifest = read('makecomapp.json');
  Object.keys(manifest.components.module).forEach((name) => {
    const { comm } = mod(name);
    assert.notEqual(comm.method, 'DELETE', name);
    assert.equal(/events\.json|\/api\/event|ingest/i.test(comm.url || ''), false, name);
  });
});
