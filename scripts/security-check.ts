/**
 * Security report for every deploy bundle in catalog/deploy/.
 *
 * Derives each bundle's security profile (src/utils/security-profile.ts, the same
 * code the storefront uses) and compares its findings with the committed baseline
 * (catalog/security-baseline.json). Existing findings are tolerated; only NEW ones
 * are reported as such ("ratchet"), so CI can tighten without breaking current tools.
 *
 *   yarn security-check                    report only (always exits 0)
 *   yarn security-check --strict           exit 1 if any finding is not in the baseline
 *   yarn security-check --update-baseline  rewrite the baseline from current findings
 *   yarn security-check --json             machine-readable output
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { deriveProfile, findingKeys, SecurityProfile } from '../src/utils/security-profile';

const ROOT = join(__dirname, '..');
const DEPLOY_DIR = join(ROOT, 'catalog', 'deploy');
const BASELINE = join(ROOT, 'catalog', 'security-baseline.json');

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
let newCount = 0;
const report = Object.entries(profiles).map(([tool, p]) => {
  const known = new Set(baseline.tools[tool] || []);
  const keys = findingKeys(p);
  const fresh = keys.filter((k) => !known.has(k));
  const fixed = [...known].filter((k) => !keys.includes(k));
  newCount += fresh.length;
  return { tool, level: p.level, findings: p.findings, newFindings: fresh, fixedFindings: fixed };
});

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
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
}

if (strict && newCount > 0) process.exit(1);
