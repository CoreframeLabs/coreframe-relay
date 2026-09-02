import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

/**
 * What this node is, precisely — read before extending it.
 *
 * Relay's documented, working integration with n8n (docs/integrations/n8n.md in the
 * coreframe-relay repo) is: an external sender (Stripe, Shopify, ...) posts to a Relay
 * ingest URL; Relay durably queues and retries; Relay forwards to your n8n workflow's
 * OWN Production Webhook URL. n8n's native Webhook trigger node receives that forward —
 * no Relay-specific node is needed, or possible, on that side. Nothing here re-implements
 * that receiving path.
 *
 * What this node DOES do: it is the counterpart direction — a workflow that wants to call
 * an external destination through Relay's queue/retry/DLQ machinery instead of a bare
 * HTTP call, using Relay's own public, already-shipped ingest endpoint
 * (`apps/proxy/src/routes/ingest.ts`, `POST /in/:teamSlug/:routeSlug/:ingestToken`).
 * That endpoint requires no new backend work — it already accepts arbitrary sender
 * traffic, which is the entire point of it.
 *
 * What this node deliberately does NOT do, and why:
 *   - It does not create, list, or configure Relay routes. No public, API-key-authenticated
 *     endpoint for that exists yet in the dashboard (`apps/dashboard/pages/api/teams/...`
 *     routes are all gated by a NextAuth session cookie via `getCurrentUserWithTeam`, not
 *     by a bearer token an external node could hold) — building against it would mean
 *     inventing an API that isn't there. Create the route in Relay's own dashboard first.
 *   - It does not read or display live DELIVERED/RETRYING/DLQ status, and cannot offer a
 *     "wait for delivery confirmation" mode. `GET /api/teams/:slug/relay/log` DOES exist
 *     and returns exactly this, but it authenticates with a NextAuth session cookie
 *     (`throwIfNoTeamAccess` → `getSession`), which an n8n credential has no way to hold.
 *     The team-API-key mechanism in `models/apiKey.ts` looks like an alternative but isn't
 *     one yet: `getApiKey()`'s only caller today is the key's own delete-guard, not any
 *     data-reading endpoint. See README.md, "Why there's no delivery-status polling".
 */
export class Relay implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Relay',
		name: 'relay',
		icon: 'file:relay.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["bodySource"] === "custom" ? "Send custom body" : "Send input item"}}',
		description:
			"Send this item to a Relay route's ingest URL for durable, retried delivery. Does not create routes or read delivery status.",
		defaults: { name: 'Relay' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [
			{
				name: 'relayIngestApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Body',
				name: 'bodySource',
				type: 'options',
				options: [
					{
						name: 'Entire Input Item',
						value: 'item',
						description: "Send this item's JSON as the request body, unchanged",
					},
					{
						name: 'Custom JSON',
						value: 'custom',
						description: 'Provide the request body explicitly, as JSON or an expression',
					},
				],
				default: 'item',
			},
			{
				displayName: 'Custom Body',
				name: 'customBody',
				type: 'json',
				default: '{}',
				displayOptions: { show: { bodySource: ['custom'] } },
				description: 'The JSON body to send to the Relay ingest URL',
			},
			{
				displayName: 'Mark As Test Request',
				name: 'markAsTest',
				type: 'boolean',
				default: false,
				description:
					"Whether to tag this request with Relay's own test marker (x-relay-event: test), so it " +
					"shows up as TEST in Relay's delivery log instead of being counted as production traffic",
			},
			{
				displayName: 'Headers',
				name: 'headers',
				placeholder: 'Add Header',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				description:
					'Extra headers to send alongside the payload. Relay forwards these to your destination ' +
					'(minus a small set of hop-by-hop and credential headers Relay strips on every route).',
				options: [
					{
						name: 'header',
						displayName: 'Header',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('relayIngestApi');
		const ingestUrl = String(credentials.ingestUrl ?? '').trim();

		// Fail once, up front, with a specific and correctable message, rather than let a
		// malformed credential surface as a generic connection error per item.
		if (!isLikelyIngestUrl(ingestUrl)) {
			throw new NodeOperationError(
				this.getNode(),
				'The Relay Ingest URL credential does not look like a Relay ingest URL ' +
					'(expected https://<host>/in/<team-slug>/<route-slug>/<ingest-token>). ' +
					"Copy it again from Relay's Routes page — see docs/integrations/n8n.md, step 3.",
			);
		}

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const bodySource = this.getNodeParameter('bodySource', itemIndex, 'item') as string;
				const markAsTest = this.getNodeParameter('markAsTest', itemIndex, false) as boolean;
				const headerCollection = this.getNodeParameter('headers', itemIndex, {}) as {
					header?: Array<{ name: string; value: string }>;
				};

				const body: IDataObject =
					bodySource === 'custom'
						? (this.getNodeParameter('customBody', itemIndex, {}) as IDataObject)
						: items[itemIndex]?.json ?? {};

				const extraHeaders: IDataObject = {};
				for (const header of headerCollection.header ?? []) {
					if (header.name) extraHeaders[header.name] = header.value;
				}
				if (markAsTest) {
					extraHeaders['x-relay-event'] = 'test';
				}

				const options: IHttpRequestOptions = {
					method: 'POST',
					url: ingestUrl,
					json: true,
					body,
					headers: extraHeaders,
					returnFullResponse: true,
				};

				const response = (await this.helpers.httpRequest(options)) as {
					statusCode: number;
					body?: IDataObject;
				};

				returnData.push({
					json: {
						ok: true,
						statusCode: response.statusCode,
						...(response.body ?? {}),
					},
					pairedItem: itemIndex,
				});
			} catch (error) {
				const description = describeRelayError(error);
				if (this.continueOnFail()) {
					returnData.push({
						json: { ok: false, error: description },
						pairedItem: itemIndex,
					});
					continue;
				}

				// [n8n error-handling reference, docs.n8n.io/.../reference/error-handling] this is
				// a failure ATTRIBUTABLE TO CALLING RELAY'S API — a non-2xx response, a timeout, a
				// DNS failure — so it is a NodeApiError, not a NodeOperationError. NodeApiError is
				// the class n8n's own nodes use for exactly this case; it renders with the request
				// context, the underlying `errorResponse` in the item's "Show error details" panel,
				// and (when `httpCode` is set) filters by status code in n8n's error-history UI.
				// The credential-shape check above this loop stays a NodeOperationError deliberately
				// — that failure is a misconfigured node, not a rejected API call, which is the
				// documented dividing line between the two classes.
				const statusCode = extractStatusCode(error);
				throw new NodeApiError(this.getNode(), error as JsonObject, {
					message: relayErrorTitle(statusCode),
					description,
					httpCode: statusCode !== undefined ? String(statusCode) : undefined,
					itemIndex,
				});
			}
		}

		return [returnData];
	}
}

/**
 * Cheap, deliberately loose shape check — not full validation. Its only job is to turn
 * "pasted the dashboard URL instead of the ingest URL" or "left the field empty" into an
 * actionable message before a request goes out, not to replace Relay's own token check.
 */
export function isLikelyIngestUrl(url: string): boolean {
	return /^https:\/\/[^/\s]+\/in\/[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(url);
}

/**
 * Defensive about the error's shape on purpose: `this.helpers.httpRequest` wraps a
 * non-2xx response in an error object, but the exact property names it exposes have
 * shifted across n8n-workflow versions, so this checks a few plausible locations rather
 * than asserting one. Shared by `describeRelayError` (the human-readable description)
 * and the node's catch block (the `httpCode` it hands to `NodeApiError`), so the two
 * never disagree about which status code a given error actually carries.
 */
export function extractStatusCode(error: unknown): number | undefined {
	const err = error as {
		statusCode?: number;
		httpCode?: string | number;
		response?: { statusCode?: number; status?: number };
		cause?: { response?: { statusCode?: number; status?: number } };
	};
	if (err.statusCode !== undefined) return err.statusCode;
	if (err.response?.statusCode !== undefined) return err.response.statusCode;
	// [Verified against a real n8n 2.37.7 instance, not just the unit tests' mocked
	// shape] `this.helpers.httpRequest`'s underlying client is axios, and an axios
	// error carries the HTTP status at `error.response.status` — NOT `.statusCode`.
	// Without this branch, a real httpRequest failure fell through to `undefined`
	// here even though `NodeApiError`'s OWN internal fallback (a wider property
	// search) still found 404 on `errorResponse`, so the thrown error's `httpCode`
	// looked right by accident while `relayErrorTitle`/`describeRelayError` — which
	// only see what THIS function returns — silently produced the generic "Request
	// to Relay failed" title instead of the specific, actionable one. This is the
	// exact "property names shift" risk the original comment on this function
	// warned about, caught by running the built node in Docker rather than only
	// against mocked `IExecuteFunctions`.
	if (err.response?.status !== undefined) return err.response.status;
	if (err.cause?.response?.statusCode !== undefined) return err.cause.response.statusCode;
	if (err.cause?.response?.status !== undefined) return err.cause.response.status;
	if (err.httpCode !== undefined) {
		const parsed = Number(err.httpCode);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

/**
 * A short, stable title per status code — this is the `message` handed to
 * `NodeApiError`, which n8n shows as the item's headline error in the canvas. Kept
 * separate from `describeRelayError`'s full sentence, which becomes the error's
 * `description` (the expandable detail), so the canvas shows a scannable title first
 * and the full explanation on demand rather than one long run-on headline.
 */
export function relayErrorTitle(statusCode: number | undefined): string {
	switch (statusCode) {
		case 404:
			return 'Relay route not found or ingest token invalid';
		case 413:
			return 'Relay rejected the payload: too large';
		case 429:
			return 'Relay is rate-limiting this team';
		case 502:
			return "Relay rejected the route's destination";
		case 503:
			return 'Relay is temporarily unavailable';
		default:
			return 'Request to Relay failed';
	}
}

/**
 * Maps the specific status codes `apps/proxy/src/routes/ingest.ts` is documented to
 * return into the same explanation `docs/integrations/n8n.md` already gives a human
 * reading the delivery log — so a workflow builder sees the same story whether they're
 * looking at the dashboard or at this node's error. Becomes the `description` on the
 * `NodeApiError` thrown in `execute()` — see `extractStatusCode` above for why the
 * status-code parsing itself lives in one place.
 */
export function describeRelayError(error: unknown): string {
	const err = error as {
		response?: { headers?: Record<string, string> };
		message?: string;
	};

	const statusCode = extractStatusCode(error);

	switch (statusCode) {
		case 404:
			return (
				'Relay returned 404 Not Found. This usually means the ingest URL is wrong, the route ' +
				"was deleted, or the ingest token was rotated — copy a fresh URL from Relay's Routes page."
			);
		case 413:
			return 'Relay rejected the request: payload too large (over 1 MiB). Reduce the body size.';
		case 429: {
			const retryAfter = err.response?.headers?.['retry-after'];
			return (
				'Relay is rate-limiting this team' +
				(retryAfter ? ` — retry after ${retryAfter}s.` : '.') +
				' This is a per-team limit, not specific to this request.'
			);
		}
		case 502:
			return (
				"Relay accepted the request but rejected the route's configured destination (its own " +
				'anti-SSRF check — the destination may resolve to a private or loopback address). Check ' +
				"the destination URL on this route in Relay's dashboard."
			);
		case 503:
			return (
				'Relay is temporarily unavailable (a queue-publish or lookup failure on its side). This ' +
				'is safe to retry — Relay itself treats a 5xx the same way toward its own senders.'
			);
		default:
			return (
				'Request to Relay failed' +
				(statusCode ? ` with status ${statusCode}` : '') +
				`: ${err.message ?? String(error)}`
			);
	}
}
