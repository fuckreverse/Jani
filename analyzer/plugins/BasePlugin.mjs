/**
 * BasePlugin.mjs — 分析插件基类
 * 所有分析插件均继承此类并实现 run() 方法
 *
 * 插件上下文 ctx 结构：
 *   ctx.sessionId  {string}   当前会话 ID
 *   ctx.db         {object}   Database 模块（get/all/run/transaction/raw）
 *   ctx.emit       {Function} 进度事件回调 (event: object) => void
 *   ctx.onCommit  {Function} 注册提交后的资源释放回调
 *   ctx.onRollback {Function} 注册回滚清理回调
 *   ctx.dataDir    {string}   会话数据目录路径
 */

export default class BasePlugin {
    /**
     * 插件唯一 ID
     * @type {string}
     */
    static id = 'base-plugin';

    /**
     * 依赖的其他插件 ID（执行前必须已完成）
     * @type {string[]}
     */
    static deps = [];

    /** Optional inputs: invalidate on change; rebuild only if previously produced. */
    static observes = [];

    /**
     * 插件描述
     * @type {string}
     */
    static description = 'Base plugin interface';

    /**
     * 插件名称（用于日志展示）
     * @type {string}
     */
    static displayName = 'Base Plugin';

    /**
     * 执行分析
     * @param {object} ctx
     * @param {string}   ctx.sessionId   当前会话 ID
     * @param {object}   ctx.db          Database 模块
     * @param {Function} ctx.emit        进度事件回调
     * @param {string}   ctx.dataDir     会话数据目录
     * @returns {Promise<void>}
     */
    async run(ctx) {
        throw new Error(`Plugin "${this.constructor.id}" must implement run(ctx)`);
    }

    /**
     * 发送进度消息的辅助方法
     * @param {object} ctx
     * @param {string} message
     * @param {number} [progress] 0~100
     */
    emitProgress(ctx, message, progress, extra) {
        if (typeof ctx.emit === 'function') {
            ctx.emit({
                plugin: this.constructor.id,
                status: 'running',
                message,
                progress: progress ?? null,
                ...(extra ?? {}),
            });
        }
    }

    /**
     * 发送完成消息
     * @param {object} ctx
     * @param {object} [summary] 统计信息
     */
    emitDone(ctx, summary) {
        if (typeof ctx.emit === 'function') {
            ctx.emit({
                plugin: this.constructor.id,
                status: 'done',
                summary: summary ?? null,
            });
        }
    }

    /**
     * 发送错误消息
     * @param {object} ctx
     * @param {Error|string} error
     */
    emitError(ctx, error) {
        if (typeof ctx.emit === 'function') {
            ctx.emit({
                plugin: this.constructor.id,
                status: 'failed',
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
}
