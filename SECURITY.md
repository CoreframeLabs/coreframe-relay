# Security Policy

Coreframe Relay is a pre-launch security infrastructure product. We take security seriously and welcome responsible vulnerability reports from security researchers.

## Reporting a Vulnerability

Please report security vulnerabilities directly to **info@coreframe-labs.dev**. Do not open a public GitHub issue for security vulnerabilities.

### What to Include

When reporting a vulnerability, include:

- A clear description of the vulnerability and its impact
- Affected component(s) (Hono proxy, Next.js dashboard, database, other)
- Steps to reproduce the issue
- Any proof of concept or test case (optional but helpful)
- Your name and affiliation (optional)

### Response Times

- **Initial acknowledgment:** Within 2 business days
- **Fix timeline:** Depends on severity (see below)
- **Public disclosure:** Coordinated with you before or at the time of the fix

## Severity Tiers and Response SLAs

| Severity | Definition | SLA to Fix | Example |
|----------|-----------|-----------|---------|
| **CRITICAL** | Can access other team's data or execute code | 24 hours | IDOR on routes, SSRF that hits internal infrastructure |
| **HIGH** | Auth bypass, privilege escalation | 72 hours | API key timing attack, approval gate spoofing |
| **MEDIUM** | Information disclosure, missing rate limit | 1 week | Error message leaks stack trace, no rate limit on DLQ retry |
| **LOW** | Missing security header, non-exploitable issue | 2 weeks | Missing X-Frame-Options header, verbose 404 message |

SLAs are measured from initial confirmation. We will provide updates on critical and high severity vulnerabilities within 24 hours of first contact.

## Scope

### In Scope

The following components are covered by this policy:

- **Hono proxy worker** (`apps/proxy`) — inbound webhook ingestion, SSRF validation, idempotency, authentication
- **Next.js dashboard** (`apps/dashboard`) — authentication, authorization, team isolation, data access controls
- **Prisma schema and database interactions** — row-level security, query scoping, tenant isolation
- **API endpoints** — authentication, rate limiting, payload validation
- **Dependencies** — known vulnerabilities in direct and transitive dependencies

### Out of Scope

The following are not covered:

- Attacks on infrastructure outside our control (Cloudflare, Supabase, Upstash, Slack)
- Social engineering or phishing attacks against Coreframe staff
- Denial of service attacks (although please report if they highlight a control gap)
- Security issues in forked code from third-party projects (e.g., BoxyHQ starter kit) that are not introduced by our modifications
- Private instances or self-hosted deployments (report directly to your operator)

## Safe Harbor

We recognize the value of security research and welcome good-faith testing of our systems. Provided your testing:

- Does not access, disclose, or modify data beyond what is necessary to demonstrate the vulnerability
- Does not negatively impact our infrastructure or services
- Does not violate any applicable laws

We will not pursue legal action against you for responsible vulnerability disclosure, even if your testing technically violates our terms of service.

## Bug Bounty

A bug bounty program is planned for the future. When launched, we will offer £50–£250 in account credits for valid MEDIUM and above severity reports. This policy will be updated with full details when the program becomes active. For now, we offer only our gratitude and public credit if you prefer it.

## Pre-Launch Status

Coreframe Relay is not yet deployed in production. This is a pre-launch security policy intended to govern disclosure of vulnerabilities discovered during development and pre-launch testing. The product, infrastructure, and team are still subject to change.

## Questions?

If you have questions about this policy or need clarification, contact **info@coreframe-labs.dev**.

---

**Last Updated:** August 2026  
**Version:** 1.0
