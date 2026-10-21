/**
 * IronLog — iOS PWA Workout & Set Logger
 * Pure ES6+ Architecture with Supabase Cloud Auth/DB & LocalStorage Offline Fallback
 */

const SUPABASE_URL = 'https://wmrvxsuudoyoveccbcev.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtcnZ4c3V1ZG95b3ZlY2NiY2V2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI1MTEyMzcsImV4cCI6MjEwODA4NzIzN30.c6Kdtsq0qhozud31WJSr8dtCBjXG8OL23o6bIOFisN8';

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
  supabase: null,
  user: null,
  exercises: [],
  sets: [],
  selectedRpe: null,
  autoRestSeconds: 90,
  importMode: 'merge',
  lastBackupMeta: null,
  timer: {
    intervalId: null,
    worker: null,
    totalSeconds: 90,
    remainingSeconds: 90,
    endTimeMs: null,
    isRunning: false,
    notifiedForCurrentRun: false
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

function formatTimeFromIso(isoStr) {
  if (!isoStr) return '';
  const dt = new Date(isoStr);
  if (isNaN(dt.getTime())) return '';
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
}

function normalizeDateKey(rawDate, fallbackCreatedAt) {
  if (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    return rawDate;
  }
  const dt = new Date(rawDate || fallbackCreatedAt || Date.now());
  if (isNaN(dt.getTime())) return getLocalDateKey();
  return getLocalDateKey(dt);
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
  }, 2600);
}

// ==========================================
// Web Audio API Synthesizer (Non-Intrusive Ambient Mode for Music Apps)
// ==========================================
function configureAmbientAudioSession() {
  // iOS 17+ AudioSession API: 'ambient' mixes with Apple Music / Spotify / YouTube Music without pausing them
  if ('audioSession' in navigator) {
    try {
      navigator.audioSession.type = 'ambient';
    } catch {
      // Ignore if browser does not support audioSession assignment
    }
  }
}

function ensureAudioContext() {
  configureAmbientAudioSession();
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
    const notes = [880, 1174.66, 1318.51, 1760]; // A5 - D6 - E6 - A6 short chime

    notes.forEach((freq, idx) => {
      const startOffset = idx * 0.13;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + startOffset);

      gain.gain.setValueAtTime(0.001, now + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.24, now + startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + startOffset + 0.12);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + startOffset);
      osc.stop(now + startOffset + 0.13);
    });

    // Suspend AudioContext immediately after the short chime finishes so it never holds onto the OS audio session
    clearTimeout(playBeepSequence._suspendTimer);
    playBeepSequence._suspendTimer = setTimeout(() => {
      if (state.audioCtx && state.audioCtx.state === 'running') {
        state.audioCtx.suspend().catch(() => {});
      }
    }, 650);
  } catch (err) {
    console.warn('Web Audio API 無法播放提示音:', err);
  }
}

// ==========================================
// Cross-App System Notification (Web Notifications + Service Worker)
// ==========================================
function isNotificationSupported() {
  return 'Notification' in window;
}

function updateNotificationStatusUI() {
  const bannerBtn = document.getElementById('enable-notify-banner-btn');
  const activeTag = document.getElementById('notify-active-tag');
  const settingsBtn = document.getElementById('request-notify-btn');

  if (!isNotificationSupported()) {
    bannerBtn?.classList.remove('hidden');
    if (bannerBtn) bannerBtn.textContent = '🔔 點此了解 iOS 跨應用通知';
    activeTag?.classList.add('hidden');
    if (settingsBtn) {
      settingsBtn.textContent = '需加入主畫面啟用';
      settingsBtn.classList.remove('ok');
    }
    return;
  }

  const perm = Notification.permission;
  if (perm === 'granted') {
    bannerBtn?.classList.add('hidden');
    activeTag?.classList.remove('hidden');
    if (settingsBtn) {
      settingsBtn.textContent = '已開啟 (Granted)';
      settingsBtn.classList.add('ok');
    }
  } else if (perm === 'denied') {
    bannerBtn?.classList.remove('hidden');
    if (bannerBtn) bannerBtn.textContent = '🔕 通知已封鎖 (點此查看)';
    activeTag?.classList.add('hidden');
    if (settingsBtn) {
      settingsBtn.textContent = '已封鎖 (請至系統設定開啟)';
      settingsBtn.classList.remove('ok');
    }
  } else {
    bannerBtn?.classList.remove('hidden');
    if (bannerBtn) bannerBtn.textContent = '🔔 開啟跨應用通知';
    activeTag?.classList.add('hidden');
    if (settingsBtn) {
      settingsBtn.textContent = '點擊開啟通知權限';
      settingsBtn.classList.remove('ok');
    }
  }
}

async function requestNotificationPermission(silentIfAlreadyGranted = false) {
  if (!isNotificationSupported()) {
    showToast('📱 iPhone 請先「加入主畫面」並從主畫面開啟，即可啟用系統橫幅通知！');
    return false;
  }

  if (Notification.permission === 'granted') {
    updateNotificationStatusUI();
    if (!silentIfAlreadyGranted) {
      showToast('🔔 跨應用系統通知已開啟！');
    }
    return true;
  }

  if (Notification.permission === 'denied') {
    showToast('⚠️ 通知權限已被封鎖，請至手機「設定 -> 通知 -> IronLog」或瀏覽器設定中開啟');
    updateNotificationStatusUI();
    return false;
  }

  try {
    const result = await Notification.requestPermission();
    updateNotificationStatusUI();
    if (result === 'granted') {
      showToast('✅ 已成功開啟跨應用通知！切換 App 也能收到倒數結束提醒');
      return true;
    } else {
      showToast('⚠️ 未授予通知權限，切換 App 時將僅透過背景音訊提醒');
      return false;
    }
  } catch (err) {
    console.warn('請求通知權限失敗:', err);
    return false;
  }
}

async function sendSwMessage(payload) {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (reg && reg.active) {
      reg.active.postMessage(payload);
    } else if (navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage(payload);
    }
  } catch (err) {
    console.warn('無法傳送訊息給 Service Worker:', err);
  }
}

async function triggerCrossAppNotification(title, body) {
  if (!isNotificationSupported() || Notification.permission !== 'granted') return;

  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(title, {
          body,
          icon: './icon.svg',
          badge: './icon.svg',
          tag: 'ironlog-rest-timer',
          renotify: true,
          vibrate: [250, 120, 250, 120, 350]
        });
        return;
      }
    }
    new Notification(title, {
      body,
      icon: './icon.svg',
      tag: 'ironlog-rest-timer'
    });
  } catch (err) {
    console.warn('發送系統通知失敗:', err);
  }
}

// ==========================================
// Supabase Client & Dual-Track Storage Logic
// ==========================================
function isSupabaseConfigured() {
  return (
    typeof SUPABASE_URL === 'string' &&
    SUPABASE_URL.startsWith('https://') &&
    SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL' &&
    typeof SUPABASE_ANON_KEY === 'string' &&
    SUPABASE_ANON_KEY.length > 20 &&
    SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY'
  );
}

function isCloudActive() {
  return Boolean(state.supabase && state.user && navigator.onLine);
}

function initSupabaseClient() {
  if (!isSupabaseConfigured()) {
    state.supabase = null;
    updateAccountUI();
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.warn('Supabase CDN SDK 尚未載入，降級為本機模式');
    state.supabase = null;
    updateAccountUI();
    return;
  }

  try {
    state.supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Check active session on startup
    state.supabase.auth.getSession().then(({ data }) => {
      state.user = data?.session?.user || null;
      updateAccountUI();
      syncDataFromActiveTrack();
    });

    // Listen to login / logout state changes
    state.supabase.auth.onAuthStateChange((_event, session) => {
      const prevUserId = state.user?.id || null;
      const nextUser = session?.user || null;
      state.user = nextUser;
      updateAccountUI();

      if ((nextUser?.id || null) !== prevUserId) {
        syncDataFromActiveTrack();
      }
    });
  } catch (err) {
    console.error('Supabase 初始化失敗:', err);
    state.supabase = null;
    updateAccountUI();
  }
}

function loadLocalSetsFromStorage() {
  try {
    const rawSets = localStorage.getItem(STORAGE_KEYS.LOGS);
    const parsed = rawSets ? JSON.parse(rawSets) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

  state.sets = loadLocalSetsFromStorage();

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

function mapSupabaseRowToSet(row) {
  return {
    id: String(row.id),
    date: normalizeDateKey(row.date, row.created_at),
    time: formatTimeFromIso(row.created_at),
    exercise: row.exercise,
    weight: Number(row.weight),
    reps: Number(row.reps),
    rpe: row.rpe !== null && row.rpe !== undefined ? String(row.rpe) : null
  };
}

async function syncDataFromActiveTrack() {
  if (isCloudActive()) {
    try {
      const { data, error } = await state.supabase
        .from('workout_logs')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;

      const cloudSets = (data || []).map(mapSupabaseRowToSet);
      state.sets = cloudSets;

      // Merge any custom exercises found in cloud records
      const cloudExercises = cloudSets.map((s) => s.exercise).filter(Boolean);
      const mergedExercises = Array.from(new Set([...state.exercises, ...cloudExercises]));
      if (mergedExercises.length !== state.exercises.length) {
        state.exercises = mergedExercises;
        saveExercisesToStorage();
      }
    } catch (err) {
      console.warn('從 Supabase 讀取失敗，自動降級使用 localStorage:', err);
      state.sets = loadLocalSetsFromStorage();
      showToast('⚠️ 雲端讀取失敗，已切換為本機離線紀錄');
    }
  } else {
    state.sets = loadLocalSetsFromStorage();
  }

  renderAllViews();
}

function renderAllViews() {
  const selectEl = document.getElementById('exercise-select');
  renderExerciseSelect(selectEl ? selectEl.value : undefined);
  renderTodaySets();
  renderHistoryAndStats();
  renderCloudBackupStatus();
  updateAccountUI();
}

function updateAccountUI() {
  const headerLoginBtn = document.getElementById('header-login-btn');
  const headerUserPill = document.getElementById('header-user-pill');
  const headerUserEmail = document.getElementById('header-user-email');

  const settingsUserEmail = document.getElementById('settings-user-email');
  const storageTrackLabel = document.getElementById('storage-track-label');
  const supabaseModeBadge = document.getElementById('supabase-mode-badge');
  const settingsLoginBtn = document.getElementById('settings-login-btn');
  const settingsLogoutBtn = document.getElementById('settings-logout-btn');

  if (state.user) {
    const email = state.user.email || '已登入使用者';
    headerLoginBtn?.classList.add('hidden');
    headerUserPill?.classList.remove('hidden');
    if (headerUserEmail) headerUserEmail.textContent = email;

    if (settingsUserEmail) settingsUserEmail.textContent = email;
    settingsLoginBtn?.classList.add('hidden');
    settingsLogoutBtn?.classList.remove('hidden');

    if (navigator.onLine) {
      if (storageTrackLabel) storageTrackLabel.textContent = '☁️ Supabase 雲端資料庫 (workout_logs)';
      if (supabaseModeBadge) {
        supabaseModeBadge.textContent = '雲端同步中';
        supabaseModeBadge.classList.add('ok');
      }
    } else {
      if (storageTrackLabel) storageTrackLabel.textContent = '📴 離線暫存 (localStorage Fallback)';
      if (supabaseModeBadge) {
        supabaseModeBadge.textContent = '離線 Fallback';
        supabaseModeBadge.classList.remove('ok');
      }
    }
  } else {
    headerLoginBtn?.classList.remove('hidden');
    headerUserPill?.classList.add('hidden');

    if (settingsUserEmail) {
      settingsUserEmail.textContent = isSupabaseConfigured()
        ? '未登入'
        : '未登入（尚未設定 Supabase 金鑰）';
    }
    if (storageTrackLabel) storageTrackLabel.textContent = '📱 本機 localStorage (Fallback)';
    if (supabaseModeBadge) {
      supabaseModeBadge.textContent = '本機離線模式';
      supabaseModeBadge.classList.remove('ok');
    }
    settingsLoginBtn?.classList.remove('hidden');
    settingsLogoutBtn?.classList.add('hidden');
  }
}

// ==========================================
// Auth Modal & Actions
// ==========================================
function openAuthModal() {
  const modal = document.getElementById('auth-modal');
  const feedback = document.getElementById('auth-feedback');
  if (!modal) return;
  modal.classList.remove('hidden');

  if (!isSupabaseConfigured()) {
    setAuthFeedback(
      '請先在 app.js 頂部填入您的 SUPABASE_URL 與 SUPABASE_ANON_KEY 後重新整理頁面。',
      false
    );
  } else if (feedback) {
    feedback.classList.add('hidden');
  }
  document.getElementById('auth-email-input')?.focus();
}

function closeAuthModal() {
  document.getElementById('auth-modal')?.classList.add('hidden');
}

function setAuthFeedback(message, isSuccess = false) {
  const feedback = document.getElementById('auth-feedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle('success', isSuccess);
  feedback.classList.remove('hidden');
}

async function handleAuthSubmit(mode) {
  if (!isSupabaseConfigured() || !state.supabase) {
    setAuthFeedback(
      '尚未設定 Supabase 金鑰！請打開 app.js 第 6~7 行填入 SUPABASE_URL 與 SUPABASE_ANON_KEY。',
      false
    );
    return;
  }

  const email = document.getElementById('auth-email-input').value.trim();
  const password = document.getElementById('auth-password-input').value;

  if (!email || !password) {
    setAuthFeedback('請完整輸入 Email 與密碼。', false);
    return;
  }
  if (password.length < 6) {
    setAuthFeedback('密碼長度請至少輸入 6 個字元。', false);
    return;
  }

  const signInBtn = document.getElementById('auth-signin-btn');
  const signUpBtn = document.getElementById('auth-signup-btn');
  signInBtn.disabled = true;
  signUpBtn.disabled = true;

  try {
    if (mode === 'signup') {
      const { data, error } = await state.supabase.auth.signUp({ email, password });
      if (error) throw error;

      if (data?.session) {
        setAuthFeedback('✅ 註冊並登入成功！', true);
        showToast(`🎉 歡迎加入，${email}！`);
        setTimeout(closeAuthModal, 600);
      } else {
        setAuthFeedback(
          '✅ 註冊成功！若您的 Supabase 專案有開啟 Email 驗證，請先至信箱點擊確認信後再登入。',
          true
        );
      }
    } else {
      const { error } = await state.supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;

      setAuthFeedback('✅ 登入成功！正在同步雲端訓練紀錄...', true);
      showToast(`☁️ 已登入：${email}`);
      setTimeout(closeAuthModal, 500);
    }
  } catch (err) {
    setAuthFeedback(`驗證失敗：${err.message || '請確認帳號密碼是否正確'}`, false);
  } finally {
    signInBtn.disabled = false;
    signUpBtn.disabled = false;
  }
}

async function handleSignOut() {
  if (!state.supabase) return;
  try {
    await state.supabase.auth.signOut();
    state.user = null;
    state.sets = loadLocalSetsFromStorage();
    renderAllViews();
    showToast('已登出雲端帳號，切換回本機紀錄');
  } catch (err) {
    showToast(`登出失敗：${err.message || ''}`);
  }
}

// ==========================================
// Rest Countdown Timer (Web Worker + Service Worker + Background Keep-Alive)
// ==========================================
function ensureTimerWorker() {
  if (state.timer.worker) return state.timer.worker;
  try {
    const workerCode = `
      let timerId = null;
      let targetEndMs = 0;
      self.onmessage = function(e) {
        const data = e.data || {};
        if (data.cmd === 'START') {
          clearInterval(timerId);
          targetEndMs = data.endTimeMs;
          timerId = setInterval(() => {
            const msLeft = targetEndMs - Date.now();
            if (msLeft <= 0) {
              clearInterval(timerId);
              timerId = null;
              self.postMessage({ type: 'DONE' });
            } else {
              self.postMessage({ type: 'TICK', msLeft });
            }
          }, 200);
        } else if (data.cmd === 'STOP') {
          clearInterval(timerId);
          timerId = null;
        }
      };
    `;
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'TICK') {
        updateTimerDisplayFromNow();
      } else if (msg.type === 'DONE') {
        completeRestTimer();
      }
    };
    state.timer.worker = worker;
    return worker;
  } catch {
    return null;
  }
}

function updateTimerDisplayFromNow() {
  if (!state.timer.isRunning) return;
  const display = document.getElementById('timer-display');
  const progressBar = document.getElementById('timer-progress-bar');

  const msLeft = state.timer.endTimeMs - Date.now();
  const secLeft = Math.max(0, msLeft / 1000);
  state.timer.remainingSeconds = secLeft;

  if (display) display.textContent = formatTimeFromSeconds(secLeft);
  const pct =
    state.timer.totalSeconds > 0
      ? Math.max(0, Math.min(100, (secLeft / state.timer.totalSeconds) * 100))
      : 0;
  if (progressBar) progressBar.style.width = `${pct}%`;

  if (secLeft <= 0) {
    completeRestTimer();
  }
}

function completeRestTimer() {
  if (!state.timer.isRunning && state.timer.notifiedForCurrentRun) return;
  state.timer.isRunning = false;
  state.timer.notifiedForCurrentRun = true;

  clearInterval(state.timer.intervalId);
  state.timer.worker?.postMessage({ cmd: 'STOP' });

  const banner = document.getElementById('timer-banner');
  const display = document.getElementById('timer-display');
  const progressBar = document.getElementById('timer-progress-bar');

  banner?.classList.remove('timer-running');
  banner?.classList.add('timer-finished');
  if (display) display.textContent = '00:00';
  if (progressBar) progressBar.style.width = '0%';

  showToast('🔔 休息結束！準備下一組訓練');

  const exerciseSelect = document.getElementById('exercise-select');
  const exerciseName = exerciseSelect ? exerciseSelect.value : '';

  if (document.visibilityState === 'visible') {
    // Only play gentle ambient Web Audio chime when user is actively viewing IronLog
    playBeepSequence();
  } else {
    // When in another app, rely purely on OS System Notification so background music is never interrupted
    triggerCrossAppNotification(
      '🔔 IronLog — 組間休息結束！',
      `休息時間到${exerciseName ? `（${exerciseName}）` : ''}，準備開始下一組訓練 💪`
    );
  }
}

function startRestTimer(seconds, options = {}) {
  configureAmbientAudioSession();

  // Automatically prompt for notification permission on first timer use if still 'default'
  if (isNotificationSupported() && Notification.permission === 'default') {
    requestNotificationPermission(true);
  }

  clearInterval(state.timer.intervalId);

  const banner = document.getElementById('timer-banner');
  const display = document.getElementById('timer-display');
  const progressBar = document.getElementById('timer-progress-bar');

  state.timer.totalSeconds = seconds;
  state.timer.remainingSeconds = seconds;
  state.timer.endTimeMs = Date.now() + seconds * 1000;
  state.timer.isRunning = true;
  state.timer.notifiedForCurrentRun = false;

  banner.classList.remove('timer-finished');
  banner.classList.add('timer-running');
  display.textContent = formatTimeFromSeconds(seconds);
  progressBar.style.width = '100%';

  // 1. Schedule Service Worker Notification for cross-app alert
  const exerciseSelect = document.getElementById('exercise-select');
  sendSwMessage({
    type: 'SCHEDULE_REST_NOTIFICATION',
    endTimeMs: state.timer.endTimeMs,
    exercise: exerciseSelect ? exerciseSelect.value : '',
    alwaysNotify: Boolean(options.alwaysNotify)
  });

  // 2. Start unthrottled Web Worker timer
  const worker = ensureTimerWorker();
  if (worker) {
    worker.postMessage({ cmd: 'START', endTimeMs: state.timer.endTimeMs });
  }

  // 3. Fallback main-thread interval
  state.timer.intervalId = setInterval(updateTimerDisplayFromNow, 250);
}

function stopRestTimer() {
  clearInterval(state.timer.intervalId);
  state.timer.worker?.postMessage({ cmd: 'STOP' });
  sendSwMessage({ type: 'CANCEL_REST_NOTIFICATION' });

  state.timer.isRunning = false;
  state.timer.notifiedForCurrentRun = false;

  const banner = document.getElementById('timer-banner');
  const display = document.getElementById('timer-display');
  const progressBar = document.getElementById('timer-progress-bar');

  banner.classList.remove('timer-running', 'timer-finished');
  display.textContent = formatTimeFromSeconds(state.autoRestSeconds || 90);
  progressBar.style.width = '0%';
}

function addSecondsToTimer(extraSeconds) {
  if (!state.timer.isRunning) {
    startRestTimer(extraSeconds);
    return;
  }
  state.timer.endTimeMs += extraSeconds * 1000;
  state.timer.totalSeconds += extraSeconds;

  const exerciseSelect = document.getElementById('exercise-select');
  sendSwMessage({
    type: 'SCHEDULE_REST_NOTIFICATION',
    endTimeMs: state.timer.endTimeMs,
    exercise: exerciseSelect ? exerciseSelect.value : ''
  });
  state.timer.worker?.postMessage({ cmd: 'START', endTimeMs: state.timer.endTimeMs });
  updateTimerDisplayFromNow();
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
    renderLastSessionForExercise(exerciseName, []);
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
  renderLastSessionForExercise(exerciseName, matchingSets);
}

function renderLastSessionForExercise(exerciseName, matchingSets) {
  const dateBadgeEl = document.getElementById('last-session-date-badge');
  const summaryEl = document.getElementById('last-session-summary');
  const listEl = document.getElementById('last-session-sets-list');
  if (!dateBadgeEl || !summaryEl || !listEl) return;

  if (!matchingSets || matchingSets.length === 0) {
    dateBadgeEl.textContent = '尚無紀錄';
    summaryEl.textContent = '';
    listEl.innerHTML = `<div class="last-session-empty">此動作尚無歷史訓練紀錄</div>`;
    return;
  }

  const todayKey = getLocalDateKey();
  const uniqueDatesDesc = Array.from(new Set(matchingSets.map((s) => s.date))).sort((a, b) =>
    a < b ? 1 : -1
  );

  // Prefer the most recent session date strictly before today so the reference stays fixed while logging today's workout.
  const priorDates = uniqueDatesDesc.filter((d) => d < todayKey);
  const targetDate = priorDates.length > 0 ? priorDates[0] : uniqueDatesDesc[0];
  const isTodayFallback = targetDate === todayKey;

  const sessionSets = matchingSets.filter((s) => s.date === targetDate);
  const sessionVolume = sessionSets.reduce(
    (sum, s) => sum + (Number(s.weight) || 0) * (Number(s.reps) || 0),
    0
  );

  dateBadgeEl.textContent = isTodayFallback ? `${targetDate} (今日)` : targetDate;
  summaryEl.textContent = `共 ${sessionSets.length} 組 · 容量 ${formatNumber(sessionVolume)} kg`;

  listEl.innerHTML = sessionSets
    .map((item, idx) => {
      const vol = formatNumber((Number(item.weight) || 0) * (Number(item.reps) || 0));
      const rpeHtml = item.rpe ? `<span class="rpe-tag">RPE ${item.rpe}</span>` : '';
      const rpeAttr = item.rpe ? escapeHtml(item.rpe) : '';
      return `
        <div class="last-session-set-row">
          <div class="last-session-set-left">
            <span class="last-session-set-num">#${idx + 1}</span>
            <div>
              <span class="last-session-set-main">${item.weight} kg × ${item.reps} 次</span>
              ${rpeHtml}
              <span class="last-session-set-vol">(${vol} kg)</span>
            </div>
          </div>
          <button
            type="button"
            class="apply-set-btn"
            data-apply-weight="${item.weight}"
            data-apply-reps="${item.reps}"
            data-apply-rpe="${rpeAttr}"
            title="將此組重量與次數帶入輸入框"
          >套用</button>
        </div>
      `;
    })
    .join('');
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

  // 2. Desktop File System Access API
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
  reader.onload = async (e) => {
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

      if (isCloudActive()) {
        // When logged in to Supabase, insert imported sets to cloud workout_logs
        const rowsToInsert = parsed.sets.map((s) => ({
          user_id: state.user.id,
          date: s.date || getLocalDateKey(),
          exercise: s.exercise,
          weight: Number(s.weight) || 0,
          reps: Number(s.reps) || 1,
          rpe: s.rpe !== null && s.rpe !== undefined && s.rpe !== '' ? Number(s.rpe) : null
        }));

        if (state.importMode === 'overwrite') {
          await state.supabase.from('workout_logs').delete().eq('user_id', state.user.id);
        }

        if (rowsToInsert.length > 0) {
          const { error } = await state.supabase.from('workout_logs').insert(rowsToInsert);
          if (error) throw error;
        }
        await syncDataFromActiveTrack();
        recordBackupSuccess();
        showToast(`☁️ 已匯入 ${rowsToInsert.length} 筆組數至 Supabase 雲端！`);
        return;
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
      renderAllViews();
      showToast(
        state.importMode === 'merge'
          ? `✅ 智慧合併完成！目前共 ${state.sets.length} 筆組數紀錄`
          : `✅ 完整覆蓋還原 ${state.sets.length} 筆組數紀錄！`
      );
    } catch (err) {
      console.error(err);
      showToast('⚠️ JSON 匯入失敗，請確認檔案格式或雲端連線');
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

  // Auth Buttons & Modal Events
  document.getElementById('header-login-btn')?.addEventListener('click', openAuthModal);
  document.getElementById('settings-login-btn')?.addEventListener('click', openAuthModal);
  document.getElementById('header-logout-btn')?.addEventListener('click', handleSignOut);
  document.getElementById('settings-logout-btn')?.addEventListener('click', handleSignOut);
  document.getElementById('close-auth-modal-btn')?.addEventListener('click', closeAuthModal);

  document.getElementById('auth-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'auth-modal') closeAuthModal();
  });

  document.getElementById('auth-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleAuthSubmit('signin');
  });

  document.getElementById('auth-signup-btn')?.addEventListener('click', () => {
    handleAuthSubmit('signup');
  });

  // Online / Offline Automatic Track Switch
  window.addEventListener('online', () => {
    updateAccountUI();
    if (isCloudActive()) {
      syncDataFromActiveTrack();
      showToast('🌐 網路已恢復，已切換至 Supabase 雲端同步');
    }
  });

  window.addEventListener('offline', () => {
    updateAccountUI();
    showToast('📴 目前處於離線狀態，已自動降級為本機儲存');
  });

  // Exercise Change -> Update PR & Last Session
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

  // Add Set Button (Dual-Track: Supabase Cloud Insert or LocalStorage Fallback)
  document.getElementById('add-set-btn').addEventListener('click', async () => {
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
    const dateStr = getLocalDateKey(now);
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const numericRpe = state.selectedRpe !== null ? Number(state.selectedRpe) : null;

    if (isCloudActive()) {
      try {
        const { data, error } = await state.supabase
          .from('workout_logs')
          .insert([
            {
              user_id: state.user.id,
              date: dateStr,
              exercise,
              weight,
              reps,
              rpe: numericRpe
            }
          ])
          .select()
          .single();

        if (error) throw error;

        const insertedSet = mapSupabaseRowToSet(data);
        state.sets.push(insertedSet);
      } catch (err) {
        console.warn('Supabase 寫入失敗，自動降級寫入 localStorage:', err);
        const fallbackSet = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          date: dateStr,
          time: timeStr,
          exercise,
          weight,
          reps,
          rpe: state.selectedRpe
        };
        state.sets.push(fallbackSet);
        saveSetsToStorage();
        showToast('⚠️ 雲端寫入失敗，已自動轉存至本機 localStorage');
      }
    } else {
      const localSet = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        date: dateStr,
        time: timeStr,
        exercise,
        weight,
        reps,
        rpe: state.selectedRpe
      };
      state.sets.push(localSet);
      saveSetsToStorage();
    }

    updatePrBannerForExercise(exercise);
    renderTodaySets();
    renderHistoryAndStats();
    renderCloudBackupStatus();

    if (state.autoRestSeconds > 0) {
      startRestTimer(state.autoRestSeconds);
      showToast(
        isCloudActive()
          ? `☁️ 已同步雲端！啟動 ${state.autoRestSeconds} 秒休息倒數`
          : `💪 已紀錄！啟動 ${state.autoRestSeconds} 秒休息倒數`
      );
    } else {
      showToast(isCloudActive() ? '☁️ 已同步組數至雲端！' : '💪 已紀錄組數！');
    }
  });

  // Delete Set & Apply Last Session Set Delegation (Dual-Track Delete)
  document.querySelector('.app-content').addEventListener('click', async (e) => {
    const applyBtn = e.target.closest('.apply-set-btn');
    if (applyBtn) {
      const w = applyBtn.dataset.applyWeight;
      const r = applyBtn.dataset.applyReps;
      const rpe = applyBtn.dataset.applyRpe;

      if (w !== undefined) document.getElementById('weight-input').value = w;
      if (r !== undefined) document.getElementById('reps-input').value = r;

      state.selectedRpe = rpe || null;
      document.querySelectorAll('.rpe-pill').forEach((p) => {
        p.classList.toggle('active', Boolean(rpe) && p.dataset.rpe === rpe);
      });

      showToast(`已帶入：${w} kg × ${r} 次${rpe ? ` (RPE ${rpe})` : ''}`);
      return;
    }

    const deleteBtn = e.target.closest('.delete-set-btn');
    if (!deleteBtn) return;
    const setId = deleteBtn.dataset.deleteId;

    if (isCloudActive()) {
      try {
        const { error } = await state.supabase
          .from('workout_logs')
          .delete()
          .eq('id', setId);
        if (error) throw error;
      } catch (err) {
        console.warn('Supabase 刪除失敗:', err);
        showToast('⚠️ 雲端刪除失敗，請檢查網路連線');
        return;
      }
    }

    state.sets = state.sets.filter((s) => String(s.id) !== String(setId));
    if (!isCloudActive()) {
      saveSetsToStorage();
    }

    updatePrBannerForExercise(exerciseSelect.value);
    renderTodaySets();
    renderHistoryAndStats();
    renderCloudBackupStatus();
    showToast(isCloudActive() ? '☁️ 已從雲端刪除該組紀錄' : '已刪除該組紀錄');
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

  // Notification Permission & Cross-App Background Test
  document.getElementById('enable-notify-banner-btn')?.addEventListener('click', () => {
    requestNotificationPermission(false);
  });

  document.getElementById('request-notify-btn')?.addEventListener('click', () => {
    requestNotificationPermission(false);
  });

  document.getElementById('test-bg-notify-btn')?.addEventListener('click', async () => {
    await requestNotificationPermission(true);
    startRestTimer(3, { alwaysNotify: true });
    showToast('⏱️ 已啟動 3 秒測試倒數！請立即切換到其他 App 或主畫面測試');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.timer.isRunning) {
      updateTimerDisplayFromNow();
    }
  });

  document.getElementById('test-sound-btn').addEventListener('click', () => {
    playBeepSequence();
    showToast('🔊 已播放計時完成提示音');
  });

  document.getElementById('clear-all-data-btn').addEventListener('click', async () => {
    const confirmed = window.confirm('確定要清空所有歷史訓練組數嗎？此操作無法復原。');
    if (!confirmed) return;

    if (isCloudActive()) {
      try {
        const { error } = await state.supabase
          .from('workout_logs')
          .delete()
          .eq('user_id', state.user.id);
        if (error) throw error;
      } catch (err) {
        showToast(`雲端清空失敗：${err.message || ''}`);
        return;
      }
    } else {
      localStorage.removeItem(STORAGE_KEYS.LOGS);
    }

    state.sets = [];
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
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker
      .register('./service-worker.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update();
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
  updateNotificationStatusUI();
  bindEvents();
  initSupabaseClient();
  checkPwaAndServiceWorkerStatus();
});
