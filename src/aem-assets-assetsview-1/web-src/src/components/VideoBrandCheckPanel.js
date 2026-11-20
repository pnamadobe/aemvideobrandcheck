import React, { useEffect, useState, useMemo } from 'react';
import { attach } from '@adobe/uix-guest';
import { EXTENSION_ID, DEFAULT_BRAND_ID, BRANDS_LIST } from '../Constants';

let actionConfig = {};
try {
  // Generated automatically by `aio app build`
  actionConfig = require('../config.json');
} catch (_) {
  actionConfig = {};
}

const PREFS_STORAGE_KEY = 'AEM_VIDEO_BRANDCHECK_PREFS_V1';
const API_KEY_STORAGE_KEY = 'AEM_VIDEO_BRANDCHECK_GEMINI_KEY';

function loadSavedBrandPrefs() {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const ids = Array.isArray(parsed.selectedBrandIds) && parsed.selectedBrandIds.length > 0
        ? parsed.selectedBrandIds
        : [DEFAULT_BRAND_ID];
      const multi = typeof parsed.multiBrandMode === 'boolean'
        ? parsed.multiBrandMode
        : ids.length > 1;
      return { selectedBrandIds: ids, multiBrandMode: multi };
    }
  } catch (_) {}
  return { selectedBrandIds: [DEFAULT_BRAND_ID], multiBrandMode: false };
}

function saveBrandPrefs(selectedBrandIds, multiBrandMode) {
  try {
    window.localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        selectedBrandIds,
        multiBrandMode,
        updatedAt: Date.now()
      })
    );
  } catch (_) {}
}

function resolveActionUrl(actionName) {
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    const host = String(window.location.hostname || '').toLowerCase();
    if (host.endsWith('.adobeio-static.net') || host.endsWith('.adobeioruntime.net')) {
      return `${window.location.origin}/api/v1/web/aem-video-brand-check/${actionName}`;
    }
  }
  if (actionConfig && actionConfig[actionName]) {
    return actionConfig[actionName];
  }
  return `/api/v1/web/aem-video-brand-check/${actionName}`;
}

function checkIsAdminUser(profile, groups) {
  if (Array.isArray(groups) && groups.length > 0) {
    const adminGroupRe = /(admin|administrators|dam-admin|brand-manager|governance|system)/i;
    if (groups.some(g => adminGroupRe.test(g?.name || ''))) {
      return true;
    }
  }
  if (profile?.email && /(@adobe\.com|admin)/i.test(profile.email)) {
    return true;
  }
  return false;
}

const STYLES = `
.bc-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  background: var(--s2-bg-base, #f8f8f8);
  color: var(--s2-text-primary, #222222);
  font-size: 13px;
}
.bc-header {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px 0 16px;
  background: #ffffff;
  border-bottom: 1px solid #e6e6e6;
}
.bc-tabs {
  display: flex;
  gap: 20px;
}
.bc-tab {
  appearance: none;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: 8px 2px 10px 2px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  color: #505050;
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.bc-tab:hover {
  color: #222222;
}
.bc-tab.active {
  color: #222222;
  border-bottom-color: #222222;
}
.bc-body {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bc-card {
  background: #ffffff;
  border: 1px solid #e6e6e6;
  border-radius: 8px;
  padding: 12px 14px;
}
.bc-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: #363636;
  margin-bottom: 6px;
}
.bc-subtext {
  font-size: 11px;
  color: #717171;
  line-height: 1.4;
}
.bc-select, .bc-input {
  width: 100%;
  height: 32px;
  padding: 0 10px;
  font-family: inherit;
  font-size: 13px;
  color: #222222;
  background: #ffffff;
  border: 1px solid #b1b1b1;
  border-radius: 6px;
  outline: none;
}
.bc-select:focus, .bc-input:focus {
  border-color: #0265dc;
  box-shadow: 0 0 0 1px #0265dc;
}
.bc-brand-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 6px;
  max-height: 148px;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid #e6e6e6;
  border-radius: 6px;
  background: #fafafa;
}
.bc-brand-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 8px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
}
.bc-brand-chip.selected {
  background: #e5f0fe;
  border-color: #9ac2fe;
  font-weight: 600;
  color: #0054b6;
}
.bc-btn-primary {
  appearance: none;
  border: none;
  height: 34px;
  padding: 0 18px;
  border-radius: 9999px;
  background: #0265dc;
  color: #ffffff;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: background 0.15s ease;
}
.bc-btn-primary:hover:not(:disabled) {
  background: #0054b6;
}
.bc-btn-primary:disabled {
  background: #d5d5d5;
  color: #717171;
  cursor: not-allowed;
}
.bc-btn-secondary {
  appearance: none;
  border: 1px solid #b1b1b1;
  height: 30px;
  padding: 0 14px;
  border-radius: 9999px;
  background: #ffffff;
  color: #222222;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.bc-btn-secondary:hover {
  background: #f3f3f3;
}
.bc-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.bc-badge.pass {
  background: #e3fcef;
  color: #05834e;
}
.bc-badge.fail {
  background: #ffebe7;
  color: #d73220;
}
.bc-badge.na {
  background: #eeeeee;
  color: #505050;
}
.bc-badge.info {
  background: #e5f0fe;
  color: #0054b6;
}
.bc-filter-bar {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.bc-filter-bar > div {
  flex: 1;
  min-width: 120px;
}
.bc-check-item {
  background: #ffffff;
  border: 1px solid #e6e6e6;
  border-left: 3px solid #d5d5d5;
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.bc-check-item.pass {
  border-left-color: #05834e;
}
.bc-check-item.fail {
  border-left-color: #d73220;
}
.bc-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
`;

export default function VideoBrandCheckPanel({ mode = 'panel' }) {
  const initialPrefs = useMemo(() => loadSavedBrandPrefs(), []);

  const [guestConnection, setGuestConnection] = useState(null);
  const [activeTab, setActiveTab] = useState('audit');
  const [assetInfo, setAssetInfo] = useState({
    id: '',
    path: ''
  });
  const [aemHost, setAemHost] = useState('');
  const [imsInfo, setImsInfo] = useState({ accessToken: '', imsOrg: '' });
  const [aemApiKey, setAemApiKey] = useState('');

  // Admin detection
  const [userProfile, setUserProfile] = useState(null);
  const [userGroups, setUserGroups] = useState([]);
  const [isAdmin, setIsAdmin] = useState(true);

  // Persisted Brand selection (single or multiple)
  const [availableBrands, setAvailableBrands] = useState(BRANDS_LIST);
  const [selectedBrandIds, setSelectedBrandIds] = useState(initialPrefs.selectedBrandIds);
  const [multiBrandMode, setMultiBrandMode] = useState(initialPrefs.multiBrandMode);

  // Admin settings
  const [geminiApiKey, setGeminiApiKey] = useState(
    () => window.localStorage.getItem(API_KEY_STORAGE_KEY) || ''
  );
  const [keySavedToast, setKeySavedToast] = useState(false);
  const [resolution, setResolution] = useState('low');
  const [writeMetadata, setWriteMetadata] = useState(true);

  // Result filters
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [categoryFilter, setCategoryFilter] = useState('ALL');
  const [brandFilter, setBrandFilter] = useState('ALL');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);

  // Persist brand selection to localStorage AND server-side App Builder State whenever changed by user
  const updateBrandSelection = (nextBrandIds, nextMultiMode) => {
    setSelectedBrandIds(nextBrandIds);
    setMultiBrandMode(nextMultiMode);
    saveBrandPrefs(nextBrandIds, nextMultiMode);
    try {
      fetch(resolveActionUrl('get-brand-checks'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'savePrefs',
          selectedBrandIds: nextBrandIds,
          multiBrandMode: nextMultiMode
        })
      }).catch(() => {});
    } catch (_) {}
  };

  useEffect(() => {
    (async () => {
      try {
        const cachedCtx = JSON.parse(window.localStorage.getItem('AEM_BRANDCHECK_CTX') || '{}');
        if (cachedCtx.imsToken) {
          setImsInfo({ accessToken: cachedCtx.imsToken, imsOrg: cachedCtx.imsOrg || '' });
        }
        if (cachedCtx.aemHost) {
          setAemHost(cachedCtx.aemHost);
        }

        const hashQuery = window.location.hash.split('?')[1] || '';
        const sp = new URLSearchParams(hashQuery);
        const qId = sp.get('assetId') || cachedCtx.assetId;
        const qPath = sp.get('assetPath') || cachedCtx.assetPath;
        const qHost = sp.get('aemHost');
        if (qHost) setAemHost(qHost);
        if (qId || qPath) {
          setAssetInfo(prev => ({
            id: qId || prev.id,
            path: qPath || prev.path
          }));
        }
      } catch (_) {}

      try {
        const conn = await attach({ id: EXTENSION_ID });
        setGuestConnection(conn);

        const sharedAuth = conn?.sharedContext?.get?.('auth') || {};
        const sharedToken =
          sharedAuth.imsToken ||
          sharedAuth.accessToken ||
          sharedAuth.token ||
          sharedAuth.authInfo?.accessToken ||
          '';
        const sharedOrg = sharedAuth.imsOrg || sharedAuth.imsOrgId || '';
        if (sharedToken) {
          setImsInfo(prev => ({
            accessToken: sharedToken || prev.accessToken,
            imsOrg: sharedOrg || prev.imsOrg
          }));
        }

        if (conn?.host?.discovery?.getAemHost) {
          const host = await conn.host.discovery.getAemHost();
          if (host) setAemHost(host);
        }
        if (conn?.host?.auth?.getIMSInfo) {
          const ims = await conn.host.auth.getIMSInfo();
          if (ims?.accessToken) setImsInfo(ims);
        }
        if (conn?.host?.auth?.getApiKey) {
          const key = await conn.host.auth.getApiKey();
          if (key) setAemApiKey(key);
        }

        let fetchedProfile = null;
        let fetchedGroups = [];
        if (conn?.host?.auth?.getCurrentUserProfile) {
          fetchedProfile = await conn.host.auth.getCurrentUserProfile();
          setUserProfile(fetchedProfile);
        }
        if (conn?.host?.auth?.getCurrentUserGroupMembership) {
          fetchedGroups = (await conn.host.auth.getCurrentUserGroupMembership()) || [];
          setUserGroups(fetchedGroups);
        }
        if (fetchedProfile || fetchedGroups.length > 0) {
          setIsAdmin(checkIsAdminUser(fetchedProfile, fetchedGroups));
        }

        if (mode === 'modal' && conn?.host?.modal?.getPayload) {
          const payload = await conn.host.modal.getPayload();
          if (payload?.assetId || payload?.assetPath) {
            setAssetInfo(prev => ({
              id: payload.assetId || prev.id,
              path: payload.assetPath || prev.path
            }));
          }
          if (payload?.aemHost) setAemHost(payload.aemHost);
        } else if (conn?.host?.details?.getCurrentResourceInfo) {
          const info = await conn.host.details.getCurrentResourceInfo();
          if (info?.id || info?.path) {
            setAssetInfo(prev => ({
              id: info.id || prev.id,
              path: info.path || prev.path
            }));
          }
        }
      } catch (_) {}

      try {
        const res = await fetch(resolveActionUrl('get-brand-checks'));
        if (res.ok) {
          const data = await res.json();
          const brandsList = Array.isArray(data.brands) ? data.brands : [];
          if (brandsList.length > 0) {
            setAvailableBrands(brandsList);
          }
          // Restore server-saved brand selection if present, otherwise default to first available brand
          const sp = data.saved_prefs;
          if (sp && Array.isArray(sp.selectedBrandIds) && sp.selectedBrandIds.length > 0) {
            const restoredMulti =
              typeof sp.multiBrandMode === 'boolean'
                ? sp.multiBrandMode
                : sp.selectedBrandIds.length > 1;
            setSelectedBrandIds(sp.selectedBrandIds);
            setMultiBrandMode(restoredMulti);
            saveBrandPrefs(sp.selectedBrandIds, restoredMulti);
          } else if (brandsList.length > 0) {
            setSelectedBrandIds(prev => {
              const validPrev = (prev || []).filter(Boolean);
              if (validPrev.length > 0) return validPrev;
              const defId = data.default_brand_id || brandsList[0].brand_id;
              return [defId];
            });
          }
        }
      } catch (_) {}
    })();
  }, [mode]);

  const handleSaveApiKey = val => {
    setGeminiApiKey(val);
    setKeySavedToast(false);
    try {
      window.localStorage.setItem(API_KEY_STORAGE_KEY, val);
    } catch (_) {}
  };

  const toggleBrandInMultiMode = brandId => {
    const nextIds = selectedBrandIds.includes(brandId)
      ? (selectedBrandIds.length > 1 ? selectedBrandIds.filter(id => id !== brandId) : selectedBrandIds)
      : [...selectedBrandIds, brandId];
    updateBrandSelection(nextIds, true);
  };

  const totalSelectedQuestions = useMemo(() => {
    const selected = availableBrands.filter(b => selectedBrandIds.includes(b.brand_id));
    return selected.reduce((acc, b) => acc + (b.video_checks || 0), 0);
  }, [availableBrands, selectedBrandIds]);

  const runBrandCheck = async (forceRefresh = true) => {
    if (selectedBrandIds.length === 0) {
      setError('Select at least one brand to run Brand Check.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (imsInfo.accessToken) {
        headers.Authorization = `Bearer ${imsInfo.accessToken}`;
      }
      if (imsInfo.imsOrg) {
        headers['x-gw-ims-org-id'] = imsInfo.imsOrg;
      }

      const res = await fetch(resolveActionUrl('evaluate-video'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          brandId: selectedBrandIds[0],
          brandIds: selectedBrandIds,
          assetId: assetInfo.id,
          assetPath: assetInfo.path,
          aemHost,
          accessToken: imsInfo.accessToken,
          aemApiKey,
          geminiApiKey,
          resolution,
          includeExplanations: true,
          writeMetadata,
          forceRefresh
        })
      });
      const text = await res.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {
        throw new Error(`Unexpected response from server (HTTP ${res.status})`);
      }
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `Evaluation failed (HTTP ${res.status})`);
      }
      setReport(data);

      if (guestConnection?.host?.toast?.display) {
        guestConnection.host.toast.display({
          variant: data.overall_aligned ? 'positive' : 'negative',
          message: `Brand Check (${data.brand_name}): ${data.compliance_score}% (${data.successful_checks} passed, ${data.failed_checks} failed)`
        });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const categories = useMemo(() => {
    if (!report?.evaluations) return ['ALL'];
    const set = new Set(report.evaluations.map(e => e.category));
    return ['ALL', ...Array.from(set).sort()];
  }, [report]);

  const evaluatedBrandNames = useMemo(() => {
    if (!report?.evaluations) return ['ALL'];
    const set = new Set(report.evaluations.map(e => e.brand_name).filter(Boolean));
    return ['ALL', ...Array.from(set)];
  }, [report]);

  const filteredEvaluations = useMemo(() => {
    if (!report?.evaluations) return [];
    return report.evaluations.filter(ev => {
      if (statusFilter !== 'ALL' && ev.aligned !== statusFilter) return false;
      if (categoryFilter !== 'ALL' && ev.category !== categoryFilter) return false;
      if (brandFilter !== 'ALL' && ev.brand_name !== brandFilter) return false;
      return true;
    });
  }, [report, statusFilter, categoryFilter, brandFilter]);

  return (
    <div className="bc-shell">
      <style>{STYLES}</style>

      {/* Spectrum 2 Top Navigation Bar */}
      <div className="bc-header">
        <div className="bc-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'audit'}
            className={`bc-tab ${activeTab === 'audit' ? 'active' : ''}`}
            onClick={() => setActiveTab('audit')}
          >
            Brand Check
          </button>
          {isAdmin && (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'admin'}
              className={`bc-tab ${activeTab === 'admin' ? 'active' : ''}`}
              onClick={() => setActiveTab('admin')}
            >
              Admin Settings
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8 }}>
          <span className="bc-badge info">gemini-decision-1</span>
          {mode === 'modal' && guestConnection?.host?.modal && (
            <button
              type="button"
              className="bc-btn-secondary"
              onClick={() => guestConnection.host.modal.closeDialog()}
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Single Scrollable Content Container */}
      <div className="bc-body">
        {activeTab === 'audit' && (
          <>
            {/* Selected Asset Card */}
            <div className="bc-card">
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>
                {assetInfo.path ? assetInfo.path.split('/').pop() : assetInfo.id}
              </div>
              <div className="bc-subtext" style={{ wordBreak: 'break-all' }}>
                {assetInfo.path || assetInfo.id}
              </div>
            </div>

            {/* Brand Selection Card */}
            <div className="bc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="bc-toggle-row">
                <label className="bc-label" style={{ margin: 0 }}>
                  Experience Context Brand{multiBrandMode ? 's' : ''}
                </label>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    color: '#505050',
                    cursor: 'pointer'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={multiBrandMode}
                    onChange={e => {
                      const nextMulti = e.target.checked;
                      const nextIds =
                        !nextMulti && selectedBrandIds.length > 1
                          ? [selectedBrandIds[0]]
                          : selectedBrandIds;
                      updateBrandSelection(nextIds, nextMulti);
                    }}
                  />
                  Compare multiple brands
                </label>
              </div>

              {!multiBrandMode ? (
                <select
                  className="bc-select"
                  value={selectedBrandIds[0] || DEFAULT_BRAND_ID}
                  onChange={e => updateBrandSelection([e.target.value], false)}
                >
                  {availableBrands.map(b => (
                    <option key={b.brand_id} value={b.brand_id}>
                      {b.brand_name} ({b.video_checks} video checks / {b.total_checks} total)
                    </option>
                  ))}
                </select>
              ) : (
                <div className="bc-brand-grid">
                  {availableBrands.map(b => {
                    const isChecked = selectedBrandIds.includes(b.brand_id);
                    return (
                      <label
                        key={b.brand_id}
                        className={`bc-brand-chip ${isChecked ? 'selected' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleBrandInMultiMode(b.brand_id)}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {b.brand_name} ({b.video_checks})
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 2 }}>
                <span className="bc-subtext">
                  {selectedBrandIds.length} brand{selectedBrandIds.length > 1 ? 's' : ''} selected ·{' '}
                  {totalSelectedQuestions} active video checks
                </span>
                <button
                  type="button"
                  className="bc-btn-primary"
                  disabled={loading || selectedBrandIds.length === 0}
                  onClick={() => runBrandCheck(true)}
                >
                  {loading ? `Evaluating ${totalSelectedQuestions} checks…` : 'Brand Check'}
                </button>
              </div>
            </div>

            {error && (
              <div
                className="bc-card"
                style={{
                  borderColor: '#f5b7b1',
                  background: '#ffebe7',
                  color: '#b01c0e',
                  fontSize: 12
                }}
              >
                {error}
              </div>
            )}

            {report && (
              <>
                {/* Summary Score Banner */}
                <div className="bc-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="bc-toggle-row" style={{ flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span className={`bc-badge ${report.overall_aligned ? 'pass' : 'fail'}`}>
                        {report.overall_aligned ? 'ALIGNED' : 'NOT ALIGNED'}
                      </span>
                      <span style={{ fontWeight: 700, fontSize: 15 }}>
                        {report.brand_name} — {report.compliance_score}%
                      </span>
                    </div>
                    <span className="bc-subtext">
                      {report.telemetry?.latency_ms} ms · ${report.telemetry?.estimated_cost_usd}
                    </span>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span className="bc-badge pass">Passed: {report.successful_checks}</span>
                    <span className="bc-badge fail">Failed: {report.failed_checks}</span>
                    <span className="bc-badge na">N/A: {report.not_applicable_checks}</span>
                    {report.metadataWrite?.written && (
                      <span className="bc-badge info">
                        Saved to xdm:score & xdm:brandScoreNotes
                      </span>
                    )}
                  </div>
                </div>

                {/* Filters */}
                <div className="bc-filter-bar">
                  <div>
                    <label className="bc-label">Verdict</label>
                    <select
                      className="bc-select"
                      value={statusFilter}
                      onChange={e => setStatusFilter(e.target.value)}
                    >
                      <option value="ALL">All ({report.evaluations.length})</option>
                      <option value="NO">Failed ({report.failed_checks})</option>
                      <option value="YES">Passed ({report.successful_checks})</option>
                      <option value="NA">N/A ({report.not_applicable_checks})</option>
                    </select>
                  </div>

                  <div>
                    <label className="bc-label">Category</label>
                    <select
                      className="bc-select"
                      value={categoryFilter}
                      onChange={e => setCategoryFilter(e.target.value)}
                    >
                      {categories.map(cat => (
                        <option key={cat} value={cat}>
                          {cat}
                        </option>
                      ))}
                    </select>
                  </div>

                  {evaluatedBrandNames.length > 2 && (
                    <div>
                      <label className="bc-label">Brand</label>
                      <select
                        className="bc-select"
                        value={brandFilter}
                        onChange={e => setBrandFilter(e.target.value)}
                      >
                        {evaluatedBrandNames.map(bn => (
                          <option key={bn} value={bn}>
                            {bn}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>

                {/* Per-check results list */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {filteredEvaluations.map(ev => {
                    const cls =
                      ev.aligned === 'YES' ? 'pass' : ev.aligned === 'NO' ? 'fail' : 'na';
                    return (
                      <div key={`${ev.brand_id}_${ev.id}`} className={`bc-check-item ${cls}`}>
                        <div className="bc-toggle-row">
                          <span style={{ fontWeight: 600, fontSize: 13 }}>
                            {ev.brand_name ? `[${ev.brand_name}] ` : ''}
                            {ev.title}
                          </span>
                          <span className={`bc-badge ${cls}`}>
                            {ev.aligned === 'YES'
                              ? 'PASS'
                              : ev.aligned === 'NO'
                              ? 'FAIL'
                              : 'N/A'}
                          </span>
                        </div>

                        <div className="bc-subtext" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <span>
                            Category: <strong>{ev.category}</strong>
                          </span>
                          {ev.probability != null && (
                            <span>· P(pass): {(ev.probability * 100).toFixed(0)}%</span>
                          )}
                          {ev.confidence != null && (
                            <span>· Confidence: {(ev.confidence * 100).toFixed(0)}%</span>
                          )}
                          {ev.timestamp && (
                            <span style={{ color: '#d73220', fontWeight: 600 }}>
                              · Time: {ev.timestamp}
                            </span>
                          )}
                        </div>

                        <div style={{ fontSize: 12, lineHeight: 1.45, color: '#222222' }}>
                          {ev.rationale}
                        </div>

                        {ev.suggestion && (
                          <div style={{ fontSize: 12, lineHeight: 1.4, color: '#0054b6', fontWeight: 500 }}>
                            Fix: {ev.suggestion}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}

        {activeTab === 'admin' && isAdmin && (
          <div className="bc-card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                Administrator Configuration
              </div>
              <div className="bc-subtext">
                Visible only to administrators. A default Gemini API key is already provisioned on
                the Adobe I/O Runtime action; enter a key below only to override it.
              </div>
              {userProfile && (
                <div className="bc-subtext" style={{ marginTop: 4 }}>
                  Signed in as <strong>{userProfile.name}</strong> ({userProfile.email})
                  {userGroups.length > 0
                    ? ` · Groups: ${userGroups.map(g => g.name).join(', ')}`
                    : ''}
                </div>
              )}
            </div>

            <div>
              <label className="bc-label">
                Google Gemini API Key Override (Gemini Developer API v1beta)
              </label>
              <input
                type="password"
                className="bc-input"
                value={geminiApiKey}
                onChange={e => handleSaveApiKey(e.target.value)}
                placeholder="Leave blank to use server-side Runtime GEMINI_API_KEY"
              />
            </div>

            <div>
              <label className="bc-label">Default Video Resolution Token Budget</label>
              <select
                className="bc-select"
                value={resolution}
                onChange={e => setResolution(e.target.value)}
              >
                <option value="low">Low (70 tokens/frame · fastest)</option>
                <option value="medium">Medium (70 tokens/frame)</option>
                <option value="high">High (280 tokens/frame · dense OCR / fine text)</option>
              </select>
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                cursor: 'pointer'
              }}
            >
              <input
                type="checkbox"
                checked={writeMetadata}
                onChange={e => setWriteMetadata(e.target.checked)}
              />
              Write results to <code>xdm:score</code> & <code>xdm:brandScoreNotes</code> on asset
            </label>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                type="button"
                className="bc-btn-primary"
                onClick={() => setKeySavedToast(true)}
              >
                Save Admin Settings
              </button>
              {keySavedToast && (
                <span className="bc-badge pass">Settings saved</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
