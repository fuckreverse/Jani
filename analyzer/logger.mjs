/**
 * logger.mjs — 统一日志模块（基于 pino + pino-pretty）
 *
 * 使用方式：
 *   import { createLogger } from './logger.mjs';
 *   const log = createLogger('MyModule');
 *   log.info('server started');
 *   log.error({ err }, 'something failed');
 *
 * 环境变量：
 *   LOG_LEVEL=debug|info|warn|error   默认 info
 *   LOG_FILE=./analyzer.log           同时写入文件（可选）
 *   LOG_JSON=true                     强制 JSON 输出，关闭 pretty（CI 场景）
 *
 * 日志级别对应颜色：
 *   debug  → 灰色
 *   info   → 绿色
 *   warn   → 黄色
 *   error  → 红色（含完整 stack）
 */

import pino from 'pino';
import { resolve } from 'path';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_FILE  = process.env.LOG_FILE  || null;
const LOG_JSON  = process.env.LOG_JSON  === 'true'; // 强制 JSON（默认 false）

// ── 构建 transport ──────────────────────────────────────────────────────────

function buildTransport() {
    const targets = [];

    if (!LOG_JSON) {
        // 彩色 pretty 输出（强制开启，不依赖 TTY 检测）
        // forceColor: true 确保在 spawn 子进程、管道等非 TTY 场景也有颜色
        targets.push({
            target: 'pino-pretty',
            level: LOG_LEVEL,
            options: {
                colorize: true,
                colorizeObjects: false,      // 对象不染色，保持可读
                forceColor: true,            // 强制颜色，解决 spawn/pipe 下无色问题
                translateTime: 'HH:MM:ss.l', // 只显示时分秒毫秒，更简洁
                ignore: 'pid,hostname,module',
                messageKey: 'msg',
                // module 字段显示在消息前，格式：[模块名]
                messageFormat: '{module} › {msg}',
                // 错误对象展开显示 stack
                errorLikeObjectKeys: ['err', 'error'],
                errorProps: 'stack,message,name,type,code',
                levelFirst: true,            // level 放最前，一眼看出严重程度
            },
        });
    } else {
        // JSON 模式（CI / 机器解析）
        targets.push({
            target: 'pino/file',
            level: LOG_LEVEL,
            options: { destination: 1 }, // fd=1 = stdout
        });
    }

    // 可选：同时写文件（始终 JSON，不带颜色码）
    if (LOG_FILE) {
        targets.push({
            target: 'pino/file',
            level: 'debug',
            options: { destination: resolve(LOG_FILE), mkdir: true },
        });
    }

    return pino.transport({ targets });
}

// ── 根 logger ───────────────────────────────────────────────────────────────

const rootLogger = pino(
    {
        level: LOG_LEVEL,
        serializers: {
            err: pino.stdSerializers.err,
            error: pino.stdSerializers.err,
        },
        base: null, // 去掉默认的 pid/hostname 字段
    },
    buildTransport()
);

// ── 工厂函数：创建子 logger ──────────────────────────────────────────────────

/**
 * 创建带模块名称前缀的子 logger
 * @param {string} name - 模块名，如 'server' / 'PluginEngine' / 'F1-EventIndex'
 * @returns {pino.Logger}
 */
export function createLogger(name) {
    return rootLogger.child({ module: name });
}

/** 直接导出根 logger（server.mjs 顶层用） */
export default rootLogger;
