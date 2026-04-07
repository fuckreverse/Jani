import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
    plugins: [vue()],
    server: {
        port: 5173,
        proxy: {
            '/api': {
                target: 'http://localhost:33000',
                changeOrigin: true,
            },
            '/ws': {
                target: 'ws://localhost:33000',
                ws: true,
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
});
