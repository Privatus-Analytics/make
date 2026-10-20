'use strict';

// Builders shared by the generator, the validator and the tests. No
// dependencies. Everything here turns documented API inputs and outputs
// (scripts/spec.json, a copy of zapier/lib/spec.json) into Make Apps SDK JSON.

const path = require('path');

const SPEC_FILE = path.join(__dirname, 'spec.json');
const loadSpec = (file = SPEC_FILE) => require(file);

// ---------- Names and labels ----------

const WORDS = { id: 'ID', ids: 'IDs', url: 'URL', utm: 'UTM', dns: 'DNS', tcp: 'TCP', http: 'HTTP', ssl: 'SSL', api: 'API', csv: 'CSV', json: 'JSON' };

/** site_id -> "Site", utm_source -> "UTM Source", add_tags -> "Add Tags" */
const label = (name) =>
  name
    .replace(/_id$/, '')
    .replace(/_ids$/, 's')
    .split('_')
    .map((word) => WORDS[word] || word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** Help text straight from the API docs, whitespace collapsed. */
const help = (text) => (text ? String(text).replace(/\s+/g, ' ').trim() : undefined);

const isDateName = (name) => /(^|_)(from|to|date|end_date|compare_from|compare_to|received_from|received_to)$/.test(name);

// ---------- Input parameters ----------

const SELECT_TYPES = new Set(['select']);

/**
 * One Make parameter from one documented input.
 *   o.type, o.rpc, o.multiple, o.options, o.fmt, o.required, o.default,
 *   o.label, o.help, o.name overrides.
 * Keys that start with `$` are generator hints and are stripped on output.
 */
const toParam = (input, o = {}) => {
  const p = { name: o.name || input.name, label: o.label || label(input.name) };
  const text = o.help !== undefined ? o.help : help(input.description);
  if (text) p.help = text;
  p.type = 'text';

  if (o.rpc) {
    p.type = 'select';
    p.options = `rpc://${o.rpc}`;
    if (o.multiple || (input.type === 'array' && input.items !== 'object')) {
      p.multiple = true;
    }
  } else if (o.type) {
    p.type = o.type;
  } else if (o.enum || input.enum) {
    p.type = 'select';
    p.options = (o.enum || input.enum).map((value) => ({ label: String(value), value }));
  } else if (input.type === 'array' && input.itemsEnum) {
    p.type = 'select';
    p.multiple = true;
    p.options = input.itemsEnum.map((value) => ({ label: String(value), value }));
  } else if (input.type === 'array' && (input.items === 'object' || input.items === 'array' || input.name === 'filters')) {
    p.type = 'json';
  } else if (input.type === 'object') {
    p.type = 'json';
  } else if (input.type === 'array') {
    p.type = 'array';
    p.spec = { type: 'text' };
  } else if (input.type === 'integer') {
    p.type = 'integer';
  } else if (input.type === 'number') {
    p.type = 'number';
  } else if (input.type === 'boolean') {
    p.type = 'boolean';
  } else if (o.fmt || isDateName(input.name)) {
    p.type = 'date';
  }
  if (o.fmt) p.$fmt = o.fmt;
  if (p.type === 'date' && !o.fmt && /YYYY-MM-DD/.test(input.description || '')) p.$fmt = 'YYYY-MM-DD';
  if (input.required || o.required) p.required = true;
  if (o.required === false) delete p.required;
  const dflt = o.default !== undefined ? o.default : input.default;
  if (dflt !== undefined && typeof dflt !== 'object' && dflt !== '') p.default = dflt;
  if (o.extra) Object.assign(p, o.extra);
  p.$in = input.in;
  p.$array = input.type === 'array';
  return p;
};

/** A hand-written parameter (not tied to an API input). */
const plain = (name, type, text, o = {}) => ({ name, type, label: o.label || label(name), ...(text ? { help: text } : {}), ...o.extra, ...(o.required ? { required: true } : {}), ...(o.default !== undefined ? { default: o.default } : {}), $in: o.in || 'body' });

/** The limit parameter every search needs. */
const LIMIT = () => ({
  name: 'limit',
  type: 'uinteger',
  label: 'Limit',
  required: true,
  default: 10,
  help: 'The maximum number of results Make returns during one execution cycle.',
  $in: 'meta',
});

/** Strips the generator hints. */
const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith('$')).map(([k, v]) => [k, clean(v)]));
  }
  return value;
};

// ---------- IML value expressions ----------

const ref = (name) => `parameters.${name}`;

/**
 * The IML expression that sends one parameter, or nothing when it is empty.
 * mode 'query' keeps JSON text as text, 'body' parses it.
 */
const valueExpr = (p, mode) => {
  const x = ref(p.name);
  if (p.type === 'number' || p.type === 'integer' || p.type === 'uinteger' || p.type === 'boolean') return `{{${x}}}`;
  if (p.type === 'array' || (p.type === 'select' && p.multiple)) return `{{if(length(${x}) > 0, ${x}, undefined)}}`;
  if (p.type === 'date' && p.$fmt) return `{{if(${x}, formatDate(${x}, '${p.$fmt}'), undefined)}}`;
  if (p.type === 'json' && mode === 'body') return `{{if(${x}, parseJSON(${x}), undefined)}}`;
  return `{{ifempty(${x}, undefined)}}`;
};

const isListParam = (p) => p.type === 'array' || (p.type === 'select' && p.multiple);

// ---------- Request building ----------

/** "/sites/{site_id}/goals.json" -> "/sites/{{parameters.site_id}}/goals.json" */
const urlFor = (op, { encode = [] } = {}) =>
  op.path.replace(/\{(\w+)\}/g, (_, name) => {
    if (name === 'workspace_id') return '{{connection.workspaceId}}';
    return encode.includes(name) ? `{{encodeURL(parameters.${name})}}` : `{{parameters.${name}}}`;
  });

/**
 * method, url, qs and body for an operation from the parameters exposed in
 * the module. Only inputs the operation declares are sent.
 *   fixed: { name: value } always sent (for example kind: 'text')
 */
const requestFor = (op, params, { fixed = {}, encode = [], bodyOverride } = {}) => {
  const req = { url: urlFor(op, { encode }), method: op.method };
  const exposed = new Map(params.map((p) => [p.name, p]));
  const qs = {};
  const body = {};
  const asQuery = op.method === 'GET' || op.method === 'DELETE';
  op.inputs.forEach((input) => {
    if (input.in === 'path' || ['page', 'per_page', 'workspace_id'].includes(input.name)) return;
    if (Object.prototype.hasOwnProperty.call(fixed, input.name)) {
      (asQuery ? qs : body)[input.name] = fixed[input.name];
      return;
    }
    const p = exposed.get(input.name);
    if (!p) return;
    if (asQuery) {
      qs[isListParam(p) ? `${p.name}[]` : p.name] = valueExpr(p, 'query');
    } else {
      body[p.name] = valueExpr(p, 'body');
    }
  });
  if (Object.keys(qs).length) req.qs = qs;
  if (bodyOverride) req.body = bodyOverride;
  else if (!asQuery && Object.keys(body).length) req.body = body;
  return req;
};

/** Pagination for the API's page, per_page and meta.total_pages lists. */
const pagination = () => ({
  qs: { page: '{{pagination.page}}' },
  condition: '{{body.meta.total_pages >= pagination.page}}',
});

// ---------- Interfaces (output) ----------

const outType = (o) => {
  if (/_at$/.test(o.name) || ['from', 'to', 'date'].includes(o.name)) return 'date';
  switch (o.type) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'collection';
    default:
      return 'text';
  }
};

const interfaceFor = (op, { skip = [] } = {}) =>
  op.outputs
    .filter((o) => !skip.includes(o.name))
    .map((o) => ({ name: o.name, label: label(o.name), type: outType(o) }));

/** An interface inferred from a sample value (webhook payloads). */
const interfaceFromSample = (value) =>
  Object.entries(value).map(([name, v]) => inferField(name, v));

const inferField = (name, v) => {
  const field = { name, label: label(name) };
  if (Array.isArray(v)) {
    field.type = 'array';
    const first = v.find((item) => item !== null && item !== undefined);
    if (first && typeof first === 'object' && !Array.isArray(first)) field.spec = interfaceFromSample(first);
    else field.spec = { type: typeof first === 'number' ? 'number' : typeof first === 'boolean' ? 'boolean' : 'text' };
  } else if (v && typeof v === 'object') {
    field.type = 'collection';
    field.spec = interfaceFromSample(v);
  } else if (typeof v === 'number') field.type = 'number';
  else if (typeof v === 'boolean') field.type = 'boolean';
  else if (/_at$/.test(name) && typeof v === 'string') field.type = 'date';
  else field.type = 'text';
  return field;
};

// ---------- IML: a small evaluator for tests and validation ----------

/** Every {{ expression }} in a JSON value (keys and strings). */
const expressions = (value, found = []) => {
  if (typeof value === 'string') {
    const re = /\{\{([\s\S]*?)\}\}/g;
    let m;
    while ((m = re.exec(value))) found.push(m[1]);
  } else if (Array.isArray(value)) value.forEach((v) => expressions(v, found));
  else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([k, v]) => {
      expressions(k, found);
      expressions(v, found);
    });
  }
  return found;
};

// The IML functions the generated code uses, enough to run it in tests.
const formatDate = (value, fmt) => {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  const iso = d.toISOString();
  return fmt === 'YYYY-MM' ? iso.slice(0, 7) : iso.slice(0, 10);
};
const FUNCTIONS = {
  ifempty: (v, f) => (v === undefined || v === null || v === '' ? f : v),
  $if: (c, a, b) => (c ? a : b),
  length: (v) => (v === undefined || v === null ? 0 : v.length),
  formatDate,
  parseJSON: (s) => (s === undefined ? undefined : JSON.parse(s)),
  min: (...a) => Math.min(...a),
  encodeURL: (s) => encodeURIComponent(s),
  substring: (s, a, b) => String(s).substring(a, b),
  round: (n) => Math.round(n),
  toString: (v) => String(v),
  join: (a, sep) => a.join(sep),
  toCollection: (arr, k, v) => Object.fromEntries((arr || []).map((i) => [i[k], i[v]])),
};

// IML arrays start at 1: x[1] is the first item. IML also reads a missing
// property as undefined instead of failing, and its if() only evaluates the
// branch it takes. The evaluator rewrites the JavaScript to match, so the
// same expressions can be run in tests.
const toJs = (expr) =>
  expr
    .split(/('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .replace(/\bif\(/g, '$if(')
        .replace(/\[(\d+)\]/g, (m, n) => `?.[${Number(n) - 1}]`)
        .replace(/([A-Za-z_\])])\.(?=[A-Za-z_])/g, '$1?.');
    })
    .join('');

const compile = (expr) => {
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) { return (${toJs(expr)}); }`);
};

/** Evaluates an IML string. A string that is one {{ }} keeps the value's type. */
const evalString = (str, scope) => {
  const whole = /^\{\{([\s\S]*)\}\}$/.exec(str);
  const run = (expr) => compile(expr)({ ...FUNCTIONS, ...scope, undefined: undefined });
  if (whole && !whole[1].includes('}}')) return run(whole[1]);
  return str.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => {
    const v = run(expr);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
};

/** Evaluates a whole JSON value, dropping keys that come out undefined. */
const evalDeep = (value, scope) => {
  if (typeof value === 'string') return evalString(value, scope);
  if (Array.isArray(value)) return value.map((v) => evalDeep(v, scope));
  if (value && typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      const r = evalDeep(v, scope);
      if (r !== undefined) out[k] = r;
    });
    return out;
  }
  return value;
};

/** The query string a request would send, Rails style (key[]=a&key[]=b). */
const queryString = (qs) => {
  const pairs = [];
  Object.entries(qs || {}).forEach(([k, v]) => {
    (Array.isArray(v) ? v : [v]).forEach((item) => pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(typeof item === 'object' ? JSON.stringify(item) : item)}`));
  });
  return pairs.join('&');
};

module.exports = {
  SPEC_FILE,
  loadSpec,
  label,
  help,
  toParam,
  plain,
  LIMIT,
  clean,
  valueExpr,
  isListParam,
  urlFor,
  requestFor,
  pagination,
  outType,
  interfaceFor,
  interfaceFromSample,
  expressions,
  compile,
  evalString,
  evalDeep,
  queryString,
  FUNCTIONS,
  SELECT_TYPES,
};
