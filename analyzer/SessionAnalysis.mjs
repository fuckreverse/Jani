import { isMainThread } from 'worker_threads';
import { enqueueAnalysis } from './AnalysisQueue.mjs';
import * as db from './db/Database.mjs';
import { autoDiscover, schedule } from './PluginEngine.mjs';

export const PHASE1_PLUGINS = Object.freeze(['F1-EventIndex']);
export const PHASE2_PLUGINS = Object.freeze(['F3-CallGraphBuilder', 'F4-VariableLifetime', 'A3-HotPathAnalyzer']);
export const PHASE3_PLUGINS = Object.freeze(['A5-LoopDetector', 'A8-ValuePatternDetector', 'I1-CryptoDetector', 'I2-SignatureAnalyzer']);
export const PHASE4_PLUGINS = Object.freeze(['A2-DataFlowGraph', 'A7-ObjectMutationTracker', 'I3-ObfuscationDetector', 'I4-AlgorithmSummarizer', 'I5-WebApiDetector']);

// Progress is observational. Only the settled job promise advances the workflow.
export async function analyzeSession(sessionId, { dataDir, hasSmap = false, selectedPlugins = null, onProgress, signal, worker, settleSession = true } = {}) {
    if (isMainThread && worker !== false) return enqueueAnalysis('workflow', sessionId, { dataDir, hasSmap, selectedPlugins, onProgress, signal });
    await autoDiscover();
    const select = ids => selectedPlugins === null ? [...ids] : ids.filter(id => selectedPlugins.includes(id));
    const phases = [
        ['phase1', [...PHASE1_PLUGINS, ...(hasSmap ? ['F2-SmapLoader'] : [])]],
        ['phase2', select(PHASE2_PLUGINS)],
        ['phase3', select(PHASE3_PLUGINS)],
        ['phase4', select(PHASE4_PLUGINS)],
    ];
    try {
        for (const [phase, plugins] of phases) {
            if (!plugins.length) continue;
            try { onProgress?.({ type: 'phase_start', sessionId, phase, plugins }); } catch { /* observer */ }
            await schedule(sessionId, { plugins, dataDir, phase, skipCompleted: true, onProgress, signal, worker: false, settleSession: false });
        }
        db.run("UPDATE sessions SET status=? WHERE id=?", settleSession ? 'ready' : 'indexing', sessionId);
    } catch (error) {
        db.run("UPDATE sessions SET status='failed' WHERE id=?", sessionId);
        throw error;
    }
}

export function parsePluginSelection(value) {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
    return Array.isArray(value) ? value : null;
}
