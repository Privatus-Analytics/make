# Privatus Analytics for Make

A custom app for [Make](https://www.make.com) (formerly Integromat) that connects
[Privatus Analytics](https://privatusanalytics.com) to Make scenarios. It is built only on the public
API (`/openapi.json`) and the signed webhooks (`/docs/api/webhooks`), so no server change is needed.
It mirrors the finished Zapier app in `../zapier`.

Nothing here is published. `src/` is the app in the folder layout of Make's Apps SDK VS Code
extension, and `dist/deploy-with-make-cli.sh` is a second route that pushes the same files with the
Make CLI.

## What it contains (72 modules)

| Kind | Count | Modules |
|---|---|---|
| Instant triggers | 25 | One "Watch ..." module for each webhook event: alerts, goal alerts, usage, uptime down and up, new and deleted sites, new members, exports, imports, site audits, experiments and the whole testimonial flow |
| Searches | 16 | Sites, goals, chart notes, alert rules, alert incidents, uptime checks, experiments, site audits, exports, members, testimonials, testimonial people, forms and requests, top values (pages, sources, countries and more) and stats over time |
| Actions | 30 | Create a site, goal, chart note, workspace chart note, campaign link, campaign cost, uptime check, status page update, export and testimonial. Pause or resume an uptime check, acknowledge or mute an alert, start, pause or end an experiment, invite members, run a site audit, update, approve, reject, return to pending or pin a testimonial, create a testimonial person, ask for a testimonial, get a site, a testimonial, live visitors and site stats |
| Universal | 1 | Make an API Call (GET, POST, PATCH, PUT, never DELETE, and only paths on the Privatus Analytics host) |
| RPCs | 12 | Dropdowns for sites, goals, segments, alert rules, uptime checks, status pages, experiments, testimonial forms, requests, testimonials, tags and collections |

Deliberately not included: any module that sends pageviews or events (the tracking script is the only
way events get in), and any module that deletes data (sites, goals, notes, testimonials, webhooks by
hand, exports). Make removes a webhook itself through the detach step when a scenario stops using it.

## How it works

- **Connection** (`connections/privatusAnalytics`): an API token (`pat_...`) in a password field, sent as
  `Authorization: Bearer`. The test is `GET /workspaces.json`. A token belongs to one workspace, so the
  call lists exactly one workspace. Its id is kept as connection data (`connection.workspaceId`) and its
  name is the connection label, so no module asks for a workspace. A 401 or an empty list marks the
  connection invalid. The token is sanitized in the logs of the base and the connection.
- **Base** (`general/base.iml.json`): `https://privatusanalytics.com`, the bearer header, JSON both ways,
  and error handling by status: 400/404/409/422 as DataError (with the API's `error.details`),
  401 InvalidAccessTokenError, 402 with a plan hint, 429 RateLimitError, 5xx ConnectionError.
- **Searches** all have a Limit, ask the API for `per_page=min(limit, 100)` and page with `page` until
  `meta.total_pages` is reached. Top values uses the breakdown's own `page` and `has_more`.
  Stats over time has no pages in the API, so it only honors the Limit.
- **Lists of values** go as Rails arrays (`status[]=a&status[]=b`): the module parameter key is written
  `status[]`, and Make repeats a key for each array item. JSON inputs (`filters`, `conditions`,
  `properties`) are JSON text fields that the module parses. Dates are formatted as the API expects
  (`YYYY-MM-DD`, `YYYY-MM` for a campaign cost month).
- **Instant triggers.** Each event has its own webhook component (`webhooks/<name>Hook`) because attach
  must name the event. Attach calls `POST /workspaces/{id}/webhooks.json` with `{url, events:[event],
  enabled:true}` and keeps the webhook id. Detach calls `DELETE /workspaces/{id}/webhooks/{id}.json`.
  Most have an optional Site parameter, applied in the webhook's `condition`. The output is the
  delivery envelope (`id`, `event`, `occurred_at`, `workspace_id`) with `data` typed from the sample
  payloads in `scripts/events.json`. Creating a webhook needs a token with the workspace settings
  permission and every site.
- **Signatures.** Deliveries carry `Privatus-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
  Make's IML has no access to the raw body, so the app cannot verify it. The webhook URL is the
  secret that only Make and Privatus Analytics know. This is stated in the app readme and in the
  review notes.

## Folder layout

```
src/                         open this folder in VS Code (the Make Apps SDK extension)
  makecomapp.json            the manifest: components, code files, origins
  general/                   base.iml.json, groups.json, readme.md, logo.png
  connections/privatusAnalytics/   communication, params, common
  modules/<name>/            communication, static-params, mappable-params, interface, samples
  rpcs/<name>/               communication, params
  webhooks/<name>/           communication, params, attach, detach
dist/deploy-with-make-cli.sh push the same files with the Make CLI
scripts/                     the generator, the validator, the spec copy and the event list
test/                        tests that run the generated IML
app-readme.md                the readme shown inside Make (copied to src/general/readme.md)
icon-512.png                 the app logo, 512 by 512
```

`src/` and `dist/` are generated. Edit `scripts/catalog.js` (what the app contains),
`scripts/lib.js` (how fields and requests are built) or `scripts/generate.js` (files and glue), then
run the generator. Never edit `src/` by hand: the next run overwrites it.

## Regenerate, validate, test

```sh
cp ../zapier/lib/spec.json scripts/spec.json   # after an API change (npm run sync in zapier first)
npm run generate                               # rewrites src/ and dist/
npm run validate                               # JSON, IML syntax, structure, copy rules
npm test                                       # generate + validate + node:test, no network
```

No dependencies are installed. Node 20 or newer is enough.

`field help texts` come straight from the API docs: a parameter's `help` is the description of the input
in `spec.json`, its options are the documented enum, and a module's interface is the documented output.

### What is verified offline, and what is not

Verified (`npm test`):

- Every file is valid JSON, and every `{{ }}` expression compiles as an IML/JavaScript expression with
  only known IML functions and 1-based array indexes.
- The generated requests, run with sample parameters through a small IML evaluator: paths, query
  strings (`status[]=a&status[]=b`), bodies, date formats, empty values dropped, pagination, the
  connection test, all 25 attach and detach calls, and every webhook condition against the sample
  payloads (right event, site filter on and off).
- Make's review rules: labels and descriptions on every module, a Limit and pagination on every search
  and RPC, token sanitized, connection test with `valid` and errors, a universal module, no module that
  deletes or sends events, and the copy rules (no em dashes, no semicolons, "Privatus Analytics", and no
  banned word).

Not verifiable without a Make account:

- The exact file names and `makecomapp.json` keys of the VS Code extension. Make documents the
  component contents but not the on-disk names. They follow what the extension writes
  (`*.communication.iml.json`, `*.mappable-params.iml.json` and so on). Before relying on it, clone any
  blank app into a folder with "Clone to Local Folder" and compare the names. If they differ, rename in
  `scripts/generate.js` (only `write()` calls and `makecomapp.json` in `main()`).
- The Make CLI section names in `dist/deploy-with-make-cli.sh` (`api`, `parameters`, `expect`,
  `interface`, `samples`) and how it names connections and webhooks. Read the script before running it.
- Behavior of Make's runtime: how it serializes array query values, whether `undefined` drops a key in
  every directive, and the webhook `condition` with parameters. These follow the Make documentation.
  The scenarios in `SUBMISSION.md` exercise them.

## Sync to Make

Either route works. Use a throwaway test app first (the origin in `makecomapp.json` is
`privatus-analytics-test`), and publish only when the scenarios pass.

1. **VS Code extension.** Install the Make Apps SDK extension, add a Make API key with the `sdk-apps:*`
   scopes (see `SUBMISSION.md`), create the app, open `src/`, then right-click `makecomapp.json` and
   choose Deploy to Make.
2. **Make CLI.** Create the app in Make, then `APP=<app name> VERSION=1 bash dist/deploy-with-make-cli.sh`.
3. **By hand** in the Make web editor: for each component, open its tab and paste the file:
   Communication from `*.communication.iml.json`, Parameters or Mappable parameters from the params
   files, Interface, Samples, and for a webhook its Attach and Detach. The base, groups and readme go in
   the app's Base, Groups and Docs. This is slow with 140 components and the other two are better.

After the first deploy, open an instant trigger and check that it is linked to its webhook, and that
every module uses the connection.

## Updating the app after the API changes

Re-run `npm run sync-spec` in `../zapier`, copy `lib/spec.json`, then generate, validate and test. A
new webhook event is a new entry in `scripts/events.json` (key, event, label, description, siteFilter,
sample). A new action or search is an entry in `scripts/catalog.js`.
