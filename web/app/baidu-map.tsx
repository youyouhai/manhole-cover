'use client';

import { useEffect, useRef, useState } from 'react';

type BaiduMapInstance = {
  centerAndZoom: (point: object, zoom: number) => void;
  enableDragging: () => void;
  enableScrollWheelZoom: (enabled: boolean) => void;
  addOverlay: (overlay: object) => void;
  addControl: (control: object) => void;
};

type BaiduMapNamespace = {
  Map: new (container: HTMLElement) => BaiduMapInstance;
  Point: new (longitude: number, latitude: number) => object;
  Size: new (width: number, height: number) => object;
  Label: new (content: string, options: { position: object; offset: object }) => {
    setStyle: (styles: Record<string, string>) => void;
  };
  NavigationControl: new () => object;
  ScaleControl: new () => object;
  Convertor: new () => {
    translate: (
      points: object[],
      from: number,
      to: number,
      callback: (result: { status: number; points?: object[] }) => void,
    ) => void;
  };
};

export type AlarmLevel = 'normal' | 'low' | 'medium' | 'critical';

const ALARM_APPEARANCE: Record<AlarmLevel, { color: string; glow: string; label: string }> = {
  normal: { color: '#1677ff', glow: 'rgba(22, 119, 255, .48)', label: '状态正常' },
  low: { color: '#f5c842', glow: 'rgba(245, 200, 66, .52)', label: '低级报警' },
  medium: { color: '#8b5cf6', glow: 'rgba(139, 92, 246, .52)', label: '中级报警' },
  critical: { color: '#ef3340', glow: 'rgba(239, 51, 64, .58)', label: '紧急报警' },
};

declare global {
  interface Window {
    BMapGL?: BaiduMapNamespace;
    __smartManholeBaiduMapReady?: () => void;
  }
}

const BAIDU_SCRIPT_ID = 'baidu-map-gl-script';

function loadBaiduMap(ak: string) {
  if (window.BMapGL) return Promise.resolve(window.BMapGL);

  return new Promise<BaiduMapNamespace>((resolve, reject) => {
    let settled = false;
    let serviceErrorDetected = false;
    const originalAlert = window.alert;
    const onScriptError = (event: ErrorEvent) => {
      if (!serviceErrorDetected || event.message !== 'Script error.') return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const restoreBrowserHooks = () => {
      window.alert = originalAlert;
      window.setTimeout(() => window.removeEventListener('error', onScriptError, true), 1500);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      restoreBrowserHooks();
      reject(new Error(message));
    };

    window.addEventListener('error', onScriptError, true);
    window.alert = (message?: unknown) => {
      const text = String(message ?? '');
      if (text.includes('APP服务被禁用') || text.includes('APP 服务被禁用')) {
        serviceErrorDetected = true;
        fail('百度地图应用服务尚未启用');
        return;
      }
      originalAlert(message);
    };

    const existing = document.getElementById(BAIDU_SCRIPT_ID);
    existing?.remove();
    window.__smartManholeBaiduMapReady = () => {
      if (settled) return;
      if (window.BMapGL) {
        settled = true;
        restoreBrowserHooks();
        resolve(window.BMapGL);
      } else fail('百度地图组件加载失败');
    };

    const script = document.createElement('script');
    script.id = BAIDU_SCRIPT_ID;
    script.async = true;
    script.src = `https://api.map.baidu.com/api?v=1.0&type=webgl&ak=${encodeURIComponent(ak)}&callback=__smartManholeBaiduMapReady`;
    script.onerror = () => fail('百度地图网络请求失败');
    document.head.appendChild(script);
  });
}

type LocationMode = 'GPS' | 'LBS' | 'UNKNOWN';

function translateGpsToBaidu(BMapGL: BaiduMapNamespace, longitude: number, latitude: number) {
  return new Promise<object>((resolve, reject) => {
    const gpsPoint = new BMapGL.Point(longitude, latitude);
    const convertor = new BMapGL.Convertor();
    // 百度坐标转换编号：1 = WGS-84（GPS），5 = BD-09。
    convertor.translate([gpsPoint], 1, 5, (result) => {
      const convertedPoint = result.points?.[0];
      if (result.status === 0 && convertedPoint) resolve(convertedPoint);
      else reject(new Error(`GPS坐标转换失败（状态码 ${result.status}）`));
    });
  });
}

export default function BaiduMap({
  longitude,
  latitude,
  locationMode = 'UNKNOWN',
  alarmLevel = 'normal',
}: {
  longitude: number;
  latitude: number;
  locationMode?: LocationMode;
  alarmLevel?: AlarmLevel;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ak = process.env.NEXT_PUBLIC_BAIDU_MAP_AK;
  const alarm = ALARM_APPEARANCE[alarmLevel];
  const [error, setError] = useState(() => ak ? '' : '尚未配置百度地图浏览器端 AK');

  useEffect(() => {
    if (!ak) return;

    let active = true;
    loadBaiduMap(ak).then(async (BMapGL) => {
      if (!active || !containerRef.current) return;
      const map = new BMapGL.Map(containerRef.current);
      const point = locationMode === 'GPS'
        ? await translateGpsToBaidu(BMapGL, longitude, latitude)
        : new BMapGL.Point(longitude, latitude);
      if (!active) return;
      map.centerAndZoom(point, 17);
      map.enableDragging();
      map.enableScrollWheelZoom(true);
      const marker = new BMapGL.Label(' ', {
        position: point,
        offset: new BMapGL.Size(-14, -14),
      });
      marker.setStyle({
        width: '28px',
        height: '28px',
        padding: '0',
        border: '6px solid rgba(255,255,255,.94)',
        borderRadius: '50%',
        backgroundColor: alarm.color,
        boxShadow: `0 0 0 7px ${alarm.glow}, 0 8px 24px rgba(4,26,59,.28)`,
      });
      map.addOverlay(marker);
      map.addControl(new BMapGL.NavigationControl());
      map.addControl(new BMapGL.ScaleControl());
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '百度地图初始化失败');
    });

    return () => { active = false; };
  }, [ak, alarm.color, alarm.glow, latitude, locationMode, longitude]);

  return (
    <div className="baidu-map-shell">
      <div ref={containerRef} className="baidu-map-canvas" aria-label="MH001 百度地图位置" />
      <div className={`baidu-map-device alarm-${alarmLevel}`}><i /><strong>MH001 · {alarm.label}</strong><span>{longitude.toFixed(6)}, {latitude.toFixed(6)}</span></div>
      {locationMode === 'GPS' && <div className="baidu-map-coordinate-note">GPS原始坐标已转换为百度地图坐标</div>}
      <div className="alarm-map-legend" aria-label="定位报警颜色说明">
        <span className="normal"><i />正常</span><span className="low"><i />低级</span><span className="medium"><i />中级</span><span className="critical"><i />紧急</span>
      </div>
      {error && <div className="baidu-map-error"><strong>地图暂时无法加载</strong><span>{error}</span><small>请检查 AK 类型和 Referer 白名单</small></div>}
    </div>
  );
}
