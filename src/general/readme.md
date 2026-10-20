# Privatus Analytics

Privatus Analytics is cookieless, privacy-first web analytics. This app connects it to Make so you can read your numbers, manage goals, alerts, uptime checks, experiments and testimonials, and start a scenario the moment something happens.

## Connect

1. In Privatus Analytics open Account, then API tokens, and create a token. A token starts with `pat_` and belongs to one workspace.
2. Give it every site and the permissions your scenarios need. The Watch modules also need the workspace settings permission, because they register a webhook.
3. In Make, add any Privatus Analytics module, click Add next to Connection and paste the token.

The connection test calls your workspace, so a wrong token is rejected at once.

## What you can do

- **Watch modules (instant triggers).** One for each of the 25 webhook events: alerts, uptime, new sites and members, exports, imports, site audits, experiments and the whole testimonial flow. Make creates the webhook in Privatus Analytics when the scenario turns on and removes it when it is no longer used. Most have an optional Site filter.
- **Search modules.** Sites, goals, chart notes, alert rules and incidents, uptime checks, experiments, site audits, exports, members, testimonials, people, forms and requests, plus top values and stats over time. Every search has a Limit and pages through the API for you.
- **Action modules.** Create sites, goals, chart notes, campaign links and costs, uptime checks, status page updates, exports, invitations and testimonials, pause or resume checks, acknowledge or mute alerts, start, pause or end experiments, and approve, reject or pin testimonials.
- **Make an API Call.** Calls any other endpoint of the Privatus Analytics API with your connection. It cannot send DELETE requests.

## Good to know

- Events reach Privatus Analytics only through its tracking script, so this app has no module that sends pageviews or events.
- No module deletes data.
- Webhook payloads reach Make on a private URL that only your scenario knows. Make cannot check the `Privatus-Signature` header, so keep the URL secret.
- Amounts are in minor units (cents) unless a field says otherwise. Durations are in milliseconds.

Documentation: https://privatusanalytics.com/docs/api
