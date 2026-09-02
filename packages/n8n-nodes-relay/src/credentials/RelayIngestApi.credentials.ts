import type {
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * This credential does not hold an API key in the usual sense — it holds one route's
 * full Relay ingest URL. The last path segment of that URL *is* the credential (Relay's
 * ingest endpoint authenticates on the path token alone; see
 * `apps/proxy/src/routes/ingest.ts` in the coreframe-relay repo). There is no separate
 * "API key" concept to layer on top of it, so this type has no `authenticate` block —
 * the Relay node reads `ingestUrl` directly and uses it as the request URL, rather than
 * n8n's generic auth-injection mechanism.
 *
 * `test` sends a real request through Relay's own test-marker path (`x-relay-event:
 * test`, documented in docs/integrations/n8n.md and honoured by ingest.ts): it proves
 * the URL is a live, active Relay route without writing a row into the customer's real
 * delivery counts.
 *
 * The `rules` array below is what turns that into a MEANINGFUL test rather than "got a
 * 2xx from something". n8n's declarative credential test only checks the HTTP status by
 * default, which would also pass for a URL that happens to answer 200 with an unrelated
 * body — the same "pasted the dashboard URL instead of the ingest URL" mistake
 * `isLikelyIngestUrl` guards against node-side. `ingest.ts` has one documented success
 * shape, `{ status: 'queued', requestId }` (see the 200 response at the end of that
 * handler) — asserting on it here means a credential that "passes" really did reach a
 * live Relay route, not merely some HTTPS endpoint.
 */
export class RelayIngestApi implements ICredentialType {
	name = 'relayIngestApi';

	displayName = 'Relay Ingest URL';

	documentationUrl = 'https://github.com/CoreframeLabs/coreframe-relay/blob/main/docs/integrations/n8n.md';

	properties: INodeProperties[] = [
		{
			displayName: 'Where To Find This',
			name: 'notice',
			type: 'notice',
			default: '',
			description:
				'In Relay: Buffer → Routes → New Route. Set the route\'s Destination to this workflow\'s ' +
				'n8n Production Webhook URL, then copy the "Get Relay URL" value shown on the last step. ' +
				'Full setup: docs/integrations/n8n.md in the coreframe-relay repo.',
		},
		{
			displayName: 'Ingest URL',
			name: 'ingestUrl',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'https://<relay-proxy-host>/in/<team-slug>/<route-slug>/<ingest-token>',
			description:
				"The full ingest URL for one Relay route, including the ingest-token path segment. " +
				'This is a secret — anyone with it can send traffic through your route.',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.ingestUrl}}',
			url: '',
			method: 'POST',
			headers: {
				'x-relay-event': 'test',
				'content-type': 'application/json',
			},
			body: {
				source: 'n8n-nodes-relay',
				event: 'credential-test',
			},
		},
		rules: [
			{
				type: 'responseSuccessBody',
				properties: {
					key: 'status',
					value: 'queued',
					message:
						"Got an HTTP success response, but not Relay's — this URL answered 200 without the " +
						'expected {"status":"queued"} body. Double check this is the ingest URL from the last ' +
						'step of Relay\'s New Route wizard, not the dashboard page for the route.',
				},
			},
		],
	};
}
