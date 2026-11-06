import { Film, ImagePlus, Images, Loader2, Plus, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssetInfo, MediaKind } from '../../shared/types';
import { thumbUrl } from '../../shared/media';
import { addAssets, addFiles } from './actions';
import { api } from '../lib/api';
import { Modal } from '../components/Modal';
import { t } from '../i18n';
import { toast, useStore } from '../store';

function Preview({ asset }: { asset: AssetInfo }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <div className="asset-fallback">{asset.kind === 'video' ? <Film /> : <Images />}</div>;
  if (asset.kind === 'video') {
    return <video src={asset.url} poster={thumbUrl(asset.url)} muted playsInline preload="metadata" onError={() => setFailed(true)} />;
  }
  return <img src={thumbUrl(asset.url)} alt={asset.name ?? ''} loading="lazy" onError={() => setFailed(true)} />;
}

function kindLabel(kind: MediaKind) {
  return kind === 'video' ? t('视频') : t('图片');
}

export function AssetsModal() {
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [kind, setKind] = useState<'all' | MediaKind>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      setAssets(await api.assets());
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return assets.filter((asset) => (kind === 'all' || asset.kind === kind) && (!q || (asset.name ?? '').toLowerCase().includes(q)));
  }, [assets, kind, query]);

  const upload = async (files: File[]) => {
    await addFiles(files);
    await load();
  };

  return (
    <Modal wide title={t('资产库')} onClose={() => useStore.setState({ modal: null })}>
      <div className="asset-library">
        <div className="asset-toolbar">
          <div className="asset-tabs">
            {(['all', 'image', 'video'] as const).map((value) => (
              <button key={value} className={kind === value ? 'on' : ''} onClick={() => setKind(value)}>
                {value === 'all' ? t('全部') : kindLabel(value)}
              </button>
            ))}
          </div>
          <label className="asset-search"><Search /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('搜索资产名称')} /></label>
          <button className="icon-btn small" title={t('刷新')} onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} /></button>
          <button className="btn primary asset-upload" onClick={() => input.current?.click()}><ImagePlus /> {t('上传资产')}</button>
          <input ref={input} hidden type="file" accept="image/*,video/*" multiple onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ''; void upload(files); }} />
        </div>
        {loading && !assets.length ? (
          <div className="asset-empty"><Loader2 className="spin" /><span>{t('正在加载资产库…')}</span></div>
        ) : visible.length ? (
          <div className="asset-grid">
            {visible.map((asset) => (
              <button key={asset.id} className="asset-card" onClick={() => { addAssets([asset]); toast(t('已添加到画布'), 'success'); }} title={t('点击添加到画布')}>
                <div className="asset-preview"><Preview asset={asset} /><span className="asset-kind">{kindLabel(asset.kind)}</span><span className="asset-add"><Plus /></span></div>
                <div className="asset-meta"><strong>{asset.name || t('未命名资产')}</strong><small>{asset.width} × {asset.height}</small></div>
              </button>
            ))}
          </div>
        ) : (
          <div className="asset-empty"><Images /><strong>{query ? t('没有匹配的资产') : t('资产库还是空的')}</strong><span>{query ? t('换个名称试试') : t('上传图片或视频后，它们会保存在这里')}</span></div>
        )}
        <div className="asset-foot">{t('{n} 个资产', { n: visible.length })} · {t('点击任意卡片即可放到画布中心')}</div>
      </div>
    </Modal>
  );
}
