/**
 * Unit tier (vitest) for GraphNode.link (docs/brief-bank/
 * linked-looks-stage-b.md, parent spec §4): sanitizeDevelopLink's lenient
 * posture (never throws — a malformed/absent link degrades quietly to "not
 * linked") and the load→save round trip (compat rule 9's node-level
 * unknown-field passthrough, which the brief required verifying BEFORE
 * relying on it — see this stage's report for the empirical check; it
 * already worked, this test pins that fact permanently).
 */
import { describe, expect, it } from 'vitest';
import { defaultGraphDoc, DEVELOP_KIND, parseGraphDoc, sanitizeDevelopLink, serializeGraphDoc } from './graphDoc';

describe('sanitizeDevelopLink', () => {
  it('absent -> undefined (every prior schema version)', () => {
    expect(sanitizeDevelopLink(undefined)).toBeUndefined();
  });
  it('never throws on structural garbage — degrades quietly to undefined', () => {
    expect(sanitizeDevelopLink('not an object')).toBeUndefined();
    expect(sanitizeDevelopLink(null)).toBeUndefined();
    expect(sanitizeDevelopLink(42)).toBeUndefined();
    expect(sanitizeDevelopLink({})).toBeUndefined(); // missing `look`
    expect(sanitizeDevelopLink({ look: '' })).toBeUndefined(); // blank look
  });
  it('fills in missing follows/materializedFrom leniently rather than rejecting the whole link', () => {
    expect(sanitizeDevelopLink({ look: 'my-look' })).toEqual({ look: 'my-look', follows: [], materializedFrom: '' });
  });
  it('round-trips a well-formed link verbatim', () => {
    const link = { look: 'my-look', follows: ['basic-tone', 'wb'], materializedFrom: 'abc123' };
    expect(sanitizeDevelopLink(link)).toEqual(link);
  });
  it('drops non-string entries from follows rather than rejecting the link', () => {
    expect(sanitizeDevelopLink({ look: 'x', follows: ['wb', 42, null], materializedFrom: 'h' })).toEqual({
      look: 'x',
      follows: ['wb'],
      materializedFrom: 'h',
    });
  });
});

describe('link field load->save round trip (compat rule 9 — node-level unknown-field passthrough)', () => {
  it('a well-formed link on the Develop node survives serialize -> parse -> serialize', () => {
    const doc = defaultGraphDoc();
    const dev = doc.nodes.find((n) => n.kind === DEVELOP_KIND)!;
    dev.link = { look: 'sunset-warm', follows: ['basic-tone', 'wb'], materializedFrom: 'deadbeef' };
    const text = serializeGraphDoc(doc, null, null);
    const parsed = parseGraphDoc(text);
    const parsedDev = parsed.graph.nodes.find((n) => n.kind === DEVELOP_KIND)!;
    expect(parsedDev.link).toEqual({ look: 'sunset-warm', follows: ['basic-tone', 'wb'], materializedFrom: 'deadbeef' });

    const rewritten = serializeGraphDoc(parsed.graph, null, null);
    const reparsed = parseGraphDoc(rewritten);
    expect(reparsed.graph.nodes.find((n) => n.kind === DEVELOP_KIND)!.link).toEqual({
      look: 'sunset-warm',
      follows: ['basic-tone', 'wb'],
      materializedFrom: 'deadbeef',
    });
  });

  it('an UNKNOWN node-level field (simulating a future build) survives an older build round trip verbatim — the general passthrough mechanism `link` itself relies on', () => {
    const doc = defaultGraphDoc();
    const text = serializeGraphDoc(doc, null, null);
    const obj = JSON.parse(text) as { graph: { nodes: Array<Record<string, unknown>> } };
    const devRaw = obj.graph.nodes.find((n) => n.type === DEVELOP_KIND)!;
    devRaw.futureField = { some: 'thing-a-future-build-added' };
    const injected = JSON.stringify(obj, null, 2) + '\n';

    const parsed = parseGraphDoc(injected);
    const parsedDevRaw = parsed.graph.nodes.find((n) => n.kind === DEVELOP_KIND) as unknown as Record<string, unknown>;
    expect(parsedDevRaw.futureField).toEqual({ some: 'thing-a-future-build-added' });

    const rewritten = serializeGraphDoc(parsed.graph, null, null);
    const rewrittenObj = JSON.parse(rewritten) as { graph: { nodes: Array<Record<string, unknown>> } };
    const rewrittenDevRaw = rewrittenObj.graph.nodes.find((n) => n.type === DEVELOP_KIND)!;
    expect(rewrittenDevRaw.futureField).toEqual({ some: 'thing-a-future-build-added' });
  });

  it('absent link on an older sidecar sanitizes to undefined, not a thrown error (back-compat)', () => {
    const doc = defaultGraphDoc();
    const text = serializeGraphDoc(doc, null, null); // no link ever set
    const parsed = parseGraphDoc(text);
    expect(parsed.graph.nodes.find((n) => n.kind === DEVELOP_KIND)!.link).toBeUndefined();
  });
});
