/** Report what the trace can establish, rather than treating every hint as proof. */
export function analysisQuality(raw, sessionId) {
    const session=raw.prepare('SELECT trace_integrity FROM sessions WHERE id=?').get(sessionId);
    const kinds=Object.fromEntries(raw.prepare('SELECT kind,COUNT(*) n FROM event_analysis WHERE session_id=? GROUP BY kind').all(sessionId).map(r=>[r.kind,r.n]));
    const truncatedPlugins=[];
    for(const row of raw.prepare('SELECT plugin_id,summary_json FROM plugin_checkpoints WHERE session_id=? AND is_stale=0').iterate(sessionId)) {
        const summary=JSON.parse(row.summary_json ?? '{}');
        if(summary?.truncated)truncatedPlugins.push(row.plugin_id);
    }
    return {
        traceIntegrity:session?.trace_integrity ?? 'unknown', precision:'statement-level', dependencyCompleteness:'partial-model',
        unresolvedDependencies:raw.prepare(`SELECT COUNT(*) n FROM event_dependencies d LEFT JOIN events e ON e.session_id=d.session_id AND e.id=d.from_event_id WHERE d.session_id=? AND e.id IS NULL`).get(sessionId).n,
        observedMetadata:Object.values(kinds).some(n=>n>0), eventKinds:kinds, truncatedPlugins,
        semantics:{assign:'binding / legacy static scope',copy:'conservative statement co-occurrence',
            call_arg:kinds.argument ? 'separate evaluated argument sources, expanded positions, rest and default bindings; argument internals remain statement-level' : 'legacy call inputs; recapture for argument isolation',
            call_ret:'observed consumption within the caller expression',field_read:'latest observed property write with matching recorded value; conflicting observations invalidate it',
            control:'lexical approximation, not a complete control-dependence graph',
            await_resume:'observed suspend/resume, rejection, Promise passthrough and recorded return assimilation'},
        limitations:[
            '仅描述本次执行；未执行路径不在结果中。',
            '语句内多个读写之间是保守依赖，不能作为表达式级证明。',
            '旧 trace 缺少调用和异步关系时不会猜测补边；建议重新采集。',
            '未插桩代码、getter/原型链和外部对象变更可能形成依赖缺口；属性删除或观测值冲突会终止旧定义。',
            'Promise.all/race/any/allSettled 的成员及胜出关系尚无精确模型，原生聚合结果采用保守输入依赖。',
            '异步调度覆盖已知原生定时器、微任务和 Promise 回调；自定义调度器、事件监听和跨 realm 原生函数需额外适配。',
            '分支控制依赖为词法区域近似；短路与条件表达式记录选择关系，但不完整覆盖 switch 和异常控制流。',
            '循环次数为重复 IID 的命中估计；热点频率不代表实际耗时。',
            '加密、签名和混淆结果为启发式线索；置信分数不是校准后的概率。',
        ],
    };
}
