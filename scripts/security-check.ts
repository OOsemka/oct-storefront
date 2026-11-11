/**
 * Security report for every deploy bundle in catalog/deploy/.
 *
 * Derives each bundle's security profile (src/utils/security-profile.ts, the same
 * code the storefront uses) and compares its findings with the committed baseline.
 * "Bundles" are everything the storefront can install: catalog/deploy/<tool>.yaml,
 * inline deployYAML on a catalog row or tool, and deployURLs that point into this
 * repository on GitHub (mapped to the local file). A deployURL elsewhere can't be
 * checked here and fails --strict
 * (catalog/security-baseline.json). Existing findings are tolerated; only NEW ones
 * are reported as such ("ratchet"), so CI can tighten without breaking current tools.
 *
 *   yarn security-check                    report; exits 1 only on a hard rule (below)
 *   yarn security-check --strict           CI mode: also exit 1 on a new finding, a stale baseline
 *                                          entry (fixed, or its bundle is gone) or a declaration
 *                                          mismatch, so the baseline only ever shrinks
 *   yarn security-check --update-baseline  rewrite the baseline from current findings
 *   yarn security-check --mark-reviewed <tool...|all>
 *                                          record that these tools' spec.security declarations
 *                                          were checked against their current bundles
 *   yarn security-check --json             machine-readable output
 *
 * Hard rules (fail even without --strict, never tolerated by the baseline):
 *   - a bundle that is not valid YAML or contains no Kubernetes objects (it would
 *     otherwise derive as a harmless, empty profile);
 *   - a Secret with data inside a bundle (credentials must never ship in a manifest);
 *   - a catalog row whose inline deployYAML has a NetworkPolicy but no
 *     versions[].minStorefront of at least 1.6.0 (older storefronts can't apply it).
 * Declaration checks: spec.security.level lower than the derived level, Routes in the
 * bundle that spec.security.network.routes doesn't list (both fail under --strict),
 * and tools with no declaration at all (always only a note: declarations are optional).
 * Declaration drift (fails under --strict): a declared tool's bundle changed, apart from
 * image tags, digests and version labels, since its declaration was last reviewed
 * (catalog/declaration-review.json). Static checks can't see everything a bundle does
 * (for example a new CRD field that publishes Routes at runtime), so a person looks.
 */
import { createHash } from 'crypto';
import { loadAll } from 'js-yaml';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { canonicalBundle } from '../src/utils/bundle-fingerprint';
import { compareSemver } from '../src/utils/catalog-types';
import { parseToolList } from '../src/utils/parse-tools';
import { deriveProfile, findingKeys, levelRank, parseBundle, SecurityProfile } from '../src/utils/security-profile';

const ROOT = join(__dirname, '..');
const DEPLOY_DIR = join(ROOT, 'catalog', 'deploy');
const BASELINE = join(ROOT, 'catalog', 'security-baseline.json');
const CATALOG = join(ROOT, 'catalog', 'community.yaml');
const REVIEWED = join(ROOT, 'catalog', 'declaration-review.json');
const HARD_FINDINGS = new Set(['secret-with-data']);
const NETWORK_POLICY_MIN_STOREFRONT = '1.6.0';

type Baseline = { comment: string; tools: Record<string, string[]> };
type Reviewed = { comment: string; tools: Record<string, string> };

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const update = args.has('--update-baseline');
const asJson = args.has('--json');
const argv = process.argv.slice(2);
const markAt = argv.indexOf('--mark-reviewed');
const markTools = markAt >= 0 ? argv.slice(markAt + 1).filter((a) => !a.startsWith('--')) : null;

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE)) return { comment: '', tools: {} };
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
}

/**
 * deployURLs into this repository, any ref: checked against the local file. The
 * repository moved from OOsemka to openshift-community-tools; GitHub redirects the
 * old URLs, so both owners count as this repository.
 */
const REPO_RAW = /^https:\/\/raw\.githubusercontent\.com\/(?:openshift-community-tools|OOsemka)\/oct-storefront\/[^/]+\/(.+)$/;
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

// Every bundle the storefront could install, keyed by an id: "<tool>" for
// catalog/deploy/<tool>.yaml, "<tool> inline <hash>" for inline deployYAML (same
// content on several rows is one bundle), "<tool> <path>" for a deployURL into
// this repository.
const bundleText: Record<string, string> = {};
const bundleTool: Record<string, string> = {};
const remoteUnchecked: string[] = [];
for (const file of readdirSync(DEPLOY_DIR).filter((f) => f.endsWith('.yaml')).sort()) {
  const id = file.replace(/\.yaml$/, '');
  bundleText[id] = readFileSync(join(DEPLOY_DIR, file), 'utf8');
  bundleTool[id] = id;
}
const tools = existsSync(CATALOG) ? parseToolList(readFileSync(CATALOG, 'utf8'), 'community') : [];
for (const t of tools) {
  const tool = t.metadata.name;
  const sources = [
    { label: 'spec', deployYAML: t.spec.deployYAML, deployURL: t.spec.deployURL },
    ...(t.spec.versions || []).map((v) => ({ label: `${v.version || '?'} (${([] as string[]).concat((v.openshift as unknown as string[] | string) || []).join(',')})`, deployYAML: v.deployYAML, deployURL: v.deployURL })),
  ];
  for (const src of sources) {
    if (src.deployYAML?.trim()) {
      const id = `${tool} inline ${sha(src.deployYAML).slice(0, 12)}`;
      bundleText[id] = src.deployYAML;
      bundleTool[id] = tool;
    } else if (src.deployURL) {
      const m = REPO_RAW.exec(src.deployURL);
      const path = m ? join(ROOT, m[1]) : '';
      if (m && existsSync(path)) {
        const id = `${tool} ${m[1]}`;
        bundleText[id] = readFileSync(path, 'utf8');
        bundleTool[id] = tool;
      } else {
        remoteUnchecked.push(`${tool} ${src.label}: ${src.deployURL}`);
      }
    }
  }
}
// A bundle that doesn't parse would derive as an empty, "plugin"-level profile (the
// derivation never throws), so an invalid manifest could look harmless. Fail instead.
const unparsable: string[] = [];
for (const id of Object.keys(bundleText).sort()) {
  try {
    const docs = (loadAll(bundleText[id]) as unknown[]).filter((d) => d && typeof d === 'object' && (d as { kind?: string }).kind);
    if (docs.length === 0) unparsable.push(`${id}: contains no Kubernetes objects`);
  } catch (e) {
    unparsable.push(`${id}: invalid YAML (${(e as Error).message.split('\n')[0]})`);
  }
}
const profiles: Record<string, SecurityProfile> = {};
const fingerprints: Record<string, string> = {};
for (const id of Object.keys(bundleText).sort()) {
  profiles[id] = deriveProfile(bundleText[id], { ownsStorefrontNamespace: bundleTool[id] === 'oct-storefront' });
  fingerprints[id] = `sha256:${sha(canonicalBundle(bundleText[id]))}`;
}

function loadReviewed(): Reviewed {
  if (!existsSync(REVIEWED)) return { comment: '', tools: {} };
  return JSON.parse(readFileSync(REVIEWED, 'utf8')) as Reviewed;
}

const bundlesOf = (tool: string) => Object.keys(bundleTool).filter((id) => bundleTool[id] === tool);

if (markTools) {
  const declared = tools.filter((t) => t.spec.security && bundlesOf(t.metadata.name).length).map((t) => t.metadata.name);
  const wanted = markTools.length === 0 || markTools.includes('all') ? declared : markTools;
  const unknown = wanted.filter((t) => !declared.includes(t));
  if (wanted.length === 0 || unknown.length) {
    console.error(`--mark-reviewed: ${unknown.length ? `not a declared tool with a bundle: ${unknown.join(', ')}` : 'no declared tools'}`);
    process.exit(1);
  }
  const cur = loadReviewed();
  const marked: Record<string, string> = {};
  for (const t of declared) {
    for (const id of bundlesOf(t)) {
      if (wanted.includes(t)) marked[id] = fingerprints[id];
      else if (cur.tools[id]) marked[id] = cur.tools[id];
    }
  }
  const out: Reviewed = {
    comment:
      'Fingerprint of each bundle (catalog/deploy, ignoring image tags, digests and version labels) when its ' +
      'spec.security declaration was last checked. Update with `yarn security-check --mark-reviewed <tool>` ' +
      'after checking the declaration still describes the bundle (scripts/security-check.ts).',
    tools: marked,
  };
  writeFileSync(REVIEWED, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Marked reviewed: ${wanted.join(', ')}`);
  process.exit(0);
}

if (update) {
  const out: Baseline = {
    comment:
      'Known security findings per bundle (scripts/security-check.ts). CI tolerates these and flags new ones. ' +
      'Remove entries as tools are fixed; an empty file is the goal.',
    tools: Object.fromEntries(Object.entries(profiles).map(([tool, p]) => [tool, findingKeys(p)])),
  };
  writeFileSync(BASELINE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${BASELINE}`);
  process.exit(0);
}

const baseline = loadBaseline();
const hard: string[] = unparsable.map((u) => `${u}; the security profile can't be derived`);
const declarationWarnings: string[] = [];
let newCount = 0;
let staleCount = 0;
const report = Object.entries(profiles).map(([tool, p]) => {
  const known = new Set(baseline.tools[tool] || []);
  const keys = findingKeys(p);
  const fresh = keys.filter((k) => !known.has(k));
  const fixed = [...known].filter((k) => !keys.includes(k));
  newCount += fresh.length;
  staleCount += fixed.length;
  // Hard rules are never tolerated, not even when someone adds them to the baseline.
  keys
    .filter((k) => HARD_FINDINGS.has(k.split(' ')[0]))
    .forEach((k) => hard.push(`${tool}: ${k} (never ship credentials in a manifest; create the Secret at runtime or reference an existing one)`));
  return { tool, level: p.level, findings: p.findings, newFindings: fresh, fixedFindings: fixed };
});

// Baseline entries for bundles that no longer exist.
const goneTools = Object.keys(baseline.tools).filter((tool) => !profiles[tool] && (baseline.tools[tool] || []).length);
goneTools.forEach((tool) => (staleCount += baseline.tools[tool].length));

// Declarations, compared with every bundle of the tool.
const undeclared: string[] = [];
const reviewed = loadReviewed();
const declarationDrift: string[] = [];
const declaredWithBundle = new Set<string>();
for (const t of tools) {
  const id = t.metadata.name;
  const declared = t.spec.security;
  const ids = bundlesOf(id);
  if (ids.length && !declared) undeclared.push(id);
  if (declared) {
    for (const b of ids) {
      const profile = profiles[b];
      declaredWithBundle.add(b);
      if (!reviewed.tools[b]) {
        declarationDrift.push(`${b}: declaration never marked as reviewed against this bundle`);
      } else if (reviewed.tools[b] !== fingerprints[b]) {
        declarationDrift.push(`${b}: bundle changed since its declaration was last reviewed`);
      }
      if (declared.level && levelRank(profile.level) > levelRank(declared.level)) {
        declarationWarnings.push(`${b}: declares level ${declared.level}, but the bundle needs ${profile.level}`);
      }
      const listed = new Set((declared.network?.routes || []).map((r) => r.name));
      profile.routes
        .filter((r) => !listed.has(r.name))
        .forEach((r) => declarationWarnings.push(`${b}: Route ${r.name} is not listed in spec.security.network.routes (say why it is needed)`));
    }
  }
  for (const v of t.spec.versions || []) {
    const inline = v.deployYAML || '';
    if (!inline.includes('NetworkPolicy')) continue;
    const hasNp = parseBundle(inline).some((d) => d.kind === 'NetworkPolicy');
    if (hasNp && (!v.minStorefront || compareSemver(v.minStorefront, NETWORK_POLICY_MIN_STOREFRONT) < 0)) {
      hard.push(`${id} ${v.version || ''}: inline deployYAML has a NetworkPolicy; set versions[].minStorefront: "${NETWORK_POLICY_MIN_STOREFRONT}" or newer`);
    }
  }
}

Object.keys(reviewed.tools)
  .filter((id) => !declaredWithBundle.has(id))
  .forEach((id) => declarationDrift.push(`${id}: review entry for a tool without a declared bundle (remove it with --mark-reviewed all)`));

if (asJson) {
  console.log(
    JSON.stringify({ tools: report, goneTools, hard, declarationWarnings, declarationDrift, remoteUnchecked, undeclared, newCount, staleCount }, null, 2),
  );
} else {
  console.log('Security report (catalog/deploy)\n');
  for (const r of report) {
    const bySev = (s: string) => r.findings.filter((f) => f.severity === s).length;
    console.log(
      `${r.tool.padEnd(26)} level=${r.level.padEnd(13)} high=${bySev('high')} warn=${bySev('warn')} info=${bySev('info')}` +
        (r.newFindings.length ? `  NEW=${r.newFindings.length}` : '') +
        (r.fixedFindings.length ? `  fixed=${r.fixedFindings.length}` : ''),
    );
    for (const k of r.newFindings) console.log(`    + new: ${k}`);
    for (const k of r.fixedFindings) console.log(`    - no longer present (remove from baseline): ${k}`);
  }
  for (const tool of goneTools) console.log(`${tool.padEnd(26)} bundle removed: delete its ${baseline.tools[tool].length} baseline entr(ies)`);
  console.log(`\n${newCount} new finding(s) not in catalog/security-baseline.json.`);
  if (staleCount) console.log(`${staleCount} baseline entr(ies) no longer present.`);
  if (declarationWarnings.length) {
    console.log('\nDeclaration warnings:');
    declarationWarnings.forEach((w) => console.log(`  ! ${w}`));
  }
  if (remoteUnchecked.length) {
    console.log('\nRemote deployURLs CI cannot check (inline the manifest or point it into this repository):');
    remoteUnchecked.forEach((w) => console.log(`  ? ${w}`));
  }
  if (declarationDrift.length) {
    console.log('\nDeclaration drift (catalog/declaration-review.json):');
    declarationDrift.forEach((w) => console.log(`  ~ ${w}`));
  }
  if (undeclared.length) console.log(`\nNo spec.security declaration (shown as "Not declared"): ${undeclared.join(', ')}`);
  if (hard.length) {
    console.log('\nHARD RULES FAILED:');
    hard.forEach((h) => console.log(`  x ${h}`));
  }
}

const strictFailed =
  strict && (newCount > 0 || staleCount > 0 || declarationWarnings.length > 0 || declarationDrift.length > 0 || remoteUnchecked.length > 0);
if (strictFailed && !asJson) {
  console.log('\nSTRICT MODE FAILED (the CI ratchet):');
  if (newCount) console.log('  x New findings. Fix them, or accept them deliberately: yarn security-check --update-baseline, and say why in the PR.');
  if (staleCount) console.log('  x Fixed findings are still in the baseline. Remove them: yarn security-check --update-baseline (check the diff only removes lines).');
  if (declarationWarnings.length) console.log('  x A declaration does not match its bundle (see "Declaration warnings"). Fix spec.security in catalog/community.yaml.');
  if (remoteUnchecked.length) console.log('  x A catalog row installs from a deployURL outside this repository, which CI cannot check.');
  if (declarationDrift.length) {
    console.log(
      '  x A bundle changed since its declaration was reviewed (see "Declaration drift"). Read the bundle diff, make sure spec.security\n' +
        '    still describes what it does (Routes, RBAC, runtime-created objects, new CRD fields that expose things), then run\n' +
        '    yarn security-check --mark-reviewed <tool>.',
    );
  }
}
if (hard.length || strictFailed) process.exit(1);
