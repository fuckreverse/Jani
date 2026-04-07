<template>
  <div class="app">
    <!-- 顶部导航栏 -->
    <header class="navbar">
      <div class="navbar-brand">
        <span class="logo">🔬</span>
        <span class="brand-name">Jani Trace Analyzer</span>
      </div>
      <nav class="navbar-nav">
        <router-link to="/" class="nav-link">会话列表</router-link>
        <router-link to="/instrument" class="nav-link">插桩工作台</router-link>
        <router-link to="/trace" class="nav-link">Trace 监控</router-link>
      </nav>
    </header>

    <!-- 页面内容 -->
    <main class="main-content">
      <router-view />
    </main>
  </div>
</template>

<script setup>
// App.vue — 路由入口，包含顶部导航栏
</script>

<style>
/* ── 全局样式 ──────────────────────────────────────────────────── */

:root {
  --bg-primary:   #0f1117;
  --bg-secondary: #1a1d27;
  --bg-tertiary:  #242736;
  --border-color: #2d3148;
  --text-primary: #e2e8f0;
  --text-muted:   #8892a4;
  --accent:       #6366f1;
  --accent-hover: #4f46e5;
  --success:      #22c55e;
  --warning:      #f59e0b;
  --danger:       #ef4444;
  --info:         #3b82f6;
}

body {
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
}

a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); }

button {
  cursor: pointer;
  border: none;
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 500;
  transition: background 0.15s;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
}
.btn-primary:hover { background: var(--accent-hover); }

.btn-secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}
.btn-secondary:hover { background: var(--border-color); }

.btn-danger {
  background: var(--danger);
  color: #fff;
}
.btn-danger:hover { opacity: 0.85; }

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
}
.badge-pending   { background: rgba(148,163,184,0.15); color: #94a3b8; }
.badge-processing{ background: rgba(59,130,246,0.15);  color: #60a5fa; }
.badge-ready     { background: rgba(34,197,94,0.15);   color: #4ade80; }
.badge-failed    { background: rgba(239,68,68,0.15);   color: #f87171; }

/* ── 导航栏 ───────────────────────────────────────────────────── */

.navbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 24px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  position: sticky;
  top: 0;
  z-index: 100;
}

.navbar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
}

.logo { font-size: 20px; }

.brand-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.3px;
}

.navbar-nav {
  display: flex;
  gap: 4px;
}

.nav-link {
  padding: 6px 14px;
  border-radius: 6px;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 500;
  transition: all 0.15s;
}

.nav-link:hover,
.nav-link.router-link-active {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

/* ── 主内容区 ────────────────────────────────────────────────────── */

.main-content {
  padding: 24px;
  max-width: 1440px;
  margin: 0 auto;
}

/* ── 通用组件 ──────────────────────────────────────────────────── */

.card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 20px;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
}

.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-muted);
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-muted);
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

pre, code {
  font-family: 'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace;
  font-size: 13px;
}

input, textarea, select {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 8px 12px;
  font-size: 13px;
  outline: none;
  width: 100%;
}

input:focus, textarea:focus, select:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(99,102,241,0.2);
}

select option {
  background: var(--bg-secondary);
}

label {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 500;
  display: block;
  margin-bottom: 4px;
}
</style>
