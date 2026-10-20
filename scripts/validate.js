#!/usr/bin/env node
'use strict';

// Offline checks of src/: valid JSON, valid IML syntax in every {{ }}, the
// structure Make's review asks for, and the copy rules. Exits 1 on a failure.
//   node scripts/validate.js

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const errors = [];
const fail = (where, message) => errors.push(`${where}: ${message}`);

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// ---------- 1. JSON and IML syntax ----------

const files = walk(SRC);
const json = {};
files.filter((f) => f.endsWith('.json')).forEach((file) => {
  const rel = path.relative(SRC, file);
  try {
    json[rel] = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(rel, `invalid JSON (${e.message})`);
  }
});

let expressionCount = 0;
const KNOWN_FUNCTIONS = new Set(['ifempty', 'if', 'length', 'formatDate', 'parseJSON', 'min', 'encodeURL', 'substring', 'round', 'toString', 'join', 'toCollection']);
Object.entries(json).forEach(([rel, value]) => {
  lib.expressions(value).forEach((expr) => {
    expressionCount += 1;
    if (expr.trim() === '...') return;
    try {
      lib.compile(expr);
    } catch (e) {
      fail(rel, `IML syntax error in {{${expr}}}: ${e.message}`);
    }
    const calls = expr.match(/[A-Za-z_]+(?=\()/g) || [];
    calls.filter((name) => !KNOWN_FUNCTIONS.has(name)).forEach((name) => fail(rel, `unknown IML function ${name}() in {{${expr}}}`));
    if (/\[0\]/.test(expr)) fail(rel, `IML arrays start at 1, found [0] in {{${expr}}}`);
  });
});

// ---------- 2. Structure ----------

const manifest = json['makecomapp.json'];
if (!manifest) fail('makecomapp.json', 'missing');
const { module: mods = {}, rpc = {}, webhook = {}, connection = {} } = (manifest && manifest.components) || {};
const groups = json['general/groups.json'] || [];
const grouped = new Set(groups.flatMap((g) => g.modules));

const base = json['general/base.iml.json'] || {};
if (!base.baseUrl) fail('base', 'no baseUrl');
if (!JSON.stringify(base.headers || {}).includes('connection.apiToken')) fail('base', 'Authorization does not use the connection token');
if (!(base.log && base.log.sanitize && base.log.sanitize.some((s) => /authorization/i.test(s)))) fail('base', 'the API token is not sanitized');
if (!base.response || !base.response.error || !base.response.error[401]) fail('base', 'no error handling for 401');

Object.entries(connection).forEach(([name, c]) => {
  const comm = json[`connections/${name}/${name}.communication.iml.json`] || {};
  if (!(comm.log && comm.log.sanitize)) fail(`connection ${name}`, 'token not sanitized in the connection test');
  if (!comm.response || !comm.response.valid) fail(`connection ${name}`, 'the connection test has no response.valid');
  if (!comm.response || !comm.response.error) fail(`connection ${name}`, 'no error handling in the connection test');
  const params = json[`connections/${name}/${name}.params.iml.json`] || [];
  if (!params.some((p) => p.type === 'password')) fail(`connection ${name}`, 'the token field is not a password field');
  if (!c.label) fail(`connection ${name}`, 'no label');
});

const rpcNames = new Set(Object.keys(rpc));
const referencedRpcs = new Set();

Object.entries(mods).forEach(([name, m]) => {
  const where = `module ${name}`;
  if (!m.label || !m.description) fail(where, 'label and description are required');
  if (!grouped.has(name)) fail(where, 'not in a group');
  if (m.connection !== Object.keys(connection)[0]) fail(where, 'no connection');
  const dir = `modules/${name}/${name}`;
  const comm = json[`${dir}.communication.iml.json`];
  const mappable = json[`${dir}.mappable-params.iml.json`] || [];
  const iface = json[`${dir}.interface.iml.json`];
  if (comm === undefined) fail(where, 'no communication file');
  if (!Array.isArray(iface)) fail(where, 'no interface file');
  if (m.moduleType !== 'instant_trigger' && m.moduleType !== 'universal' && (iface || []).length === 0) fail(where, 'empty interface');
  if (m.moduleType === 'search') {
    const limit = mappable.find((p) => p.name === 'limit');
    if (!limit) fail(where, 'a search needs a limit parameter');
    // The time series endpoint returns every bucket at once and has no pages.
    if (!comm.pagination && name !== 'searchDailyStats') fail(where, 'a search needs pagination');
    if (!(comm.response && comm.response.limit)) fail(where, 'a search needs response.limit');
  }
  if (m.moduleType === 'instant_trigger') {
    if (!webhook[m.webhook]) fail(where, `webhook ${m.webhook} is missing`);
  }
  mappable.forEach((p) => {
    if (!p.label) fail(`${where} param ${p.name}`, 'no label');
    const refs = [p.options].concat(p.spec && p.spec.options).filter((o) => typeof o === 'string');
    refs.forEach((o) => {
      const m2 = /^rpc:\/\/(\w+)$/.exec(o);
      if (m2) referencedRpcs.add(m2[1]);
    });
  });
  // Every parameters.<name> used in the request must exist in the module.
  const used = new Set();
  JSON.stringify(comm || {}).replace(/parameters\.(\w+)/g, (_, n) => used.add(n));
  used.forEach((n) => {
    if (!mappable.some((p) => p.name === n) && m.moduleType !== 'universal') fail(where, `uses parameters.${n} but has no such parameter`);
  });
  if (m.moduleType !== 'universal' && /delete/i.test(`${(comm || {}).method}`)) fail(where, 'a module that deletes data');
});

Object.entries(webhook).forEach(([name, w]) => {
  const dir = `webhooks/${name}/${name}`;
  ['communication', 'params', 'attach', 'detach'].forEach((part) => {
    if (json[`${dir}.${part}.iml.json`] === undefined) fail(`webhook ${name}`, `no ${part} file`);
  });
  const attach = json[`${dir}.attach.iml.json`] || {};
  const detach = json[`${dir}.detach.iml.json`] || {};
  if (!/webhook\.url/.test(JSON.stringify(attach))) fail(`webhook ${name}`, 'attach does not send webhook.url');
  if (!(attach.response && attach.response.data && attach.response.data.webhookId)) fail(`webhook ${name}`, 'attach does not keep the webhook id');
  if (detach.method !== 'DELETE' || !/webhook\.webhookId/.test(detach.url || '')) fail(`webhook ${name}`, 'detach does not delete the stored webhook');
  (json[`${dir}.params.iml.json`] || []).forEach((p) => {
    const m2 = /^rpc:\/\/(\w+)$/.exec(p.options || '');
    if (m2) referencedRpcs.add(m2[1]);
  });
});

referencedRpcs.forEach((r) => {
  if (!rpcNames.has(r)) fail('rpc', `rpc://${r} is referenced but not defined`);
});
rpcNames.forEach((r) => {
  const comm = json[`rpcs/${r}/${r}.communication.iml.json`] || {};
  if (!(comm.response && comm.response.limit)) fail(`rpc ${r}`, 'no response.limit');
  if (!comm.pagination) fail(`rpc ${r}`, 'no pagination');
  if (comm.method !== 'GET') fail(`rpc ${r}`, 'an RPC must only read');
});

if (!Object.values(mods).some((m) => m.moduleType === 'universal')) fail('app', 'no universal "Make an API Call" module');
const triggers = Object.values(mods).filter((m) => m.moduleType === 'instant_trigger');
if (triggers.length !== 25) fail('app', `expected 25 instant triggers, found ${triggers.length}`);

// ---------- 3. Copy rules ----------

// Everything a person reads: labels, descriptions, help text, the readme.
const copy = [];
Object.entries(mods).forEach(([n, m]) => copy.push([`module ${n}`, m.label], [`module ${n}`, m.description]));
Object.entries(webhook).forEach(([n, w]) => copy.push([`webhook ${n}`, w.label]));
Object.entries(json).forEach(([rel, value]) => {
  const visit = (v) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') {
      ['label', 'help'].forEach((k) => typeof v[k] === 'string' && copy.push([rel, v[k]]));
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
});
copy.push(['general/readme.md', fs.readFileSync(path.join(SRC, 'general/readme.md'), 'utf8')]);
copy.forEach(([where, text]) => {
  if (/[—–]/.test(text)) fail(where, `dash character in "${text.slice(0, 50)}"`);
  if (/;/.test(text)) fail(where, `semicolon in "${text.slice(0, 50)}"`);
  if (/\bPrivatus\b(?!\s+Analytics)/.test(text.replace(/Privatus-Signature/g, ''))) fail(where, `"Privatus" without "Analytics" in "${text.slice(0, 60)}"`);
  if (/\banswer/i.test(text)) fail(where, `a banned word in "${text.slice(0, 50)}"`);
});

// The icon.
const png = fs.readFileSync(path.join(ROOT, 'icon-512.png'));
if (png.readUInt32BE(16) !== 512 || png.readUInt32BE(20) !== 512) fail('icon-512.png', 'must be 512 by 512');

if (errors.length) {
  console.error(`${errors.length} problem(s):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
console.log(`OK: ${Object.keys(json).length} JSON files, ${expressionCount} IML expressions, ${Object.keys(mods).length} modules, ${rpcNames.size} RPCs, ${Object.keys(webhook).length} webhooks, ${copy.length} texts checked.`);
