import { load, loadAll } from 'js-yaml';
import {
  CATEGORIES,
  COMMUNITY_TOOL_API,
  CommunityTool,
  CommunityToolSpec,
  DEFAULT_CHANNEL,
  PublicCatalog,
  PublicCatalogExtension,
  ToolCategory,
  ToolSource,
  ToolVersion,
  openshiftList,
} from './catalog-types';

function asString(v: unknown): string {
  return v == null ? '' : String(v).trim();
}

function asStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter(Boolean);
  if (typeof v === 'string' && v.trim()) {
    return v
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function asCategory(v: unknown): ToolCategory {
  const c = asString(v).toLowerCase();
  return (CATEGORIES as string[]).includes(c) ? (c as ToolCategory) : 'management';
}

function asSource(v: unknown, fallback: ToolSource): ToolSource {
  const s = asString(v).toLowerCase();
  if (s === 'external' || s === 'community') return s;
  return fallback;
}

/** Read validated OpenShift versions from validatedOn, versions[].openshift, or compatibility.openshift. */
function readValidatedOn(raw: Record<string, unknown>): string[] {
  const compatibility =
    raw.compatibility && typeof raw.compatibility === 'object'
      ? (raw.compatibility as Record<string, unknown>)
      : {};
  const fromValidated = asStringList(raw.validatedOn);
  if (fromValidated.length) return fromValidated;
  const fromVersions = asVersions(raw.versions).flatMap((v) => openshiftList(v));
  if (fromVersions.length) return fromVersions;
  return asStringList(compatibility.openshift);
}

function asChannels(v: unknown): Record<string, Record<string, unknown>> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  return v as Record<string, Record<string, unknown>>;
}

function asVersions(v: unknown): ToolVersion[] {
  if (!Array.isArray(v)) return [];
  const out: ToolVersion[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const openshift = asStringList(o.openshift);
    const version = asString(o.version) || undefined;
    const minOpenShift = asString(o.minOpenShift) || undefined;
    const maxOpenShift = asString(o.maxOpenShift) || undefined;
    if (!openshift.length && !version && !minOpenShift && !maxOpenShift) continue;
    out.push({
      version,
      channel: asString(o.channel) || undefined,
      openshift: openshift.length === 1 ? openshift[0] : openshift,
      minOpenShift,
      maxOpenShift,
      image: asString(o.image) || undefined,
      gitRef: asString(o.gitRef) || undefined,
      deployURL: asString(o.deployURL) || undefined,
      deployYAML: asString(o.deployYAML) || undefined,
    });
  }
  return out;
}

export function specFromUnknown(
  raw: Record<string, unknown>,
  fallbackSource: ToolSource,
): CommunityToolSpec {
  return {
    displayName: asString(raw.displayName) || asString(raw.name) || 'Untitled',
    description: asString(raw.description),
    category: asCategory(raw.category),
    source: asSource(raw.source, fallbackSource),
    git: asString(raw.git) || undefined,
    image: asString(raw.image) || undefined,
    consolePlugin: asString(raw.consolePlugin) || asString(raw.plugin) || '',
    href: asString(raw.href) || undefined,
    validatedOn: readValidatedOn(raw),
    minOpenShift: asString(raw.minOpenShift) || undefined,
    maxOpenShift: asString(raw.maxOpenShift) || undefined,
    deployURL: asString(raw.deployURL) || undefined,
    deployYAML: asString(raw.deployYAML) || undefined,
    defaultChannel: asString(raw.defaultChannel) || undefined,
    pinVersion: asString(raw.pinVersion) || asString(raw.version) || undefined,
    channels: asChannels(raw.channels),
    versions: asVersions(raw.versions).length ? asVersions(raw.versions) : undefined,
  };
}

export function toolFromDoc(doc: unknown, fallbackSource: ToolSource): CommunityTool | null {
  if (!doc || typeof doc !== 'object') return null;
  const obj = doc as Record<string, unknown>;
  const metadata =
    obj.metadata && typeof obj.metadata === 'object'
      ? (obj.metadata as Record<string, unknown>)
      : {};
  const specRaw =
    obj.spec && typeof obj.spec === 'object' ? (obj.spec as Record<string, unknown>) : obj;
  const name = asString(metadata.name) || asString(specRaw.consolePlugin) || asString(specRaw.id);
  if (!name) return null;
  const spec = specFromUnknown(specRaw, fallbackSource);
  if (!spec.consolePlugin) spec.consolePlugin = name;
  if (fallbackSource === 'external') spec.source = 'external';
  return {
    apiVersion: asString(obj.apiVersion) || COMMUNITY_TOOL_API,
    kind: asString(obj.kind) || 'CommunityTool',
    metadata: { name },
    spec,
  };
}

export function parseToolList(yamlText: string, fallbackSource: ToolSource): CommunityTool[] {
  if (!yamlText?.trim()) return [];
  const docs = loadAll(yamlText);
  const tools: CommunityTool[] = [];
  for (const doc of docs) {
    if (!doc) continue;
    if (typeof doc === 'object' && doc && Array.isArray((doc as { items?: unknown[] }).items)) {
      for (const item of (doc as { items: unknown[] }).items) {
        const tool = toolFromDoc(item, fallbackSource);
        if (tool) tools.push(tool);
      }
      continue;
    }
    const tool = toolFromDoc(doc, fallbackSource);
    if (tool) tools.push(tool);
  }
  return tools;
}

export function parseSingleTool(yamlText: string): { tool?: CommunityTool; error?: string } {
  try {
    const doc = load(yamlText);
    const tool = toolFromDoc(doc, 'external');
    if (!tool) return { error: 'YAML must be a CommunityTool document with metadata.name.' };
    tool.spec.source = 'external';
    if (!tool.spec.consolePlugin) {
      return { error: 'spec.consolePlugin is required.' };
    }
    if (!tool.spec.validatedOn?.length && !tool.spec.versions?.length) {
      return {
        error:
          'spec.versions or spec.validatedOn is required (for example versions: [{ version: "1.0.0", channel: "stable", openshift: ["4.22"], image: "quay.io/example/oct-tool:1.0.0-ocp4.22" }]).',
      };
    }
    const hasInstall =
      tool.spec.deployYAML ||
      tool.spec.deployURL ||
      tool.spec.image ||
      tool.spec.versions?.some((v) => v.image || v.deployYAML || v.deployURL);
    if (!hasInstall) {
      return {
        error:
          'Provide spec.versions[].image (or spec.deployYAML, spec.deployURL, or spec.image) so the storefront can Add the plugin.',
      };
    }
    return { tool };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function parsePublicCatalog(input: unknown): PublicCatalog | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as PublicCatalog;
  if (Array.isArray(obj.extensions)) return obj;
  if (Array.isArray(input)) return { extensions: input as PublicCatalog['extensions'] };
  return obj.kind || obj.apiVersion ? obj : null;
}

export function mergePublicIntoTool(
  tool: CommunityTool,
  ext: PublicCatalogExtension,
): CommunityTool {
  const spec = { ...tool.spec };
  if (ext.displayName) spec.displayName = ext.displayName;
  if (ext.description) spec.description = ext.description;
  if (ext.category) spec.category = ext.category;
  if (ext.git) spec.git = ext.git;
  if (ext.image) spec.image = ext.image;
  if (ext.consolePlugin) spec.consolePlugin = ext.consolePlugin;
  if (ext.href) spec.href = ext.href;
  if (ext.validatedOn?.length) spec.validatedOn = ext.validatedOn;
  if (ext.minOpenShift) spec.minOpenShift = ext.minOpenShift;
  if (ext.maxOpenShift) spec.maxOpenShift = ext.maxOpenShift;
  if (ext.defaultChannel) spec.defaultChannel = ext.defaultChannel;
  if (ext.pinVersion) spec.pinVersion = ext.pinVersion;
  if (ext.versions?.length) spec.versions = ext.versions;
  spec.source = 'community';
  return { ...tool, spec };
}

export function toolFromPublic(ext: PublicCatalogExtension): CommunityTool | null {
  const id = asString(ext.id) || asString(ext.consolePlugin);
  if (!id) return null;
  return {
    apiVersion: COMMUNITY_TOOL_API,
    kind: 'CommunityTool',
    metadata: { name: id },
    spec: {
      displayName: ext.displayName || id,
      description: ext.description || '',
      category: ext.category || 'management',
      source: 'community',
      git: ext.git,
      image: ext.image,
      consolePlugin: ext.consolePlugin || id,
      href: ext.href,
      validatedOn: ext.validatedOn || [],
      minOpenShift: ext.minOpenShift,
      maxOpenShift: ext.maxOpenShift,
      defaultChannel: ext.defaultChannel,
      pinVersion: ext.pinVersion,
      versions: ext.versions,
    },
  };
}

export function toCommunityYaml(tools: CommunityTool[]): string {
  return tools
    .map((t) => {
      const lines = [
        `apiVersion: ${COMMUNITY_TOOL_API}`,
        'kind: CommunityTool',
        'metadata:',
        `  name: ${t.metadata.name}`,
        'spec:',
        `  displayName: ${JSON.stringify(t.spec.displayName)}`,
        `  description: ${JSON.stringify(t.spec.description)}`,
        `  category: ${t.spec.category}`,
        `  source: ${t.spec.source}`,
        `  consolePlugin: ${t.spec.consolePlugin}`,
      ];
      if (t.spec.git) lines.push(`  git: ${t.spec.git}`);
      if (t.spec.image) lines.push(`  image: ${t.spec.image}`);
      if (t.spec.href) lines.push(`  href: ${t.spec.href}`);
      lines.push('  validatedOn:');
      for (const v of t.spec.validatedOn || []) lines.push(`    - ${JSON.stringify(v)}`);
      if (t.spec.minOpenShift) lines.push(`  minOpenShift: ${JSON.stringify(t.spec.minOpenShift)}`);
      if (t.spec.maxOpenShift) lines.push(`  maxOpenShift: ${JSON.stringify(t.spec.maxOpenShift)}`);
      if (t.spec.deployURL) lines.push(`  deployURL: ${t.spec.deployURL}`);
      if (t.spec.defaultChannel) lines.push(`  defaultChannel: ${t.spec.defaultChannel}`);
      if (t.spec.pinVersion) lines.push(`  pinVersion: ${JSON.stringify(t.spec.pinVersion)}`);
      if (t.spec.channels && Object.keys(t.spec.channels).length) {
        lines.push('  channels:');
        for (const name of Object.keys(t.spec.channels)) {
          lines.push(`    ${name}: {}`);
        }
      }
      if (t.spec.versions?.length) {
        lines.push('  versions:');
        for (const ver of t.spec.versions) {
          const ocp = openshiftList(ver);
          if (ver.version) lines.push(`    - version: ${JSON.stringify(ver.version)}`);
          else lines.push('    -');
          lines.push(`      channel: ${ver.channel || t.spec.defaultChannel || DEFAULT_CHANNEL}`);
          if (ocp.length === 1) {
            lines.push(`      openshift: ${JSON.stringify(ocp[0])}`);
          } else if (ocp.length > 1) {
            lines.push('      openshift:');
            for (const minor of ocp) lines.push(`        - ${JSON.stringify(minor)}`);
          }
          if (ver.minOpenShift) lines.push(`      minOpenShift: ${JSON.stringify(ver.minOpenShift)}`);
          if (ver.maxOpenShift) lines.push(`      maxOpenShift: ${JSON.stringify(ver.maxOpenShift)}`);
          if (ver.image) lines.push(`      image: ${ver.image}`);
          if (ver.gitRef) lines.push(`      gitRef: ${ver.gitRef}`);
          if (ver.deployURL) lines.push(`      deployURL: ${ver.deployURL}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n---\n');
}
