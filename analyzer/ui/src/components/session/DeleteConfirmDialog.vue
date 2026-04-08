<template>
  <div class="dialog-overlay" @click.self="$emit('cancel')">
    <div class="dialog card">
      <h2 class="dialog-title">确认删除</h2>
      <p>确定删除会话 <strong>{{ session.name || session.id.slice(0, 8) }}</strong> 吗？</p>
      <p class="delete-hint">⚠️ 此操作不可撤销。会话的 trace 文件及所有分析数据将被永久删除。</p>
      <div class="dialog-actions">
        <button class="btn-secondary" @click="$emit('cancel')">取消</button>
        <button class="btn-danger" :disabled="deleting" @click="doDelete">
          {{ deleting ? '删除中...' : '确认删除' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';

const props = defineProps({
    session: { type: Object, required: true },
});
const emit = defineEmits(['cancel', 'deleted']);

const deleting = ref(false);

async function doDelete() {
    deleting.value = true;
    try {
        const res = await fetch(`/api/sessions/${props.session.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
        emit('deleted', props.session.id);
    } catch (e) {
        alert(`删除失败：${e.message}`);
    } finally {
        deleting.value = false;
    }
}
</script>

<style scoped>
.dialog-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.dialog { max-width: 420px; }
.dialog-title { font-size: 18px; font-weight: 700; margin-bottom: 12px; }
.delete-hint { font-size: 12px; color: var(--text-muted); margin-top: 8px; line-height: 1.5; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 16px; }
</style>
