import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * [RELAY-119] The second, OPTIONAL credential for the Relay node: a per-route, read-only
 * delivery-status token. Distinct from `RelayIngestApi` on purpose — that one holds a
 * WRITE capability (the ingest URL), this one holds a token that can only answer
 * "what happened to request X on the one route it is pinned to". A leaked n8n
 * credential store therefore exposes that route's delivery metadata (status, attempt
 * count, response code, timings — never payloads, never sender IPs), not the ability to
 * inject traffic, and not any other route or team.
 *
 * Minted in Relay via `POST /api/teams/:slug/relay/routes/:routeId/read-tokens` (ADMIN
 * or OWNER; API-only in v1, no dashboard button yet). The token is shown exactly once.
 * It expires 365 days after minting; rotate by minting a new one, updating this
 * credential, then revoking the old one — both can coexist while you do that.
 *
 * Unlike `RelayIngestApi`, this type HAS a real `authenticate` block: the token travels
 * as `Authorization: Bearer`, which is n8n's generic auth-injection path, so every
 * request the node (or a plain HTTP Request node using this credential) makes to the
 * status endpoint carries it without the node code touching the secret.
 *
 * The `test` calls the status endpoint with NO `requestId`, which Relay answers with a
 * 200 introspection `{ data: { ok: true, scope: 'delivery:read', route: {...} } }` for a
 * live token — and a 401 JSON (not a login redirect) for a dead one. The `rules` entry
 * asserts on that body, same bar `RelayIngestApi` set: a credential that "passes" here
 * reached Relay's own endpoint with a token Relay accepted, not merely some URL that
 * answered 200.
 */
export class RelayStatusApi implements ICredentialType {
	name = 'relayStatusApi';

	displayName = 'Relay Status API';

	documentationUrl = 'https://github.com/CoreframeLabs/coreframe-relay/blob/main/docs/integrations/n8n.md';

	properties: INodeProperties[] = [
		{
			displayName: 'Where To Find This',
			name: 'notice',
			type: 'notice',
			default: '',
			description:
				'Optional. Lets the Relay node wait for and report DELIVERED / RETRYING / DLQ status after ' +
				'a send. Mint a read token for the route in Relay (ADMIN or OWNER): POST ' +
				'/api/teams/<team-slug>/relay/routes/<route-id>/read-tokens with {"name": "..."} while ' +
				'signed in, and paste the one-time token below. It is pinned to that one route.',
		},
		{
			displayName: 'Relay Dashboard URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://www.coreframe-labs.dev',
			required: true,
			placeholder: 'https://www.coreframe-labs.dev',
			description:
				'Origin of the Relay dashboard (where you sign in) — NOT the proxy host in the ingest URL. ' +
				'No trailing slash.',
		},
		{
			displayName: 'Read Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'relay_rt_…',
			description:
				'A Relay delivery read token (starts with relay_rt_). Read-only, pinned to one route, ' +
				'expires after a year. Anyone with it can read that route\'s delivery status.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.token}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/relay/deliveries',
			method: 'GET',
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'data.scope',
					value: 'delivery:read',
					message:
						"Got an HTTP success response, but not Relay's — this URL answered 200 without the " +
						'expected {"data":{"scope":"delivery:read"}} body. Check the Relay Dashboard URL is the ' +
						'origin you sign in at (e.g. https://www.coreframe-labs.dev), with no path.',
				},
			},
		],
	};
}
