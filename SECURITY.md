# Security

## Reporting a vulnerability

Report it privately through
[GitHub security advisories](https://github.com/kay-g2/odoo-ai-gateway/security/advisories/new),
not in a public issue. The latest release is the supported one.

## Running the gateway

- Keep `auth.accountTokens` set. `allowAnyAccountToken: true` lets anyone who can reach the gateway
  spend your provider credits.
- Set `webhook.allowedHosts` to your Odoo hosts. Without it, any authenticated caller chooses where
  results are posted.
- Put TLS in front of the gateway. Keep provider keys in the environment, not in the config file.
- Logs carry job, provider, model, timings and token usage, never keys. Prompts and outputs are
  not logged either, with one exception: a failed provider call logs the provider's error message
  as is, which can quote request or model text.
