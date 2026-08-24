import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import { CATALOG_PROXY, PublicCatalog } from './catalog-types';
import { parsePublicCatalog } from './parse-tools';

const TIMEOUT_MS = 4000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export type PublicFetchResult = {
  ok: boolean;
  catalog?: PublicCatalog;
  reason?: string;
};

/** Fail-open GET of the public catalog via catalog-service. Never throws. */
export async function fetchPublicCatalog(): Promise<PublicFetchResult> {
  try {
    const body = await withTimeout(
      consoleFetchJSON(`${CATALOG_PROXY}/api/v1/public-catalog`),
      TIMEOUT_MS,
    );
    if (!body || body.ok === false) {
      return { ok: false, reason: (body && body.reason) || 'public catalog unavailable' };
    }
    const catalog = parsePublicCatalog(body.catalog ?? body);
    if (!catalog) return { ok: false, reason: 'public catalog payload was empty' };
    return { ok: true, catalog };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchDeployYaml(url: string): Promise<{ ok: boolean; yaml?: string; reason?: string }> {
  try {
    const body = await withTimeout(
      consoleFetchJSON(
        `${CATALOG_PROXY}/api/v1/fetch-yaml?url=${encodeURIComponent(url)}`,
      ),
      10000,
    );
    if (!body || body.ok === false || typeof body.yaml !== 'string') {
      return { ok: false, reason: (body && body.reason) || 'fetch-yaml failed' };
    }
    return { ok: true, yaml: body.yaml };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Best-effort. Ignore all errors. */
export async function postPublicDownload(id: string): Promise<void> {
  try {
    await withTimeout(
      consoleFetchJSON.post(`${CATALOG_PROXY}/api/v1/stats/download`, { id }),
      TIMEOUT_MS,
    );
  } catch {
    /* fail-open */
  }
}

/** Best-effort. Ignore all errors. */
export async function postPublicRating(id: string, rating: number): Promise<void> {
  try {
    await withTimeout(
      consoleFetchJSON.post(`${CATALOG_PROXY}/api/v1/stats/rating`, { id, rating }),
      TIMEOUT_MS,
    );
  } catch {
    /* fail-open */
  }
}
