/**
 * Catalog tile marks shipped in the storefront webpack bundle.
 *
 * CommunityTool `spec.icon` should be a bundled key such as `tiles/oct-baremetal.svg`,
 * not a GitHub-raw or lab URL. Tiles also fall back to `metadata.name` / `consolePlugin`.
 *
 * To add an icon for a new extension:
 * 1. Draw an original SVG (64×64, readable at ~40px) in `src/assets/tiles/oct-<name>.svg`.
 * 2. `register('oct-<name>', importedUrl)` below.
 * 3. Set `spec.icon: tiles/oct-<name>.svg` in `catalog/community.yaml` and `deploy/install.yaml`.
 */
import { CommunityTool } from './catalog-types';
import octBaremetal from '../assets/tiles/oct-baremetal.svg';
import octBanner from '../assets/tiles/oct-banner.svg';
import octNetworkBond from '../assets/tiles/oct-network-bond.svg';
import octWindowsBuilder from '../assets/tiles/oct-windows-builder.svg';

const BUNDLED: Record<string, string> = {};

function register(id: string, url: string): void {
  BUNDLED[id] = url;
  BUNDLED[`${id}.svg`] = url;
  BUNDLED[`tiles/${id}.svg`] = url;
}

register('oct-baremetal', octBaremetal);
register('oct-banner', octBanner);
register('oct-network-bond', octNetworkBond);
/** Original paperclip assistant (googly eyes + eyebrows). Not Microsoft Clippy art. */
register('oct-windows-builder', octWindowsBuilder);

function normalizeIconKey(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (s.startsWith('data:') || /^https?:\/\//i.test(s)) return s;
  return s.replace(/^\.?\//, '').replace(/^(src\/)?(assets\/)?/, '');
}

function lookupBundled(key: string): string | undefined {
  if (BUNDLED[key]) return BUNDLED[key];
  const base = key.split('/').pop() || key;
  if (BUNDLED[base]) return BUNDLED[base];
  return BUNDLED[base.replace(/\.svg$/i, '')];
}

/** Resolve a tile image src from spec.icon or the plugin id. */
export function resolveTileIcon(tool: CommunityTool): string | undefined {
  const candidates = [tool.spec.icon, tool.metadata.name, tool.spec.consolePlugin];
  for (const raw of candidates) {
    if (!raw) continue;
    const key = normalizeIconKey(raw);
    if (!key) continue;
    if (key.startsWith('data:') || /^https?:\/\//i.test(key)) return raw.trim();
    const hit = lookupBundled(key);
    if (hit) return hit;
  }
  return undefined;
}
