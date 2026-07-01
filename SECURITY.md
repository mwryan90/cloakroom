# Security Policy

Cloakroom is a privacy guardrail: it keeps sensitive values out of an AI
agent's context. Security is the product, so we take reports seriously.

## Supported versions

Cloakroom is pre-1.0 and released in lockstep across all packages
(`cloakroom`, `cloakroom-core`, `cloakroom-adapter-powerbi`, `cloakroom-ui`).
Only the latest `0.3.x` release receives fixes.

| Version | Supported |
| ------- | --------- |
| latest `0.3.x` | ✅ |
| older | ❌ |

## What Cloakroom protects — and what it doesn't

Cloakroom is a **guardrail against accidental exposure, not a DLP product or
security boundary**. It masks values it has seen in a tagged column or a
warm-up scan, anywhere they subsequently appear. It does **not** protect
against values never observed in a tagged column, inference from unmasked
numbers/dates, a malicious upstream server, or anyone with access to the
local mapping store. The full threat model is in the [README](README.md#threat-model--read-this-before-relying-on-it).

## The mapping store is the secret

`masking-map.jsonl` holds the real value↔token mappings. It is gitignored and
npmignored by default and must never be committed, published, or shared.
Treat it like a credential. A report that Cloakroom emitted store contents
over the MCP transport, or shipped the store in a package tarball, is a
security bug — please report it.

## Reporting a vulnerability

Please report privately, not in a public issue:

1. Preferred: open a private report via the repository's **Security** tab →
   **Report a vulnerability** (GitHub private vulnerability reporting).
2. If that is unavailable, open a public issue that says only "security
   report — please provide a private contact" (no details), and we'll follow
   up with a private channel.

Please include a description, reproduction steps, affected version, and the
impact you observed. We aim to acknowledge within a few days.

## Coordinated disclosure

We ask that you give us reasonable time to release a fix before any public
disclosure. We're happy to credit reporters who want acknowledgement.
