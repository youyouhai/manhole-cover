'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type BatchStatus = 'created' | 'uploading' | 'completed' | 'partial_failed' | 'failed';

type PhotoBatch = {
  batchId: string;
  deviceId: string;
  requestedCount: number;
  successCount: number;
  failedCount: number;
  status: BatchStatus;
  capturedAtMs: number;
  completedAtMs: number | null;
  createdAtMs: number;
};

type PhotoItem = {
  photoId: string;
  sequence: number;
  storageFileId: string;
  sizeBytes: number;
  capturedAtMs: number;
  status: string;
  previewUrl: string;
};

type RawRecord = Record<string, unknown>;

const STATUS_LABELS: Record<BatchStatus, string> = {
  created: '等待上传',
  uploading: '上传中',
  completed: '已完成',
  partial_failed: '部分失败',
  failed: '上传失败',
};

function timestampMs(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object' && '$date' in value) {
    return timestampMs((value as { $date: unknown }).$date);
  }
  return null;
}

function formatTime(value: number | null) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function toBatch(row: RawRecord): PhotoBatch {
  const status = String(row.status || 'created') as BatchStatus;
  return {
    batchId: String(row.batchId || row._id || ''),
    deviceId: String(row.deviceId || ''),
    requestedCount: Number(row.requestedCount) || 0,
    successCount: Number(row.successCount) || 0,
    failedCount: Number(row.failedCount) || 0,
    status: status in STATUS_LABELS ? status : 'created',
    capturedAtMs: timestampMs(row.capturedAt) || 0,
    completedAtMs: timestampMs(row.completedAt),
    createdAtMs: timestampMs(row.createdAt) || 0,
  };
}

export default function PhotoCollection() {
  const [batches, setBatches] = useState<PhotoBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deviceFilter, setDeviceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);
  const [onlineDevices, setOnlineDevices] = useState(0);
  const [selectedBatch, setSelectedBatch] = useState<PhotoBatch | null>(null);
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [preview, setPreview] = useState<PhotoItem | null>(null);
  const [brokenPhotos, setBrokenPhotos] = useState<string[]>([]);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandMessage, setCommandMessage] = useState('');
  const [pendingCommandId, setPendingCommandId] = useState('');
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([]);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState('');
  const pageSize = 10;

  const loadBatches = useCallback(async () => {
    try {
      const { cloudbaseAuth } = await import('./lib/cloudbase');
      const { accessToken } = await cloudbaseAuth.getAccessToken();
      const apiBase = process.env.NEXT_PUBLIC_PHOTO_API_BASE;
      if (!apiBase) throw new Error('照片服务地址尚未配置');
      const response = await fetch(`${apiBase}/api/admin/photo-batches?page=1&pageSize=50`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const result = await response.json() as { items?: RawRecord[]; onlineDevices?: number; message?: string };
      if (!response.ok) throw new Error(result.message || '照片批次读取失败');
      const rows = Array.isArray(result.items) ? result.items : [];
      setBatches(rows.map(toBatch));
      setSelectedBatchIds((previous) => previous.filter((id) => rows.some((row) => (row.batchId || row._id) === id)));
      setOnlineDevices(Number(result.onlineDevices) || 0);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '照片批次读取失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(loadBatches, 0);
    const timer = window.setInterval(loadBatches, 5000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadBatches]);

  const filtered = useMemo(() => {
    const start = startDate ? new Date(`${startDate}T00:00:00`).getTime() : 0;
    const end = endDate ? new Date(`${endDate}T23:59:59.999`).getTime() : Number.MAX_SAFE_INTEGER;
    return batches.filter((batch) => (
      (!deviceFilter || batch.deviceId.toLowerCase().includes(deviceFilter.trim().toLowerCase()))
      && (!statusFilter || batch.status === statusFilter)
      && batch.capturedAtMs >= start
      && batch.capturedAtMs <= end
    ));
  }, [batches, deviceFilter, endDate, startDate, statusFilter]);

  const todayStart = new Date().setHours(0, 0, 0, 0);
  const todayBatches = batches.filter((batch) => batch.createdAtMs >= todayStart);
  const todayPhotos = todayBatches.reduce((sum, batch) => sum + batch.successCount, 0);
  const failedBatches = todayBatches.filter((batch) => batch.status === 'failed' || batch.status === 'partial_failed').length;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  const deletableVisible = visible.filter((batch) => !['created', 'uploading'].includes(batch.status));
  const allVisibleSelected = deletableVisible.length > 0 && deletableVisible.every((batch) => selectedBatchIds.includes(batch.batchId));
  const allPhotosSelected = photos.length > 0 && photos.every((photo) => selectedPhotoIds.includes(photo.photoId));

  useEffect(() => { setSelectedBatchIds([]); }, [page, deviceFilter, statusFilter, startDate, endDate]);

  const loadBatchDetail = useCallback(async (batch: PhotoBatch, showSpinner = false) => {
    if (showSpinner) setDetailLoading(true);
    try {
      const { cloudbaseAuth } = await import('./lib/cloudbase');
      const { accessToken } = await cloudbaseAuth.getAccessToken();
      const apiBase = process.env.NEXT_PUBLIC_PHOTO_API_BASE;
      if (!apiBase) throw new Error('照片服务地址尚未配置');
      const response = await fetch(`${apiBase}/api/admin/photo-batches/${encodeURIComponent(batch.batchId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const result = await response.json() as { photos?: RawRecord[]; message?: string };
      if (!response.ok) throw new Error(result.message || '批次照片读取失败');
      const rows = Array.isArray(result.photos) ? result.photos : [];
      setBrokenPhotos([]);
      setDetailError('');
      setPhotos(rows.map((row) => ({
        photoId: String(row.photoId || row._id || ''),
        sequence: Number(row.sequence) || 0,
        storageFileId: String(row.storageFileId || ''),
        sizeBytes: Number(row.sizeBytes) || 0,
        capturedAtMs: timestampMs(row.capturedAt) || 0,
        status: String(row.status || 'uploaded'),
        previewUrl: String(row.previewUrl || ''),
      })));
      setSelectedPhotoIds((previous) => previous.filter((id) => rows.some((row) => (row.photoId || row._id) === id)));
    } catch (loadError) {
      setDetailError(loadError instanceof Error ? loadError.message : '批次照片读取失败');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  function openBatch(batch: PhotoBatch) {
    setSelectedBatch(batch);
    setPhotos([]);
    setSelectedPhotoIds([]);
    setDeleteMessage('');
    setDetailError('');
    void loadBatchDetail(batch, true);
  }

  useEffect(() => {
    if (!selectedBatch) return;
    const timer = window.setInterval(() => void loadBatchDetail(selectedBatch), 5000);
    return () => window.clearInterval(timer);
  }, [loadBatchDetail, selectedBatch]);

  useEffect(() => {
    if (!pendingCommandId) return;
    let cancelled = false;
    const checkCommand = async () => {
      try {
        const { cloudbaseAuth } = await import('./lib/cloudbase');
        const { accessToken } = await cloudbaseAuth.getAccessToken();
        const response = await fetch(`${process.env.NEXT_PUBLIC_PHOTO_API_BASE}/api/admin/capture-command/${encodeURIComponent(pendingCommandId)}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) return;
        const command = await response.json() as { status: string; requestedCount: number };
        if (cancelled) return;
        if (command.status === 'accepted') {
          setCommandMessage(`相机已领取 ${command.requestedCount} 张拍照指令，正在拍照并上传；照片批次会自动刷新。`);
          setPendingCommandId('');
        } else if (command.status === 'expired') {
          setCommandMessage('指令已过期，相机在 2 分钟内没有联网领取。请检查相机热点、供电与本地 /status，再重新发送。');
          setPendingCommandId('');
        }
      } catch {
        // Keep the pending indicator; the next poll may recover from a transient network error.
      }
    };
    void checkCommand();
    const timer = window.setInterval(() => void checkCommand(), 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [pendingCommandId]);

  async function requestCapture(requestedCount: 1 | 3 | 5) {
    setCommandBusy(true);
    setCommandMessage('正在发送拍照指令…');
    try {
      const { cloudbaseAuth } = await import('./lib/cloudbase');
      const { accessToken } = await cloudbaseAuth.getAccessToken();
      const apiBase = process.env.NEXT_PUBLIC_PHOTO_API_BASE;
      if (!apiBase) throw new Error('照片服务地址尚未配置');
      const response = await fetch(`${apiBase}/api/admin/capture-command`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'goouuu-cam-001', requestedCount }),
      });
      const result = await response.json() as { commandId?: string; message?: string };
      if (!response.ok) throw new Error(result.message || `指令提交失败（HTTP ${response.status}）`);
      setPendingCommandId(result.commandId || '');
      setCommandMessage(`已排队 ${requestedCount} 张拍照指令，等待相机领取（有效期 2 分钟）。这不等于已拍照；收到照片后批次会自动刷新。`);
    } catch (requestError) {
      setCommandMessage(requestError instanceof Error ? requestError.message : '拍照指令发送失败');
    } finally {
      setCommandBusy(false);
    }
  }

  function toggleBatchSelection(batchId: string) {
    setSelectedBatchIds((previous) => previous.includes(batchId)
      ? previous.filter((id) => id !== batchId) : [...previous, batchId]);
  }

  function toggleVisibleBatches() {
    const visibleIds = deletableVisible.map((batch) => batch.batchId);
    setSelectedBatchIds((previous) => allVisibleSelected
      ? previous.filter((id) => !visibleIds.includes(id))
      : [...new Set([...previous, ...visibleIds])]);
  }

  async function deleteSelectedBatches() {
    const batchIds = selectedBatchIds.filter((id) => deletableVisible.some((batch) => batch.batchId === id));
    if (!batchIds.length || deleteBusy) return;
    if (!window.confirm(`将永久删除本页选中的 ${batchIds.length} 个批次及其中全部云端照片。删除后无法恢复，确定继续吗？`)) return;
    setDeleteBusy(true);
    setDeleteMessage('正在删除云端照片与批次记录…');
    try {
      const { cloudbaseAuth } = await import('./lib/cloudbase');
      const { accessToken } = await cloudbaseAuth.getAccessToken();
      const apiBase = process.env.NEXT_PUBLIC_PHOTO_API_BASE;
      if (!apiBase) throw new Error('照片服务地址尚未配置');
      const response = await fetch(`${apiBase}/api/admin/photo-batches/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchIds, confirmation: 'DELETE' }),
      });
      const result = await response.json() as { deletedBatchIds?: string[]; deletedPhotoCount?: number; failures?: unknown[]; message?: string };
      if (!response.ok) throw new Error(result.message || `删除失败（HTTP ${response.status}）`);
      setSelectedBatchIds([]);
      setDeleteMessage(`已删除 ${result.deletedBatchIds?.length || 0} 个批次及 ${result.deletedPhotoCount || 0} 张云端照片${result.failures?.length ? `；${result.failures.length} 个批次未删除，请重试` : ''}。`);
      await loadBatches();
    } catch (deleteError) {
      setDeleteMessage(deleteError instanceof Error ? deleteError.message : '删除失败，请重试');
    } finally {
      setDeleteBusy(false);
    }
  }

  async function deleteSelectedPhotos() {
    if (!selectedBatch || !selectedPhotoIds.length || deleteBusy) return;
    const photoIds = selectedPhotoIds.filter((id) => photos.some((photo) => photo.photoId === id));
    if (!photoIds.length) return;
    if (!window.confirm(`将永久删除选中的 ${photoIds.length} 张云端照片。删除后无法恢复，确定继续吗？`)) return;
    setDeleteBusy(true);
    setDeleteMessage('正在删除选中的云端照片…');
    try {
      const { cloudbaseAuth } = await import('./lib/cloudbase');
      const { accessToken } = await cloudbaseAuth.getAccessToken();
      const apiBase = process.env.NEXT_PUBLIC_PHOTO_API_BASE;
      if (!apiBase) throw new Error('照片服务地址尚未配置');
      const response = await fetch(`${apiBase}/api/admin/photo-batches/${encodeURIComponent(selectedBatch.batchId)}/photos/delete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ photoIds, confirmation: 'DELETE' }),
      });
      const result = await response.json() as { deletedCount?: number; message?: string };
      if (!response.ok) throw new Error(result.message || `删除失败（HTTP ${response.status}）`);
      const deletedCount = Number(result.deletedCount) || 0;
      setSelectedPhotoIds([]);
      setDeleteMessage(`已删除 ${deletedCount} 张云端照片。`);
      setSelectedBatch((current) => {
        if (!current) return null;
        const successCount = Math.max(0, current.successCount - deletedCount);
        return { ...current, successCount, failedCount: current.requestedCount - successCount,
          status: successCount === 0 ? 'failed' : 'partial_failed' };
      });
      await Promise.all([loadBatchDetail(selectedBatch, true), loadBatches()]);
    } catch (deleteError) {
      setDeleteMessage(deleteError instanceof Error ? deleteError.message : '删除失败，请重试');
    } finally {
      setDeleteBusy(false);
    }
  }

  function resetFilters() {
    setDeviceFilter('');
    setStatusFilter('');
    setStartDate('');
    setEndDate('');
    setPage(1);
  }

  return (
    <div className="photo-page">
      <section className="section-title">
        <div><p className="eyebrow">PHOTO COLLECTION</p><h2>照片采集</h2></div>
        <span>每5秒自动刷新</span>
      </section>

      <section className="photo-stat-grid" aria-label="照片采集统计">
        <article><span>今日批次</span><strong>{todayBatches.length}</strong><small>设备采集任务</small></article>
        <article><span>今日照片</span><strong>{todayPhotos}</strong><small>已安全入库</small></article>
        <article><span>异常批次</span><strong>{failedBatches}</strong><small>失败或部分失败</small></article>
        <article><span>相机在线</span><strong>{onlineDevices}</strong><small>最近5分钟有通信</small></article>
      </section>

      <section className="panel-card photo-capture-controls" aria-label="远程拍照">
        <div><p className="eyebrow">REMOTE CAPTURE</p><h2>远程采集 · goouuu-cam-001</h2><p>相机需连接可上网的 2.4 GHz 热点并运行新版固件；倾斜设备确认报警后会自动连拍 3 张。当前相机{onlineDevices > 0 ? '近 5 分钟有通信' : '暂无在线心跳'}。</p></div>
        <div className="photo-capture-actions">
          <button type="button" disabled={commandBusy} onClick={() => void requestCapture(1)}>拍一张</button>
          <button type="button" disabled={commandBusy} onClick={() => void requestCapture(3)}>连拍 3 张</button>
          <button type="button" disabled={commandBusy} onClick={() => void requestCapture(5)}>连拍 5 张</button>
        </div>
        {commandMessage && <p role="status" className="photo-command-message">{commandMessage}</p>}
      </section>

      <article className="panel-card photo-list-card">
        <div className="panel-head"><div><p className="eyebrow">CAPTURE BATCHES</p><h2>采集批次</h2></div><span>{filtered.length} 条记录</span></div>
        <div className="photo-filters">
          <label><span>设备编号</span><input value={deviceFilter} onChange={(event) => { setDeviceFilter(event.target.value); setPage(1); }} placeholder="goouuu-cam-001" /></label>
          <label><span>开始日期</span><input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setPage(1); }} /></label>
          <label><span>结束日期</span><input type="date" value={endDate} onChange={(event) => { setEndDate(event.target.value); setPage(1); }} /></label>
          <label><span>批次状态</span><select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }}><option value="">全部状态</option>{Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <button className="photo-reset" type="button" onClick={resetFilters}>重置筛选</button>
        </div>

        <div className="photo-selection-bar">
          <label><input type="checkbox" checked={allVisibleSelected} disabled={!deletableVisible.length || deleteBusy} onChange={toggleVisibleBatches} />全选本页可删除批次</label>
          <span>已选 {selectedBatchIds.length} 个批次</span>
          <button className="photo-delete" type="button" disabled={!selectedBatchIds.length || deleteBusy} onClick={() => void deleteSelectedBatches()}>{deleteBusy ? '删除中…' : '删除选中批次'}</button>
          <small>正在上传的批次不能删除；云端照片和记录会一起清理</small>
        </div>
        {deleteMessage && <p className="photo-delete-message" role="status">{deleteMessage}</p>}

        {error && <div className="photo-state error"><strong>照片数据暂时无法加载</strong><span>{error}</span><button type="button" onClick={() => void loadBatches()}>重新加载</button></div>}
        {!error && loading && <div className="photo-state"><strong>正在读取照片批次…</strong><span>请稍候</span></div>}
        {!error && !loading && visible.length === 0 && <div className="photo-state"><strong>暂无照片批次</strong><span>相机首次上传后会自动显示在这里</span></div>}
        {!error && visible.length > 0 && (
          <div className="data-table-wrap"><table className="data-table photo-table">
            <thead><tr><th>选择</th><th>批次编号</th><th>设备编号</th><th>请求</th><th>成功</th><th>失败</th><th>状态</th><th>采集时间</th><th>完成时间</th><th>操作</th></tr></thead>
            <tbody>{visible.map((batch) => <tr key={batch.batchId}>
              <td><input type="checkbox" aria-label={`选择批次 ${batch.batchId}`} checked={selectedBatchIds.includes(batch.batchId)} disabled={deleteBusy || ['created', 'uploading'].includes(batch.status)} onChange={() => toggleBatchSelection(batch.batchId)} /></td>
              <td className="mono">{batch.batchId}</td><td>{batch.deviceId}</td><td>{batch.requestedCount}</td><td>{batch.successCount}</td><td>{batch.failedCount}</td>
              <td><span className={`photo-status status-${batch.status}`}>{STATUS_LABELS[batch.status]}</span></td>
              <td>{formatTime(batch.capturedAtMs)}</td><td>{formatTime(batch.completedAtMs)}</td>
              <td><button className="photo-view" type="button" onClick={() => void openBatch(batch)}>查看照片</button></td>
            </tr>)}</tbody>
          </table></div>
        )}

        <div className="photo-pagination"><span>第 {Math.min(page, pageCount)} / {pageCount} 页</span><div><button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>上一页</button><button type="button" disabled={page >= pageCount} onClick={() => setPage((current) => current + 1)}>下一页</button></div></div>
      </article>

      {selectedBatch && <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelectedBatch(null)}>
        <section className="photo-modal" role="dialog" aria-modal="true" aria-label="照片批次详情" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-head"><div><p className="eyebrow">BATCH DETAIL</p><h2>{selectedBatch.batchId}</h2></div><button type="button" onClick={() => setSelectedBatch(null)} aria-label="关闭">×</button></div>
          <div className="photo-batch-summary"><span>设备 {selectedBatch.deviceId}</span><span>{selectedBatch.successCount}/{selectedBatch.requestedCount} 张成功</span><span className={`photo-status status-${selectedBatch.status}`}>{STATUS_LABELS[selectedBatch.status]}</span></div>
          <div className="photo-selection-bar">
            <label><input type="checkbox" checked={allPhotosSelected} disabled={!photos.length || deleteBusy || ['created', 'uploading'].includes(selectedBatch.status)} onChange={() => setSelectedPhotoIds(allPhotosSelected ? [] : photos.map((photo) => photo.photoId))} />全选本批照片</label>
            <span>已选 {selectedPhotoIds.length} 张</span>
            <button className="photo-delete" type="button" disabled={!selectedPhotoIds.length || deleteBusy || ['created', 'uploading'].includes(selectedBatch.status)} onClick={() => void deleteSelectedPhotos()}>{deleteBusy ? '删除中…' : '删除选中照片'}</button>
          </div>
          {deleteMessage && <p className="photo-delete-message" role="status">{deleteMessage}</p>}
          {detailLoading && <div className="photo-state"><strong>正在生成安全预览链接…</strong></div>}
          {detailError && <div className="photo-state error"><strong>照片读取失败</strong><span>{detailError}</span><button type="button" onClick={() => void loadBatchDetail(selectedBatch, true)}>重试</button></div>}
          {!detailLoading && !detailError && photos.length === 0 && <div className="photo-state"><strong>此批次暂未收到照片</strong><span>设备上传后页面会自动更新</span></div>}
          <div className="photo-grid">{photos.map((photo) => <article className="photo-tile" key={photo.photoId}>
            <label className="photo-select"><input type="checkbox" checked={selectedPhotoIds.includes(photo.photoId)} disabled={deleteBusy || ['created', 'uploading'].includes(selectedBatch.status)} onChange={() => setSelectedPhotoIds((previous) => previous.includes(photo.photoId) ? previous.filter((id) => id !== photo.photoId) : [...previous, photo.photoId])} />选中</label>
            <button type="button" className="photo-image-button" onClick={() => photo.previewUrl && !brokenPhotos.includes(photo.photoId) && setPreview(photo)} disabled={!photo.previewUrl || brokenPhotos.includes(photo.photoId)}>
              <div>{photo.previewUrl && !brokenPhotos.includes(photo.photoId) ? <img src={photo.previewUrl} alt={`第${photo.sequence}张采集照片`} onError={() => setBrokenPhotos((previous) => [...new Set([...previous, photo.photoId])])} /> : <span>图片无法加载，请重开批次以刷新链接</span>}</div>
              <strong>第 {photo.sequence} 张</strong><small>{formatTime(photo.capturedAtMs)} · {(photo.sizeBytes / 1024).toFixed(1)} KB</small>
            </button>
          </article>)}</div>
        </section>
      </div>}

      {preview && <div className="modal-backdrop photo-preview-backdrop" role="presentation" onMouseDown={() => setPreview(null)}><section className="photo-preview" role="dialog" aria-modal="true" aria-label="照片原图预览" onMouseDown={(event) => event.stopPropagation()}><button type="button" onClick={() => setPreview(null)} aria-label="关闭原图">×</button><img src={preview.previewUrl} alt={`第${preview.sequence}张采集照片原图`} /><span>第 {preview.sequence} 张 · {(preview.sizeBytes / 1024).toFixed(1)} KB</span></section></div>}
    </div>
  );
}
