import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { canonicalBundle, imageRepository } from '../bundle-fingerprint';

const BASE = `
apiVersion: v1
kind: Namespace
metadata: { name: oct-x, labels: { app.kubernetes.io/version: "1.0.0" } }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: oct-x
  namespace: oct-x
  labels: { communitytools.io/extension-version: "1.0.0", app: oct-x }
spec:
  template:
    spec:
      containers:
        - { name: p, image: "quay.io/org/oct-x:1.0.0-ocp4.22", ports: [{ containerPort: 9443 }] }
      initContainers:
        - { name: i, image: "quay.io/org/init@sha256:aaaa" }
`;

describe('imageRepository', () => {
  it('drops tags and digests but keeps registry ports', () => {
    expect(imageRepository('quay.io/org/img:1.2.3')).toBe('quay.io/org/img');
    expect(imageRepository('quay.io/org/img:1.2.3@sha256:abcd')).toBe('quay.io/org/img');
    expect(imageRepository('quay.io/org/img@sha256:abcd')).toBe('quay.io/org/img');
    expect(imageRepository('registry.local:5000/org/img:2')).toBe('registry.local:5000/org/img');
    expect(imageRepository('registry.local:5000/org/img')).toBe('registry.local:5000/org/img');
    expect(imageRepository('ubi9')).toBe('ubi9');
  });
});

describe('canonicalBundle', () => {
  const same = (a: string, b: string) => expect(canonicalBundle(a)).toBe(canonicalBundle(b));
  const differs = (a: string, b: string) => expect(canonicalBundle(a)).not.toBe(canonicalBundle(b));

  it('ignores what every release changes: tags, digests, version labels, order', () => {
    same(BASE, BASE.replace(/1\.0\.0/g, '1.0.1').replace('sha256:aaaa', 'sha256:bbbb'));
    const [ns, dep] = BASE.split('---');
    same(BASE, `${dep}\n---\n${ns}`);
    same(BASE, BASE.replace('name: oct-x\n  namespace: oct-x', 'namespace: oct-x\n  name: oct-x'));
  });

  it('notices changes that can matter for security', () => {
    differs(BASE, BASE.replace('quay.io/org/oct-x', 'quay.io/other/oct-x'));
    differs(BASE, BASE.replace('containerPort: 9443', 'containerPort: 8080'));
    differs(BASE, BASE.replace('app: oct-x', 'app: oct-y'));
    differs(BASE, `${BASE}\n---\napiVersion: v1\nkind: Secret\nmetadata: { name: s, namespace: oct-x }\n`);
  });

  it('catches the Shift-on-Shift 0.5.0 CRD change but not the 0.5.2 tag bump', () => {
    const sos = readFileSync(join(__dirname, '../../../catalog/deploy/oct-shift-on-shift-virt.yaml'), 'utf8');
    same(sos, sos.replace(/:0\.5\.2-ocp4\.22/g, ':0.5.1-ocp4.22'));
    differs(sos, sos.replace(/ +publishAppRoutes:\n( +.*\n){2}/, ''));
  });
});
