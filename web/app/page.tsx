'use client';

import { useEffect, useState } from 'react';
import AuthGate from './auth-gate';
import BaiduMap, { type AlarmLevel } from './baidu-map';
import PhotoCollection from './photo-collection';

type TabId = 'overview' | 'map' | 'history' | 'alerts' | 'photos';

type DeviceLocation = {
  longitude: number;
  latitude: number;
  locationMode: 'GPS' | 'LBS' | 'UNKNOWN';
  configuredIntervalSec: number;
  receivedAtMs: number | null;
};

type DeviceStatus = {
  risk: number;
  state: string;
  angleDeg: number;
  waterValid: boolean;
  clearanceCm: number | null;
  riseRateValid: boolean;
  riseRateCmPerMin: number | null;
  hallState: string;
  hallLeftPresent: boolean;
  hallRightPresent: boolean;
  sensorOnline: boolean;
  calibrated: boolean;
  alarmLatched: boolean;
  receivedAtMs: number | null;
};

type SensorHistoryRecord = DeviceStatus & {
  id: string;
  deviceId: string;
};

type LocationHistoryRecord = {
  id: string;
  deviceId: string;
  longitude: number;
  latitude: number;
  receivedAtMs: number | null;
};

type HistoryRow = {
  id: string;
  receivedAtMs: number;
  time: string;
  angle: string;
  clearance: string;
  waterLevel: WaterLevelKey;
  tiltLevel: AlarmLevel;
  hall: string;
  location: string;
  state: string;
};

type EventItem = {
  id: string;
  recordId: string;
  tone: string;
  title: string;
  detail: string;
  category: string;
  isWarning: boolean;
};

type WaterLevelKey = 'unknown' | 'safe' | 'caution' | 'danger' | 'critical';

const DEFAULT_LOCATION: DeviceLocation = {
  longitude: 87.573301,
  latitude: 43.819889,
  locationMode: 'LBS',
  configuredIntervalSec: 20,
  receivedAtMs: null,
};

const DEFAULT_STATUS: DeviceStatus = {
  risk: 0,
  state: 'NORMAL',
  angleDeg: 0,
  waterValid: false,
  clearanceCm: null,
  riseRateValid: false,
  riseRateCmPerMin: null,
  hallState: 'BOTH_PRESENT',
  hallLeftPresent: true,
  hallRightPresent: true,
  sensorOnline: false,
  calibrated: false,
  alarmLatched: false,
  receivedAtMs: null,
};

function locationModeLabel(mode: DeviceLocation['locationMode']) {
  return mode === 'GPS' ? 'GPS定位' : mode === 'LBS' ? '基站定位' : '定位方式待识别';
}

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

function alarmLevelFromRisk(risk: number): AlarmLevel {
  if (risk >= 3) return 'critical';
  if (risk === 2) return 'medium';
  if (risk === 1) return 'low';
  return 'normal';
}

function waterLevel(clearanceCm: number | null, valid = true): { key: WaterLevelKey; label: string; rule: string } {
  if (!valid || clearanceCm === null || !Number.isFinite(clearanceCm)) {
    return { key: 'unknown', label: '等待有效回波', rule: '距离尚未确认' };
  }
  if (clearanceCm > 30) return { key: 'safe', label: '安全', rule: '> 30cm' };
  if (clearanceCm >= 20) return { key: 'caution', label: '有点危险', rule: '20–30cm' };
  if (clearanceCm >= 10) return { key: 'danger', label: '危险', rule: '10–20cm' };
  return { key: 'critical', label: '最危险', rule: '< 10cm' };
}

function formatReportTime(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestamp));
}

function tiltStateLabel(state: string) {
  const labels: Record<string, string> = {
    NORMAL: '姿态正常',
    SLIGHT_TILT: '轻度倾斜',
    TILT_WARNING: '中度倾斜',
    TILTED: '重度倾斜',
    FLIPPED: '严重倾斜',
    INVERTED: '井盖翻转',
    CALIBRATION_REQUIRED: '需要校准',
    SENSOR_FAULT: '传感器故障',
  };
  return labels[state] || '状态待识别';
}

function hallStateLabel(state: string) {
  const labels: Record<string, string> = {
    BOTH_PRESENT: '双侧在位',
    LEFT_MISSING: '左侧离位',
    RIGHT_MISSING: '右侧离位',
    BOTH_MISSING: '双侧离位',
  };
  return labels[state] || '状态待识别';
}

const tabs: Array<{ id: TabId; icon: string; label: string }> = [
  { id: 'overview', icon: '总', label: '总览' },
  { id: 'map', icon: '图', label: '地图' },
  { id: 'history', icon: '史', label: '历史' },
  { id: 'alerts', icon: '警', label: '告警' },
  { id: 'photos', icon: '照', label: '照片' },
];

function Particles() {
  return (
    <div className="particle-field" aria-hidden="true">
      {Array.from({ length: 18 }, (_, index) => (
        <span key={index} style={{ left: `${(index * 37 + 9) % 96}%`, top: `${(index * 23 + 7) % 91}%`, animationDelay: `${(index % 7) * -0.9}s`, animationDuration: `${7 + (index % 5)}s` }} />
      ))}
    </div>
  );
}

function PositionVisual({ expanded = false, track = false, alarmLevel = 'normal', longitude, latitude, modeLabel }: { expanded?: boolean; track?: boolean; alarmLevel?: AlarmLevel; longitude: number; latitude: number; modeLabel: string }) {
  const longitudeDirection = longitude < 0 ? 'W' : 'E';
  const latitudeDirection = latitude < 0 ? 'S' : 'N';
  return (
    <div className={`map-stage ${expanded ? 'expanded' : ''}`} aria-label="MH001设备位置示意">
      <div className="scan-ring ring-one" /><div className="scan-ring ring-two" /><div className="map-grid" />
      <div className="road road-a" /><div className="road road-b" /><div className="road road-c" />
      <div className="map-label label-a">监测区域 A-01</div><div className="map-label label-b">当前{modeLabel}区域</div>
      <div className={`device-pin alarm-${alarmLevel}`}><span>MH001</span></div>
      {track && <><div className="track-line" /><i className="track-point point-a" /><i className="track-point point-b" /><i className="track-point point-c" /></>}
      <div className="coordinates"><b>{Math.abs(longitude).toFixed(6)}° {longitudeDirection}</b><span>{Math.abs(latitude).toFixed(6)}° {latitudeDirection}</span></div>
      <div className="map-legend"><i />设备在线 <em>{modeLabel}</em></div>
      {expanded && <div className="map-placeholder">{track ? '近7天定位轨迹预览' : '交互地图服务配置完成后将在此加载'}</div>}
    </div>
  );
}

function PanelHead({ kicker, title, tag }: { kicker: string; title: string; tag?: string }) {
  return <div className="panel-head"><div><p className="eyebrow">{kicker}</p><h2>{title}</h2></div>{tag && <span>{tag}</span>}</div>;
}

function Dashboard() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [detailOpen, setDetailOpen] = useState(false);
  const [alertFilter, setAlertFilter] = useState<'all' | 'warning'>('all');
  const [mapMode, setMapMode] = useState<'live' | 'track'>('live');
  const [historyRange, setHistoryRange] = useState<'today' | 'week'>('today');
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  const [deviceLocation, setDeviceLocation] = useState<DeviceLocation>(DEFAULT_LOCATION);
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>(DEFAULT_STATUS);
  const [sensorHistory, setSensorHistory] = useState<SensorHistoryRecord[]>([]);
  const [locationHistory, setLocationHistory] = useState<LocationHistoryRecord[]>([]);
  const [locationReadError, setLocationReadError] = useState('');
  const [deletingRecordId, setDeletingRecordId] = useState('');
  const [deleteMessage, setDeleteMessage] = useState('');
  const [selectedRecordIds, setSelectedRecordIds] = useState<string[]>([]);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const modeLabel = locationModeLabel(deviceLocation.locationMode);
  const alarmLevel = alarmLevelFromRisk(deviceStatus.risk);
  const secondsSinceReport = deviceLocation.receivedAtMs
    ? Math.max(0, Math.floor((clockMs - deviceLocation.receivedAtMs) / 1000))
    : 0;
  const reportAgeLabel = deviceLocation.receivedAtMs ? `${secondsSinceReport} 秒前` : '等待设备上报';
  const sensorSecondsSinceReport = deviceStatus.receivedAtMs
    ? Math.max(0, Math.floor((clockMs - deviceStatus.receivedAtMs) / 1000))
    : 0;
  const sensorReportAgeLabel = deviceStatus.receivedAtMs
    ? `${sensorSecondsSinceReport} 秒前`
    : '等待设备上报';
  const currentWaterLevel = waterLevel(deviceStatus.clearanceCm, deviceStatus.waterValid);
  const currentTiltLevel = alarmLevelFromRisk(deviceStatus.risk);
  const liveMetrics = [
    {
      label: '井盖姿态',
      value: `${deviceStatus.angleDeg.toFixed(1)}°`,
      hint: tiltStateLabel(deviceStatus.state),
      tone: `tilt-${currentTiltLevel}`,
      cardClass: `tilt-${currentTiltLevel}`,
      trend: `风险 ${deviceStatus.risk} 级`,
    },
    {
      label: '水面净空',
      value: deviceStatus.waterValid && deviceStatus.clearanceCm !== null
        ? `${deviceStatus.clearanceCm.toFixed(1)} cm`
        : '暂无有效数据',
      hint: currentWaterLevel.label,
      tone: `water-${currentWaterLevel.key}`,
      cardClass: `water-${currentWaterLevel.key}`,
      trend: deviceStatus.riseRateValid && deviceStatus.riseRateCmPerMin !== null
        ? `${currentWaterLevel.rule} · 变化 ${deviceStatus.riseRateCmPerMin.toFixed(2)} cm/min`
        : `${currentWaterLevel.rule} · 变化率计算中`,
    },
    {
      label: '霍尔状态',
      value: hallStateLabel(deviceStatus.hallState),
      hint: deviceStatus.hallLeftPresent && deviceStatus.hallRightPresent ? '井盖闭合' : '检测到离位',
      tone: deviceStatus.hallState === 'BOTH_PRESENT' ? 'normal' : 'warning',
      trend: `左${deviceStatus.hallLeftPresent ? '在位' : '离位'} · 右${deviceStatus.hallRightPresent ? '在位' : '离位'}`,
    },
    {
      label: '最后上报',
      value: sensorReportAgeLabel,
      hint: deviceStatus.sensorOnline ? '传感器在线' : '等待设备状态',
      tone: 'live',
      trend: '周期 20 秒',
    },
  ];
  const historyRows: HistoryRow[] = sensorHistory.map((record) => {
    const receivedAtMs = record.receivedAtMs ?? 0;
    const nearestLocation = locationHistory.reduce<LocationHistoryRecord | null>((nearest, location) => {
      if (!location.receivedAtMs || !receivedAtMs) return nearest;
      const distance = Math.abs(location.receivedAtMs - receivedAtMs);
      if (distance > 120000) return nearest;
      if (!nearest?.receivedAtMs || distance < Math.abs(nearest.receivedAtMs - receivedAtMs)) return location;
      return nearest;
    }, null);
    const level = waterLevel(record.clearanceCm, record.waterValid);
    return {
      id: record.id,
      receivedAtMs,
      time: receivedAtMs ? formatReportTime(receivedAtMs) : '时间未知',
      angle: `${record.angleDeg.toFixed(1)}°`,
      clearance: record.waterValid && record.clearanceCm !== null ? `${record.clearanceCm.toFixed(1)} cm · ${level.label}` : '无有效回波',
      waterLevel: level.key,
      tiltLevel: alarmLevelFromRisk(record.risk),
      hall: hallStateLabel(record.hallState),
      location: nearestLocation ? `${nearestLocation.longitude.toFixed(6)}, ${nearestLocation.latitude.toFixed(6)}` : '—',
      state: tiltStateLabel(record.state),
    };
  });
  const rangeStart = historyRange === 'today'
    ? new Date(new Date(clockMs).setHours(0, 0, 0, 0)).getTime()
    : clockMs - 7 * 24 * 60 * 60 * 1000;
  const visibleHistory = historyRows.filter((row) => row.receivedAtMs >= rangeStart);
  const liveEvents: EventItem[] = sensorHistory.flatMap((record) => {
    if (!record.receivedAtMs) return [];
    const time = formatReportTime(record.receivedAtMs);
    const level = waterLevel(record.clearanceCm, record.waterValid);
    const items: EventItem[] = [];
    if (record.risk > 0) items.push({ id: `${record.id}-tilt`, recordId: record.id, tone: `tilt-${alarmLevelFromRisk(record.risk)}`, title: `${tiltStateLabel(record.state)} · ${record.angleDeg.toFixed(1)}°`, detail: `${time} · 倾斜风险 ${record.risk} 级`, category: '倾斜告警', isWarning: true });
    if (record.waterValid && level.key !== 'safe') items.push({ id: `${record.id}-water`, recordId: record.id, tone: `water-${level.key}`, title: `水面净空${level.label} · ${record.clearanceCm?.toFixed(1)}cm`, detail: `${time} · 水位等级 ${level.rule}`, category: '水位告警', isWarning: true });
    if (record.hallState !== 'BOTH_PRESENT') items.push({ id: `${record.id}-hall`, recordId: record.id, tone: 'warn', title: `霍尔检测：${hallStateLabel(record.hallState)}`, detail: `${time} · 检测到井盖离位`, category: '霍尔告警', isWarning: true });
    if (items.length === 0) items.push({ id: `${record.id}-normal`, recordId: record.id, tone: 'ok', title: '设备状态正常', detail: `${time} · 传感器数据已同步`, category: '状态记录', isWarning: false });
    return items;
  });
  const visibleEvents = alertFilter === 'warning' ? liveEvents.filter((event) => event.isWarning) : liveEvents;
  const currentAlertCount = Number(deviceStatus.risk > 0) + Number(currentWaterLevel.key !== 'safe' && currentWaterLevel.key !== 'unknown') + Number(deviceStatus.hallState !== 'BOTH_PRESENT');
  const todayStart = new Date(new Date(clockMs).setHours(0, 0, 0, 0)).getTime();
  const todayEventCount = liveEvents.filter((event) => sensorHistory.some((record) => event.id.startsWith(record.id) && (record.receivedAtMs ?? 0) >= todayStart)).length;

  useEffect(() => {
    let active = true;

    async function refreshLocation() {
      setClockMs(Date.now());
      try {
        type LocationRecord = {
          longitude?: unknown;
          latitude?: unknown;
          locationMode?: unknown;
          configuredIntervalSec?: unknown;
          receivedAt?: unknown;
          updatedAt?: unknown;
        };
        type StatusRecord = {
          _id?: unknown;
          deviceId?: unknown;
          risk?: unknown;
          state?: unknown;
          angleDeg?: unknown;
          waterValid?: unknown;
          clearanceCm?: unknown;
          riseRateValid?: unknown;
          riseRateCmPerMin?: unknown;
          hallState?: unknown;
          hallLeftPresent?: unknown;
          hallRightPresent?: unknown;
          sensorOnline?: unknown;
          calibrated?: unknown;
          alarmLatched?: unknown;
          receivedAt?: unknown;
          updatedAt?: unknown;
        };
        type LocationHistoryRaw = LocationRecord & { _id?: unknown; deviceId?: unknown };
        const { cloudbaseApp } = await import('./lib/cloudbase');
        const database = cloudbaseApp.database();
        const [result, statusResult, sensorHistoryResult, locationHistoryResult] = await Promise.all([
          database.collection('device_locations').doc('MH001').get(),
          database.collection('device_status').doc('MH001').get(),
          database.collection('sensors').orderBy('receivedAt', 'desc').limit(100).get(),
          database.collection('locations').orderBy('receivedAt', 'desc').limit(100).get(),
        ]) as [
          { data?: LocationRecord | LocationRecord[] },
          { data?: StatusRecord | StatusRecord[] },
          { data?: StatusRecord[] },
          { data?: LocationHistoryRaw[] },
        ];
        const record = Array.isArray(result.data) ? result.data[0] : result.data;
        const statusRecord = Array.isArray(statusResult.data) ? statusResult.data[0] : statusResult.data;
        if (!active) return;

        if (record) {
          const longitude = Number(record.longitude);
          const latitude = Number(record.latitude);
          const interval = Number(record.configuredIntervalSec);
          const rawMode = String(record.locationMode || 'UNKNOWN').toUpperCase();
          setDeviceLocation((current) => ({
            longitude: Number.isFinite(longitude) ? longitude : current.longitude,
            latitude: Number.isFinite(latitude) ? latitude : current.latitude,
            locationMode: rawMode === 'GPS' || rawMode === 'LBS' ? rawMode : current.locationMode,
            configuredIntervalSec: Number.isInteger(interval) && interval > 0 ? interval : current.configuredIntervalSec,
            receivedAtMs: timestampMs(record.receivedAt ?? record.updatedAt) ?? current.receivedAtMs,
          }));
        }
        if (statusRecord) {
          const risk = Number(statusRecord.risk);
          const angleDeg = Number(statusRecord.angleDeg);
          const clearanceCm = statusRecord.clearanceCm === null ? null : Number(statusRecord.clearanceCm);
          const riseRate = statusRecord.riseRateCmPerMin === null ? null : Number(statusRecord.riseRateCmPerMin);
          setDeviceStatus((current) => ({
            risk: Number.isInteger(risk) && risk >= 0 && risk <= 5 ? risk : current.risk,
            state: String(statusRecord.state || current.state),
            angleDeg: Number.isFinite(angleDeg) ? angleDeg : current.angleDeg,
            waterValid: Boolean(statusRecord.waterValid),
            clearanceCm: clearanceCm !== null && Number.isFinite(clearanceCm) ? clearanceCm : null,
            riseRateValid: Boolean(statusRecord.riseRateValid),
            riseRateCmPerMin: riseRate !== null && Number.isFinite(riseRate) ? riseRate : null,
            hallState: String(statusRecord.hallState || current.hallState),
            hallLeftPresent: Boolean(statusRecord.hallLeftPresent),
            hallRightPresent: Boolean(statusRecord.hallRightPresent),
            sensorOnline: Boolean(statusRecord.sensorOnline),
            calibrated: Boolean(statusRecord.calibrated),
            alarmLatched: Boolean(statusRecord.alarmLatched),
            receivedAtMs: timestampMs(statusRecord.receivedAt ?? statusRecord.updatedAt) ?? current.receivedAtMs,
          }));
        }
        const statusRows = Array.isArray(sensorHistoryResult.data) ? sensorHistoryResult.data : [];
        setSensorHistory(statusRows
          .filter((row) => String(row.deviceId || 'MH001') === 'MH001')
          .map((row, index) => {
            const clearanceCm = row.clearanceCm === null ? null : Number(row.clearanceCm);
            const riseRate = row.riseRateCmPerMin === null ? null : Number(row.riseRateCmPerMin);
            return {
              id: String(row._id || `${timestampMs(row.receivedAt ?? row.updatedAt) || 0}-${index}`),
              deviceId: String(row.deviceId || 'MH001'),
              risk: Number(row.risk) || 0,
              state: String(row.state || 'NORMAL'),
              angleDeg: Number(row.angleDeg) || 0,
              waterValid: Boolean(row.waterValid),
              clearanceCm: clearanceCm !== null && Number.isFinite(clearanceCm) ? clearanceCm : null,
              riseRateValid: Boolean(row.riseRateValid),
              riseRateCmPerMin: riseRate !== null && Number.isFinite(riseRate) ? riseRate : null,
              hallState: String(row.hallState || 'BOTH_PRESENT'),
              hallLeftPresent: Boolean(row.hallLeftPresent),
              hallRightPresent: Boolean(row.hallRightPresent),
              sensorOnline: Boolean(row.sensorOnline),
              calibrated: Boolean(row.calibrated),
              alarmLatched: Boolean(row.alarmLatched),
              receivedAtMs: timestampMs(row.receivedAt ?? row.updatedAt),
            };
          }));
        const locationRows = Array.isArray(locationHistoryResult.data) ? locationHistoryResult.data : [];
        setLocationHistory(locationRows
          .filter((row) => String(row.deviceId || 'MH001') === 'MH001')
          .map((row, index) => ({
            id: String(row._id || `${timestampMs(row.receivedAt ?? row.updatedAt) || 0}-${index}`),
            deviceId: String(row.deviceId || 'MH001'),
            longitude: Number(row.longitude),
            latitude: Number(row.latitude),
            receivedAtMs: timestampMs(row.receivedAt ?? row.updatedAt),
          }))
          .filter((row) => Number.isFinite(row.longitude) && Number.isFinite(row.latitude)));
        setLocationReadError('');
      } catch (error) {
        if (active) setLocationReadError(error instanceof Error ? error.message : '定位数据读取失败');
      }
    }

    void refreshLocation();
    const timer = window.setInterval(refreshLocation, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  function exportHistory() {
    const header = ['时间', '倾斜角度', '水面净空', '霍尔状态', '位置', '状态'];
    const csv = [header, ...visibleHistory.map((row) => [row.time, row.angle, row.clearance, row.hall, row.location, row.state])]
      .map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    link.download = `MH001-${historyRange === 'today' ? 'today' : '7days'}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function deleteRecord(recordId: string) {
    if (deletingRecordId) return;
    const confirmed = window.confirm('确定删除这条上报记录吗？对应的时间线事件也会一并移除，此操作无法撤销。');
    if (!confirmed) return;
    setDeletingRecordId(recordId);
    setDeleteMessage('');
    try {
      const { cloudbaseApp } = await import('./lib/cloudbase');
      await cloudbaseApp.database().collection('sensors').doc(recordId).remove();
      setSensorHistory((records) => records.filter((record) => record.id !== recordId));
      setSelectedEvent((event) => event?.recordId === recordId ? null : event);
      setDeleteMessage('记录已删除');
    } catch (error) {
      setDeleteMessage(error instanceof Error ? `删除失败：${error.message}` : '删除失败，请确认当前账户权限');
    } finally {
      setDeletingRecordId('');
    }
  }

  function toggleRecordSelection(recordId: string) {
    setSelectedRecordIds((ids) => ids.includes(recordId)
      ? ids.filter((id) => id !== recordId)
      : [...ids, recordId]);
  }

  function toggleVisibleSelection() {
    const visibleIds = visibleHistory.map((row) => row.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedRecordIds.includes(id));
    setSelectedRecordIds((ids) => allSelected
      ? ids.filter((id) => !visibleIds.includes(id))
      : Array.from(new Set([...ids, ...visibleIds])));
  }

  async function deleteRecords(recordIds: string[]) {
    const uniqueIds = Array.from(new Set(recordIds));
    if (!uniqueIds.length || deletingRecordId) return;
    const confirmed = window.confirm(`确定批量删除选中的 ${uniqueIds.length} 条上报记录吗？对应的时间线事件也会一并移除，此操作无法撤销。`);
    if (!confirmed) return;
    setDeletingRecordId('__batch__');
    setDeleteMessage('');
    try {
      const { cloudbaseApp } = await import('./lib/cloudbase');
      const collection = cloudbaseApp.database().collection('sensors');
      const results = await Promise.allSettled(uniqueIds.map(async (id) => {
        await collection.doc(id).remove();
        return id;
      }));
      const removedIds = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      setSensorHistory((records) => records.filter((record) => !removedIds.includes(record.id)));
      setSelectedRecordIds((ids) => ids.filter((id) => !removedIds.includes(id)));
      setSelectedEvent((event) => event && removedIds.includes(event.recordId) ? null : event);
      const failedCount = uniqueIds.length - removedIds.length;
      setDeleteMessage(failedCount ? `已删除 ${removedIds.length} 条，${failedCount} 条删除失败` : `已批量删除 ${removedIds.length} 条记录`);
    } catch (error) {
      setDeleteMessage(error instanceof Error ? `批量删除失败：${error.message}` : '批量删除失败，请稍后重试');
    } finally {
      setDeletingRecordId('');
    }
  }

  return (
      <main className="shell">
        <Particles />
        <aside className="sidebar">
          <button className="brand-mark" type="button" onClick={() => setActiveTab('overview')} aria-label="返回系统总览"><span /></button>
          <nav aria-label="主要导航">
            {tabs.map((tab) => <button key={tab.id} type="button" className={`nav-item ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}><span>{tab.icon}</span>{tab.label}</button>)}
          </nav>
          <div className="sidebar-foot"><i />SYSTEM<br />ONLINE</div>
        </aside>

        <section className="workspace">
          <header className="topbar">
            <div><p className="eyebrow">SMART MANHOLE · MONITORING PLATFORM</p><h1>智能井盖检测系统</h1></div>
            <div className="operator"><span className="operator-avatar">维</span><div><strong>系统维护人员</strong><small><i />监测中心在线</small></div></div>
          </header>

          <section className="status-strip">
            <div><span className="pulse" /><strong>MH001</strong><small>设备在线</small></div>
            <p>{locationReadError ? `定位数据读取异常：${locationReadError}` : `M100PG ${modeLabel} · ${deviceLocation.configuredIntervalSec}秒上报 · 数据链路正常`}</p>
            <button type="button" onClick={() => setDetailOpen(true)}>设备详情 <span>→</span></button>
          </section>

          {activeTab === 'overview' && <div className="tab-page page-enter">
            <section className="section-title"><div><p className="eyebrow">SYSTEM OVERVIEW</p><h2>运行总览</h2></div><span>数据更新于 {reportAgeLabel}</span></section>
            <section className="metric-grid" aria-label="设备状态摘要">
              {liveMetrics.map((metric, index) => <button className={`metric-card ${'cardClass' in metric ? metric.cardClass : ''}`} key={metric.label} type="button" onClick={() => setDetailOpen(true)}><div className="metric-head"><span>0{index + 1} · {metric.label}</span><i className={metric.tone} /></div><strong>{metric.value}</strong><small>{metric.hint}</small><em>{metric.trend}</em></button>)}
            </section>
            <section className="main-grid">
              <article className="panel-card map-card"><PanelHead kicker="REAL-TIME POSITION" title="设备位置" tag={modeLabel} /><PositionVisual alarmLevel={alarmLevel} longitude={deviceLocation.longitude} latitude={deviceLocation.latitude} modeLabel={modeLabel} /><button className="panel-link" type="button" onClick={() => setActiveTab('map')}>进入地图视图 <span>→</span></button></article>
              <aside className="panel-card alerts-card"><PanelHead kicker="LATEST EVENTS" title="运行事件" tag="实时更新" /><ol className="event-list">{liveEvents.slice(0, 3).map((event) => <li key={event.id}><i className={event.tone} /><div><strong>{event.title}</strong><small>{event.detail}</small></div></li>)}</ol>{liveEvents.length === 0 && <p className="empty-state">等待首条真实传感器记录</p>}<button className="secondary" type="button" onClick={() => setActiveTab('alerts')}>查看全部记录</button></aside>
            </section>
          </div>}

          {activeTab === 'map' && <div className="tab-page page-enter">
            <section className="section-title"><div><p className="eyebrow">LIVE LOCATION</p><h2>实时定位</h2></div><div className="segmented"><button className={mapMode === 'live' ? 'active' : ''} onClick={() => setMapMode('live')}>实时位置</button><button className={mapMode === 'track' ? 'active' : ''} onClick={() => setMapMode('track')}>历史轨迹</button></div></section>
            <article className="panel-card full-map-card"><PanelHead kicker="DEVICE MH001" title={mapMode === 'live' ? '设备位置监测' : '设备历史轨迹'} tag={`${deviceLocation.longitude.toFixed(6)}, ${deviceLocation.latitude.toFixed(6)}`} />{mapMode === 'live' ? <BaiduMap longitude={deviceLocation.longitude} latitude={deviceLocation.latitude} locationMode={deviceLocation.locationMode} alarmLevel={alarmLevel} /> : <PositionVisual expanded track alarmLevel={alarmLevel} longitude={deviceLocation.longitude} latitude={deviceLocation.latitude} modeLabel={modeLabel} />}<div className="map-stats"><div><span>定位方式</span><strong>{modeLabel}</strong></div><div><span>上报周期</span><strong>{deviceLocation.configuredIntervalSec} 秒</strong></div><div><span>网络状态</span><strong className="text-online">4G 在线</strong></div><div><span>历史保留</span><strong>7 天</strong></div></div></article>
          </div>}

          {activeTab === 'history' && <div className="tab-page page-enter">
            <section className="section-title"><div><p className="eyebrow">DATA HISTORY</p><h2>历史数据</h2></div><div className="segmented"><button className={historyRange === 'today' ? 'active' : ''} onClick={() => setHistoryRange('today')}>今天</button><button className={historyRange === 'week' ? 'active' : ''} onClick={() => setHistoryRange('week')}>近7天</button></div></section>
            <article className="panel-card history-card"><PanelHead kicker="TELEMETRY RECORDS" title="MH001 上报记录" tag="每5秒自动刷新" />{deleteMessage && <p className="record-message" role="status">{deleteMessage}</p>}<div className="batch-toolbar"><span>已选择 {selectedRecordIds.length} 条</span><button className="batch-delete" type="button" disabled={!selectedRecordIds.length || deletingRecordId === '__batch__'} onClick={() => void deleteRecords(selectedRecordIds)}>{deletingRecordId === '__batch__' ? '批量删除中…' : '删除所选记录'}</button></div><div className="data-table-wrap"><table className="data-table"><thead><tr><th className="select-cell"><input type="checkbox" aria-label="全选当前列表" checked={visibleHistory.length > 0 && visibleHistory.every((row) => selectedRecordIds.includes(row.id))} onChange={toggleVisibleSelection} /></th><th>时间</th><th>倾斜角度</th><th>水面净空</th><th>霍尔状态</th><th>位置</th><th>姿态状态</th><th>操作</th></tr></thead><tbody>{visibleHistory.map((row) => <tr key={row.id}><td className="select-cell"><input type="checkbox" aria-label={`选择 ${row.time} 的记录`} checked={selectedRecordIds.includes(row.id)} onChange={() => toggleRecordSelection(row.id)} /></td><td>{row.time}</td><td>{row.angle}</td><td><span className={`water-badge water-${row.waterLevel}`}>{row.clearance}</span></td><td>{row.hall}</td><td className="mono">{row.location}</td><td><span className={`tilt-badge tilt-${row.tiltLevel}`}>{row.state}</span></td><td><button className="delete-record" type="button" disabled={Boolean(deletingRecordId)} onClick={() => void deleteRecord(row.id)}>{deletingRecordId === row.id ? '删除中…' : '删除'}</button></td></tr>)}</tbody></table>{visibleHistory.length === 0 && <p className="empty-state">当前时间范围内暂无设备上报记录</p>}</div><div className="table-foot"><span>显示最近{visibleHistory.length}条真实记录</span><button type="button" onClick={exportHistory}>导出数据</button></div></article>
          </div>}

          {activeTab === 'alerts' && <div className="tab-page page-enter">
            <section className="section-title"><div><p className="eyebrow">ALERT CENTER</p><h2>告警中心</h2></div><div className="segmented"><button className={alertFilter === 'all' ? 'active' : ''} onClick={() => setAlertFilter('all')}>全部事件</button><button className={alertFilter === 'warning' ? 'active' : ''} onClick={() => setAlertFilter('warning')}>仅告警</button></div></section>
            <section className="alert-summary"><div><span>当前告警</span><strong>{currentAlertCount}</strong><small>{currentAlertCount ? '存在需要关注的设备状态' : '系统运行正常'}</small></div><div><span>今日事件</span><strong>{todayEventCount}</strong><small>来自真实设备上报</small></div><div><span>设备在线率</span><strong>{sensorSecondsSinceReport <= 60 ? '100%' : '0%'}</strong><small>按最近60秒上报判断</small></div></section>
            <article className="panel-card alert-log-card"><PanelHead kicker="EVENT TIMELINE" title="事件时间线" tag={`${visibleEvents.length} 条真实记录`} />{deleteMessage && <p className="record-message" role="status">{deleteMessage}</p>}<div className="batch-toolbar"><span>批量操作会清除当前筛选结果对应的上报记录</span><button className="batch-delete" type="button" disabled={!visibleEvents.length || deletingRecordId === '__batch__'} onClick={() => void deleteRecords(visibleEvents.map((event) => event.recordId))}>{deletingRecordId === '__batch__' ? '批量清除中…' : `清除当前列表（${new Set(visibleEvents.map((event) => event.recordId)).size}条）`}</button></div><ol className="timeline">{visibleEvents.map((event) => <li key={event.id}><i className={event.tone} /><div><span>{event.category}</span><strong>{event.title}</strong><small>{event.detail}</small></div><div className="timeline-actions"><button type="button" onClick={() => setSelectedEvent(event)}>查看</button><button className="delete-record" type="button" disabled={Boolean(deletingRecordId)} onClick={() => void deleteRecord(event.recordId)}>{deletingRecordId === event.recordId ? '删除中…' : '删除'}</button></div></li>)}</ol>{visibleEvents.length === 0 && <p className="empty-state">暂无符合条件的告警记录</p>}</article>
          </div>}

          {activeTab === 'photos' && <div className="tab-page page-enter">
            <PhotoCollection />
          </div>}
        </section>

        {detailOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setDetailOpen(false)}><section className="device-modal" role="dialog" aria-modal="true" aria-label="MH001设备详情" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p className="eyebrow">DEVICE PROFILE</p><h2>MH001 设备详情</h2></div><button onClick={() => setDetailOpen(false)} aria-label="关闭">×</button></div><div className="device-hero"><span className="device-orbit"><i /></span><div><strong>M100PG · 4G Cat.1</strong><small><i />在线 · 最近上报{reportAgeLabel}</small></div></div><dl className="detail-list"><div><dt>设备编号</dt><dd>MH001</dd></div><div><dt>定位方式</dt><dd>{modeLabel}</dd></div><div><dt>经度</dt><dd>{Math.abs(deviceLocation.longitude).toFixed(6)}° {deviceLocation.longitude < 0 ? 'W' : 'E'}</dd></div><div><dt>纬度</dt><dd>{Math.abs(deviceLocation.latitude).toFixed(6)}° {deviceLocation.latitude < 0 ? 'S' : 'N'}</dd></div><div><dt>网络链路</dt><dd>4G / HTTPS</dd></div><div><dt>数据周期</dt><dd>{deviceLocation.configuredIntervalSec}秒</dd></div></dl><button className="modal-action" type="button" onClick={() => { setDetailOpen(false); setActiveTab('history'); }}>查看历史数据</button></section></div>}
        {selectedEvent && <div className="modal-backdrop" role="presentation" onMouseDown={() => setSelectedEvent(null)}><section className="event-modal" role="dialog" aria-modal="true" aria-label="事件详情" onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><p className="eyebrow">EVENT DETAIL</p><h2>{selectedEvent.title}</h2></div><button onClick={() => setSelectedEvent(null)} aria-label="关闭">×</button></div><span className="event-category">{selectedEvent.category}</span><p>{selectedEvent.detail}</p><div className="event-resolution"><i />系统已记录该事件，当前无需人工处理。</div><button className="modal-action" type="button" onClick={() => setSelectedEvent(null)}>确认</button></section></div>}
      </main>
  );
}

export default function Home() {
  return <AuthGate><Dashboard /></AuthGate>;
}
