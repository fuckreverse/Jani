/**
 * useValueViewer.js — 全局"完整值查看器" modal 状态管理
 *
 * 任意组件调用 openValueViewer(value, label?) 即可弹出 ValueViewer modal 展示完整值。
 * ValueViewer.vue 挂载在 SessionDetail.vue 中，监听 valueViewerState 变化来开/关。
 */

import { reactive } from 'vue';

/** 全局单例状态（reactive object，所有组件共享） */
export const valueViewerState = reactive({
    value:      null,   // 当前要展示的值（任意类型）
    label:      '',     // 可选标签（如变量名）
    openCount:  0,      // 每次打开时自增，ValueViewer watch 此字段来触发打开
    closeCount: 0,      // 每次关闭时自增
});

/**
 * 打开值查看器
 * @param {*} value  要展示的完整值（任意类型）
 * @param {string} [label]  可选标签，如变量名 "foo" 或来源描述
 */
export function openValueViewer(value, label = '') {
    valueViewerState.value  = value;
    valueViewerState.label  = label;
    valueViewerState.openCount++;
}

/**
 * 关闭值查看器
 */
export function closeValueViewer() {
    valueViewerState.closeCount++;
}

/**
 * 判断一个已格式化展示的字符串是否被截断（末尾有 '…' 或 '...'）
 * 用于决定是否渲染"可点击"样式
 * @param {string} displayed  truncate/formatValue 的输出
 * @returns {boolean}
 */
export function isValueTruncated(displayed) {
    if (!displayed) return false;
    return displayed.endsWith('…') || displayed.endsWith('...');
}
