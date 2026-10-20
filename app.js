/**
 * IronLog — iOS PWA Workout & Set Logger
 * Pure ES6+ Module-Free Architecture with LocalStorage & Web Audio API
 */

const STORAGE_KEYS = {
  LOGS: 'ironlog_workout_sets_v1',
  EXERCISES: 'ironlog_exercises_v1',
  AUTO_REST: 'ironlog_auto_rest_sec_v1',
  LAST_BACKUP: 'ironlog_last_backup_meta_v1'
};

const DEFAULT_EXERCISES = [
  '槓鈴臥推 (Barbell Bench Press)',
  '啞鈴上斜臥推 (Incline Dumbbell Press)',
  '槓鈴深蹲 (Barbell Squat)',
  '傳統硬舉 (Conventional Deadlift)',
  '滑輪下拉 (Lat Pulldown)',
  '坐姿划船 (Seated Cable Row)',
  '槓鈴肩推 (Overhead Press)',
  '啞鈴側平舉 (Lateral Raise)'
];

const state = {
  exercises: [],
  sets: [],
  selectedRpe: null,
  autoRestSeconds: 90,
  importMode: 'merge',
  lastBackupMeta: null,
  timer: {
    intervalId: null,
    totalSeconds: 90,
    remainingSeconds: 90,
    endTimeMs: null,
    isRunning: false
  },
  audioCtx: null
};

// ==========================================
// Helpers: Date & Formatting
// ==========================================
function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTimeFromSeconds(sec) {
  const safeSec = Math.max(0, Math.ceil(sec));
  const mins = String(Math.floor(safeSec / 60)).padStart(2, '0');
  const secs = String(safeSec % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function formatNumber(num) {
  return Number(num).toLocaleString('zh-TW', { maximumFractionDigits: 1 });
}

function showToast(message) {
  const toastEl = document.getElementById('toast');
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toastEl.classList.remove('visible');
  }, 2400);
}

// ==========================================
// Web Audio API Synthesizer (iOS Compatible)
// ==========================================
function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!state.audioCtx) {
    state.audioCtx = new AudioContextClass();
  }
  if (state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }
  return state.audioCtx;
}

function playBeepSequence() {
  try {
    const ctx = ensureAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const notes = [880, 1174.66, 1318.51, 1760]; // A5 - D6 - E6 - A6 chime

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.14);

      gain.gain.setValueAtTime(0.001, now + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.28, now + idx * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.14 + 0.13);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.14);
      osc.stop(now + idx * 0.14 + 0.14);
    });
  } catch (err) {
    console.warn('Web Audio API 無法播放提示音:', err);
  }
}

// ==========================================
// Storage Management
// ==========================================
function loadStateFromStorage() {
  try {
    const rawExercises = localStorage.getItem(STORAGE_KEYS.EXERCISES);
    state.exercises = rawExercises ? JSON.parse(rawExercises) : [...DEFAULT_EXERCISES];
    if (!Array.isArray(state.exercises) || state.exercises.length === 0) {
      state.exercises = [...DEFAULT_EXERCISES];
    }
  } catch {
    state.exercises = [...DEFAULT_EXERCISES];
  }

  try {
    const rawSets = localStorage.getItem(STORAGE_KEYS.LOGS);
    state.sets = rawSets ? JSON.parse(rawSets) : [];
    if (!Array.isArray(state.sets)) state.sets = [];
  } catch {
    state.sets = [];
  }

  const savedAutoRest = localStorage.getItem(STORAGE_KEYS.AUTO_REST);
  if (savedAutoRest !== null) {
    state.autoRestSeconds = Number(savedAutoRest);
  }

  try {
    const rawBackupMeta = localStorage.getItem(STORAGE_KEYS.LAST_BACKUP);
    state.lastBackupMeta = rawBackupMeta ? JSON.parse(rawBackupMeta) : null;
  } catch {
    state.lastBackupMeta = null;
  }
}

function saveExercisesToStorage() {
  localStorage.setItem(STORAGE_KEYS.EXERCISES, JSON.stringify(state.exercises));
}

function saveSetsToStorage() {
  localStorage.setItem(STORAGE_KEYS.LOGS, JSON.stringify(state.sets));
}

// ==========================================
// Rest Countdown Timer
// ==========================================
function startRestTimer(seconds) {
  ensureAudioContext();
  clearInterval(state.timer.intervalId);

  const banner = document.getElementById('timer-banner');
  const display = document.getElementById('timer-display');
  const progressBar = document.getElementById('timer-progress-bar');

  state.timer.totalSeconds = seconds;
  state.timer.remainingSeconds = seconds;
  state.timer.endTimeMs = Date.now() + seconds * 1000;
  state.timer.isRunning = true;

  banner.classList.remove('timer-finished');
  banner.classList.add('timer-running');
  display.textContent = formatTimeFromSeconds(seconds);
  progressBar.style.width = '100%';

  state.timer.intervalId = setInterval(() => {
    const msLeft = state.timer.endTimeMs - Date.now();
    const secLeft = Math.max(0, msLeft / 1000);
    state.timer.remainingSeconds = secLeft;

    display.textContent = formatTimeFromSeconds(secLeft);
    const pct = state.timer.totalSeconds > 0
      ? Math.max(0, Math.min(100, (secLeft / state.timer.totalSeconds) * 100))
      : 0;
    progressBar.style.width = `${pct}%`;

    if (secLeft <= 0) {
      clearInterval(state.timer.intervalId);
      state.timer.isRunning = false;
      banner.classList.remove('timer-running');
      banner.classList.add('timer-finished');
      display.textContent = '00:00';
      progressBar.style.width = '0%';
      playBeepSequence();
      showToast('🔔 休息結束！準備下一組訓練');
    }
  }, 200);
}

function stopRestTimer() {
  clearInterval(state.timer.intervalId);
  state.timer.isRunning = false;
  const banner = document.getElementById('timer-banner');
  const display = document.getElementById('timer-display');
  const progressBar = document.getElementById('timer-progress-bar');

  banner.classList.remove('timer-running', 'timer-finished');
  display.textContent = formatTimeFromSeconds(state.autoRestSeconds || 90);
  progressBar.style.width = '0%';
}

function addSecondsToTimer(extraSeconds) {
  ensureAudioContext();
  if (!state.timer.isRunning) {
    startRestTimer(extraSeconds);
    return;
  }
  state.timer.endTimeMs += extraSeconds * 1000;
  state.timer.totalSeconds += extraSeconds;
}

// ==========================================
// UI Rendering
// ==========================================
function renderExerciseSelect(selectedExerciseName) {
  const selectEl = document.getElementById('exercise-select');
  const currentVal = selectedExerciseName || selectEl.value || state.exercises[0];
  selectEl.innerHTML = '';

  state.exercises.forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    if (name === currentVal) option.selected = true;
    selectEl.appendChild(option);
  });

  updatePrBannerForExercise(selectEl.value);
}

function updatePrBannerForExercise(exerciseName) {
  const prWeightEl = document.getElementById('pr-weight-value');
  const prVolumeEl = document.getElementById('pr-volume-value');

  const matchingSets = state.sets.filter((s) => s.exercise === exerciseName);
  if (matchingSets.length === 0) {
    prWeightEl.textContent = '尚無紀錄';
    prVolumeEl.textContent = '--';
    return;
  }

  let maxWeight = 0;
  let maxWeightReps = 0;
  let maxSingleSetVolume = 0;

  matchingSets.forEach((s) => {
    const w = Number(s.weight) || 0;
    const r = Number(s.reps) || 0;
    const vol = w * r;
    if (w > maxWeight || (w === maxWeight && r > maxWeightReps)) {
      maxWeight = w;
      maxWeightReps = r;
    }
    if (vol > maxSingleSetVolume) {
      maxSingleSetVolume = vol;
    }
  });

  prWeightEl.textContent = `${maxWeight} kg × ${maxWeightReps}`;
  prVolumeEl.textContent = `${formatNumber(maxSingleSetVolume)} kg`;
}

function renderTodaySets() {
  const todayKey = getLocalDateKey();
  document.getElementById('today-date-label').textContent = todayKey;

  const todaySets = state.sets.filter((s) => s.date === todayKey);
  const todayVolume = todaySets.reduce((sum, s) => sum + Number(s.weight) * Number(s.reps), 0);

  document.getElementById('header-today-sets').textContent = `${todaySets.length} 組`;
  document.getElementById('header-today-volume').textContent = `${formatNumber(todayVolume)} kg`;

  const listEl = document.getElementById('today-sets-list');
  if (todaySets.length === 0) {
    listEl.innerHTML = `<div class="empty-state">今日尚無訓練組數，調整上方重量後點擊「完成並紀錄此組」開始！</div>`;
    return;
  }

  listEl.innerHTML = todaySets
    .map((item, idx) => {
      const rpeHtml = item.rpe ? `<span class="rpe-tag">RPE ${item.rpe}</span>` : '';
      const volume = formatNumber(Number(item.weight) * Number(item.reps));
      return `
        <div class="set-row">
          <div class="set-left">
            <span class="set-index">#${idx + 1}</span>
            <div class="set-title-group">
              <span class="set-exercise-name">${escapeHtml(item.exercise)}</span>
              <span class="set-meta">${item.time || ''} · 容量 ${volume} kg</span>
            </div>
          </div>
          <div class="set-right">
            <div class="set-metrics">
              <span class="set-weight-reps">${item.weight} kg × ${item.reps}</span>
              ${rpeHtml}
            </div>
            <button type="button" class="delete-set-btn" data-delete-id="${item.id}" aria-label="刪除此組">✕</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderHistoryAndStats() {
  const totalSets = state.sets.length;
  const totalVolume = state.sets.reduce((acc, s) => acc + Number(s.weight) * Number(s.reps), 0);
  const totalTonnage = (totalVolume / 1000).toFixed(2);

  // Group sets by date descending
  const grouped = {};
  state.sets.forEach((s) => {
    if (!grouped[s.date]) grouped[s.date] = [];
    grouped[s.date].push(s);
  });

  const sortedDates = Object.keys(grouped).sort((a, b) => (a < b ? 1 : -1));

  document.getElementById('stat-total-volume').innerHTML = `${formatNumber(totalVolume)} <small>kg</small>`;
  document.getElementById('stat-total-tonnage').textContent = `${totalTonnage} 噸 (Tons)`;
  document.getElementById('stat-total-sets').innerHTML = `${totalSets} <small>組</small>`;
  document.getElementById('stat-total-days').textContent = `共 ${sortedDates.length} 個訓練日`;

  const container = document.getElementById('history-days-container');
  if (sortedDates.length === 0) {
    container.innerHTML = `<div class="card"><div class="empty-state">目前還沒有任何歷史訓練紀錄</div></div>`;
    return;
  }

  container.innerHTML = sortedDates
    .map((dateKey) => {
      const daySets = grouped[dateKey];
      const dayVol = daySets.reduce((acc, s) => acc + Number(s.weight) * Number(s.reps), 0);
      const rowsHtml = daySets
        .map((item, idx) => {
          const rpeHtml = item.rpe ? `<span class="rpe-tag">RPE ${item.rpe}</span>` : '';
          return `
            <div class="set-row">
              <div class="set-left">
                <span class="set-index">#${idx + 1}</span>
                <div class="set-title-group">
                  <span class="set-exercise-name">${escapeHtml(item.exercise)}</span>
                  <span class="set-meta">${item.time || ''}</span>
                </div>
              </div>
              <div class="set-right">
                <div class="set-metrics">
                  <span class="set-weight-reps">${item.weight} kg × ${item.reps}</span>
                  ${rpeHtml}
                </div>
                <button type="button" class="delete-set-btn" data-delete-id="${item.id}" aria-label="刪除此組">✕</button>
              </div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="card">
          <div class="day-card-header">
            <span class="day-date-title">${dateKey}</span>
            <span class="day-summary-badges">${daySets.length} 組 · ${formatNumber(dayVol)} kg</span>
          </div>
          <div class="sets-list">${rowsHtml}</div>
        </div>
      `;
    })
    .join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==========================================
// Backup: Cloud Share (Web Share API / File System Access API) & JSON Export/Import
// ==========================================
function buildBackupPayload() {
  return {
    app: 'IronLog',
    version: 1,
    exportedAt: new Date().toISOString(),
    exercises: state.exercises,
    sets: state.sets
  };
}

function recordBackupSuccess() {
  const nowIso = new Date().toISOString();
  state.lastBackupMeta = {
    timestamp: nowIso,
    setCount: state.sets.length
  };
  localStorage.setItem(STORAGE_KEYS.LAST_BACKUP, JSON.stringify(state.lastBackupMeta));
  renderCloudBackupStatus();
}

function renderCloudBackupStatus() {
  const lastBackupEl = document.getElementById('last-backup-time');
  const summaryEl = document.getElementById('local-data-summary');
  const badgeEl = document.getElementById('backup-status-badge');
  if (!lastBackupEl || !summaryEl || !badgeEl) return;

  summaryEl.textContent = `${state.sets.length} 組紀錄 · ${state.exercises.length} 個動作`;

  if (!state.lastBackupMeta || !state.lastBackupMeta.timestamp) {
    lastBackupEl.textContent = '尚無備份紀錄';
    badgeEl.textContent = state.sets.length > 0 ? `${state.sets.length} 組待備份` : '尚未備份';
    badgeEl.classList.remove('ok');
    return;
  }

  const dt = new Date(state.lastBackupMeta.timestamp);
  const formattedTime = `${dt.getFullYear()}/${String(dt.getMonth() + 1).padStart(2, '0')}/${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  lastBackupEl.textContent = formattedTime;

  const unsavedDiff = Math.max(0, state.sets.length - (state.lastBackupMeta.setCount || 0));
  if (unsavedDiff === 0) {
    badgeEl.textContent = '已同步最新';
    badgeEl.classList.add('ok');
  } else {
    badgeEl.textContent = `新增 ${unsavedDiff} 組待備份`;
    badgeEl.classList.remove('ok');
  }
}

async function saveToCloudDrive() {
  const payload = buildBackupPayload();
  const jsonString = JSON.stringify(payload, null, 2);
  const dateStr = getLocalDateKey();
  const fileName = `IronLog_Backup_${dateStr}.json`;

  // 1. Prioritize iOS / Mobile Web Share API with Files (Save to iCloud Drive / Google Drive / OneDrive)
  try {
    const file = new File([jsonString], fileName, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        title: `IronLog 健身紀錄備份 (${dateStr})`,
        text: `IronLog 訓練資料備份（共 ${state.sets.length} 組紀錄）`,
        files: [file]
      });
      recordBackupSuccess();
      showToast('☁️ 已開啟系統雲端選單並完成備份！');
      return;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      showToast('已取消雲端分享');
      return;
    }
  }

  // 2. Desktop File System Access API (Directly pick iCloud Drive / OneDrive / Google Drive folder)
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: 'IronLog JSON 雲端備份檔',
            accept: { 'application/json': ['.json'] }
          }
        ]
      });
      const writable = await handle.createWritable();
      await writable.write(jsonString);
      await writable.close();
      recordBackupSuccess();
      showToast('☁️ 已成功儲存至您選擇的雲端資料夾！');
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') {
        showToast('已取消存檔');
        return;
      }
    }
  }

  // 3. Fallback to standard download
  exportBackupJson();
}

function exportBackupJson() {
  const payload = buildBackupPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const dateStr = getLocalDateKey();
  link.href = url;
  link.download = `IronLog_Backup_${dateStr}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  recordBackupSuccess();
  showToast('✅ 已匯出 JSON 備份檔');
}

function importBackupJson(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const parsed = JSON.parse(e.target.result);
      if (!parsed || !Array.isArray(parsed.sets)) {
        showToast('⚠️ 備份檔案格式不正確');
        return;
      }

      if (Array.isArray(parsed.exercises) && parsed.exercises.length > 0) {
        const mergedExercises = Array.from(new Set([...state.exercises, ...parsed.exercises]));
        state.exercises = mergedExercises;
        saveExercisesToStorage();
      }

      if (state.importMode === 'merge') {
        const existingMap = new Map();
        state.sets.forEach((s) => existingMap.set(s.id, s));
        parsed.sets.forEach((s) => {
          const id = s.id || `${s.date}_${s.time}_${s.exercise}_${s.weight}_${s.reps}`;
          existingMap.set(id, { ...s, id });
        });
        state.sets = Array.from(existingMap.values());
      } else {
        state.sets = parsed.sets;
      }

      saveSetsToStorage();
      recordBackupSuccess();
      renderExerciseSelect();
      renderTodaySets();
      renderHistoryAndStats();
      showToast(
        state.importMode === 'merge'
          ? `✅ 智慧合併完成！目前共 ${state.sets.length} 筆組數紀錄`
          : `✅ 完整覆蓋還原 ${state.sets.length} 筆組數紀錄！`
      );
    } catch {
      showToast('⚠️ JSON 解析失敗，請確認檔案有效');
    }
  };
  reader.readAsText(file);
}

// ==========================================
// Event Listeners & Initialization
// ==========================================
function bindEvents() {
  // Bottom Tab Navigation
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;
      const title = btn.dataset.title;

      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.id === targetTab);
      });

      document.getElementById('page-title').textContent = title;
      if (targetTab === 'tab-history') {
        renderHistoryAndStats();
      }
    });
  });

  // Exercise Change -> Update PR
  const exerciseSelect = document.getElementById('exercise-select');
  exerciseSelect.addEventListener('change', () => {
    updatePrBannerForExercise(exerciseSelect.value);
  });

  // Toggle Custom Exercise Drawer
  const drawer = document.getElementById('custom-exercise-drawer');
  const customInput = document.getElementById('custom-exercise-input');
  document.getElementById('toggle-add-exercise-btn').addEventListener('click', () => {
    drawer.classList.toggle('hidden');
    if (!drawer.classList.contains('hidden')) {
      customInput.focus();
    }
  });

  document.getElementById('save-custom-exercise-btn').addEventListener('click', () => {
    const newName = customInput.value.trim();
    if (!newName) {
      showToast('請輸入動作名稱');
      return;
    }
    if (!state.exercises.includes(newName)) {
      state.exercises.unshift(newName);
      saveExercisesToStorage();
    }
    renderExerciseSelect(newName);
    customInput.value = '';
    drawer.classList.add('hidden');
    showToast(`已新增動作：${newName}`);
  });

  // Stepper Buttons (±2.5kg / ±1 rep)
  document.querySelectorAll('.stepper-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.stepTarget;
      const stepDelta = parseFloat(btn.dataset.step);
      const inputEl = document.getElementById(targetId);
      const currentVal = parseFloat(inputEl.value) || 0;
      const minVal = parseFloat(inputEl.min) || 0;
      const nextVal = Math.max(minVal, Math.round((currentVal + stepDelta) * 100) / 100);
      inputEl.value = nextVal;
    });
  });

  // RPE Pills
  document.querySelectorAll('.rpe-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      const rpeVal = pill.dataset.rpe;
      if (state.selectedRpe === rpeVal) {
        state.selectedRpe = null;
        pill.classList.remove('active');
      } else {
        state.selectedRpe = rpeVal;
        document.querySelectorAll('.rpe-pill').forEach((p) => p.classList.remove('active'));
        pill.classList.add('active');
      }
    });
  });

  document.getElementById('clear-rpe-btn').addEventListener('click', () => {
    state.selectedRpe = null;
    document.querySelectorAll('.rpe-pill').forEach((p) => p.classList.remove('active'));
  });

  // Auto Rest Selector Pills
  document.querySelectorAll('#auto-rest-selector .preset-pill').forEach((pill) => {
    if (Number(pill.dataset.rest) === state.autoRestSeconds) {
      document.querySelectorAll('#auto-rest-selector .preset-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
    }
    pill.addEventListener('click', () => {
      state.autoRestSeconds = Number(pill.dataset.rest);
      localStorage.setItem(STORAGE_KEYS.AUTO_REST, String(state.autoRestSeconds));
      document.querySelectorAll('#auto-rest-selector .preset-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
    });
  });

  // Add Set Button
  document.getElementById('add-set-btn').addEventListener('click', () => {
    ensureAudioContext();
    const exercise = exerciseSelect.value;
    const weight = parseFloat(document.getElementById('weight-input').value);
    const reps = parseInt(document.getElementById('reps-input').value, 10);

    if (isNaN(weight) || weight < 0) {
      showToast('請輸入有效的重量 (kg)');
      return;
    }
    if (isNaN(reps) || reps < 1) {
      showToast('請輸入有效的次數 (至少 1 次)');
      return;
    }

    const now = new Date();
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const newSet = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      date: getLocalDateKey(now),
      time: timeStr,
      exercise,
      weight,
      reps,
      rpe: state.selectedRpe
    };

    state.sets.push(newSet);
    saveSetsToStorage();

    updatePrBannerForExercise(exercise);
    renderTodaySets();
    renderHistoryAndStats();
    renderCloudBackupStatus();

    if (state.autoRestSeconds > 0) {
      startRestTimer(state.autoRestSeconds);
      showToast(`💪 已紀錄！啟動 ${state.autoRestSeconds} 秒休息倒數`);
    } else {
      showToast('💪 已紀錄組數！');
    }
  });

  // Delete Set Delegation (Works in both Today & History tabs)
  document.querySelector('.app-content').addEventListener('click', (e) => {
    const deleteBtn = e.target.closest('.delete-set-btn');
    if (!deleteBtn) return;
    const setId = deleteBtn.dataset.deleteId;
    state.sets = state.sets.filter((s) => s.id !== setId);
    saveSetsToStorage();
    updatePrBannerForExercise(exerciseSelect.value);
    renderTodaySets();
    renderHistoryAndStats();
    renderCloudBackupStatus();
    showToast('已刪除該組紀錄');
  });

  // Timer Banner Controls
  document.querySelectorAll('[data-timer-set]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sec = Number(btn.dataset.timerSet);
      startRestTimer(sec);
    });
  });

  document.getElementById('timer-add-15').addEventListener('click', () => {
    addSecondsToTimer(15);
  });

  document.getElementById('timer-stop-btn').addEventListener('click', () => {
    stopRestTimer();
  });

  // Backup & Settings
  document.getElementById('cloud-share-btn').addEventListener('click', saveToCloudDrive);
  document.getElementById('export-json-btn').addEventListener('click', exportBackupJson);

  document.querySelectorAll('#import-mode-selector .preset-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      state.importMode = pill.dataset.importMode;
      document.querySelectorAll('#import-mode-selector .preset-pill').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
    });
  });

  const importInput = document.getElementById('import-json-input');
  importInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      importBackupJson(e.target.files[0]);
      importInput.value = '';
    }
  });

  document.getElementById('test-sound-btn').addEventListener('click', () => {
    playBeepSequence();
    showToast('🔊 已播放計時完成提示音');
  });

  document.getElementById('clear-all-data-btn').addEventListener('click', () => {
    const confirmed = window.confirm('確定要清空所有歷史訓練組數嗎？此操作無法復原。');
    if (!confirmed) return;
    state.sets = [];
    saveSetsToStorage();
    updatePrBannerForExercise(exerciseSelect.value);
    renderTodaySets();
    renderHistoryAndStats();
    renderCloudBackupStatus();
    showToast('已清空所有訓練紀錄');
  });
}

function checkPwaAndServiceWorkerStatus() {
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  const pwaBadge = document.getElementById('pwa-status-badge');
  if (isStandalone) {
    pwaBadge.textContent = '已啟用 (Standalone)';
    pwaBadge.classList.add('ok');
  } else {
    pwaBadge.textContent = '瀏覽器模式 (可加入主畫面)';
  }

  const swBadge = document.getElementById('sw-status-badge');
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('./service-worker.js')
      .then(() => {
        swBadge.textContent = '已就緒 (離線可用)';
        swBadge.classList.add('ok');
      })
      .catch(() => {
        swBadge.textContent = '需透過 HTTP/HTTPS 啟動';
      });
  } else {
    swBadge.textContent = '不支援';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadStateFromStorage();
  renderExerciseSelect();
  renderTodaySets();
  renderHistoryAndStats();
  renderCloudBackupStatus();
  bindEvents();
  checkPwaAndServiceWorkerStatus();
});
