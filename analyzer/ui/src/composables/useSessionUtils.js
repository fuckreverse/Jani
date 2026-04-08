// 共享工具函数 —— 供 SessionDetail 及各 Tab 子组件使用

export function formatDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('zh-CN');
}

export function formatBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatValue(v) {
    if (v === undefined || v === null) return String(v);
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 80) + '...' : s;
}

export function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

export function formatArgValue(v) {
    if (v === null || v === undefined) return String(v);
    if (typeof v === 'string') {
        try {
            const parsed = JSON.parse(v);
            if (typeof parsed === 'string') return parsed;
            return JSON.stringify(parsed);
        } catch {
            return v;
        }
    }
    try { return JSON.stringify(v); } catch { return String(v); }
}

export function statusLabel(s) {
    return { pending: '等待中', processing: '分析中', running: '运行中', ready: '就绪', failed: '失败', error: '错误' }[s] ?? s ?? '未知';
}
