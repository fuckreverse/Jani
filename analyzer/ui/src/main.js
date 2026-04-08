import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import SessionList from './views/SessionList.vue';
import SessionDetail from './views/SessionDetail.vue';
import InstrumentStudio from './views/InstrumentStudio.vue';
import TraceMonitor from './views/TraceMonitor.vue';
import WorkspaceList from './views/WorkspaceList.vue';
import WorkspaceDetail from './views/WorkspaceDetail.vue';
import StorageAnalyzer from './views/StorageAnalyzer.vue';

const routes = [
    { path: '/',                  component: SessionList,      name: 'home' },
    { path: '/sessions/:id',      component: SessionDetail,    name: 'session-detail' },
    { path: '/instrument',        component: InstrumentStudio, name: 'instrument' },
    { path: '/trace',             component: TraceMonitor,     name: 'trace-monitor' },
    { path: '/workspaces',        component: WorkspaceList,    name: 'workspaces' },
    { path: '/workspaces/:id',    component: WorkspaceDetail,  name: 'workspace-detail' },
    { path: '/storage',           component: StorageAnalyzer,  name: 'storage-analyzer' },
];

const router = createRouter({
    history: createWebHistory(),
    routes,
});

createApp(App).use(router).mount('#app');
