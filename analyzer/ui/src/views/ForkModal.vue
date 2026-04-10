<template>
  <Teleport to="body">
    <div v-if="visible" class="modal-overlay" @click.self="onClose">
      <div class="modal-box">
        <div class="modal-header">
          <span class="modal-title">🔁 重新插桩</span>
          <button class="modal-close" @click="onClose">✕</button>
        </div>
        <div class="modal-body">
          <p class="modal-hint">将复用原始源文件，以下方选项进行重新插桩，并创建一个新的工作空间。</p>
          <div class="modal-field">
            <label>新工作空间名称</label>
            <input v-model="localName" placeholder="新工作空间名称" style="width:100%" />
          </div>
          <InstrumentOptions ref="optsRef" :embedded="true" />
        </div>
        <div class="modal-footer">
          <div v-if="error" class="fork-error">❌ {{ error }}</div>
          <div class="modal-btns">
            <button class="btn-secondary btn-sm" @click="onClose" :disabled="loading">取消</button>
            <button class="btn-accent btn-sm" @click="handleSubmit" :disabled="loading">
              <span v-if="loading">⏳ 插桩中...</span>
              <span v-else>开始插桩 →</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';
import InstrumentOptions from './InstrumentOptions.vue';

const props = defineProps({
  /** 是否显示 */
  visible: {
    type: Boolean,
    default: false,
  },
  /** 工作空间 id */
  projectId: {
    type: String,
    required: true,
  },
  /** 初始名称（通常为原工作空间名 + '-fork'） */
  initialName: {
    type: String,
    default: '',
  },
  /** 原工作空间的 instrument_options JSON 字符串，用于回填选项 */
  initialOptions: {
    type: String,
    default: '',
  },
});

const emit = defineEmits([
  'close',
  /** 插桩成功：payload = { projectId: string } */
  'success',
]);

const localName = ref('');
const loading   = ref(false);
const error     = ref('');
const optsRef   = ref(null);

// 每次弹窗打开时，回填名称和选项
watch(() => props.visible, async (val) => {
  if (!val) return;
  localName.value = props.initialName;
  error.value     = '';
  loading.value   = false;
  await nextTick();
  if (optsRef.value && props.initialOptions) {
    try {
      const savedOpts = JSON.parse(props.initialOptions);
      optsRef.value.loadOptions(savedOpts);
    } catch { /* 忽略解析失败 */ }
  }
});

function onClose() {
  if (loading.value) return;
  emit('close');
}

async function handleSubmit() {
  if (loading.value) return;
  loading.value = true;
  error.value   = '';
  try {
    const options = optsRef.value?.buildOptions() ?? {};
    const res = await fetch(`/api/projects/${props.projectId}/fork`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name: localName.value.trim(), options }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    emit('success', { projectId: data.projectId });
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}

.modal-box {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  width: min(720px, 96vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}
.modal-close:hover { background: var(--bg-tertiary); }

.modal-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.modal-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.6;
}

.modal-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.modal-field label {
  font-size: 11px;
  color: var(--text-muted);
}

.modal-footer {
  border-top: 1px solid var(--border-color);
  padding: 14px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modal-btns {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.fork-error {
  padding: 8px 12px;
  background: rgba(239,68,68,0.08);
  border-radius: 6px;
  color: var(--danger);
  font-size: 12px;
}

.btn-sm { padding: 4px 10px; font-size: 12px; }

.btn-secondary {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-secondary:hover { background: var(--bg-tertiary); }
.btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-accent {
  background: rgba(99,102,241,0.18);
  color: #818cf8;
  border: 1px solid rgba(99,102,241,0.35);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-accent:hover { background: rgba(99,102,241,0.28); }
.btn-accent:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
