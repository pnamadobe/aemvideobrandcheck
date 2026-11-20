/**
 * AEM OpenAPI + Legacy HTTP helpers for fetching video renditions and writing
 * Brand Governance evaluation metadata back to the asset.
 */

const fetch = require('node-fetch');

function normalizeAemHost(aemHost) {
  if (!aemHost) return '';
  const trimmed = aemHost.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function isHtmlPayload(text) {
  if (!text) return false;
  const trimmed = String(text).trim().slice(0, 120).toLowerCase();
  return trimmed.startsWith('<!doctype') || trimmed.startsWith('<html');
}

function safeParseJson(text, contextLabel = 'AEM') {
  if (!text) return {};
  if (isHtmlPayload(text)) {
    throw new Error(`${contextLabel} returned an HTML login page instead of JSON.`);
  }
  return JSON.parse(text);
}

/**
 * Fetches asset metadata and ETag via OpenAPI `/adobe/assets/{assetId}/metadata`.
 */
async function getAssetMetadata(aemHost, assetId, accessToken, apiKey) {
  const base = normalizeAemHost(aemHost);
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json'
  };
  if (apiKey) headers['x-api-key'] = apiKey;

  const res = await fetch(
    `${base}/adobe/assets/${encodeURIComponent(assetId)}/metadata`,
    { method: 'GET', headers, redirect: 'manual' }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to GET asset metadata (${res.status}): ${errText.slice(0, 200)}`);
  }

  const etag = res.headers.get('etag');
  const rawText = await res.text();
  const body = safeParseJson(rawText, 'AEM Metadata API');
  return { etag, metadata: body };
}

function encodeDamPath(damPath) {
  return String(damPath || '')
    .split('/')
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

/**
 * Resolves a pre-signed HTTPS URL (<15 MB) OR downloads the video binary from AEM.
 * Returning `{ presignedUrl }` allows Gemini Decision 1 to fetch the video directly from Azure Blob
 * in <1 second without downloading/re-uploading through the Runtime container!
 */
async function fetchVideoBinaryFromAem({
  aemHost,
  assetId,
  assetPath,
  downloadUrl,
  accessToken,
  apiKey
}) {
  // 1. Pre-signed downloadUrl provided directly
  if (downloadUrl && /^https?:\/\//i.test(downloadUrl)) {
    return {
      presignedUrl: downloadUrl,
      mimeType: 'video/mp4'
    };
  }

  const base = normalizeAemHost(aemHost);
  const authHeaders = {};
  if (accessToken) authHeaders.Authorization = `Bearer ${accessToken}`;
  if (apiKey) authHeaders['x-api-key'] = apiKey;

  // Helper that checks for a 302 redirect to a pre-signed Azure Blob URL (`aem-blob-ns-...`)
  async function probePresignedOrFetch(url) {
    const res = await fetchWithTimeout(url, { headers: authHeaders, redirect: 'manual' }, 8000);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (loc) {
        const targetUrl = loc.startsWith('/') ? `${base}${loc}` : loc;
        // If it's a pre-signed blob URL (`sig=`), inspect Content-Length via HEAD; if <= 14.5 MB, pass URL directly to Gemini!
        if (targetUrl.includes('sig=')) {
          try {
            const headRes = await fetchWithTimeout(targetUrl, { method: 'HEAD' }, 4000);
            const len = Number(headRes.headers.get('content-length') || 0);
            const ct = headRes.headers.get('content-type') || 'video/mp4';
            if (len > 0 && len <= 14.5 * 1024 * 1024) {
              return { presignedUrl: targetUrl, mimeType: ct };
            }
          } catch (_) {}
        }
        const binRes = await fetchWithTimeout(targetUrl, {}, 20000);
        if (binRes.ok) {
          const buf = await binRes.buffer();
          return {
            buffer: buf,
            mimeType: binRes.headers.get('content-type') || 'video/mp4'
          };
        }
      }
    }
    if (res.ok) {
      const ct = String(res.headers.get('content-type') || '').toLowerCase();
      if (!ct.includes('text/html')) {
        const buf = await res.buffer();
        if (buf.length > 0) {
          return { buffer: buf, mimeType: ct || 'video/mp4' };
        }
      }
    }
    return null;
  }

  // 2. If we have assetPath, immediately try the fast DAM rendition paths (`_jcr_content/renditions/...`)
  //    which return a 302 Location to Azure Blob in ~150ms!
  let resolvedPath = assetPath;
  if (resolvedPath && base) {
    const encodedPath = encodeDamPath(resolvedPath);
    const fastCandidates = [
      `${base}${encodedPath}/_jcr_content/renditions/cq5dam.preview.mp4`,
      `${base}${encodedPath}/_jcr_content/renditions/mobile.mp4`,
      `${base}${encodedPath}/_jcr_content/renditions/original`,
      `${base}${encodedPath}/jcr:content/renditions/original`
    ];
    for (const candUrl of fastCandidates) {
      try {
        const hit = await probePresignedOrFetch(candUrl);
        if (hit) return hit;
      } catch (_) {}
    }
  }

  // 3. Try `/adobe/repository?path=<resolvedPath>` presigned block download
  if (resolvedPath && base && accessToken) {
    try {
      const repoUrl = `${base}/adobe/repository?path=${encodeURIComponent(resolvedPath)}`;
      const repoRes = await fetchWithTimeout(
        repoUrl,
        {
          headers: {
            ...authHeaders,
            'X-Adobe-Accept-Unsupported-API': '1'
          },
          redirect: 'manual'
        },
        6000
      );
      if (repoRes.ok) {
        const repoText = await repoRes.text();
        if (!isHtmlPayload(repoText)) {
          const repoData = JSON.parse(repoText);
          const rendLinks = Array.isArray(
            repoData?._links?.['http://ns.adobe.com/adobecloud/rel/rendition']
          )
            ? repoData._links['http://ns.adobe.com/adobecloud/rel/rendition']
            : [];
          const preferredOrder = [
            'cq5dam.preview.mp4',
            'mobile.mp4',
            'cq5dam.video.iehq.mp4',
            'cq5dam.video.hq.m4v'
          ];
          let dlHref = null;
          for (const pref of preferredOrder) {
            const hit = rendLinks.find(r => r?.['dc:title'] === pref);
            if (hit?._links?.['http://ns.adobe.com/adobecloud/rel/download']?.href) {
              dlHref = hit._links['http://ns.adobe.com/adobecloud/rel/download'].href;
              break;
            }
          }
          if (!dlHref) {
            dlHref = repoData?._links?.['http://ns.adobe.com/adobecloud/rel/download']?.href;
          }
          if (dlHref) {
            const dlRes = await fetchWithTimeout(
              dlHref,
              {
                headers: {
                  ...authHeaders,
                  Accept: 'application/vnd.adobecloud.download+json'
                },
                redirect: 'manual'
              },
              6000
            );
            if (dlRes.ok) {
              const dlText = await dlRes.text();
              if (!isHtmlPayload(dlText)) {
                const dlJson = JSON.parse(dlText);
                if (dlJson?.href) {
                  try {
                    const headRes = await fetchWithTimeout(dlJson.href, { method: 'HEAD' }, 4000);
                    const len = Number(headRes.headers.get('content-length') || 0);
                    if (len > 0 && len <= 14.5 * 1024 * 1024) {
                      return {
                        presignedUrl: dlJson.href,
                        mimeType: headRes.headers.get('content-type') || 'video/mp4'
                      };
                    }
                  } catch (_) {}
                  const binRes = await fetchWithTimeout(dlJson.href, {}, 20000);
                  if (binRes.ok) {
                    const buf = await binRes.buffer();
                    return {
                      buffer: buf,
                      mimeType: binRes.headers.get('content-type') || 'video/mp4'
                    };
                  }
                }
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  // 4. Try OpenAPI rendition download `/adobe/assets/{assetId}/renditions/original/as/video.mp4`
  if (assetId && base) {
    for (const suffix of [
      `/adobe/assets/${encodeURIComponent(assetId)}/original/as/video.mp4`,
      `/adobe/assets/${encodeURIComponent(assetId)}/renditions/original/as/video.mp4`
    ]) {
      try {
        const hit = await probePresignedOrFetch(`${base}${suffix}`);
        if (hit) return hit;
      } catch (_) {}
    }
  }

  // 5. If resolvedPath was missing and only assetId was provided, resolve path via QueryBuilder and retry step 2
  if (!resolvedPath && assetId && base && accessToken) {
    const rawUuid = String(assetId).replace(/^urn:aaid:aem:/i, '').trim();
    try {
      const qbUrl = `${base}/bin/querybuilder.json?property=jcr:uuid&property.value=${encodeURIComponent(rawUuid)}&p.limit=5`;
      const qbRes = await fetchWithTimeout(qbUrl, { headers: authHeaders, redirect: 'manual' }, 5000);
      if (qbRes.ok) {
        const qbText = await qbRes.text();
        if (!isHtmlPayload(qbText)) {
          const qbData = JSON.parse(qbText);
          const hit = (qbData.hits || []).find(h => h?.path && h.path.startsWith('/content/dam'));
          if (hit) {
            resolvedPath = hit.path;
            const encodedPath = encodeDamPath(resolvedPath);
            for (const candUrl of [
              `${base}${encodedPath}/_jcr_content/renditions/cq5dam.preview.mp4`,
              `${base}${encodedPath}/_jcr_content/renditions/mobile.mp4`,
              `${base}${encodedPath}/_jcr_content/renditions/original`
            ]) {
              const rHit = await probePresignedOrFetch(candUrl);
              if (rHit) return rHit;
            }
          }
        }
      }
    } catch (_) {}
  }

  throw new Error(
    `Unable to download video rendition from AEM for ${resolvedPath || assetId}. Verify that your session has access to ${base}.`
  );
}

/**
 * Writes the brand governance evaluation summary back to AEM `assetMetadata` via RFC-6902 JSON Patch
 * (`PATCH /adobe/assets/{assetId}/metadata` with `If-Match: <ETag>`).
 *
 * Writes to standard XDM brand governance fields:
 *  - `/xdm:brandscore` (integer 0-100 compliance score)
 *  - `/xdm:brandscorenotes` (human-readable + structured breakdown of brand(s), pass/fail/NA counts, and failed check rationales)
 */
async function writeEvaluationToAssetMetadata({
  aemHost,
  assetId,
  evaluationResult,
  accessToken,
  apiKey
}) {
  if (!aemHost || !assetId || !accessToken) {
    return { written: false, reason: 'Missing aemHost, assetId, or accessToken' };
  }

  const base = normalizeAemHost(aemHost);
  let etag = '*';
  try {
    const metaRes = await getAssetMetadata(aemHost, assetId, accessToken, apiKey);
    if (metaRes && metaRes.etag) etag = metaRes.etag;
  } catch (_) {
    // OpenAPI metadata GET can return HTML login redirect on some Author tiers without API Mesh;
    // proceed with wildcard ETag and Sling fallback below.
  }

  // Support both single-brand and multi-brand evaluation results
  const brandReports = evaluationResult.brand_reports || [evaluationResult];
  const avgScore =
    evaluationResult.compliance_score ??
    Math.round(
      brandReports.reduce((acc, r) => acc + (r.compliance_score || 0), 0) /
        Math.max(1, brandReports.length)
    );

  const notesSections = brandReports.map(r => {
    const failedItems = (r.evaluations || [])
      .filter(e => e.aligned === 'NO')
      .map(e => {
        const timePart = e.timestamp ? ` [${e.timestamp}]` : '';
        const fixPart = e.suggestion ? ` Fix: ${e.suggestion}` : '';
        return `• [FAIL] (${e.category}) ${e.title}${timePart}: ${e.rationale}${fixPart}`;
      });

    const header = `[${r.brand_name}] ${r.overall_aligned ? 'ALIGNED' : 'NOT ALIGNED'} — Score: ${r.compliance_score}% (${r.successful_checks} passed, ${r.failed_checks} failed, ${r.not_applicable_checks} N/A)`;
    return failedItems.length > 0
      ? `${header}\n${failedItems.join('\n')}`
      : `${header}\n• All applicable video brand checks passed.`;
  });

  const brandScoreNotes = `${notesSections.join('\n\n')}\n\nEvaluated by Gemini Decisions API (gemini-decision-1) at ${new Date().toISOString()}`;

  const patchOps = [
    {
      op: 'add',
      path: '/xdm:score',
      value: String(avgScore)
    },
    {
      op: 'add',
      path: '/xdm:brandScore',
      value: String(avgScore)
    },
    {
      op: 'add',
      path: '/xdm:brandscore',
      value: String(avgScore)
    },
    {
      op: 'add',
      path: '/xdm:brandScoreNotes',
      value: brandScoreNotes
    }
  ];

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json-patch+json',
    'If-Match': etag || '*'
  };
  if (apiKey) headers['x-api-key'] = apiKey;

  let res = await fetch(
    `${base}/adobe/assets/${encodeURIComponent(assetId)}/metadata`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patchOps),
      redirect: 'manual'
    }
  );

  // Retry once on 412 Precondition Failed
  if (res.status === 412) {
    try {
      const fresh = await getAssetMetadata(aemHost, assetId, accessToken, apiKey);
      headers['If-Match'] = fresh.etag || '*';
      res = await fetch(
        `${base}/adobe/assets/${encodeURIComponent(assetId)}/metadata`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify(patchOps),
          redirect: 'manual'
        }
      );
    } catch (_) {}
  }

  return {
    written: res.ok,
    status: res.status,
    fieldsWritten: ['xdm:score', 'xdm:brandScore', 'xdm:brandscore', 'xdm:brandScoreNotes'],
    brandscore: avgScore
  };
}

module.exports = {
  normalizeAemHost,
  getAssetMetadata,
  fetchVideoBinaryFromAem,
  writeEvaluationToAssetMetadata
};
