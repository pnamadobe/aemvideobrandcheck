import React, { useEffect } from 'react';
import { register } from '@adobe/uix-guest';
import { EXTENSION_ID } from '../Constants';

function buildModalUrl(assetId, assetPath, aemHost) {
  const qs = new URLSearchParams(
    Object.entries({
      v: String(Date.now()),
      assetId: assetId || '',
      assetPath: assetPath || '',
      aemHost: aemHost || ''
    }).filter(([, val]) => Boolean(val))
  ).toString();
  return `/index.html?v=${Date.now()}#brand-check-modal?${qs}`;
}

function extractDamPathDeep(obj, depth = 0, seen = new Set()) {
  try {
    if (depth > 4 || !obj) return '';
    if (typeof obj === 'string') {
      const idx = obj.indexOf('/content/dam');
      if (idx >= 0) {
        try {
          return decodeURIComponent(obj.slice(idx));
        } catch (_) {
          return obj.slice(idx);
        }
      }
      return '';
    }
    if (typeof obj !== 'object' || seen.has(obj)) return '';
    seen.add(obj);
    for (const k of ['path', 'repositoryPath', 'repo:path', 'assetPath']) {
      if (typeof obj[k] === 'string' && obj[k].includes('/content/dam')) {
        return obj[k];
      }
    }
  } catch (_) {}
  return '';
}

function buildPanelUrl(resource, aemHost) {
  const res = resource?.resource || resource || {};
  const assetId = res.id || res.assetId || res['repo:id'] || '';
  const assetPath = extractDamPathDeep(resource) || res.path || res.assetPath || res['repo:path'] || '';
  const qs = new URLSearchParams(
    Object.entries({
      v: String(Date.now()),
      assetId,
      assetPath,
      aemHost: aemHost || ''
    }).filter(([, val]) => Boolean(val))
  ).toString();
  return `/index.html?v=${Date.now()}#brand-check-panel?${qs}`;
}

function detectReferrerAemHost() {
  try {
    const ref = document.referrer || '';
    const m = ref.match(/[?&]repoId=([^&#]+)/i);
    if (m) {
      const host = decodeURIComponent(m[1]).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      if (host) return `https://${host}`;
    }
  } catch (_) {}
  return '';
}

function readSharedAuth(gc) {
  try {
    const auth = gc?.sharedContext?.get?.('auth') || {};
    const imsToken =
      auth.imsToken || auth.accessToken || auth.token || auth.authInfo?.accessToken || '';
    const imsOrg = auth.imsOrg || auth.imsOrgId || '';
    return { imsToken, imsOrg };
  } catch (_) {
    return { imsToken: '', imsOrg: '' };
  }
}

export default function ExtensionRegistration() {
  useEffect(() => {
    const init = async () => {
      let activeConnection = null;
      const refHost = detectReferrerAemHost();

      const guestConnection = await register({
        id: EXTENSION_ID,
        methods: {
          // 1. Details View side-rail panel
          detailSidePanel: {
            getPanels(resource) {
              try {
                const shared = readSharedAuth(activeConnection);
                if (shared.imsToken) {
                  window.localStorage.setItem(
                    'AEM_BRANDCHECK_CTX',
                    JSON.stringify({ ...shared, aemHost: refHost, ts: Date.now() })
                  );
                }
              } catch (_) {}
              return [
                {
                  id: 'video-brand-check-panel',
                  tooltip: 'Brand Check',
                  icon: 'Shield',
                  title: 'Brand Check',
                  contentUrl: buildPanelUrl(resource, refHost),
                  reloadOnThemeChange: true
                }
              ];
            },
            async getHiddenBuiltInPanels() {
              return [];
            },
            async overrideBuiltInPanel() {
              return null;
            }
          },
          // 2. Browse View ActionBar action + required quickActions stub
          actionBar: {
            async getActions(params = {}) {
              const { resourceSelection } = params || {};
              const resources = Array.isArray(resourceSelection?.resources)
                ? resourceSelection.resources
                : Array.isArray(resourceSelection)
                ? resourceSelection
                : resourceSelection
                ? [resourceSelection]
                : [];

              if (resources.length === 0) {
                return [];
              }

              const selected = resources[0] || {};
              let selectedId = '';
              let selectedPath = '';
              try {
                selectedId = selected.id || selected.assetId || '';
                selectedPath =
                  selected.path || selected.assetPath || extractDamPathDeep(selected) || '';
              } catch (_) {}
              return [
                {
                  id: 'run-video-brand-check',
                  icon: 'Shield',
                  label: 'Brand Check',
                  onClick: async () => {
                    let hostUrl = refHost;
                    try {
                      const dHost = await guestConnection.host?.discovery?.getAemHost?.();
                      if (dHost) hostUrl = dHost;
                      const ims = await guestConnection.host?.auth?.getIMSInfo?.();
                      const shared = readSharedAuth(guestConnection);
                      window.localStorage.setItem(
                        'AEM_BRANDCHECK_CTX',
                        JSON.stringify({
                          imsToken: ims?.accessToken || ims?.imsToken || shared.imsToken || '',
                          imsOrg: ims?.imsOrg || shared.imsOrg || '',
                          aemHost: hostUrl,
                          assetId: selectedId,
                          assetPath: selectedPath,
                          ts: Date.now()
                        })
                      );
                    } catch (_) {}

                    await guestConnection.host.modal.openDialog({
                      title: 'Brand Check',
                      contentUrl: buildModalUrl(selectedId, selectedPath, hostUrl),
                      type: 'modal',
                      size: 'L',
                      payload: {
                        assetId: selectedId,
                        assetPath: selectedPath,
                        aemHost: hostUrl
                      }
                    });
                  }
                }
              ];
            },
            async getHiddenBuiltInActions() {
              return [];
            },
            async overrideBuiltInAction() {
              return false;
            }
          },
          quickActions: {
            async getHiddenBuiltInActions() {
              return [];
            },
            async overrideBuiltInAction() {
              return false;
            }
          },
          headerMenu: {
            async getButtons() {
              return [];
            },
            async getHiddenButtonIds() {
              return [];
            },
            async overrideButton() {
              return false;
            }
          }
        }
      });
      activeConnection = guestConnection;
    };

    init().catch(console.error);
  }, []);

  return (
    <div style={{ padding: 12, fontSize: 12, color: '#666' }}>
      Brand Check Extension registered (`aem/assets/assetsview/1`).
    </div>
  );
}
