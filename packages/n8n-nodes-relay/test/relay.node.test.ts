import { describe, expect, it, vi } from 'vitest';
import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { Relay, describeRelayError, isLikelyIngestUrl } from '../src/nodes/Relay/Relay.node';

const VALID_URL = 'https://relay.example.com/in/acme/stripe-orders/tok_abc123';

/**
 * A minimal stand-in for n8n's IExecuteFunctions. This is the part of the honesty gap
 * documented in README.md: it exercises the node's own request-building and error-mapping
 * logic exactly as n8n would call it, but it is not n8n itself — nothing here proves the
 * node loads correctly inside a running n8n instance.
 */
function buildContext(opts: {
	items: INodeExecutionData[];
	credentials?: Record<string, unknown>;
	params?: Record<string, unknown>;
	httpRequest?: ReturnType<typeof vi.fn>;
	continueOnFail?: boolean;
}) {
	const { items, credentials = { ingestUrl: VALID_URL }, params = {}, continueOnFail = false } = opts;

	const httpRequest = opts.httpRequest ?? vi.fn().mockResolvedValue({ statusCode: 200, body: { status: 'queued', requestId: 'req_1' } });

	const ctx = {
		getInputData: () => items,
		getCredentials: vi.fn().mockResolvedValue(credentials),
		getNodeParameter: (name: string, _itemIndex: number, fallback?: unknown) =>
			name in params ? params[name] : fallback,
		continueOnFail: () => continueOnFail,
		getNode: () => ({ id: 'n1', name: 'Relay', type: 'relay', typeVersion: 1, position: [0, 0], parameters: {} }),
		helpers: { httpRequest },
	};

	return { ctx: ctx as unknown as IExecuteFunctions, httpRequest };
}

describe('isLikelyIngestUrl', () => {
	it('accepts a well-formed Relay ingest URL', () => {
		expect(isLikelyIngestUrl(VALID_URL)).toBe(true);
	});

	it('rejects the dashboard/marketing URL a user might paste by mistake', () => {
		expect(isLikelyIngestUrl('https://app.relay.example.com/teams/acme/routes')).toBe(false);
	});

	it('rejects an empty credential', () => {
		expect(isLikelyIngestUrl('')).toBe(false);
	});
});

describe('describeRelayError', () => {
	it('maps 404 to the rotated-token / wrong-route explanation', () => {
		expect(describeRelayError({ statusCode: 404 })).toMatch(/route was deleted|ingest token was rotated/);
	});

	it('maps 429 and surfaces retry-after when present', () => {
		const message = describeRelayError({ statusCode: 429, response: { headers: { 'retry-after': '30' } } });
		expect(message).toContain('retry after 30s');
	});

	it('maps 502 to the destination-rejected / anti-SSRF explanation', () => {
		expect(describeRelayError({ statusCode: 502 })).toMatch(/anti-SSRF/);
	});

	it('falls back to the raw message for an unmapped status', () => {
		expect(describeRelayError({ statusCode: 418, message: "I'm a teapot" })).toContain("I'm a teapot");
	});
});

describe('Relay node execute()', () => {
	it('POSTs the input item as the body to the credential ingest URL', async () => {
		const items: INodeExecutionData[] = [{ json: { orderId: 42 } }];
		const { ctx, httpRequest } = buildContext({ items, params: { bodySource: 'item', markAsTest: false, headers: {} } });

		const relay = new Relay();
		const result = await relay.execute.call(ctx);

		expect(httpRequest).toHaveBeenCalledTimes(1);
		const options = httpRequest.mock.calls[0][0];
		expect(options.method).toBe('POST');
		expect(options.url).toBe(VALID_URL);
		expect(options.body).toEqual({ orderId: 42 });
		expect(options.headers['x-relay-event']).toBeUndefined();

		expect(result[0][0].json).toMatchObject({ ok: true, statusCode: 200, status: 'queued', requestId: 'req_1' });
	});

	it('sets x-relay-event: test when Mark As Test Request is on', async () => {
		const items: INodeExecutionData[] = [{ json: {} }];
		const { ctx, httpRequest } = buildContext({ items, params: { bodySource: 'item', markAsTest: true, headers: {} } });

		await new Relay().execute.call(ctx);

		expect(httpRequest.mock.calls[0][0].headers['x-relay-event']).toBe('test');
	});

	it('sends the custom body instead of the input item when bodySource is custom', async () => {
		const items: INodeExecutionData[] = [{ json: { ignored: true } }];
		const { ctx, httpRequest } = buildContext({
			items,
			params: { bodySource: 'custom', customBody: { hello: 'world' }, markAsTest: false, headers: {} },
		});

		await new Relay().execute.call(ctx);

		expect(httpRequest.mock.calls[0][0].body).toEqual({ hello: 'world' });
	});

	it('forwards extra headers from the fixedCollection', async () => {
		const items: INodeExecutionData[] = [{ json: {} }];
		const { ctx, httpRequest } = buildContext({
			items,
			params: { bodySource: 'item', markAsTest: false, headers: { header: [{ name: 'X-Source', value: 'n8n' }] } },
		});

		await new Relay().execute.call(ctx);

		expect(httpRequest.mock.calls[0][0].headers['X-Source']).toBe('n8n');
	});

	it('throws a NodeOperationError up front for a malformed ingest URL credential, without calling httpRequest', async () => {
		const items: INodeExecutionData[] = [{ json: {} }];
		const { ctx, httpRequest } = buildContext({ items, credentials: { ingestUrl: 'not-a-url' } });

		await expect(new Relay().execute.call(ctx)).rejects.toThrow(/does not look like a Relay ingest URL/);
		expect(httpRequest).not.toHaveBeenCalled();
	});

	it('throws per item on failure when continueOnFail is off', async () => {
		const items: INodeExecutionData[] = [{ json: {} }];
		const httpRequest = vi.fn().mockRejectedValue({ statusCode: 404 });
		const { ctx } = buildContext({ items, params: { bodySource: 'item', markAsTest: false, headers: {} }, httpRequest, continueOnFail: false });

		await expect(new Relay().execute.call(ctx)).rejects.toThrow(/404 Not Found/);
	});

	it('collects a per-item error instead of throwing when continueOnFail is on', async () => {
		const items: INodeExecutionData[] = [{ json: {} }, { json: {} }];
		const httpRequest = vi
			.fn()
			.mockRejectedValueOnce({ statusCode: 404 })
			.mockResolvedValueOnce({ statusCode: 200, body: { status: 'queued' } });
		const { ctx } = buildContext({ items, params: { bodySource: 'item', markAsTest: false, headers: {} }, httpRequest, continueOnFail: true });

		const result = await new Relay().execute.call(ctx);

		expect(result[0]).toHaveLength(2);
		expect(result[0][0].json.ok).toBe(false);
		expect(result[0][1].json.ok).toBe(true);
	});
});
