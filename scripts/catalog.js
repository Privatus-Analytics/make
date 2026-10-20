'use strict';

// What the Make app contains. Labels follow Make's naming conventions
// ("Create a Goal", "Search Goals", "Watch Alert Triggered"). Field names,
// types, help texts and output fields come from the API docs through
// scripts/spec.json. Nothing here deletes data.

const { toParam, plain, LIMIT } = require('./lib');

// A site dropdown (an RPC), and the other dropdowns used by many modules.
const rpcField = (name, rpc, labelText, text, o = {}) => ({
  name,
  type: 'select',
  options: `rpc://${rpc}`,
  label: labelText,
  ...(text ? { help: text } : {}),
  ...(o.required ? { required: true } : {}),
  ...(o.multiple ? { multiple: true } : {}),
  $in: o.in || 'body',
});

const SITE = (o = {}) =>
  rpcField('site_id', 'listSites', 'Site', o.help || 'The site, from the sites this API token can open. You can also map a site ID (pa_...) from an earlier module.', {
    required: o.required !== false,
    in: 'path',
  });

const PERIODS = ['today', 'yesterday', '24h', '7d', '14d', '28d', '30d', '90d', 'mtd', 'last_month', 'qtd', 'last_quarter', 'ytd', '12mo', 'last_year', 'all', 'custom'];

// ---------- Field pickers ----------

/**
 * Make parameters for an operation's inputs.
 *   only / omit  names to keep or leave out
 *   o            { name: { ...toParam options } } per input
 *   extra        parameters appended
 */
const fieldsFor = (spec, opId, { only, omit = [], o = {}, extra = [] } = {}) => {
  const op = spec[opId];
  if (!op) throw new Error(`Unknown operation ${opId}`);
  const byName = Object.fromEntries(op.inputs.map((input) => [input.name, input]));
  const names = only || op.inputs.map((input) => input.name);
  const params = names
    .filter((name) => !['page', 'per_page', 'workspace_id'].includes(name) && !omit.includes(name))
    .map((name) => {
      if (!byName[name]) throw new Error(`${opId} has no input ${name}`);
      return toParam(byName[name], o[name] || {});
    });
  return params.concat(extra);
};

const periodOptions = { period: { default: '30d' } };

// ---------- RPCs (dropdowns) ----------

const rpcs = [
  { name: 'listSites', op: 'sites_list', label: 'List Sites', value: 'id', text: "{{if(item.name && item.name !== item.domain, item.name + ' (' + item.domain + ')', item.domain)}}" },
  { name: 'listGoals', op: 'goals_list', label: 'List Goals', needs: 'site_id', params: { status: 'active' }, text: '{{item.name}}' },
  { name: 'listSegments', op: 'segments_list', label: 'List Segments', needs: 'site_id', text: '{{item.name}}' },
  { name: 'listAlertRules', op: 'alerts_list', label: 'List Alert Rules', text: '{{item.name}}' },
  { name: 'listUptimeChecks', op: 'uptime_checks_list', label: 'List Uptime Checks', needs: 'site_id', text: "{{item.name + ' (' + item.status + ')'}}" },
  { name: 'listStatusPages', op: 'status_pages_list', label: 'List Status Pages', text: '{{item.name}}' },
  { name: 'listExperiments', op: 'experiments_list', label: 'List Experiments', needs: 'site_id', params: { status: 'all' }, text: "{{item.name + ' (' + item.status + ')'}}" },
  { name: 'listTestimonialForms', op: 'testimonial_forms_list', label: 'List Testimonial Forms', needs: 'site_id', text: '{{item.name}}' },
  { name: 'listTestimonialRequests', op: 'testimonial_requests_list', label: 'List Testimonial Requests', needs: 'site_id', text: "{{item.name + ' (' + item.status + ')'}}" },
  {
    name: 'listTestimonials',
    op: 'testimonials_list',
    label: 'List Testimonials',
    needs: 'site_id',
    params: { sort: 'added_desc' },
    text: "{{ifempty(item.person.name, 'Unknown') + ': ' + substring(ifempty(item.body, item.title), 0, 60)}}",
  },
  { name: 'listTestimonialTags', op: 'testimonial_tags_list', label: 'List Testimonial Tags', needs: 'site_id', text: '{{item.name}}' },
  { name: 'listTestimonialCollections', op: 'testimonial_collections_list', label: 'List Testimonial Collections', needs: 'site_id', text: '{{item.name}}' },
];

// ---------- Actions ----------

const TAGS_HELP = 'Tag names or IDs. A name that does not exist yet is created.';

const actions = (spec) => {
  const TESTIMONIAL = rpcField('id', 'listTestimonials', 'Testimonial', 'The testimonial (tm_...). The list shows the newest ones. You can also map a testimonial ID from an earlier module.', { required: true, in: 'path' });
  const EXPERIMENT = rpcField('id', 'listExperiments', 'Experiment', 'The experiment (exp_...).', { required: true, in: 'path' });
  const ALERT = rpcField('id', 'listAlertRules', 'Alert Rule', 'The alert rule (alr_...).', { required: true, in: 'path' });
  const CHECK = rpcField('id', 'listUptimeChecks', 'Uptime Check', 'The uptime check (upc_...). Choose the site first.', { required: true, in: 'path' });
  const siteFirst = (...rest) => [SITE(), ...rest];

  return [
    // Sites
    {
      name: 'createSite', label: 'Create a Site', crud: 'create', op: 'sites_create',
      description: 'Adds a website to the workspace and returns its tracking snippet details.',
      fields: fieldsFor(spec, 'sites_create', { only: ['domain', 'name', 'timezone', 'currency'], o: { domain: { help: 'The domain to track, like example.com. Enter only the domain, without https:// or a path.' } } }),
    },
    {
      name: 'getSite', label: 'Get a Site', crud: 'read', op: 'sites_get',
      description: 'Gets one site by its ID, with its settings and tracking details.',
      fields: [rpcField('id', 'listSites', 'Site', 'The site (pa_...).', { required: true, in: 'path' })],
    },

    // Goals, notes
    {
      name: 'createGoal', label: 'Create a Goal', crud: 'create', op: 'goals_create',
      description: 'Creates a conversion goal on a site. Goals count matching events across all existing history at once.',
      fields: siteFirst(...fieldsFor(spec, 'goals_create', {
        omit: ['site_id'],
        o: {
          conditions: { help: 'Event goals only. A JSON list of property tests that must all match, like [{"key":"plan","operator":"is","value":"pro"}]. Operators: is, is_not, contains, gt, lt.' },
          fixed_value: { help: 'The value of one completion in the site currency, like 49.5. Used when Value Mode is fixed.' },
        },
      })),
    },
    {
      name: 'createChartNote', label: 'Create a Chart Note', crud: 'create', op: 'notes_create',
      description: "Adds a note (annotation) to a site's charts, such as a deploy, a campaign launch or an outage.",
      fields: siteFirst(...fieldsFor(spec, 'notes_create', { omit: ['site_id'], o: { date: { type: 'date', fmt: 'YYYY-MM-DD', help: 'The day the note is shown on. Defaults to today.' }, end_date: { type: 'date', fmt: 'YYYY-MM-DD', help: 'For a note that covers several days, the last day.' } } })),
    },
    {
      name: 'createWorkspaceChartNote', label: 'Create a Workspace Chart Note', crud: 'create', op: 'workspace_notes_create',
      description: 'Adds a note to the charts of every site in the workspace, such as a release that touched them all.',
      fields: fieldsFor(spec, 'workspace_notes_create', { o: { date: { type: 'date', fmt: 'YYYY-MM-DD', help: 'The day the note is shown on. Defaults to today.' }, end_date: { type: 'date', fmt: 'YYYY-MM-DD', help: 'For a note that covers several days, the last day.' } } }),
    },

    // Campaigns
    {
      name: 'createCampaignLink', label: 'Create a Campaign Link', crud: 'create', op: 'links_create',
      description: 'Saves a tagged campaign link (with UTM parameters) in the campaign URL builder and returns the full URL.',
      fields: siteFirst(...fieldsFor(spec, 'links_create', { omit: ['site_id'] })),
    },
    {
      name: 'addCampaignCost', label: 'Add a Campaign Cost', crud: 'create', op: 'campaign_costs_create',
      description: 'Records what a campaign cost in a month, for cost per acquisition and return on ad spend (Business plan).',
      fields: siteFirst(...fieldsFor(spec, 'campaign_costs_create', { omit: ['site_id'], o: {
        campaign: { help: 'The utm_campaign value the cost belongs to, exactly as it arrives on the site.' },
        month: { type: 'date', fmt: 'YYYY-MM', help: 'The month the money was spent. Any day in it works, like 2026-10-01.' },
      } })),
    },

    // Uptime, alerts, status
    {
      name: 'createUptimeCheck', label: 'Create an Uptime Check', crud: 'create', op: 'uptime_checks_create',
      description: 'Starts monitoring a URL, a keyword on a page, a TCP port or a DNS name for a site.',
      fields: siteFirst(...fieldsFor(spec, 'uptime_checks_create', { omit: ['site_id'] })),
    },
    {
      name: 'pauseUptimeCheck', label: 'Pause an Uptime Check', crud: 'update', op: 'uptime_checks_pause',
      description: 'Pauses an uptime check, for example during planned maintenance.',
      fields: [SITE({ help: 'The site that has the check. Only used to fill the Uptime Check list.' }), CHECK],
    },
    {
      name: 'resumeUptimeCheck', label: 'Resume an Uptime Check', crud: 'update', op: 'uptime_checks_resume',
      description: 'Resumes a paused uptime check.',
      fields: [SITE({ help: 'The site that has the check. Only used to fill the Uptime Check list.' }), CHECK],
    },
    {
      name: 'acknowledgeAlert', label: 'Acknowledge an Alert', crud: 'update', op: 'alerts_acknowledge',
      description: "Acknowledges an alert rule's open incident, so the team knows someone is on it.",
      fields: [ALERT],
    },
    {
      name: 'muteAlert', label: 'Mute an Alert', crud: 'update', op: 'alerts_mute',
      description: 'Silences the notifications of an alert rule for a number of minutes. It keeps recording incidents.',
      fields: [ALERT, ...fieldsFor(spec, 'alerts_mute', { omit: ['id'] })],
    },
    {
      name: 'postStatusPageUpdate', label: 'Post a Status Page Update', crud: 'create', op: 'status_page_posts_create',
      description: "Publishes an incident update on a status page and, by default, emails the page's subscribers.",
      fields: [
        rpcField('status_page_id', 'listStatusPages', 'Status Page', 'The status page (sp_...).', { required: true, in: 'path' }),
        ...fieldsFor(spec, 'status_page_posts_create', { omit: ['status_page_id'], o: { posted_at: { type: 'date', help: 'When it happened. Defaults to now. Posts are sorted by this time.' } } }),
      ],
    },

    // Exports, members, audits
    {
      name: 'createExport', label: 'Create an Export', crud: 'create', op: 'exports_create',
      description: 'Queues a data export (CSV, JSON, XLSX, NDJSON or a ZIP of dashboard panels). Use the Watch Export Ready module to act when its file is ready.',
      fields: [
        SITE({ help: 'The site to export.' }),
        ...fieldsFor(spec, 'exports_create', { omit: ['site_id', 'segment_id', 'workspace_id'], o: {
          from: { type: 'date', fmt: 'YYYY-MM-DD', help: 'The first day to include.' },
          to: { type: 'date', fmt: 'YYYY-MM-DD', help: 'The last day to include (inclusive). At most 400 days after the first (93 days for raw).' },
          filters: { help: 'A JSON list of filters, each [dimension, operator, value], like [["country","is","US"]].' },
        } }),
        rpcField('segment_id', 'listSegments', 'Segment', 'A saved segment. Its filters are added to the filters above.'),
      ],
    },
    {
      name: 'inviteMember', label: 'Invite Members', crud: 'create', op: 'invitations_create',
      description: 'Invites people to the workspace by email. Each gets an invitation link valid for 14 days.',
      output: { invitations: '{{body.data}}', count: '{{length(body.data)}}' },
      outputInterface: [{ name: 'invitations', label: 'Invitations', type: 'array' }, { name: 'count', label: 'Count', type: 'number' }],
      fields: fieldsFor(spec, 'invitations_create', { omit: ['custom_role_id'], o: {
        emails: { help: 'The email addresses to invite.' },
        role: { default: 'viewer' },
        site_ids: { rpc: 'listSites', multiple: true, help: 'The sites they may open. Only used when All Sites is false.' },
      } }),
    },
    {
      name: 'runSiteAudit', label: 'Run a Site Audit', crud: 'create', op: 'site_audit_run',
      description: 'Starts an SEO audit of a site now. Use the Watch Site Audit Completed module to act on the result.',
      fields: [SITE()],
    },

    // Experiments
    ...[['start', 'Start', 'Starts'], ['pause', 'Pause', 'Pauses'], ['end', 'End', 'Ends']].map(([verb, title, third]) => ({
      name: `${verb}Experiment`, label: `${title} an Experiment`, crud: 'update', op: `experiments_${verb}`,
      description: `${third} an A/B or split URL experiment.`,
      fields: [SITE({ help: 'The site that has the experiment.' }), EXPERIMENT],
    })),

    // Testimonials
    {
      name: 'getTestimonial', label: 'Get a Testimonial', crud: 'read', op: 'testimonials_get',
      description: 'Gets one testimonial with everything about it, such as the person, the media and the tags.',
      fields: [SITE(), TESTIMONIAL],
    },
    {
      name: 'createTestimonial', label: 'Create a Testimonial', crud: 'create', op: 'testimonials_create',
      description: "Adds a text testimonial, for example from a review, a support chat or a survey reply. It counts toward the plan's monthly testimonials.",
      fixed: { kind: 'text' },
      fields: siteFirst(...fieldsFor(spec, 'testimonials_create', {
        only: ['body', 'person_name', 'person_email', 'person_title', 'person_company', 'person_company_url', 'person_social_url', 'rating', 'title', 'highlight', 'received_at', 'source_name', 'source_url', 'language', 'status', 'tags', 'collection_ids', 'properties', 'pinned', 'external_id', 'allow_duplicate'],
        o: {
          body: { required: true, help: 'The words, up to 10,000 characters.' },
          person_name: { required: true, help: 'Who gave it.' },
          rating: { help: '1 to 5 stars. Leave empty for no rating.' },
          received_at: { type: 'date' },
          tags: { help: TAGS_HELP },
          collection_ids: { rpc: 'listTestimonialCollections', multiple: true, label: 'Collections', help: 'Manual collections to add it to.' },
          properties: { help: "Custom property values by key as a JSON object, like {\"plan\":\"pro\"}, as set up in the site's testimonial settings." },
          external_id: { label: 'External ID', help: 'Your own ID for it, such as the review or ticket ID. Sending the same one again returns the testimonial already stored instead of a copy.' },
        },
      }).filter((p) => p.name !== 'site_id')),
    },
    {
      name: 'updateTestimonial', label: 'Update a Testimonial', crud: 'update', op: 'testimonials_update',
      description: 'Changes a testimonial: its words, rating, tags, custom properties and more. Only the fields filled in are changed.',
      fields: [SITE(), TESTIMONIAL, ...fieldsFor(spec, 'testimonials_update', { omit: ['site_id', 'id', 'person_id'], o: {
        received_at: { type: 'date' },
        add_tags: { rpc: 'listTestimonialTags', multiple: true, help: TAGS_HELP },
        remove_tags: { rpc: 'listTestimonialTags', multiple: true },
        properties: { help: 'Custom property values by key as a JSON object, like {"plan":"pro"}.' },
      } })],
    },
    ...[['approve', 'Approve', 'Approves'], ['reject', 'Reject', 'Rejects'], ['pend', 'Return to Pending', 'Returns']].map(([verb, title, third]) => ({
      name: `${verb}Testimonial`, label: verb === 'pend' ? 'Return a Testimonial to Pending' : `${title} a Testimonial`, crud: 'update', op: `testimonials_${verb}`,
      description: verb === 'pend' ? 'Returns a testimonial to pending, so it is not shown until it is approved again.' : `${third} a testimonial${verb === 'approve' ? ', so it can be shown on walls and widgets' : ''}.`,
      fields: [SITE(), TESTIMONIAL],
    })),
    {
      name: 'pinTestimonial', label: 'Pin or Unpin a Testimonial', crud: 'update', op: 'testimonials_pin',
      description: 'Pins a testimonial so it is shown first, or unpins it.',
      fields: [SITE(), TESTIMONIAL, plain('pinned', 'boolean', 'Yes pins the testimonial, no unpins it.', { label: 'Pinned', default: true })],
    },
    {
      name: 'createTestimonialPerson', label: 'Create a Testimonial Person', crud: 'create', op: 'testimonial_people_create',
      description: 'Adds a person (a customer who gives testimonials) to a site.',
      fields: siteFirst(...fieldsFor(spec, 'testimonial_people_create', { omit: ['site_id', 'avatar_media_id'], o: { name: { required: true } } })),
    },
    {
      name: 'askForTestimonial', label: 'Ask for a Testimonial', crud: 'create', op: 'testimonial_request_recipients_create',
      description: 'Adds a person to a testimonial request. In a running request they get the first email at once, in a draft they wait for it to be sent. Request emails need the Business plan and a connected email provider.',
      fields: [
        SITE(),
        rpcField('request_id', 'listTestimonialRequests', 'Request', 'The testimonial request (req_...).', { required: true, in: 'path' }),
        plain('email', 'email', 'The address the request email goes to.', { label: 'Email', required: true }),
        plain('name', 'text', 'Used in the email greeting and to fill in the form.', { label: 'Name' }),
        plain('company', 'text', null, { label: 'Company' }),
        plain('title', 'text', null, { label: 'Job Title' }),
        plain('properties', 'json', "Custom property values for the testimonial by key as a JSON object, as set up in the site's testimonial settings.", { label: 'Properties' }),
      ],
      body: {
        recipients: [{
          email: '{{parameters.email}}',
          name: '{{ifempty(parameters.name, undefined)}}',
          company: '{{ifempty(parameters.company, undefined)}}',
          title: '{{ifempty(parameters.title, undefined)}}',
          properties: '{{if(parameters.properties, parseJSON(parameters.properties), undefined)}}',
        }],
      },
    },

    // Reads that return one bundle
    {
      name: 'getLiveVisitors', label: 'Get Live Visitors', crud: 'read', op: 'live_get',
      description: 'Gets how many visitors are on a site right now (the last 5 minutes) and what they are doing, from the last 30 minutes.',
      fields: [SITE(), ...fieldsFor(spec, 'live_get', { omit: ['site_id', 'feed', 'limit', 'filters'] })],
      interface: [
        { name: 'live_visitors', label: 'Live Visitors', type: 'number' },
        { name: 'window_minutes', label: 'Window (Minutes)', type: 'number' },
        { name: 'sparkline', label: 'Sparkline', type: 'array', spec: [{ name: 'minute', label: 'Minute', type: 'date' }, { name: 'visits', label: 'Visits', type: 'number' }] },
        { name: 'top_pages', label: 'Top Pages', type: 'array', spec: [{ name: 'value', label: 'Value', type: 'text' }, { name: 'visits', label: 'Visits', type: 'number' }] },
        { name: 'top_referrers', label: 'Top Referrers', type: 'array', spec: [{ name: 'value', label: 'Value', type: 'text' }, { name: 'visits', label: 'Visits', type: 'number' }] },
        { name: 'top_countries', label: 'Top Countries', type: 'array', spec: [{ name: 'value', label: 'Value', type: 'text' }, { name: 'visits', label: 'Visits', type: 'number' }] },
        { name: 'top_events', label: 'Top Events', type: 'array', spec: [{ name: 'value', label: 'Value', type: 'text' }, { name: 'completions', label: 'Completions', type: 'number' }] },
      ],
    },
    {
      name: 'getSiteStats', label: 'Get Site Stats', crud: 'read', op: 'stats_aggregate',
      description: 'Gets the visitors, visits, pageviews, bounce rate, visit duration and revenue of a site for a period, optionally compared with the previous one.',
      fields: [SITE(), ...periodFields(spec, 'stats_aggregate')],
      output: {
        from: '{{body.data.period.from}}',
        to: '{{body.data.period.to}}',
        visitors: '{{body.data.metrics.visitors}}',
        visits: '{{body.data.metrics.visits}}',
        pageviews: '{{body.data.metrics.pageviews}}',
        views_per_visit: '{{body.data.metrics.views_per_visit}}',
        bounce_rate: '{{body.data.metrics.bounce_rate}}',
        visit_duration: '{{body.data.metrics.visit_duration}}',
        visit_duration_seconds: '{{round(body.data.metrics.visit_duration / 1000)}}',
        revenue: '{{body.data.metrics.revenue}}',
        revenue_amount: '{{body.data.metrics.revenue / 100}}',
        comparison_period: '{{body.data.comparison_period}}',
        comparison: '{{body.data.comparison}}',
        change: '{{body.data.change}}',
      },
      interface: [
        { name: 'from', label: 'From', type: 'date' },
        { name: 'to', label: 'To', type: 'date' },
        { name: 'visitors', label: 'Visitors', type: 'number' },
        { name: 'visits', label: 'Visits', type: 'number' },
        { name: 'pageviews', label: 'Pageviews', type: 'number' },
        { name: 'views_per_visit', label: 'Views per Visit', type: 'number' },
        { name: 'bounce_rate', label: 'Bounce Rate (%)', type: 'number' },
        { name: 'visit_duration', label: 'Visit Duration (Milliseconds)', type: 'number' },
        { name: 'visit_duration_seconds', label: 'Visit Duration (Seconds)', type: 'number' },
        { name: 'revenue', label: 'Revenue (Minor Units)', type: 'number' },
        { name: 'revenue_amount', label: 'Revenue (Site Currency)', type: 'number' },
        { name: 'comparison_period', label: 'Comparison Period', type: 'collection', spec: [{ name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }] },
        { name: 'comparison', label: 'Comparison', type: 'collection' },
        { name: 'change', label: 'Change (%)', type: 'collection' },
      ],
    },
  ];
};

/** The shared period, compare, filters and segment inputs of the stats operations. */
function periodFields(spec, opId, { withInterval = false } = {}) {
  const names = ['period', 'from', 'to', 'compare', 'filters', 'segment_id'];
  const fields = fieldsFor(spec, opId, {
    only: names,
    o: {
      period: { default: '30d', required: true },
      compare: { enum: ['none', 'previous_period', 'previous_year'] },
      from: { type: 'date', fmt: 'YYYY-MM-DD' },
      to: { type: 'date', fmt: 'YYYY-MM-DD' },
      segment_id: { rpc: 'listSegments' },
    },
  });
  if (withInterval) fields.push(...fieldsFor(spec, opId, { only: ['interval'], o: { interval: { default: 'day' } } }));
  return fields;
}

// ---------- Searches ----------

const searches = (spec) => {
  const list = (name, label, op, fields, description, extra = {}) => ({ name, label, op, fields, description, ...extra });
  return [
    list('searchSites', 'Search Sites', 'sites_list', fieldsFor(spec, 'sites_list', { only: ['query', 'label', 'sort'] }), 'Searches the sites of the workspace by domain or name.'),
    list('searchGoals', 'Search Goals', 'goals_list', [SITE(), ...fieldsFor(spec, 'goals_list', { only: ['status', 'period', 'from', 'to', 'filters'], o: { ...periodOptions, from: { type: 'date', fmt: 'YYYY-MM-DD' }, to: { type: 'date', fmt: 'YYYY-MM-DD' } } })], 'Searches the goals of a site, with completions, conversions, rate and value for a period.'),
    list('searchChartNotes', 'Search Chart Notes', 'notes_list', [SITE(), ...fieldsFor(spec, 'notes_list', { only: ['source', 'query'] })], 'Searches the chart notes of a site.'),
    list('searchAlertRules', 'Search Alert Rules', 'alerts_list', [SITE({ required: false, help: 'Only rules of this site. Leave empty for every site.' }), ...fieldsFor(spec, 'alerts_list', { only: ['state', 'kind'] })], 'Searches the alert rules of the workspace, with their state (ok or triggered).'),
    list('searchAlertIncidents', 'Search Alert Incidents', 'alerts_history', [rpcField('id', 'listAlertRules', 'Alert Rule', 'The alert rule (alr_...).', { required: true, in: 'path' }), ...fieldsFor(spec, 'alerts_history', { only: ['open'] })], 'Searches the incidents of one alert rule, newest first.'),
    list('searchUptimeChecks', 'Search Uptime Checks', 'uptime_checks_list', [SITE(), ...fieldsFor(spec, 'uptime_checks_list', { only: ['status', 'query'] })], 'Searches the uptime checks of a site, with status and uptime.'),
    list('searchExperiments', 'Search Experiments', 'experiments_list', [SITE(), ...fieldsFor(spec, 'experiments_list', { only: ['status', 'kind'] })], 'Searches the experiments of a site, with status, variants and results.'),
    list('searchSiteAudits', 'Search Site Audits', 'site_audit_history', [SITE(), ...fieldsFor(spec, 'site_audit_history', { only: ['status'] })], 'Searches the SEO audits of a site, newest first, with score, pages crawled and issues found and fixed.'),
    list('searchExports', 'Search Exports', 'exports_list', [SITE({ required: false, help: 'Only exports of this site. Leave empty for every site.' }), ...fieldsFor(spec, 'exports_list', { only: ['status', 'kind'] })], 'Searches the data exports of the workspace.'),
    list('searchMembers', 'Search Members', 'members_list', fieldsFor(spec, 'members_list', { only: ['query', 'role'] }), 'Searches the members of the workspace by email or name, with their role.'),
    list('searchTestimonials', 'Search Testimonials', 'testimonials_list', [SITE(), ...fieldsFor(spec, 'testimonials_list', {
      only: ['q', 'sort', 'status', 'kind', 'rating', 'form_id', 'tag_id', 'collection_id', 'language', 'received_from', 'received_to', 'pinned'],
      o: {
        q: { label: 'Search' },
        sort: { default: 'received_desc' },
        form_id: { rpc: 'listTestimonialForms', multiple: true },
        tag_id: { rpc: 'listTestimonialTags', multiple: true },
        collection_id: { rpc: 'listTestimonialCollections', multiple: true },
        received_from: { type: 'date', fmt: 'YYYY-MM-DD' },
        received_to: { type: 'date', fmt: 'YYYY-MM-DD' },
      },
    })], 'Searches the testimonials of a site by their words, the person, rating, status, tags and more.'),
    list('searchTestimonialPeople', 'Search Testimonial People', 'testimonial_people_list', [SITE(), ...fieldsFor(spec, 'testimonial_people_list', { only: ['query', 'company', 'sort'] })], 'Searches the people of a site (customers who give testimonials) by email or name.'),
    list('searchTestimonialForms', 'Search Testimonial Forms', 'testimonial_forms_list', [SITE(), ...fieldsFor(spec, 'testimonial_forms_list', { only: ['q', 'language', 'sort', 'direction'] })], 'Searches the testimonial forms of a site.'),
    list('searchTestimonialRequests', 'Search Testimonial Requests', 'testimonial_requests_list', [SITE(), ...fieldsFor(spec, 'testimonial_requests_list', { only: ['q', 'status'], o: { } }), rpcField('form_id', 'listTestimonialForms', 'Form', 'Only requests of this form.')], 'Searches the testimonial requests of a site.'),
  ];
};

module.exports = { rpcs, actions, searches, periodFields, fieldsFor, rpcField, SITE, PERIODS };
