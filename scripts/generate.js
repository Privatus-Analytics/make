#!/usr/bin/env node
'use strict';

// Builds the Make app (src/) from scripts/spec.json and the catalog.
//
//   node scripts/generate.js [--spec path/to/spec.json]
//
// scripts/spec.json is a copy of ../zapier/lib/spec.json (the API's own
// OpenAPI trimmed to the operations the integrations use). Refresh it with
//   cp ../zapier/lib/spec.json scripts/spec.json
// and run this script again. src/ and dist/ are rewritten from scratch.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const catalog = require('./catalog');
const events = require('./events.json');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const APP = 'privatus-analytics';
const CONNECTION = 'privatusAnalytics';
const BASE_URL = 'https://privatusanalytics.com';

const specArg = process.argv.indexOf('--spec');
const spec = lib.loadSpec(specArg > 0 ? path.resolve(process.argv[specArg + 1]) : lib.SPEC_FILE);

const TYPE = { action: 4, search: 9, trigger: 1, instant_trigger: 10, universal: 12 };

// ---------- Files ----------

const written = [];
const write = (rel, content) => {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
  fs.writeFileSync(file, text);
  written.push(rel);
};

// ---------- General ----------

const base = {
  baseUrl: BASE_URL,
  headers: {
    Authorization: 'Bearer {{connection.apiToken}}',
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
  log: { sanitize: ['request.headers.authorization'] },
  response: {
    error: {
      400: { type: 'DataError', message: '[{{statusCode}}] {{body.error.message}} {{body.error.details}}' },
      401: { type: 'InvalidAccessTokenError', message: '[{{statusCode}}] {{body.error.message}}' },
      402: { type: 'RuntimeError', message: '[{{statusCode}}] {{body.error.message}} This needs a higher Privatus Analytics plan.' },
      403: { type: 'RuntimeError', message: '[{{statusCode}}] {{body.error.message}}' },
      404: { type: 'DataError', message: '[{{statusCode}}] {{body.error.message}}' },
      409: { type: 'DataError', message: '[{{statusCode}}] {{body.error.message}}' },
      422: { type: 'DataError', message: '[{{statusCode}}] {{body.error.message}} {{body.error.details}}' },
      429: { type: 'RateLimitError', message: '[{{statusCode}}] {{body.error.message}}' },
      500: { type: 'ConnectionError', message: '[{{statusCode}}] {{body.error.message}}' },
      502: { type: 'ConnectionError', message: '[{{statusCode}}] The Privatus Analytics API is not reachable right now.' },
      503: { type: 'ConnectionError', message: '[{{statusCode}}] The Privatus Analytics API is not reachable right now.' },
    },
  },
};

const connection = {
  type: 'basic',
  label: 'Privatus Analytics API token',
  params: [
    {
      name: 'apiToken',
      type: 'password',
      label: 'API token',
      required: true,
      editable: true,
      help: 'An API token that starts with pat_. Create one in Privatus Analytics under Account, API tokens. A token belongs to one workspace. Give it every site and the permissions the modules you use need (webhook modules need workspace settings).',
    },
  ],
  communication: {
    url: `${BASE_URL}/workspaces.json`,
    method: 'GET',
    headers: { Authorization: 'Bearer {{parameters.apiToken}}', Accept: 'application/json' },
    log: { sanitize: ['request.headers.authorization'] },
    response: {
      valid: '{{statusCode === 200 && length(body.data) > 0}}',
      data: { workspaceId: '{{body.data[1].id}}' },
      metadata: { type: 'text', value: '{{body.data[1].name}}' },
      error: {
        message: '[{{statusCode}}] {{ifempty(body.error.message, "This API token cannot see a workspace.")}}',
        type: 'InvalidAccessTokenError',
      },
    },
  },
};

// ---------- RPCs ----------

const buildRpc = (def) => {
  const op = spec[def.op];
  const qs = { per_page: 100 };
  Object.entries(def.params || {}).forEach(([k, v]) => {
    qs[k] = v;
  });
  const req = lib.requestFor(op, []);
  req.qs = { ...(req.qs || {}), ...qs };
  if (def.needs) req.url = req.url.replace(`{{parameters.${def.needs}}}`, `{{parameters.${def.needs}}}`);
  // An optional site filter (alerts) is passed when the module has one.
  if (!def.needs && op.inputs.some((i) => i.name === 'site_id' && i.in !== 'path')) {
    req.qs.site_id = '{{ifempty(parameters.site_id, undefined)}}';
  }
  req.pagination = lib.pagination();
  req.response = {
    iterate: '{{body.data}}',
    limit: 300,
    output: { label: def.text, value: '{{item.id}}' },
  };
  return { label: def.label, communication: req, params: [] };
};

// ---------- Modules ----------

const modules = [];

const moduleFiles = (m) => {
  const dir = `src/modules/${m.name}`;
  write(`${dir}/${m.name}.communication.iml.json`, m.communication || {});
  write(`${dir}/${m.name}.static-params.iml.json`, m.staticParams || []);
  write(`${dir}/${m.name}.mappable-params.iml.json`, lib.clean(m.mappable || []));
  write(`${dir}/${m.name}.interface.iml.json`, m.interface || []);
  write(`${dir}/${m.name}.samples.iml.json`, m.samples || {});
  modules.push(m);
};

const buildAction = (def) => {
  const op = spec[def.op];
  const req = lib.requestFor(op, def.fields, { fixed: def.fixed, bodyOverride: def.body });
  req.response = { output: def.output || '{{body.data}}' };
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    moduleType: 'action',
    typeId: TYPE.action,
    actionCrud: def.crud,
    group: def.group,
    communication: req,
    mappable: def.fields,
    interface: def.interface || def.outputInterface || lib.interfaceFor(op),
  };
};

const buildSearch = (def) => {
  const op = spec[def.op];
  const params = [...def.fields, lib.LIMIT()];
  const req = lib.requestFor(op, params);
  req.qs = { ...(req.qs || {}), per_page: '{{min(parameters.limit, 100)}}' };
  req.pagination = lib.pagination();
  req.response = { iterate: '{{body.data}}', output: '{{item}}', limit: '{{parameters.limit}}' };
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    moduleType: 'search',
    typeId: TYPE.search,
    actionCrud: 'search',
    communication: req,
    mappable: params,
    interface: lib.interfaceFor(op),
  };
};

const DIMENSIONS = [
  'page', 'entry_page', 'exit_page', 'channel', 'referrer', 'referrer_url', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'ref', 'hostname', 'country', 'language', 'device', 'browser', 'browser_version', 'os', 'os_version', 'screen', 'event', 'goal',
];

const METRIC_FIELDS = [
  ['value', 'Value', 'text'], ['share', 'Share (%)', 'number'], ['visitors', 'Visitors', 'number'], ['visits', 'Visits', 'number'],
  ['pageviews', 'Pageviews', 'number'], ['views_per_visit', 'Views per Visit', 'number'], ['bounce_rate', 'Bounce Rate (%)', 'number'],
  ['visit_duration', 'Visit Duration (Milliseconds)', 'number'], ['revenue', 'Revenue (Minor Units)', 'number'],
  ['time_on_page', 'Time on Page (Milliseconds)', 'number'], ['scroll_depth', 'Scroll Depth (%)', 'number'],
  ['completions', 'Completions', 'number'], ['conversions', 'Conversions', 'number'], ['conversion_rate', 'Conversion Rate (%)', 'number'],
];

const buildTopValues = () => {
  const op = spec.stats_breakdown;
  const dimension = {
    name: 'dimension', type: 'select', label: 'Report', required: true, default: 'page',
    help: 'What to rank: pages, sources, countries and more. For a custom event property, leave this and fill in Custom Property.',
    options: DIMENSIONS.map((value) => ({ label: lib.label(value), value })),
  };
  const custom = lib.plain('custom_property', 'text', 'Optional. A custom event property key, like plan. When filled in, the report ranks the values of that property and Report is ignored.', { label: 'Custom Property' });
  const fields = [
    catalog.SITE(), dimension, custom,
    ...catalog.periodFields(spec, 'stats_breakdown'),
    ...catalog.fieldsFor(spec, 'stats_breakdown', { only: ['sort', 'search'] }),
    lib.LIMIT(),
  ];
  const req = {
    url: `/sites/{{parameters.site_id}}/breakdown/{{encodeURL(ifempty(parameters.custom_property, parameters.dimension))}}.json`,
    method: 'GET',
  };
  // The path takes the property as prop:<key>.
  req.url = `/sites/{{parameters.site_id}}/breakdown/{{if(parameters.custom_property, 'prop:' + parameters.custom_property, parameters.dimension)}}.json`;
  const exposed = fields.filter((f) => !['site_id', 'dimension', 'custom_property', 'limit'].includes(f.name));
  req.qs = lib.requestFor({ ...op, inputs: op.inputs.filter((i) => i.in !== 'path') }, exposed).qs;
  req.qs.limit = '{{min(parameters.limit, 100)}}';
  req.pagination = { qs: { page: '{{pagination.page}}' }, condition: '{{body.data.has_more}}' };
  req.response = {
    iterate: '{{body.data.rows}}',
    limit: '{{parameters.limit}}',
    output: Object.fromEntries([
      ['dimension', '{{body.data.dimension}}'],
      ['period_from', '{{body.data.period.from}}'],
      ['period_to', '{{body.data.period.to}}'],
      ...METRIC_FIELDS.map(([name]) => [name, `{{item.${name}}}`]),
    ]),
  };
  return {
    name: 'searchTopValues',
    label: 'Search Top Values',
    description: 'Ranks the top values of one report (pages, referrers, campaigns, countries, devices, events, goals and more) for a period, one row per bundle.',
    moduleType: 'search', typeId: TYPE.search, actionCrud: 'search',
    communication: req, mappable: fields,
    interface: [
      { name: 'dimension', label: 'Report', type: 'text' },
      { name: 'period_from', label: 'Period From', type: 'date' },
      { name: 'period_to', label: 'Period To', type: 'date' },
      ...METRIC_FIELDS.map(([name, labelText, type]) => ({ name, label: labelText, type })),
    ],
  };
};

const buildDailyStats = () => {
  const fields = [catalog.SITE(), ...catalog.periodFields(spec, 'stats_timeseries', { withInterval: true }), lib.LIMIT()];
  const exposed = fields.filter((f) => f.name !== 'limit');
  const req = lib.requestFor(spec.stats_timeseries, exposed);
  req.response = {
    iterate: '{{body.data.series}}',
    limit: '{{parameters.limit}}',
    output: {
      date: '{{item.date}}', visitors: '{{item.visitors}}', visits: '{{item.visits}}', pageviews: '{{item.pageviews}}',
      views_per_visit: '{{item.views_per_visit}}', bounce_rate: '{{item.bounce_rate}}', visit_duration: '{{item.visit_duration}}', revenue: '{{item.revenue}}',
      interval: '{{body.data.interval}}',
    },
  };
  return {
    name: 'searchDailyStats',
    label: 'Search Stats Over Time',
    description: 'Gets the visitors, visits and pageviews of a site for each day (or hour, week or month) of a period, one bucket per bundle.',
    moduleType: 'search', typeId: TYPE.search, actionCrud: 'search',
    communication: req, mappable: fields,
    interface: [
      { name: 'date', label: 'Date', type: 'date' },
      { name: 'interval', label: 'Interval', type: 'text' },
      ...['visitors', 'visits', 'pageviews', 'views_per_visit', 'bounce_rate', 'visit_duration', 'revenue'].map((name) => ({ name, label: lib.label(name), type: 'number' })),
    ],
  };
};

const buildUniversal = () => ({
  name: 'makeApiCall',
  label: 'Make an API Call',
  description: 'Performs an arbitrary authorized API call to the Privatus Analytics API. This module cannot send DELETE requests.',
  moduleType: 'universal',
  typeId: TYPE.universal,
  actionCrud: 'universal',
  communication: {
    url: "{{'" + BASE_URL + "' + if(substring(parameters.url, 0, 1) === '/', '', '/') + parameters.url}}",
    method: '{{parameters.method}}',
    headers: '{{toCollection(parameters.headers, "key", "value")}}',
    qs: '{{toCollection(parameters.qs, "key", "value")}}',
    body: '{{parameters.body}}',
    response: { output: { body: '{{body}}', headers: '{{headers}}', statusCode: '{{statusCode}}' } },
  },
  mappable: [
    { name: 'url', label: 'URL', type: 'text', required: true, help: 'A path relative to https://privatusanalytics.com, like /sites/pa_7Q2K9XH3AB/stats/aggregate.json. It must start with a slash. Every endpoint is listed at https://privatusanalytics.com/docs/api.', validate: { pattern: '^/(?!/)' } },
    { name: 'method', label: 'Method', type: 'select', required: true, default: 'GET', options: ['GET', 'POST', 'PATCH', 'PUT'].map((value) => ({ label: value, value })), help: 'The HTTP method. Deleting data is not available in this module.' },
    { name: 'headers', label: 'Headers', type: 'array', help: 'Extra request headers. The Authorization header is added for you.', spec: [{ name: 'key', label: 'Key', type: 'text', required: true }, { name: 'value', label: 'Value', type: 'text' }] },
    { name: 'qs', label: 'Query String', type: 'array', help: 'Query string parameters, like period = 30d. For a list, write the key with brackets, like status[], once for each value.', spec: [{ name: 'key', label: 'Key', type: 'text', required: true }, { name: 'value', label: 'Value', type: 'text' }] },
    { name: 'body', label: 'Body', type: 'any', help: 'The request body as JSON, for POST, PATCH and PUT.' },
  ],
  interface: [
    { name: 'statusCode', label: 'Status Code', type: 'number' },
    { name: 'headers', label: 'Headers', type: 'collection' },
    { name: 'body', label: 'Body', type: 'any' },
  ],
});

// ---------- Webhooks and instant triggers ----------

const webhookName = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const buildWebhook = (e) => {
  const name = `${webhookName(e.key)}Hook`;
  const params = e.siteFilter
    ? [{ name: 'siteId', type: 'select', label: 'Site', options: 'rpc://listSites', help: 'Only run for this site. Leave empty to run for every site in the workspace.' }]
    : [];
  const siteCheck = e.siteFilter
    ? ' && (!parameters.siteId || body.data.site_id === parameters.siteId || body.data.check.site_id === parameters.siteId)'
    : '';
  return {
    name,
    label: e.label,
    type: 'web',
    connection: CONNECTION,
    params,
    communication: {
      condition: `{{body.event === '${e.event}'${siteCheck}}}`,
      output: {
        id: '{{body.id}}',
        event: '{{body.event}}',
        occurred_at: '{{body.created_at}}',
        workspace_id: '{{body.workspace_id}}',
        data: '{{body.data}}',
      },
    },
    attach: {
      url: '/workspaces/{{connection.workspaceId}}/webhooks.json',
      method: 'POST',
      body: { url: '{{webhook.url}}', events: [e.event], enabled: true },
      response: {
        data: { webhookId: '{{body.data.id}}', workspaceId: '{{connection.workspaceId}}' },
      },
    },
    detach: {
      url: '/workspaces/{{webhook.workspaceId}}/webhooks/{{webhook.webhookId}}.json',
      method: 'DELETE',
    },
  };
};

const buildTrigger = (e, webhook) => {
  const envelope = { id: 'whd_9K3M7QX2PL', event: e.event, occurred_at: '2026-10-20T10:15:00Z', workspace_id: 'ws_5N8D2WLE4C', data: e.sample };
  return {
    name: `watch${e.key.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase())}`,
    label: `Watch ${e.label}`,
    description: e.description.replace(/^Triggers when /, 'Triggers when ').replace(/\.$/, '') + '. Make creates the webhook in Privatus Analytics for you and removes it when the scenario no longer uses it.',
    moduleType: 'instant_trigger',
    typeId: TYPE.instant_trigger,
    webhook: webhook.name,
    communication: {},
    mappable: [],
    interface: [
      { name: 'id', label: 'Delivery ID', type: 'text' },
      { name: 'event', label: 'Event', type: 'text' },
      { name: 'occurred_at', label: 'Occurred At', type: 'date' },
      { name: 'workspace_id', label: 'Workspace ID', type: 'text' },
      { name: 'data', label: 'Data', type: 'collection', spec: lib.interfaceFromSample(e.sample) },
    ],
    samples: envelope,
  };
};

// ---------- Build ----------

const GROUPS = [
  ['Triggers', (m) => m.moduleType === 'instant_trigger'],
  ['Sites', (m) => /Site\b|Sites\b/.test(m.label) && !/Audit|Stats|Live/.test(m.label)],
  ['Analytics', (m) => /Stats|Top Values|Live/.test(m.label)],
  ['Goals and Notes', (m) => /Goal|Note/.test(m.label)],
  ['Campaigns', (m) => /Campaign/.test(m.label)],
  ['Alerts', (m) => /Alert/.test(m.label)],
  ['Uptime and Status', (m) => /Uptime|Status Page/.test(m.label)],
  ['Experiments', (m) => /Experiment/.test(m.label)],
  ['Audits, Exports and Members', (m) => /Audit|Export|Member/.test(m.label)],
  ['Testimonials', (m) => /Testimonial/.test(m.label)],
  ['Advanced', (m) => m.moduleType === 'universal'],
];

const main = () => {
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.rmSync(DIST, { recursive: true, force: true });

  // RPCs
  const rpcDefs = catalog.rpcs.map((def) => ({ name: def.name, ...buildRpc(def) }));

  // Modules
  const built = [
    ...catalog.actions(spec).map(buildAction),
    ...catalog.searches(spec).map(buildSearch),
    buildTopValues(),
    buildDailyStats(),
    buildUniversal(),
  ];
  const webhooks = events.map(buildWebhook);
  events.forEach((e, i) => built.push(buildTrigger(e, webhooks[i])));
  built.forEach(moduleFiles);

  // General
  write('src/general/base.iml.json', base);
  const groups = GROUPS.map(([labelText, test]) => ({ label: labelText, modules: modules.filter(test).map((m) => m.name) }));
  const grouped = new Set(groups.flatMap((g) => g.modules));
  const orphans = modules.filter((m) => !grouped.has(m.name)).map((m) => m.name);
  if (orphans.length) throw new Error(`Modules in no group: ${orphans.join(', ')}`);
  write('src/general/groups.json', groups.filter((g) => g.modules.length));
  write('src/general/readme.md', fs.readFileSync(path.join(ROOT, 'app-readme.md'), 'utf8'));
  fs.copyFileSync(path.join(ROOT, 'icon-512.png'), path.join(ROOT, 'src/general/logo.png'));

  // Connection
  const cdir = `src/connections/${CONNECTION}`;
  write(`${cdir}/${CONNECTION}.communication.iml.json`, connection.communication);
  write(`${cdir}/${CONNECTION}.params.iml.json`, connection.params);
  write(`${cdir}/${CONNECTION}.common.json`, {});

  // RPCs
  rpcDefs.forEach((r) => {
    write(`src/rpcs/${r.name}/${r.name}.communication.iml.json`, r.communication);
    write(`src/rpcs/${r.name}/${r.name}.params.iml.json`, r.params);
  });

  // Webhooks
  webhooks.forEach((w) => {
    const dir = `src/webhooks/${w.name}`;
    write(`${dir}/${w.name}.communication.iml.json`, w.communication);
    write(`${dir}/${w.name}.params.iml.json`, w.params);
    write(`${dir}/${w.name}.attach.iml.json`, w.attach);
    write(`${dir}/${w.name}.detach.iml.json`, w.detach);
  });

  // makecomapp.json: the manifest the VS Code extension reads.
  const comp = {
    fileVersion: 2,
    generalCodeFiles: { base: 'general/base.iml.json', groups: 'general/groups.json', readme: 'general/readme.md' },
    components: {
      connection: {
        [CONNECTION]: { type: 'basic', label: connection.label, codeFiles: { communication: `connections/${CONNECTION}/${CONNECTION}.communication.iml.json`, params: `connections/${CONNECTION}/${CONNECTION}.params.iml.json`, common: `connections/${CONNECTION}/${CONNECTION}.common.json` } },
      },
      module: Object.fromEntries(modules.map((m) => [m.name, {
        label: m.label,
        description: m.description,
        moduleType: m.moduleType,
        ...(m.actionCrud ? { actionCrud: m.actionCrud } : {}),
        connection: CONNECTION,
        ...(m.webhook ? { webhook: m.webhook } : {}),
        codeFiles: {
          communication: `modules/${m.name}/${m.name}.communication.iml.json`,
          staticParams: `modules/${m.name}/${m.name}.static-params.iml.json`,
          mappableParams: `modules/${m.name}/${m.name}.mappable-params.iml.json`,
          interface: `modules/${m.name}/${m.name}.interface.iml.json`,
          samples: `modules/${m.name}/${m.name}.samples.iml.json`,
        },
      }])),
      rpc: Object.fromEntries(rpcDefs.map((r) => [r.name, { label: r.label, connection: CONNECTION, codeFiles: { communication: `rpcs/${r.name}/${r.name}.communication.iml.json`, params: `rpcs/${r.name}/${r.name}.params.iml.json` } }])),
      webhook: Object.fromEntries(webhooks.map((w) => [w.name, { type: 'web', label: w.label, connection: CONNECTION, codeFiles: { communication: `webhooks/${w.name}/${w.name}.communication.iml.json`, params: `webhooks/${w.name}/${w.name}.params.iml.json`, attach: `webhooks/${w.name}/${w.name}.attach.iml.json`, detach: `webhooks/${w.name}/${w.name}.detach.iml.json` } }])),
      function: {},
    },
    origins: [
      { label: 'Testing', baseUrl: 'https://eu1.make.com/api', appId: `${APP}-test`, appVersion: 1, apikeyFile: '../.secrets/apikey', changesCount: 0, components: {} },
    ],
  };
  write('src/makecomapp.json', comp);

  writeDeployScript({ rpcDefs, webhooks });

  console.log(`Wrote ${written.length} files: ${modules.length} modules (${modules.filter((m) => m.moduleType === 'instant_trigger').length} instant triggers), ${rpcDefs.length} RPCs, ${webhooks.length} webhooks.`);
};

// ---------- Deploy script for the Make CLI ----------

const q = (json) => `'${JSON.stringify(json).replace(/'/g, "'\\''")}'`;

function writeDeployScript({ rpcDefs, webhooks }) {
  const L = [];
  L.push('#!/usr/bin/env bash');
  L.push('# Pushes src/ to a Make app with the Make CLI (make-cli), section by section.');
  L.push('# Generated by scripts/generate.js. Not run by the generator: read it first.');
  L.push('#   1. Install and log in to make-cli (see the Make developer docs, Make CLI).');
  L.push('#   2. Create the app once in Make (Create a new app), with the name below.');
  L.push('#   3. APP=privatus-analytics VERSION=1 bash dist/deploy-with-make-cli.sh');
  L.push('set -euo pipefail');
  L.push(`APP="\${APP:-${APP}}"`);
  L.push('VERSION="${VERSION:-1}"');
  L.push('cd "$(dirname "$0")/.."');
  L.push('body() { cat "$1"; }');
  L.push('');
  L.push('echo "Base and documentation"');
  L.push('make-cli sdk-apps set-section --name="$APP" --version="$VERSION" --section=base --body="$(body src/general/base.iml.json)"');
  L.push('make-cli sdk-apps set-docs --name="$APP" --version="$VERSION" --docs="$(body src/general/readme.md)"');
  L.push('');
  L.push('echo "Connection"');
  L.push(`make-cli sdk-connections create --app-name="$APP" --type=basic --label=${q(connection.label)} || true`);
  L.push(`# The connection name Make assigns is printed above. Use it here:`);
  L.push(`CONN="\${CONN:-$APP}"`);
  L.push(`make-cli sdk-connections set-section --connection-name="$CONN" --section=api --body="$(body src/connections/${CONNECTION}/${CONNECTION}.communication.iml.json)"`);
  L.push(`make-cli sdk-connections set-section --connection-name="$CONN" --section=parameters --body="$(body src/connections/${CONNECTION}/${CONNECTION}.params.iml.json)"`);
  L.push('');
  L.push('echo "RPCs"');
  rpcDefs.forEach((r) => {
    L.push(`make-cli sdk-rpcs create --app-name="$APP" --app-version="$VERSION" --name=${r.name} --label=${q(r.label)} || true`);
    L.push(`make-cli sdk-rpcs set-section --app-name="$APP" --app-version="$VERSION" --rpc-name=${r.name} --section=api --body="$(body src/rpcs/${r.name}/${r.name}.communication.iml.json)"`);
  });
  L.push('');
  L.push('echo "Webhooks"');
  webhooks.forEach((w) => {
    L.push(`make-cli sdk-webhooks create --app-name="$APP" --type=web --label=${q(w.label)} || true`);
    L.push(`# Webhook ${w.name}: the CLI names it itself. Set WEBHOOK_${w.name} to that name if it differs.`);
    L.push(`W="\${WEBHOOK_${w.name}:-${w.name}}"`);
    ['api:communication', 'parameters:params', 'attach:attach', 'detach:detach'].forEach((pair) => {
      const [section, file] = pair.split(':');
      L.push(`make-cli sdk-webhooks set-section --webhook-name="$W" --section=${section} --body="$(body src/webhooks/${w.name}/${w.name}.${file}.iml.json)"`);
    });
  });
  L.push('');
  L.push('echo "Modules"');
  modules.forEach((m) => {
    L.push(`make-cli sdk-modules create --app-name="$APP" --app-version="$VERSION" --name=${m.name} --type-id=${m.typeId} --label=${q(m.label)} --description=${q(m.description)} || true`);
    [['api', 'communication'], ['parameters', 'static-params'], ['expect', 'mappable-params'], ['interface', 'interface'], ['samples', 'samples']].forEach(([section, file]) => {
      L.push(`make-cli sdk-modules set-section --app-name="$APP" --app-version="$VERSION" --module-name=${m.name} --section=${section} --body="$(body src/modules/${m.name}/${m.name}.${file}.iml.json)"`);
    });
  });
  L.push('');
  L.push('echo "Groups"');
  L.push('make-cli sdk-apps set-section --name="$APP" --version="$VERSION" --section=groups --body="$(body src/general/groups.json)"');
  L.push('echo "Done. Link each instant trigger to its webhook and each module to the connection in the Make editor if the CLI did not."');
  write('dist/deploy-with-make-cli.sh', `${L.join('\n')}\n`);
  fs.chmodSync(path.join(ROOT, 'dist/deploy-with-make-cli.sh'), 0o755);
}

main();
