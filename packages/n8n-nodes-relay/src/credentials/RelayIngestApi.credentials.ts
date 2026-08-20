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
	};
}
