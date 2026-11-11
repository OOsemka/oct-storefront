import { describe, expect, it } from 'vitest';
import { semverFromImage } from '../bundle-check';

describe('semverFromImage', () => {
  it('reads the semver from an -ocp tag', () => {
    expect(semverFromImage('quay.io/org/oct-x:1.2.3-ocp4.22')).toBe('1.2.3');
    expect(semverFromImage('quay.io/org/oct-x:v1.2.3')).toBe('1.2.3');
  });
  it('keeps working for digest-pinned references that still carry the tag', () => {
    expect(semverFromImage('quay.io/org/oct-x:1.2.3-ocp4.22@sha256:' + 'a'.repeat(64))).toBe('1.2.3');
  });
  it('returns undefined when there is no usable tag', () => {
    expect(semverFromImage('quay.io/org/oct-x@sha256:' + 'b'.repeat(64))).toBeUndefined();
    expect(semverFromImage('quay.io/org/oct-x')).toBeUndefined();
    expect(semverFromImage('quay.io/org/oct-x:latest')).toBeUndefined();
    expect(semverFromImage('registry:5000/oct-x')).toBeUndefined();
  });
});
