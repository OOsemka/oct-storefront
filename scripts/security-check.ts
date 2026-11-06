/**
 * Security report for every deploy bundle in catalog/deploy/.
 *
 * Derives each bundle's security profile (src/utils/security-profile.ts, the same
 * code the storefront uses) and compares its findings with the committed baseline
 * (catalog/security-baseline.json). Existing findings are tolerated; only NEW ones
 * are reported as such ("ratchet"), so CI can tighten without breaking current tools.
 *
 *   yarn security-check                    report; exits 1 only on a hard rule (below)
 *   yarn security-check --strict           also exit 1 if any finding is not in the baseline
 *   yarn security-check --update-baseline  rewrite the baseline from current findings
 *   yarn security-check --json             machine-readable output
 *
 * Hard rules (fail even without --strict; existing baseline entries are tolerated):
 *   - a Secret with data inside a bundle (credentials must never ship in a manifest);
 *   - a catalog row whose inline deployYAML has a NetworkPolicy but no
 *     versions[].minStorefront of at least 1.6.0 (older storefronts can't apply it).
 * Declaration checks (warnings): spec.security.level lower than the derived level,
 * Routes in the bundle that spec.security.network.routes doesn't list, tools with
 * no declaration at all.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { compareSemver } from '../src/utils/catalog-types';
import { parseToolList } from '../src/utils/parse-tools';
import { deriveProfile, findingKeys, levelRank, parseBundle, SecurityProfile } from '../src/utils/security-profile';

const ROOT = join(__dirname, '..');
const DEPLOY_DIR = join(ROOT, 'catalog', 'deploy');
const BASELINE = join(ROOT, 'catalog', 'security-baseline.json');
const CATALOG = join(ROOT, 'catalog', 'community.yaml');
const HARD_FINDINGS = new Set(['secret-with-data']);
const NETWORK_POLICY_MIN_STOREFRONT = '1.6.0';

type Baseline = { comment: string; tools: Record<string, string[]> };

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const update = args.has('--update-baseline');
const asJson = args.has('--json');

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE)) return { comment: '', tools: {} };
  return JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
}

const profiles: Record<string, SecurityProfile> = {};
for (const file of readdirSync(DEPLOY_DIR).filter((f) => f.endsWith('.yaml')).sort()) {
  profiles[file.replace(/\.yaml$/, '')] = deriveProfile(readFileSync(join(DEPLOY_DIR, file), 'utf8'));
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
const hard: string[] = [];
const declarationWarnings: string[] = [];
let newCount = 0;
const report = Object.entries(profiles).map(([tool, p]) => {
  const known = new Set(baseline.tools[tool] || []);
  const keys = findingKeys(p);
  const fresh = keys.filter((k) => !known.has(k));
  const fixed = [...known].filter((k) => !keys.includes(k));
  newCount += fresh.length;
  fresh
    .filter((k) => HARD_FINDINGS.has(k.split(' ')[0]))
    .forEach((k) => hard.push(`${tool}: ${k} (never ship credentials in a manifest; create the Secret at runtime or reference an existing one)`));
  return { tool, level: p.level, findings: p.findings, newFindings: fresh, fixedFindings: fixed };
});

// Catalog rows: declarations and inline manifests.
const tools = existsSync(CATALOG) ? parseToolList(readFileSync(CATALOG, 'utf8'), 'community') : [];
const undeclared: string[] = [];
for (const t of tools) {
  const id = t.metadata.name;
  const profile = profiles[id];
  const declared = t.spec.security;
  if (profile) {
    if (!declared) undeclared.push(id);
    else {
      if (declared.level && levelRank(profile.level) > levelRank(declared.level)) {
        declarationWarnings.push(`${id}: declares level ${declared.level}, but the bundle needs ${profile.level}`);
      }
      const listed = new Set((declared.network?.routes || []).map((r) => r.name));
      profile.routes
        .filter((r) => !listed.has(r.name))
        .forEach((r) => declarationWarnings.push(`${id}: Route ${r.name} is not listed in spec.security.network.routes (say why it is needed)`));
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

if (asJson) {
  console.log(JSON.stringify({ tools: report, hard, declarationWarnings, undeclared }, null, 2));
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
  console.log(`\n${newCount} new finding(s) not in catalog/security-baseline.json.`);
  if (declarationWarnings.length) {
    console.log('\nDeclaration warnings:');
    declarationWarnings.forEach((w) => console.log(`  ! ${w}`));
  }
  if (undeclared.length) console.log(`\nNo spec.security declaration (shown as "Not declared"): ${undeclared.join(', ')}`);
  if (hard.length) {
    console.log('\nHARD RULES FAILED:');
    hard.forEach((h) => console.log(`  x ${h}`));
  }
}

if (hard.length || (strict && newCount > 0)) process.exit(1);
