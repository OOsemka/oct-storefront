/**
 * Canonical text of a deploy bundle for the declaration-drift check in
 * scripts/security-check.ts. Two bundles normalize to the same text when they
 * differ only in things a release changes every time: image tags and digests,
 * version labels, document order and key order. Anything else (RBAC, CRD
 * schemas, new objects, ports, env) changes the text, so the check asks for the
 * tool's spec.security declaration to be looked at again.
 *
 * Pure (no hashing here), so it can be unit-tested and never pulls Node-only
 * modules into the browser bundle.
 */
import { parseBundle } from './security-profile';

/** Labels that change with every release. */
const VERSION_LABELS = new Set(['communitytools.io/extension-version', 'app.kubernetes.io/version']);

/** `quay.io/org/img:1.2.3@sha256:...` → `quay.io/org/img` (a registry port such as `host:5000/` is kept). */
export function imageRepository(image: string): string {
  let s = image.trim().replace(/@sha256:[0-9a-fA-F]+$/, '');
  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  if (colon > slash) s = s.slice(0, colon);
  return s;
}

function normalize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === 'labels' && VERSION_LABELS.has(k)) continue;
      out[k] = normalize((value as Record<string, unknown>)[k], k);
    }
    return out;
  }
  if (key === 'image' && typeof value === 'string') return imageRepository(value);
  return value;
}

/** Canonical, order-independent text of a bundle; '' when it has no documents. */
export function canonicalBundle(yaml: string): string {
  return parseBundle(yaml)
    .map((d) => JSON.stringify(normalize(d)))
    .sort()
    .join('\n');
}
