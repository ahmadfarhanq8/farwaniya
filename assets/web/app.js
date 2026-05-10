// ═══════════════════════════════════════
// متغيرات عامة
// ═══════════════════════════════════════
let employees          = [];
let officers           = [];
let leaves             = [];
let statistics         = [];
let leavePermissions   = [];
let archiveFiles       = [];
let otherRequests      = [];   // طلبات أخرى — محملة من Supabase
let accountsCache      = [];   // الحسابات — محملة من Supabase
let notificationsCache = [];   // إشعارات الموظفين — محملة من Supabase
let appSettings        = {};   // إعدادات التطبيق — محملة من Supabase

// ─── نظام الإشعارات للمدير ───────────────────────────────────
let adminNotifications = [];
let currentAdminNotificationId = null;
let _adminPollInterval = null;

// ─── حماية من محاولات تسجيل الدخول المتعددة ────────────────────────────
const _loginAttempts = {};
const _LOGIN_MAX = 5;
const _LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // 5 دقائق

// ─── كشف انقطاع الاتصال ──────────────────────────────────────
(function setupOfflineDetection(){
    function updateOnline(){
        const banner = document.getElementById('offline-banner');
        if (!banner) return;
        if (navigator.onLine) {
            banner.style.display = 'none';
            // عند العودة، أعد تحميل البيانات تلقائياً
            if (window._wasOffline && typeof loadAllData === 'function' && typeof currentUser !== 'undefined' && currentUser) {
                window._wasOffline = false;
                loadAllData().then(() => {
                    if (typeof refreshAllRoleScreens === 'function') refreshAllRoleScreens();
                    if (typeof showToast === 'function') showToast('✓ عاد الاتصال — تم تحديث البيانات', 'success');
                }).catch(()=>{});
            }
        } else {
            banner.style.display = 'block';
            window._wasOffline = true;
        }
    }
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    document.addEventListener('DOMContentLoaded', updateOnline);
    // تأكد عند التحميل
    setTimeout(updateOnline, 500);
})();

// ─── تعقيم HTML لمنع XSS ───────────────────────────────────
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Helpers: Loading state للأزرار + استخراج رسائل الأخطاء ───
function _btnSetLoading(btn, loading, originalText) {
    if (!btn) return;
    if (loading) {
        if (!btn.dataset._origHtml) btn.dataset._origHtml = btn.innerHTML;
        btn.disabled = true;
        btn.style.opacity = '0.7';
        btn.style.pointerEvents = 'none';
        btn.innerHTML = '<span class="btn-spinner" style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.4);border-top-color:#fff;border-radius:50%;animation:_spin 0.8s linear infinite;vertical-align:middle;margin-left:6px;"></span><span>جاري المعالجة...</span>';
    } else {
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.pointerEvents = '';
        if (btn.dataset._origHtml) {
            btn.innerHTML = btn.dataset._origHtml;
            delete btn.dataset._origHtml;
        } else if (originalText) {
            btn.innerHTML = originalText;
        }
    }
}

// تشغيل عملية async مع loading على زر، وإظهار رسالة خطأ تفصيلية لو فشلت
async function withButtonLoading(btnOrEvent, fn, errPrefix = 'حدث خطأ') {
    const btn = (btnOrEvent && btnOrEvent.currentTarget) ? btnOrEvent.currentTarget
              : (btnOrEvent && btnOrEvent.tagName) ? btnOrEvent : null;
    _btnSetLoading(btn, true);
    try {
        return await fn();
    } catch (err) {
        const msg = extractErrorMessage(err) || errPrefix;
        showToast(`${errPrefix}: ${msg}`, 'error');
        console.error(errPrefix, err);
        throw err;
    } finally {
        _btnSetLoading(btn, false);
    }
}

// استخراج رسالة خطأ مفهومة من نتائج Supabase أو exceptions
function extractErrorMessage(err) {
    if (!err) return '';
    // كشف أخطاء الشبكة
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return 'لا يوجد اتصال بالإنترنت. يرجى التحقق من الشبكة وإعادة المحاولة.';
    }
    if (typeof err === 'string') {
        if (/network|fetch|failed to fetch|networkerror/i.test(err)) {
            return 'فشل الاتصال بالخادم. تحقق من الإنترنت وحاول مجدداً.';
        }
        return err;
    }
    const msg = (err.error && typeof err.error === 'string') ? err.error
              : (err.error && err.error.message) ? err.error.message
              : err.message || err.details || err.hint || '';
    if (msg && /network|fetch|failed to fetch|networkerror|timeout/i.test(msg)) {
        return 'فشل الاتصال بالخادم. تحقق من الإنترنت وحاول مجدداً.';
    }
    if (msg) return msg;
    try { return JSON.stringify(err); } catch(_) { return String(err); }
}

// حقن CSS animation للـ spinner مرة واحدة
(function _injectSpinnerCSS(){
    if (document.getElementById('_btn-spinner-css')) return;
    const s = document.createElement('style');
    s.id = '_btn-spinner-css';
    s.textContent = '@keyframes _spin{to{transform:rotate(360deg)}}';
    (document.head || document.documentElement).appendChild(s);
})();

// ─── ضمان تحميل البيانات قبل فتح أي نافذة تعتمد على قوائم الموظفين/الضباط ───
// كاش لمنع التحميل المتكرر خلال فترة قصيرة
const _ensureLoadedCache = { ts: 0 };
const _ENSURE_LOADED_TTL = 3000; // 3 ثوانٍ

async function ensureDataLoaded(opts) {
    opts = opts || {};
    const needEmployees = opts.employees !== false;
    const needOfficers  = opts.officers  !== false;
    const force         = !!opts.force;
    const now = Date.now();
    // تجنّب الإعادة لو حُمِّلت مؤخراً
    if (!force && (now - _ensureLoadedCache.ts) < _ENSURE_LOADED_TTL) {
        if ((!needEmployees || employees.length > 0) && (!needOfficers || officers.length > 0)) return;
    }
    try {
        const tasks = [];
        if (needEmployees && window.db && typeof window.db.getEmployees === 'function') {
            tasks.push(window.db.getEmployees().then(r => { if (Array.isArray(r)) employees = r; }));
        }
        if (needOfficers && window.db && typeof window.db.getOfficers === 'function') {
            tasks.push(window.db.getOfficers().then(r => { if (Array.isArray(r)) officers = r; }));
        }
        await Promise.all(tasks);
        _ensureLoadedCache.ts = Date.now();
    } catch (e) {
        console.warn('ensureDataLoaded warning:', e);
    }
}

// ─── سجل تدقيق (Audit Log) ───────────────────────────────────
function logAudit(action, entity_type, entity_id, extras) {
    try {
        if (!window.db || typeof window.db.auditLog !== 'function') return;
        const u = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : {};
        const entry = Object.assign({
            actor       : u.username || u.name || 'unknown',
            actor_role  : u.role || '',
            action      : action,
            entity_type : entity_type,
            entity_id   : entity_id != null ? entity_id : null
        }, extras || {});
        window.db.auditLog(entry).catch(()=>{});
    } catch(_) {}
}

// ─── حد أقصى لحجم الملف + ضغط الصور قبل الرفع ────────────────
const MAX_UPLOAD_SIZE_MB = 10;
const IMAGE_COMPRESS_THRESHOLD_MB = 2;
const IMAGE_MAX_DIMENSION = 1920;

function _compressImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('فشل قراءة الصورة'));
        reader.onload = (ev) => {
            const img = new Image();
            img.onerror = () => reject(new Error('فشل تحميل الصورة'));
            img.onload = () => {
                let w = img.width, h = img.height;
                if (w > IMAGE_MAX_DIMENSION || h > IMAGE_MAX_DIMENSION) {
                    const ratio = Math.min(IMAGE_MAX_DIMENSION / w, IMAGE_MAX_DIMENSION / h);
                    w = Math.round(w * ratio);
                    h = Math.round(h * ratio);
                }
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
                // حساب حجم تقريبي بعد الضغط
                const bytes = Math.round((dataUrl.length - 22) * 0.75);
                resolve({ dataUrl, size: bytes, name: file.name.replace(/\.(png|webp|tiff?|bmp|heic)$/i, '.jpg') });
            };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// تحقق من الحجم وضغط الصور إذا لزم. يُرجع { dataUrl, size, name } أو null عند الخطأ
async function prepareFileForUpload(file) {
    const maxBytes = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
    const isImage = file.type && file.type.startsWith('image/');
    // حاول ضغط الصور الكبيرة
    if (isImage && file.size > IMAGE_COMPRESS_THRESHOLD_MB * 1024 * 1024) {
        try {
            const r = await _compressImage(file);
            if (r.size > maxBytes) {
                showToast(`الصورة "${file.name}" كبيرة جداً حتى بعد الضغط (الحد ${MAX_UPLOAD_SIZE_MB}MB)`, 'error');
                return null;
            }
            return r;
        } catch(_) { /* fallback to original */ }
    }
    if (file.size > maxBytes) {
        showToast(`الملف "${file.name}" يتجاوز الحد المسموح (${MAX_UPLOAD_SIZE_MB}MB)`, 'error');
        return null;
    }
    // قراءة عادية
    const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error('فشل قراءة الملف'));
        r.onload = (ev) => resolve(ev.target.result);
        r.readAsDataURL(file);
    });
    return { dataUrl, size: file.size, name: file.name };
}

// إعادة رسم كل الشاشات المرتبطة بالطلبات (إجازات/استئذانات/طلبات)
// يُستدعى بعد أي عملية approve/reject/save لتحديث UI الأدوار الثلاثة
function refreshAllRoleScreens(opts) {
    opts = opts || {};
    if (opts.skipAdmin !== true) {
        if (typeof renderLeaves      === 'function') try { renderLeaves();      } catch(_) {}
        if (typeof renderPermissions === 'function') try { renderPermissions(); } catch(_) {}
    }
    if (typeof loadEmployeeDashboard === 'function') try { loadEmployeeDashboard(); } catch(_) {}
    if (typeof loadEmployeeRequests  === 'function') try { loadEmployeeRequests();  } catch(_) {}
    if (typeof loadOfficerDashboard  === 'function') try { loadOfficerDashboard();  } catch(_) {}
    if (typeof loadOfficerRequests   === 'function') try { loadOfficerRequests();   } catch(_) {}
}


function getAdminNotificationMeta(type) {
    const icons = {
        leave:      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
        permission: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
        other:      `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`
    };
    return {
        label: type === 'leave' ? 'إجازة' : type === 'permission' ? 'استئذان' : 'طلب آخر',
        color: type === 'leave' ? '#16a34a' : type === 'permission' ? '#d97706' : '#2563eb',
        bg: type === 'leave' ? '#dcfce7' : type === 'permission' ? '#fef3c7' : '#dbeafe',
        cardBg: type === 'leave' ? '#f0fdf4' : type === 'permission' ? '#fffbeb' : '#eff6ff',
        icon: icons[type] || icons.other
    };
}

function closeAdminNotificationDetail() {
    currentAdminNotificationId = null;
    const modal = document.getElementById('admin-notification-detail-modal');
    if (modal) modal.style.display = 'none';
}

function openAdminNotificationDetail(id, skipListRefresh = false) {
    const notification = adminNotifications.find(n => n.id === id);
    if (!notification) return;

    currentAdminNotificationId = id;
    notification.read = true;
    saveNotificationsToStorage();
    updateBellBadge();
    if (!skipListRefresh) renderNotificationsPage();

    const meta = getAdminNotificationMeta(notification.type);
    const modal      = document.getElementById('admin-notification-detail-modal');
    const headerEl   = document.getElementById('admin-notif-detail-header');
    const iconWrapEl = document.getElementById('admin-notif-detail-icon-wrap');
    const iconEl     = document.getElementById('admin-notif-detail-icon');
    const subtitleEl = document.getElementById('admin-notif-detail-subtitle');
    const badgeEl    = document.getElementById('admin-notif-detail-status-badge');
    const dateEl     = document.getElementById('admin-notif-detail-date');
    const messageEl  = document.getElementById('admin-notif-detail-message');
    const actionsEl  = document.getElementById('admin-notif-detail-actions');
    if (!modal) return;

    const s = notification.actioned === 'approve' ? 'approved'
             : notification.actioned === 'reject'  ? 'rejected'
             : 'pending';

    const gradients = {
        approved: 'linear-gradient(135deg,#16a34a 0%,#22c55e 100%)',
        rejected:  'linear-gradient(135deg,#b91c1c 0%,#ef4444 100%)',
        pending:   `linear-gradient(135deg,${meta.color} 0%,${meta.color}cc 100%)`
    };
    const svgIcons = {
        approved: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        rejected:  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        pending:   meta.type === 'leave'
            ? `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`
            : `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`
    };
    const labels = { approved: 'مقبول', rejected: 'مرفوض', pending: 'جديد' };

    if (headerEl)   headerEl.style.background   = gradients[s];
    if (iconWrapEl) iconWrapEl.style.background = 'rgba(255,255,255,0.22)';
    if (iconEl)     iconEl.innerHTML             = svgIcons[s] || svgIcons.pending;
    if (subtitleEl) subtitleEl.textContent       = `${notification.personName} — ${meta.label} (${notification.requestType})`;
    if (badgeEl)    badgeEl.textContent          = labels[s];
    if (dateEl)     dateEl.textContent           = notification.date;
    if (messageEl)  messageEl.textContent        = notification.actioned
        ? `تم ${notification.actioned === 'approve' ? 'قبول' : 'رفض'} طلب ${meta.label} المقدم من ${notification.personName} بتاريخ ${notification.date}.`
        : `تم استلام طلب ${meta.label} جديد من ${notification.personName} بتاريخ ${notification.date}.\nيمكنك قبول الطلب أو رفضه من الأزرار أدناه.`;

    if (actionsEl) {
        actionsEl.innerHTML = notification.actioned
            ? `<button onclick="closeAdminNotificationDetail()" style="width:100%;background:linear-gradient(135deg,#1D5FA7,#2C7BCC);color:#fff;border:none;border-radius:14px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;">حسناً</button>`
            : `<button onclick="handleNotifAction('approve','${notification.type}',${notification.refId},${notification.id})" style="flex:1;background:linear-gradient(135deg,#16a34a,#22c55e);color:#fff;border:none;border-radius:14px;padding:13px;font-size:14px;font-weight:700;cursor:pointer;">قبول</button>
               <button onclick="handleNotifAction('reject','${notification.type}',${notification.refId},${notification.id})" style="flex:1;background:linear-gradient(135deg,#b91c1c,#ef4444);color:#fff;border:none;border-radius:14px;padding:13px;font-size:14px;font-weight:700;cursor:pointer;">رفض</button>`;
    }

    modal.style.display = 'flex';
}

async function addAdminNotification({ type, personName, requestType, date, refId }) {
    adminNotifications.unshift({
        id: Date.now(),
        type,
        personName,
        requestType,
        date,
        refId,
        read: false,
        createdAt: new Date().toISOString()
    });
    await saveNotificationsToStorage();
    updateBellBadge();
    // إرسال push notification للمدير حتى لو خارج التطبيق
    const typeLabel = type === 'leave' ? 'إجازة' : type === 'permission' ? 'استئذان' : 'طلب آخر';
    sendAdminPushNotification({
        title: `طلب ${typeLabel} جديد`,
        body: `${personName} — ${requestType}`
    });
}

function updateBellBadge() {
    const btn = document.getElementById('btn-home-bell');
    if (!btn) return;
    const unread = adminNotifications.filter(n => !n.read).length;
    let badge = btn.querySelector('.bell-badge');
    if (unread > 0) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'bell-badge';
            btn.appendChild(badge);
        }
        badge.textContent = unread > 9 ? '9+' : unread;
    } else {
        if (badge) badge.remove();
    }
}

async function showAdminNotifications() {
    // تحديد الكل كمقروء
    adminNotifications.forEach(n => n.read = true);
    updateBellBadge();
    await saveNotificationsToStorage();

    // إزالة أي بانيل سابق
    const existing = document.getElementById('admin-notif-panel');
    if (existing) { existing.remove(); return; }

    const overlay = document.createElement('div');
    overlay.id = 'admin-notif-panel';
    overlay.style.cssText = `
        position:fixed;top:0;left:0;right:0;bottom:0;z-index:9000;
        display:flex;flex-direction:column;justify-content:flex-end;
        background:rgba(0,0,0,0.45);
    `;

    const items = adminNotifications.length === 0
        ? `<div style="text-align:center;color:#999;padding:30px 0;">لا توجد إشعارات بعد</div>`
        : adminNotifications.map(n => `
            <div id="notif-item-${n.id}" onclick="openAdminNotificationDetail(${n.id})" style="padding:14px 16px;border-bottom:1px solid #f0f0f0;cursor:pointer;">
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="width:40px;height:40px;border-radius:50%;background:${getAdminNotificationMeta(n.type).color}22;
                        display:flex;align-items:center;justify-content:center;flex-shrink:0;color:${getAdminNotificationMeta(n.type).color};">
                        ${getAdminNotificationMeta(n.type).icon}
                    </div>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:700;font-size:14px;color:#1e293b;">${n.personName}</div>
                        <div style="font-size:12px;color:${getAdminNotificationMeta(n.type).color};font-weight:600;margin:2px 0;">
                            ${getAdminNotificationMeta(n.type).label} — ${n.requestType}
                        </div>
                        <div style="font-size:11px;color:#94a3b8;">${n.date}</div>
                    </div>
                </div>
                <div style="display:flex;gap:8px;margin-top:10px;justify-content:flex-end;">
                    <button onclick="event.stopPropagation(); handleNotifAction('approve','${n.type}',${n.refId},${n.id})"
                        style="flex:1;padding:8px 0;border:none;border-radius:10px;background:#22c55e;
                        color:#fff;font-weight:700;font-size:13px;cursor:pointer;">قبول</button>
                    <button onclick="event.stopPropagation(); handleNotifAction('reject','${n.type}',${n.refId},${n.id})"
                        style="flex:1;padding:8px 0;border:none;border-radius:10px;background:#ef4444;
                        color:#fff;font-weight:700;font-size:13px;cursor:pointer;">رفض</button>
                </div>
            </div>`).join('');

    overlay.innerHTML = `
        <div style="background:#fff;border-radius:20px 20px 0 0;max-height:72vh;
            overflow-y:auto;box-shadow:0 -4px 20px rgba(0,0,0,0.18);display:flex;flex-direction:column;">
            <div style="display:flex;justify-content:space-between;align-items:center;
                padding:16px 20px 12px;border-bottom:1px solid #f0f0f0;">
                <h3 style="margin:0;font-size:17px;font-weight:700;color:#1e293b;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1e293b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-left:6px;"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg> الإشعارات</h3>
                <button onclick="document.getElementById('admin-notif-panel').remove()"
                    style="border:none;background:#f1f5f9;color:#64748b;border-radius:50%;
                    width:32px;height:32px;font-size:18px;cursor:pointer;display:flex;
                    align-items:center;justify-content:center;">✕</button>
            </div>
            <div style="overflow-y:auto;flex:1;">${items}</div>
        </div>`;

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
}

async function handleNotifAction(action, type, refId, notifId) {
    // إيجاد الزر الذي ضُغط لإظهار loading state عليه
    const btn = (typeof event !== 'undefined' && event && event.currentTarget) ? event.currentTarget : null;
    _btnSetLoading(btn, true);
    try {
        // تنفيذ القبول أو الرفض
        if (type === 'leave') {
            if (action === 'approve') await approveLeave(refId);
            else await rejectLeave(refId);
        } else if (type === 'permission') {
            if (action === 'approve') await approvePermission(refId);
            else await rejectPermission(refId);
        } else if (type === 'other') {
            // Update the saved "other" request status and notify employee
            try {
                const req = otherRequests.find(r => r.id == refId);
                if (req) {
                    const newStatus = action === 'approve' ? 'approved' : 'rejected';
                    await window.db.updateOtherRequest(req.id, { status: newStatus, updated_at: new Date().toISOString() });
                    otherRequests = await window.db.getOtherRequests();
                    if (window.db.addNotification) {
                        await window.db.addNotification({
                            person_id: req.person_id,
                            title: action === 'approve' ? 'تمت الموافقة على طلبك ✅' : 'تم رفض طلبك ❌',
                            message: `${req.type} — ${req.description}`,
                            type: 'message',
                            status: newStatus
                        });
                        notificationsCache = await window.db.getNotifications();
                        window.db.sendPushNotificationToPerson({
                            title: action === 'approve' ? 'تمت الموافقة على طلبك ✅' : 'تم رفض طلبك ❌',
                            body: `${req.type}${req.description ? ' — ' + req.description : ''}`,
                            personId: req.person_id
                        });
                    }
                }
            } catch (e) { console.error(e); showToast('فشل تحديث الطلب: ' + extractErrorMessage(e), 'error'); }
        }
        // تحديث حالة الإشعار بدل حذفه
        const notif = adminNotifications.find(n => n.id === notifId);
        if (notif) {
            notif.actioned = action; // 'approve' | 'reject'
            notif.read = true;
        }
        saveNotificationsToStorage();
        updateBellBadge();
        // إعادة رسم الصفحة لتحديث الكارد
        renderNotificationsPage();
        if (currentAdminNotificationId === notifId) {
            openAdminNotificationDetail(notifId, true);
        }
    } finally {
        _btnSetLoading(btn, false);
    }
}

async function saveNotificationsToStorage() {
    try {
        await window.db.saveAdminNotifications(adminNotifications);
    } catch (e) {
        console.warn('saveNotificationsToStorage error:', e);
    }
}

function loadNotificationsFromStorage() {
    // No-op: adminNotifications مُحمَّل مسبقاً في loadAllData()
}

// ─── FCM Push Notifications ──────────────────────────────────────────────────
async function _saveFCMTokenForCurrentUser() {
    if (!window.flutter_inappwebview || !currentUser) return;
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            const token = await window.flutter_inappwebview.callHandler('getFCMToken');
            if (token) {
                const personId = currentUser.employeeId || currentUser.officerId || null;
                await window.db.saveFCMToken({ role: currentUser.role, token, personId });
                // FCM token saved
                return;
            }
        } catch(e) { console.warn('FCM token attempt', attempt + 1, 'error:', e); }
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    console.warn('⚠️ FCM token not available after 10 attempts');
}

async function refreshAdminNotifications() {
    try {
        const fresh = await window.db.getAdminNotifications();
        if (Array.isArray(fresh)) {
            adminNotifications = fresh;
            renderNotificationsPage();
            updateBellBadge();
        }
    } catch(e) { console.warn('refresh error:', e); }
}

function setupNotificationsPullToRefresh() {
    const page = document.getElementById('page-notifications');
    const indicator = document.getElementById('ptr-indicator');
    if (!page || !indicator || page._ptrSetup) return;
    page._ptrSetup = true;

    let startY = 0;
    let pulling = false;
    const THRESHOLD = 65;

    // نستمع على الـ window لأن التمرير يحدث على مستوى الصفحة الكاملة
    const onTouchStart = (e) => {
        if (window.scrollY === 0) {
            startY = e.touches[0].clientY;
            pulling = true;
        }
    };

    const onTouchMove = (e) => {
        if (!pulling) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 10) {
            indicator.style.display = 'flex';
            const rotate = Math.min(dy / THRESHOLD * 180, 360);
            const icon = document.getElementById('ptr-icon');
            if (icon) icon.style.transform = `rotate(${rotate}deg)`;
        }
    };

    const onTouchEnd = async (e) => {
        if (!pulling) return;
        pulling = false;
        const dy = e.changedTouches[0].clientY - startY;
        if (dy >= THRESHOLD) {
            const icon = document.getElementById('ptr-icon');
            if (icon) { icon.style.transition = 'transform 0.4s'; icon.style.transform = 'rotate(360deg)'; }
            await refreshAdminNotifications();
        }
        setTimeout(() => {
            indicator.style.display = 'none';
            const icon = document.getElementById('ptr-icon');
            if (icon) { icon.style.transition = ''; icon.style.transform = ''; }
        }, 300);
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove',  onTouchMove,  { passive: true });
    window.addEventListener('touchend',   onTouchEnd,   { passive: true });

    // تنظيف عند مغادرة الصفحة
    page._ptrCleanup = () => {
        window.removeEventListener('touchstart', onTouchStart);
        window.removeEventListener('touchmove',  onTouchMove);
        window.removeEventListener('touchend',   onTouchEnd);
        page._ptrSetup = false;
    };
}

function setupEmployeeNotificationsPullToRefresh() {
    _setupPullToRefresh('emp-scroll-notifications', 'emp-ptr-indicator', 'emp-ptr-icon', loadNotifications);
}

function setupOfficerNotificationsPullToRefresh() {
    _setupPullToRefresh('off-scroll-notifications', 'off-ptr-indicator', 'off-ptr-icon', loadOfficerNotifications);
}

async function _refreshEmployeeRequests() {
    const [lvs, , others] = await Promise.all([window.db.getLeaves(), loadPermissions(), window.db.getOtherRequests()]);
    if (lvs) leaves = lvs.map(l => ({ ...l, type: l.type || 'leave', status: normalizeApprovalStatus(l.status) }));
    if (others) otherRequests = others;
    loadEmployeeRequests();
}

async function _refreshOfficerRequests() {
    const [lvs, , others] = await Promise.all([window.db.getLeaves(), loadPermissions(), window.db.getOtherRequests()]);
    if (lvs) leaves = lvs.map(l => ({ ...l, type: l.type || 'leave', status: normalizeApprovalStatus(l.status) }));
    if (others) otherRequests = others;
    loadOfficerRequests();
}

function setupEmployeeRequestsPullToRefresh() {
    _setupPullToRefresh('emp-scroll-requests', 'emp-ptr-requests-indicator', 'emp-ptr-requests-icon', _refreshEmployeeRequests);
}

function setupOfficerRequestsPullToRefresh() {
    _setupPullToRefresh('off-scroll-requests', 'off-ptr-requests-indicator', 'off-ptr-requests-icon', _refreshOfficerRequests);
}

function _setupPullToRefresh(scrollId, indicatorId, iconId, refreshFn) {
    const scrollEl = document.getElementById(scrollId);
    const indicator = document.getElementById(indicatorId);
    if (!scrollEl || !indicator || scrollEl._ptrSetup) return;
    scrollEl._ptrSetup = true;

    let startY = 0;
    let pulling = false;
    const THRESHOLD = 65;

    scrollEl.addEventListener('touchstart', (e) => {
        if (scrollEl.scrollTop === 0) { startY = e.touches[0].clientY; pulling = true; }
    }, { passive: true });

    scrollEl.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const dy = e.touches[0].clientY - startY;
        if (dy > 10) {
            indicator.style.display = 'flex';
            const icon = document.getElementById(iconId);
            if (icon) icon.style.transform = `rotate(${Math.min(dy / THRESHOLD * 180, 360)}deg)`;
        }
    }, { passive: true });

    scrollEl.addEventListener('touchend', async (e) => {
        if (!pulling) return;
        pulling = false;
        const dy = e.changedTouches[0].clientY - startY;
        if (dy >= THRESHOLD) {
            const icon = document.getElementById(iconId);
            if (icon) { icon.style.transition = 'transform 0.4s'; icon.style.transform = 'rotate(360deg)'; }
            await refreshFn();
        }
        setTimeout(() => {
            indicator.style.display = 'none';
            const icon = document.getElementById(iconId);
            if (icon) { icon.style.transition = ''; icon.style.transform = ''; }
        }, 300);
    }, { passive: true });
}

async function sendAdminPushNotification({ title, body }) {
    try {
        await window.db.sendPushNotificationToAdmin({ title, body });
    } catch(e) { console.warn('Push notification error:', e); }
}

function renderNotificationsPage() {
    const container = document.getElementById('notifications-list');
    if (!container) return;

    if (adminNotifications.length === 0) {
        container.innerHTML = `
            <div class="notification-empty-state">
                <div class="notification-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>
                <div class="notification-empty-title">لا توجد إشعارات جديدة</div>
                <div class="notification-empty-subtitle">ستظهر هنا طلبات الموظفين والضباط</div>
            </div>`;
        return;
    }

    const typeIcon = t => t === 'leave'
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`
        : t === 'permission'
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

    const iconClass = t => t === 'leave' ? 'req-icon-leave' : t === 'permission' ? 'req-icon-permission' : 'req-icon-other';

    const statusCls = a => a === 'approve' ? 'emp-status-accepted' : a === 'reject' ? 'emp-status-rejected' : 'emp-status-pending';
    const statusLabel = a => a === 'approve' ? 'مقبول' : a === 'reject' ? 'مرفوض' : 'جديد';
    const dotColor = t => t === 'leave' ? '#16a34a' : t === 'permission' ? '#d97706' : '#2563eb';

    container.innerHTML = adminNotifications.map(n => {
        const cls = statusCls(n.actioned);
        const lbl = statusLabel(n.actioned);
        const isRead = !!n.actioned;
        return `<div class="req-item clickable" onclick="openAdminNotificationDetail(${n.id})" style="${isRead ? 'opacity:0.75;' : ''}">
            <div class="req-item-icon ${iconClass(n.type)}" style="color:${getAdminNotificationMeta(n.type).color};">
                ${typeIcon(n.type)}
            </div>
            <div class="req-item-body">
                <p class="req-item-title">${n.personName}</p>
                <p class="req-item-date">${getAdminNotificationMeta(n.type).label} — ${n.requestType}</p>
                <p style="font-size:12px;color:#7a8797;margin-top:2px;">${n.date}</p>
            </div>
            <div class="req-item-right">
                <span class="emp-status ${cls}">${lbl}</span>
                ${!isRead ? `<span style="width:8px;height:8px;border-radius:50%;background:${dotColor(n.type)};display:inline-block;"></span>` : ''}
            </div>
        </div>`;
    }).join('');
}





function getEmployees() {
    return employees;
}

function getOfficers() {
    return officers;
}

function getLeaves() {
    return leaves;
}

function getPermissions() {
    return leavePermissions;
}

function getArchive() {
    return archiveFiles;
}

function addLeave(leave) {
    leaves.push(leave);
    return leaves;
}

function addPermission(permission) {
    leavePermissions.push(permission);
    return leavePermissions;
}

function addArchive(item) {
    archiveFiles.push(item);
    return archiveFiles;
}

function normalizeApprovalStatus(status) {
    return status === 'approved' || status === 'rejected' || status === 'pending'
        ? status
        : 'pending';
}

function getApprovalStatusMeta(status) {
    const normalized = normalizeApprovalStatus(status);
    if (normalized === 'approved') {
        return { key: 'approved', label: 'مقبول', className: 'emp-status-accepted', color: '#127a3e' };
    }
    if (normalized === 'rejected') {
        return { key: 'rejected', label: 'مرفوض', className: 'emp-status-rejected', color: '#b42318' };
    }
    return { key: 'pending', label: 'قيد المراجعة', className: 'emp-status-pending', color: '#b06200' };
}

function renderApprovalButtons(kind, id) {
    return `<div style="display:flex;gap:6px;margin-top:8px;">
        <button type="button" class="btn" onclick="event.stopPropagation();approve${kind}(${id})" style="padding:4px 10px;font-size:12px;border-radius:8px;background:#16a34a;color:white;border:none;">✔ موافقة</button>
        <button type="button" class="btn" onclick="event.stopPropagation();reject${kind}(${id})" style="padding:4px 10px;font-size:12px;border-radius:8px;background:#dc2626;color:white;border:none;">❌ رفض</button>
    </div>`;
}

function isApprovedAndNonAdmin(status) {
    return normalizeApprovalStatus(status) === 'approved' && currentUser && currentUser.role !== 'admin';
}

async function approveLeave(id) {
    // اجلب الإجازة من القاعدة إذا لم تكن موجودة في الذاكرة
    let leave = leaves.find(l => l.id === id);
    if (!leave) {
        const fresh = await window.db.getLeaves();
        if (Array.isArray(fresh)) {
            leaves = fresh.map(l => ({ ...l, type: l.type || 'leave', status: normalizeApprovalStatus(l.status) }));
            leave = leaves.find(l => l.id === id);
        }
    }
    if (!leave) { showToast('لم يتم العثور على الإجازة', 'error'); return; }
    const upRes = await window.db.updateLeave(id, {
        leave_type: leave.leave_type,
        start_date: leave.start_date,
        end_date: leave.end_date,
        return_date: leave.return_date || null,
        days: leave.days || 0,
        status: 'approved',
        notes: leave.notes || null,
        type: 'leave'
    });
    if (upRes && upRes.success === false) { showToast('فشل حفظ الموافقة: ' + (extractErrorMessage(upRes) || 'أعد المحاولة'), 'error'); return; }
    leave.status = 'approved';
    logAudit('approve_leave', 'leave', leave.id, { person_id: leave.person_id, person_type: leave.person_type, details: { leave_type: leave.leave_type, start_date: leave.start_date, end_date: leave.end_date, days: leave.days } });
    
    // Send notification to employee or officer
    if (leave.person_id) {
        const notifData = {
            person_id: leave.person_id,
            title: 'تمت الموافقة على الإجازة',
            message: `تمت الموافقة على طلب ${leave.leave_type || 'الإجازة'} من ${leave.start_date} إلى ${leave.end_date}`,
            type: 'leave',
            status: 'approved'
        };
        await window.db.addNotification(notifData);
        window.db.sendPushNotificationToPerson({ title: 'تمت الموافقة على الإجازة ✅', body: `طلب ${leave.leave_type || 'الإجازة'} من ${leave.start_date} إلى ${leave.end_date}`, personId: leave.person_id });
        triggerNotificationEffects();
    }
    
    // تحديث كل البيانات وإعادة عرض كل القوائم ذات الصلة
    await loadAllData();
    refreshAllRoleScreens();
    showToast('تمت الموافقة على الإجازة ✅', 'success');
}

async function rejectLeave(id) {
    let leave = leaves.find(l => l.id === id);
    if (!leave) {
        const fresh = await window.db.getLeaves();
        if (Array.isArray(fresh)) {
            leaves = fresh.map(l => ({ ...l, type: l.type || 'leave', status: normalizeApprovalStatus(l.status) }));
            leave = leaves.find(l => l.id === id);
        }
    }
    if (!leave) { showToast('لم يتم العثور على الإجازة', 'error'); return; }
    const upRes = await window.db.updateLeave(id, {
        leave_type: leave.leave_type,
        start_date: leave.start_date,
        end_date: leave.end_date,
        return_date: leave.return_date || null,
        days: leave.days || 0,
        status: 'rejected',
        notes: leave.notes || null,
        type: 'leave'
    });
    if (upRes && upRes.success === false) { showToast('فشل حفظ الرفض: ' + (extractErrorMessage(upRes) || 'أعد المحاولة'), 'error'); return; }
    leave.status = 'rejected';
    logAudit('reject_leave', 'leave', leave.id, { person_id: leave.person_id, person_type: leave.person_type, details: { leave_type: leave.leave_type, start_date: leave.start_date, end_date: leave.end_date } });
    
    // Send notification to employee or officer
    if (leave.person_id) {
        const notifData = {
            person_id: leave.person_id,
            title: 'تم رفض الإجازة',
            message: `تم رفض طلب ${leave.leave_type || 'الإجازة'} من ${leave.start_date} إلى ${leave.end_date}`,
            type: 'leave',
            status: 'rejected'
        };
        await window.db.addNotification(notifData);
        window.db.sendPushNotificationToPerson({ title: 'تم رفض الإجازة ❌', body: `طلب ${leave.leave_type || 'الإجازة'} من ${leave.start_date} إلى ${leave.end_date}`, personId: leave.person_id });
        triggerNotificationEffects();
    }
    
    await loadAllData();
    refreshAllRoleScreens();
    showToast('تم رفض الإجازة', 'error');
}

async function approvePermission(id) {
    let permission = leavePermissions.find(p => p.id === id);
    if (!permission) {
        const fresh = await window.db.getLeavePermissions();
        if (Array.isArray(fresh)) {
            leavePermissions = fresh;
            permission = leavePermissions.find(p => p.id === id);
        }
    }
    if (!permission) { showToast('لم يتم العثور على الاستئذان', 'error'); return; }
    const result = await window.db.updateLeavePermission(id, {
        date: permission.date,
        type: permission.type,
        notes: permission.notes || '',
        status: 'approved',
        request_type: 'permission'
    });
    if (result && (result.error || result.success === false)) {
        showToast('فشل حفظ الموافقة: ' + (extractErrorMessage(result) || 'أعد المحاولة'), 'error');
        return;
    }
    permission.status = 'approved';
    logAudit('approve_permission', 'permission', permission.id, { person_id: permission.person_id, person_type: permission.person_type, details: { date: permission.date, type: permission.type } });
    
    // Send notification to employee
    const personId = permission.person_id != null ? permission.person_id : permission.employee_id;
    if (personId) {
        const notifData = {
            person_id: personId,
            title: 'تمت الموافقة على الاستئذان',
            message: `تمت الموافقة على استئذان ${permission.type || ''} بتاريخ ${permission.date}`,
            type: 'permission',
            status: 'approved'
        };
        await window.db.addNotification(notifData);
        window.db.sendPushNotificationToPerson({ title: 'تمت الموافقة على الاستئذان ✅', body: `استئذان ${permission.type || ''} بتاريخ ${permission.date}`, personId });
        triggerNotificationEffects();
    }
    
    await loadAllData();
    refreshAllRoleScreens();
    showToast('تمت الموافقة على الاستئذان ✅', 'success');
}

async function rejectPermission(id) {
    let permission = leavePermissions.find(p => p.id === id);
    if (!permission) {
        const fresh = await window.db.getLeavePermissions();
        if (Array.isArray(fresh)) {
            leavePermissions = fresh;
            permission = leavePermissions.find(p => p.id === id);
        }
    }
    if (!permission) { showToast('لم يتم العثور على الاستئذان', 'error'); return; }
    const result = await window.db.updateLeavePermission(id, {
        date: permission.date,
        type: permission.type,
        notes: permission.notes || '',
        status: 'rejected',
        request_type: 'permission'
    });
    if (result && (result.error || result.success === false)) {
        showToast('فشل حفظ الرفض: ' + (extractErrorMessage(result) || 'أعد المحاولة'), 'error');
        return;
    }
    permission.status = 'rejected';
    logAudit('reject_permission', 'permission', permission.id, { person_id: permission.person_id, person_type: permission.person_type, details: { date: permission.date, type: permission.type } });
    
    // Send notification to employee
    const personId = permission.person_id != null ? permission.person_id : permission.employee_id;
    if (personId) {
        const notifData = {
            person_id: personId,
            title: 'تم رفض الاستئذان',
            message: `تم رفض استئذان ${permission.type || ''} بتاريخ ${permission.date}`,
            type: 'permission',
            status: 'rejected'
        };
        await window.db.addNotification(notifData);
        window.db.sendPushNotificationToPerson({ title: 'تم رفض الاستئذان ❌', body: `استئذان ${permission.type || ''} بتاريخ ${permission.date}`, personId });
        triggerNotificationEffects();
    }
    
    await loadAllData();
    refreshAllRoleScreens();
    showToast('تم رفض الاستئذان', 'error');
}

// ═══════════════════════════════════════
// نظام تسجيل دخول مؤقت للاختبار (بدون حفظ)
// ═══════════════════════════════════════
let currentUser = null;

const STATS_ALLOWED_PAGES = new Set(['statistics']);

function setRootViews({ login, admin, employee, officer }) {
    const loginScreen = document.getElementById('login-screen');
    const appMain = document.getElementById('app-main-content');
    const bottomNav = document.getElementById('bottomNav');
    const employeeApp = document.getElementById('employee-app');
    const officerApp = document.getElementById('officer-app');

    if (loginScreen) loginScreen.style.display = login ? 'flex' : 'none';
    if (appMain) appMain.style.display = admin ? 'block' : 'none';
    if (bottomNav) bottomNav.style.display = admin ? 'flex' : 'none';
    if (employeeApp) employeeApp.style.display = employee ? 'flex' : 'none';
    if (officerApp) officerApp.style.display = officer ? 'flex' : 'none';
}

function employeeNavigate(page) {
    // ── Teleport: أعد صفحة الإحصائيات إلى مكانها الأصلي عند المغادرة
    if (page !== 'statistics') {
        const statsPage = document.getElementById('page-statistics');
        const anchor    = document.getElementById('page-statistics-anchor');
        const shell     = document.getElementById('emp-page-statistics');
        if (statsPage && anchor && shell && shell.contains(statsPage)) {
            anchor.parentNode.insertBefore(statsPage, anchor.nextSibling);
            statsPage.classList.remove('active');
        }
    }

    document.querySelectorAll('[id^="emp-page-"]').forEach(el => el.style.display = 'none');
    const target = document.getElementById('emp-page-' + page);
    if (target) target.style.display = 'block';

    document.querySelectorAll('.emp-tab').forEach(tab => tab.classList.remove('active'));
    const activeTab = document.querySelector(`.emp-tab[data-emp-tab="${page}"]`);
    if (activeTab) activeTab.classList.add('active');

    // ── Teleport: انقل صفحة الإحصائيات داخل employee app
    if (page === 'statistics') {
        const statsPage = document.getElementById('page-statistics');
        const shell     = document.getElementById('emp-page-statistics');
        if (statsPage && shell && !shell.contains(statsPage)) {
            shell.appendChild(statsPage);
        }
        if (statsPage) {
            statsPage.classList.add('active');
            statsPage.style.display = 'block';
        }
        initStatisticsPage();
    }

    if (page === 'dashboard') {
        Promise.all([window.db.getLeaves(), loadPermissions()]).then(([lvs]) => {
            if (lvs) leaves = lvs.map(l => ({ ...l, type: l.type || 'leave', status: normalizeApprovalStatus(l.status) }));
            loadEmployeeDashboard();
        });
    }

    if (page === 'archive') {
        loadEmployeeArchive(); // async
    }

    if (page === 'requests') {
        Promise.all([window.db.getLeaves(), loadPermissions(), window.db.getOtherRequests()]).then(([lvs, , others]) => {
            if (lvs) leaves = lvs.map(l => ({ ...l, type: l.type || 'leave', status: normalizeApprovalStatus(l.status) }));
            if (others) otherRequests = others;
            loadEmployeeRequests();
        });
        setupEmployeeRequestsPullToRefresh();
    }

    if (page === 'notifications') {
        loadNotifications();
        setupEmployeeNotificationsPullToRefresh();
    }

    // Update notification badge
    loadNotifications();
}

function setupEmployeeUI() {
    const userLabel = document.getElementById('employee-app-user');
    const statsButton = document.getElementById('btn-stats');
    const statsTab = document.getElementById('emp-tab-stats');
    if (userLabel) userLabel.textContent = currentUser ? `Welcome, ${currentUser.username}` : 'Welcome';
    if (statsButton) statsButton.style.display = currentUser?.role === 'stats' ? 'block' : 'none';
    if (statsTab) statsTab.style.display = currentUser?.role === 'stats' ? 'flex' : 'none';
}

function loadEmployeeDashboard() {
    const user = currentUser;
    if (!user) return;

    const emp = getEmployees().find(e => e.id == user.employeeId);
    if (!emp) return;

    const myLeaves = getLeaves().filter(l => l.person_type === 'employee' && l.person_id == emp.id && normalizeApprovalStatus(l.status) !== 'rejected');

    const now = new Date();
    const myPermissions = getPermissions().filter(p => {
        const personId = p.person_id != null ? p.person_id : p.employee_id;
        const d = new Date(p.date);
        return personId == emp.id &&
               d.getMonth() === now.getMonth() &&
               d.getFullYear() === now.getFullYear();
    });

    // رصيد الاستئذانات الشهري — المقبول فقط يُحسب، المعلق والمرفوض لا يُحجزان رصيداً
    const permTotal     = 4;
    const activePerms   = myPermissions.filter(p => normalizeApprovalStatus(p.status) === 'approved');
    const permUsed      = Math.min(activePerms.length, permTotal);
    const permRemaining = Math.max(permTotal - permUsed, 0);
    const permPercent   = (permUsed / permTotal) * 100;
    const permColor     = permRemaining >= 3 ? '#22c55e' : permRemaining === 2 ? '#f59e0b' : '#ef4444';

    const permBarEl  = document.getElementById('perm-bar');
    const permTextEl = document.getElementById('perm-text');
    if (permBarEl)  { permBarEl.style.width = permPercent + '%'; permBarEl.style.background = permColor; }
    if (permTextEl) permTextEl.textContent = `متبقي ${permRemaining} من ${permTotal}`;

    // بيانات الموظف
    const nameEl = document.getElementById('emp-name');
    const jobEl  = document.getElementById('emp-job');
    const idEl   = document.getElementById('emp-id');
    if (nameEl) nameEl.textContent = emp.name || '';
    if (jobEl)  jobEl.textContent  = emp.job || emp.department || '';
    if (idEl)   idEl.textContent   = 'الرقم المدني: ' + (emp.number || '-');

    // حالة الإجازة
    const statusEl = document.getElementById('leave-status');
    if (statusEl) {
        const card = statusEl.closest('.emp-leave-card');
        const subEl = card ? card.querySelector('.emp-leave-content p:nth-child(2)') : null;
        const iconEl = card ? card.querySelector('.emp-leave-icon') : null;
        const activeLeave = myLeaves.find(l => getLeaveStatus(l) === 'جارية' && normalizeApprovalStatus(l.status) === 'approved');
        if (activeLeave) {
            statusEl.textContent = 'إجازة سارية حالياً';
            if (subEl) subEl.textContent = `${activeLeave.leave_type || 'إجازة'} • ${activeLeave.start_date} → ${activeLeave.end_date}`;
            if (iconEl) iconEl.textContent = '🌴';
            if (card) {
                card.style.cursor = 'pointer';
                card.onclick = () => showLeaveDetails(activeLeave.id);
            }
        } else {
            statusEl.textContent = 'لا توجد إجازة نشطة';
            if (subEl) subEl.textContent = 'أنت على رأس العمل حالياً';
            if (iconEl) iconEl.textContent = '✓';
            if (card) { card.style.cursor = ''; card.onclick = null; }
        }
    }

    // آخر الطلبات (إجازات + استئذانات + طلبات أخرى - الشهر الحالي فقط، تتجدد كل بداية شهر)
    const currentYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const allMyPermissions = getPermissions().filter(p => {
        const personId = p.person_id != null ? p.person_id : p.employee_id;
        return personId == emp.id && normalizeApprovalStatus(p.status) === 'approved';
    });
    const allMyOther = otherRequests.filter(r => r.person_id == emp.id && normalizeApprovalStatus(r.status) === 'approved');
    const lastRequests = [
        ...myLeaves.map(l => ({
            type: 'leave',
            title: l.leave_type || 'إجازة',
            date: l.start_date || l.date || '',
            status: normalizeApprovalStatus(l.status)
        })),
        ...allMyPermissions.map(p => ({
            type: 'permission',
            title: p.type === 'start' ? 'استئذان بداية دوام' : 'استئذان نهاية دوام',
            date: p.date || '',
            status: normalizeApprovalStatus(p.status)
        })),
        ...allMyOther.map(r => ({
            type: 'other',
            title: r.type || 'طلب آخر',
            date: r.date ? r.date.slice(0, 10) : '',
            status: normalizeApprovalStatus(r.status)
        }))
    ]
        .filter(r => r.date && r.date.startsWith(currentYearMonth))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .slice(0, 3);

    const requestsEl = document.getElementById('my-requests');
    if (requestsEl) {
        if (lastRequests.length === 0) {
            requestsEl.innerHTML = '<div class="req-empty">لا توجد طلبات هذا الشهر</div>';
        } else {
            requestsEl.innerHTML = lastRequests.map(r => {
                const statusMeta = getApprovalStatusMeta(r.status);
                const icon = r.type === 'leave' ? '🗓️' : r.type === 'permission' ? '⏱' : '📄';
                const iconClass = r.type === 'leave' ? 'req-icon-leave' : r.type === 'permission' ? 'req-icon-permission' : 'req-icon-other';
                return `<div class="req-item">
                    <div class="req-item-icon ${iconClass}">${icon}</div>
                    <div class="req-item-body">
                        <p class="req-item-title">${r.title || ''}</p>
                        <p class="req-item-date">${r.date || ''}</p>
                    </div>
                    <div class="req-item-right">
                        <span class="emp-status ${statusMeta.className}">${statusMeta.label}</span>
                    </div>
                </div>`;
            }).join('');
        }
    }
}

async function loadEmployeeArchive() {
    const user = currentUser;
    if (!user) return;

    const emp = getEmployees().find(e => e.id == user.employeeId);
    if (!emp) return;

    const listEl = document.getElementById('emp-archive-list');
    if (!listEl) return;

    listEl.innerHTML = '<p style="color:#8e8e93;text-align:center;font-size:14px;">جارٍ التحميل...</p>';

    currentEmpArchive = await window.db.archiveGetByEmployee(emp.id) || [];

    // تحديث كروت التصنيف
    const setS = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setS('emp-arch-stat-total', currentEmpArchive.length);
    setS('emp-arch-stat-leave',  currentEmpArchive.filter(f => f.type === 'leave').length);
    setS('emp-arch-stat-perm',   currentEmpArchive.filter(f => f.type === 'permission').length);
    setS('emp-arch-stat-doc',    currentEmpArchive.filter(f => f.type === 'document').length);

    // إعادة ضبط الفلتر للكل عند التحميل
    const sel = document.getElementById('emp-arch-type-filter');
    if (sel) sel.value = '';
    document.querySelectorAll('.filter-pills[data-target="emp-arch-type-filter"] .filter-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.value === '');
    });

    // تحميل لوحة التحكم
    switchEmpArchiveTab('dashboard');
    renderEmpArchiveTypeCards();
    renderEmployeeArchiveList();
}

function switchEmpArchiveTab(tab) {
    ['dashboard','all'].forEach(t => {
        const panel = document.getElementById('emp-arch-panel-' + t);
        const btn   = document.getElementById('emp-arch-tab-' + t);
        if (panel) panel.style.display = t === tab ? '' : 'none';
        if (btn)   btn.className = 'archive-tab' + (t === tab ? ' active' : '');
    });
}

function filterByCustomTypeEmp(key) {
    switchEmpArchiveTab('all');
    const sel = document.getElementById('emp-arch-type-filter');
    if (sel) sel.value = key;
    document.querySelectorAll('.filter-pills[data-target="emp-arch-type-filter"] .filter-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.value === key);
    });
    renderEmployeeArchiveList();
}

function renderEmpArchiveTypeCards() {
    const grid = document.getElementById('emp-arch-types-grid');
    if (!grid) return;

    const allTypes = [
        ...defaultArchiveTypes,
        ...customArchiveTypes
    ];

    const cards = allTypes.map(t => {
        const count = currentEmpArchive.filter(f => f.type === t.key).length;
        return `<div class="archive-quick-card" onclick="filterByCustomTypeEmp('${t.key}')" style="border-top:3px solid ${t.color};">
            <h4 class="archive-quick-title">${t.name}</h4>
            <p class="archive-quick-desc">${t.desc || ''}</p>
            <span class="archive-quick-btn" style="color:${t.btnColor||t.color};">${count} ملف ←</span>
        </div>`;
    }).join('');

    grid.innerHTML = cards || '<div class="arch-list-empty">لا توجد أنواع</div>';
}

function renderEmployeeArchiveList() {
    const listEl = document.getElementById('emp-archive-list');
    if (!listEl) return;

    const typeFilter = (document.getElementById('emp-arch-type-filter')?.value) || '';
    const search = (document.getElementById('emp-arch-search')?.value || '').toLowerCase();
    let filtered = typeFilter ? currentEmpArchive.filter(f => f.type === typeFilter) : currentEmpArchive;
    if (search) filtered = filtered.filter(f => (f.file_name || '').toLowerCase().includes(search) || (f.notes || '').toLowerCase().includes(search));

    if (filtered.length === 0) {
        listEl.innerHTML = '<div class="arch-list-empty">لا توجد ملفات</div>';
        return;
    }

    listEl.innerHTML = filtered.map(f => `<div class="arch-file-item">
            <div class="arch-file-info">
                <div class="arch-file-name">${typeof getFileIcon === 'function' ? getFileIcon(f.file_type) : '📄'} ${f.file_name || 'ملف'}</div>
                <div class="arch-file-meta">
                    ${getArchiveTypeBadge(f.type)}
                    <span>${(f.date || f.created_at || '').slice(0, 10) || '-'}</span>
                    ${f.file_size ? `<span>${f.file_size}</span>` : ''}
                    ${f.notes ? `<span>📌 ${f.notes}</span>` : ''}
                </div>
            </div>
            <div class="arch-file-actions">
                <button class="arch-soft-btn arch-btn-view" onclick="viewArchiveFile(${f.id})">👁 عرض</button>
                <button class="arch-soft-btn arch-btn-download" onclick="downloadArchiveFile(${f.id})">⬇️ تحميل</button>
            </div>
        </div>`).join('');
}

function loadEmployeeRequests() {
    const user = currentUser;
    if (!user) return;

    const emp = getEmployees().find(e => e.id == user.employeeId);
    if (!emp) return;

    const listEl = document.getElementById('emp-requests-list');
    if (!listEl) return;

    const myLeaves = getLeaves()
        .filter(l => l.person_id == emp.id)
        .map(l => ({
            id: l.id,
            requestType: 'leave',
            title: l.leave_type || 'إجازة',
            subtitle: `${l.start_date || ''}${l.end_date ? ' ← ' + l.end_date : ''}`,
            date: l.start_date || l.date || '',
            status: normalizeApprovalStatus(l.status)
        }));

    const myPermissions = getPermissions()
        .filter(p => {
            const personId = p.person_id != null ? p.person_id : p.employee_id;
            return personId == emp.id;
        })
        .map(p => ({
            id: p.id,
            requestType: 'permission',
            title: p.type === 'start' ? 'استئذان بداية دوام' : 'استئذان نهاية دوام',
            subtitle: p.notes || 'بدون ملاحظات',
            date: p.date || '',
            status: normalizeApprovalStatus(p.status)
        }));

    const myOtherRequests = otherRequests
        .filter(r => r.person_id == emp.id)
        .map(r => ({
            id: r.id,
            requestType: 'other',
            title: r.type || 'طلب آخر',
            subtitle: r.description || '',
            date: r.date ? r.date.slice(0, 10) : '',
            status: normalizeApprovalStatus(r.status)
        }));

    const allRequests = [...myLeaves, ...myPermissions, ...myOtherRequests]
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    if (allRequests.length === 0) {
        listEl.innerHTML = '<p style="color:#8e8e93;text-align:center;font-size:14px;">لا توجد طلبات</p>';
        return;
    }

    listEl.innerHTML = allRequests.map(req => {
        const statusMeta = getApprovalStatusMeta(req.status);
        const icon = req.requestType === 'leave' ? '🗓' : req.requestType === 'permission' ? '⏱' : '📄';
        const isLocked = req.requestType !== 'other' && isApprovedAndNonAdmin(req.status);
        const cardClick = req.requestType === 'leave'
            ? `onclick="showLeaveDetails(${req.id})"`
            : req.requestType === 'permission'
            ? `onclick="editPermission(${req.id})"`
            : '';
        const typeBadge = req.requestType === 'leave' ? 'arch-file-type-leave' : req.requestType === 'permission' ? 'arch-file-type-permission' : 'arch-file-type-other';
        const typeLabel = req.requestType === 'leave' ? 'إجازة' : req.requestType === 'permission' ? 'استئذان' : 'طلب آخر';
        return `<div class="arch-file-item" ${cardClick} style="cursor:${cardClick ? 'pointer' : 'default'};">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                <div class="arch-file-info">
                    <div class="arch-file-name">${icon} ${req.title}</div>
                    <div class="arch-file-meta">
                        <span class="arch-file-type ${typeBadge}">${typeLabel}</span>
                        <span>${req.date}</span>
                        ${req.subtitle ? `<span>${req.subtitle}</span>` : ''}
                    </div>
                </div>
                <div class="arch-file-actions" style="flex-direction:column;align-items:flex-end;gap:4px;">
                    <span class="emp-status ${statusMeta.className}">${statusMeta.label}</span>
                    ${!isLocked && req.requestType !== 'other' ? `<button class="arch-soft-btn arch-btn-delete" onclick="event.stopPropagation();${req.requestType === 'leave' ? `empDeleteLeave(${req.id})` : `empDeletePermission(${req.id})`}">🗑 حذف</button>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
}

async function empDeleteLeave(id) {
    const leave = getLeaves().find(l => l.id == id);
    if (leave && isApprovedAndNonAdmin(leave.status)) {
        showToast('لا يمكن حذف الإجازة بعد الموافقة عليها من الأدمن', 'error');
        return;
    }
    if (!confirm('هل تريد حذف هذه الإجازة؟')) return;
    await window.db.deleteLeave(id);
    await loadAllData();
    loadEmployeeRequests();
    loadEmployeeDashboard();
    showToast('تم حذف الإجازة 🗑️', 'warning');
}

async function empDeletePermission(id) {
    const perm = getPermissions().find(p => p.id == id);
    if (perm && isApprovedAndNonAdmin(perm.status)) {
        showToast('لا يمكن حذف الاستئذان بعد الموافقة عليه من الأدمن', 'error');
        return;
    }
    if (!confirm('هل تريد حذف هذا الاستئذان؟')) return;
    const result = await window.db.deleteLeavePermission(id);
    if (result && result.error) { showToast(result.error, 'error'); return; }
    await loadAllData();
    loadEmployeeRequests();
    loadEmployeeDashboard();
    showToast('تم حذف الاستئذان 🗑️', 'warning');
}

// ═══════════════════════════════════════
// Notification System Enhancement
// ═══════════════════════════════════════

// Notification sound - uses device native sound via Flutter

function getUnreadNotificationCount() {
    if (!currentUser) return 0;
    return notificationsCache.filter(n =>
        (n.person_id == currentUser.employeeId || n.person_id === 'all') &&
        !(n.read_by && n.read_by.includes(String(currentUser.employeeId)))
    ).length;
}

function updateNotificationBadge() {
    const count = getUnreadNotificationCount();
    const badgeEl = document.getElementById('emp-notif-badge');
    
    if (!badgeEl) return;
    
    if (count > 0) {
        badgeEl.textContent = count > 9 ? '9+' : count;
        badgeEl.style.display = 'block';
    } else {
        badgeEl.style.display = 'none';
    }
}

function playNotificationSound() {
    try {
        if (window.flutter_inappwebview) {
            window.flutter_inappwebview.callHandler('playSystemSound');
        }
    } catch (e) {
        // Silently fail
    }
}

function animateNotificationBell() {
    const bellTab = document.querySelector('.emp-tab[data-emp-tab="notifications"]');
    if (!bellTab) return;
    
    bellTab.classList.add('notif-animate');
    
    setTimeout(() => {
        bellTab.classList.remove('notif-animate');
    }, 500);
}

function showNotificationToast(notification) {
    const container = document.getElementById('notification-toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'notification-toast';
    
    // Add status class for colors
    if (notification.status === 'approved') {
        toast.classList.add('approved');
    } else if (notification.status === 'rejected') {
        toast.classList.add('rejected');
    } else {
        toast.classList.add('info');
    }

    // Icon based on status
    const statusIcons = {
        approved: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        rejected:  `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        info:      `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`
    };
    const icon = statusIcons[notification.status] || statusIcons.info;

    toast.innerHTML = `
        <div class="notification-toast-icon">${icon}</div>
        <div class="notification-toast-content">
            <div class="notification-toast-title">${notification.title}</div>
            <div class="notification-toast-message">${notification.message}</div>
        </div>
    `;

    // Click to open notifications page
    toast.onclick = () => {
        if (typeof employeeNavigate === 'function') {
            employeeNavigate('notifications');
        }
        toast.style.animation = 'toastSlideOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    };

    container.appendChild(toast);

    // Auto remove after 4 seconds
    setTimeout(() => {
        toast.style.animation = 'toastSlideOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function triggerNotificationEffects() {
    updateNotificationBadge();
    playNotificationSound();
    animateNotificationBell();
}

function timeAgo(date) {
    const seconds = Math.floor((new Date() - new Date(date)) / 1000);

    if (seconds < 60) return 'الآن';
    if (seconds < 3600) {
        const minutes = Math.floor(seconds / 60);
        return minutes === 1 ? 'منذ دقيقة' : `منذ ${minutes} دقيقة`;
    }
    if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        return hours === 1 ? 'منذ ساعة' : `منذ ${hours} ساعة`;
    }

    const days = Math.floor(seconds / 86400);
    return days === 1 ? 'منذ يوم' : `منذ ${days} يوم`;
}

async function loadNotifications() {
    const user = currentUser;
    if (!user) return;

    const listEl = document.getElementById('notification-list');
    if (!listEl) return;

    notificationsCache = await window.db.getNotifications();
    const allNotifications = notificationsCache;
    const myNotifications = allNotifications.filter(n =>
        n.person_id == user.employeeId || n.person_id === 'all'
    ).sort((a, b) => new Date(b.date) - new Date(a.date));

    // Update badge using the new function
    updateNotificationBadge();

    if (myNotifications.length === 0) {
        listEl.innerHTML = `
            <div class="notification-empty-state">
                <div class="notification-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>
                <div class="notification-empty-title">لا توجد إشعارات جديدة</div>
                <div class="notification-empty-subtitle">ستظهر هنا إشعارات طلباتك</div>
            </div>`;
        return;
    }

    const statusColor = s => s === 'approved' ? '#16a34a' : s === 'rejected' ? '#dc2626' : '#2563eb';
    const statusBg = s => s === 'approved' ? '#dcfce7' : s === 'rejected' ? '#fee2e2' : '#dbeafe';
    const statusCardBg = s => s === 'approved' ? '#f0fdf4' : s === 'rejected' ? '#fff5f5' : '#eff6ff';
    const statusIcon = s => s === 'approved'
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
        : s === 'rejected'
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    const statusLabel = s => s === 'approved' ? 'موافقة' : s === 'rejected' ? 'مرفوض' : 'معلومة';

    listEl.innerHTML = myNotifications.map(n => {
        const color = statusColor(n.status);
        const bg = statusBg(n.status);
        const icon = statusIcon(n.status);
        const label = statusLabel(n.status);
        const isRead = n.read_by && n.read_by.includes(String(user.employeeId));
        const dateText = timeAgo(n.date);
        const iconClass = n.status === 'approved' ? 'req-icon-leave' : n.status === 'rejected' ? '' : 'req-icon-other';
        const iconStyle = n.status === 'rejected' ? `background:rgba(220,38,38,0.12);` : '';
        const statusCls = n.status === 'approved' ? 'emp-status-accepted' : n.status === 'rejected' ? 'emp-status-rejected' : 'emp-status-info';

        return `<div class="req-item clickable${!isRead ? ' unread' : ''}" onclick="openNotificationDetail(${n.id})">
            <div class="req-item-icon ${iconClass}" style="${iconStyle}">${icon}</div>
            <div class="req-item-body">
                <p class="req-item-title">${n.title}</p>
                <p class="req-item-date">${dateText}</p>
                ${n.message ? `<p style="font-size:12px;color:#7a8797;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${n.message}</p>` : ''}
            </div>
            <div class="req-item-right">
                <span class="emp-status ${statusCls}">${label}</span>
                ${!isRead ? `<span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;box-shadow:0 0 0 3px ${color}22;"></span>` : '<span style="width:10px;height:10px;"></span>'}
            </div>
            <span class="req-item-arrow">&#x2039;</span>
        </div>`;
    }).join('');
}

function markNotificationRead(id) {
    if (currentUser && currentUser.employeeId) {
        window.db.markNotificationAsRead(id, currentUser.employeeId);
    }
    setTimeout(async () => {
        notificationsCache = await window.db.getNotifications();
        updateNotificationBadge();
        await loadNotifications();
    }, 50);
}

async function markAllNotificationsRead() {
    if (!currentUser) return;
    await window.db.markAllNotificationsAsRead(currentUser.employeeId);
    notificationsCache = await window.db.getNotifications();
    setTimeout(() => {
        updateNotificationBadge();
        loadNotifications();
    }, 50);
    showToast('تم تحديد جميع الإشعارات كمقروءة ✓', 'success');
}

// ═══════════════════════════════════════
// Notification Detail Modal
// ═══════════════════════════════════════

let currentNotificationId = null;

async function openNotificationDetail(id) {
    const allNotifications = notificationsCache;
    const notification = allNotifications.find(n => n.id === id);
    if (!notification) return;
    currentNotificationId = id;

    const modal      = document.getElementById('notification-detail-modal');
    const headerEl   = document.getElementById('notif-detail-header');
    const iconWrapEl = document.getElementById('notif-detail-icon-wrap');
    const iconEl     = document.getElementById('notif-detail-icon');
    const subtitleEl = document.getElementById('notif-detail-subtitle');
    const badgeEl    = document.getElementById('notif-detail-status-badge');
    const messageEl  = document.getElementById('notif-detail-message');
    const dateEl     = document.getElementById('notif-detail-date');

    const gradients = {
        approved: 'linear-gradient(135deg,#16a34a,#22c55e)',
        rejected:  'linear-gradient(135deg,#dc2626,#f87171)',
        info:      'linear-gradient(135deg,#1D5FA7,#2C7BCC)'
    };
    const iconBgs = {
        approved: 'rgba(255,255,255,0.22)',
        rejected:  'rgba(255,255,255,0.22)',
        info:      'rgba(255,255,255,0.22)'
    };
    const icons   = {
        approved: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
        rejected:  `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
        info:      `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`
    };
    const labels  = { approved: 'موافقة', rejected: 'مرفوض', info: 'معلومة' };

    const s = notification.status || 'info';
    if (headerEl)   headerEl.style.background   = gradients[s] || gradients.info;
    if (iconWrapEl) iconWrapEl.style.background = iconBgs[s] || iconBgs.info;
    if (iconEl)     iconEl.innerHTML             = icons[s]   || icons.info;
    if (subtitleEl) subtitleEl.textContent       = notification.title || '';
    if (badgeEl)    badgeEl.textContent          = labels[s]  || '';
    if (messageEl)  messageEl.textContent        = notification.message || '';

    if (dateEl) {
        dateEl.textContent = new Date(notification.date).toLocaleString('ar-EG', {
            year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'
        });
    }

    // Mark as read
    if (currentUser && currentUser.employeeId) {
        await window.db.markNotificationAsRead(id, currentUser.employeeId);
        notificationsCache = await window.db.getNotifications();
        updateNotificationBadge();
        loadNotifications();
    } else if (currentUser && currentUser.officerId) {
        await window.db.markNotificationAsRead(id, currentUser.officerId);
        notificationsCache = await window.db.getNotifications();
        updateOfficerNotificationBadge();
        loadOfficerNotifications();
    }

    if (modal) modal.style.display = 'flex';
}

function closeNotificationDetail() {
    const modal = document.getElementById('notification-detail-modal');
    if (modal) modal.style.display = 'none';
    currentNotificationId = null;
    updateNotificationBadge();
    loadNotifications();
}

// ═══════════════════════════════════════
// Broadcast Message System
// ═══════════════════════════════════════

function openBroadcastMessageModal() {
    const modal = document.getElementById('broadcast-message-modal');
    const messageEl = document.getElementById('broadcast-message');
    const targetEl = document.getElementById('broadcast-target');
    const errorEl = document.getElementById('broadcast-error');
    
    if (modal) {
        modal.style.display = 'flex';
        if (messageEl) messageEl.value = '';
        if (targetEl) targetEl.value = 'all';
        if (errorEl) errorEl.style.display = 'none';
        
        // Focus on message textarea
        setTimeout(() => {
            if (messageEl) messageEl.focus();
        }, 100);
    }
}

function closeBroadcastMessageModal() {
    const modal = document.getElementById('broadcast-message-modal');
    if (modal) modal.style.display = 'none';
}

async function sendBroadcastMessage() {
    const messageEl = document.getElementById('broadcast-message');
    const targetEl = document.getElementById('broadcast-target');
    const errorEl = document.getElementById('broadcast-error');
    
    const message = messageEl ? messageEl.value.trim() : '';
    const target = targetEl ? targetEl.value : 'all';
    
    // Validation
    if (!message) {
        if (errorEl) {
            errorEl.textContent = 'يرجى كتابة نص الرسالة';
            errorEl.style.display = 'block';
        }
        return;
    }
    
    if (message.length < 5) {
        if (errorEl) {
            errorEl.textContent = 'يرجى كتابة رسالة أطول (5 أحرف على الأقل)';
            errorEl.style.display = 'block';
        }
        return;
    }
    
    // Get all employees
    const allEmployees = getEmployees();
    
    // Filter based on target
    const targetEmployees = allEmployees.filter(emp => {
        if (target === 'all') return true;
        if (target === 'morning') return emp.shift === 'morning';
        if (target === 'evening') return emp.shift === 'evening';
        return false;
    });
    
    if (targetEmployees.length === 0) {
        if (errorEl) {
            errorEl.textContent = 'لا يوجد موظفين في الفئة المستهدفة';
            errorEl.style.display = 'block';
        }
        return;
    }
    
    // Send notification to each employee
    let successCount = 0;
    for (const emp of targetEmployees) {
        const notifData = {
            person_id: emp.id,
            title: '📢 رسالة من رئيس القسم',
            message: message,
            type: 'message',
            status: 'info'
        };
        
        await window.db.addNotification(notifData);
        window.db.sendPushNotificationToPerson({ title: '📢 رسالة من رئيس القسم', body: message, personId: emp.id });
        successCount++;
    }
    
    // Trigger notification effects (once for admin feedback)
    triggerNotificationEffects();
    
    // Show success toast
    const targetLabel = target === 'all' ? 'جميع الموظفين' : 
                        target === 'morning' ? 'موظفي فترة الصبح' :
                        'موظفي فترة العصر';
    showToast(`تم إرسال الرسالة إلى ${successCount} موظف (${targetLabel})`, 'success');
    
    // Close modal
    closeBroadcastMessageModal();
}

function openEmployeeLeaveRequest() {
    if (!currentUser) return;
    const emp = getEmployees().find(e => e.id == currentUser.employeeId);
    if (!emp) {
        showToast('تعذر تحديد بيانات الموظف', 'error');
        return;
    }
    showAddLeaveModal('employee', emp.id);
}

function openEmployeePermissionRequest() {
    if (!currentUser) return;
    const emp = getEmployees().find(e => e.id == currentUser.employeeId);
    if (!emp) {
        showToast('تعذر تحديد بيانات الموظف', 'error');
        return;
    }
    showAddPermissionModal('employee', emp.id);
}

// ═══════════════════════════════════════
// Other Request (طلب آخر)
// ═══════════════════════════════════════
function openOtherRequestModal() {
    const modal  = document.getElementById('other-request-modal');
    const typeEl = document.getElementById('other-type');
    const descEl = document.getElementById('other-desc');
    const errEl  = document.getElementById('other-request-error');
    if (typeEl) typeEl.value = '';
    if (descEl) descEl.value = '';
    if (errEl)  { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (modal) modal.style.display = 'flex';
    setTimeout(() => { if (typeEl) typeEl.focus(); }, 100);
}

function closeOtherRequestModal() {
    const modal = document.getElementById('other-request-modal');
    if (modal) modal.style.display = 'none';
}

async function submitOtherRequest() {
    if (!currentUser) return;
    const typeEl = document.getElementById('other-type');
    const descEl = document.getElementById('other-desc');
    const errEl  = document.getElementById('other-request-error');

    const type = typeEl ? typeEl.value.trim() : '';
    const desc = descEl ? descEl.value.trim() : '';

    const showError = (msg) => {
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        else alert(msg);
    };

    if (!type || !desc) { showError('يرجى تعبئة جميع الحقول'); return; }
    if (type.length < 2) { showError('نوع الطلب قصير جداً'); return; }
    if (desc.length < 5) { showError('الوصف قصير جداً (5 أحرف على الأقل)'); return; }

    const isOfficer = currentUser.role === 'officer';
    let personId, personName, personType;
    if (isOfficer) {
        const off = getOfficers().find(o => o.id == currentUser.officerId);
        personId = currentUser.officerId;
        personName = off ? ((off.rank ? off.rank + ' ' : '') + off.name) : (currentUser.username || 'ضابط');
        personType = 'officer';
    } else {
        const emp = getEmployees().find(e => e.id == currentUser.employeeId);
        personId = currentUser.employeeId;
        personName = emp ? emp.name : (currentUser.username || 'موظف');
        personType = 'employee';
    }
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10);

    const newRequest = {
        id: Date.now(),
        person_id: personId,
        person_name: personName,
        person_type: personType,
        type: type,
        description: desc,
        status: 'pending',
        date: today.toISOString()
    };

    // Persist into other_requests via Supabase
    try {
        await window.db.addOtherRequest(newRequest);
        otherRequests = await window.db.getOtherRequests();
    } catch (e) {
        console.error('Failed to save other request:', e);
    }

    // Notify admin via the bell system
    try {
        addAdminNotification({
            type: 'other',
            personName: personName,
            requestType: type,
            date: dateStr,
            refId: newRequest.id
        });
    } catch (e) { console.error(e); }

    // Confirmation toast for the employee
    if (typeof showToast === 'function') {
        showToast('تم تقديم الطلب بنجاح', 'success');
    }

    closeOtherRequestModal();
}

function showLoginScreen() {
    setRootViews({ login: true, admin: false, employee: false, officer: false });
    const errorEl = document.getElementById('login-error');
    const userEl = document.getElementById('login-username');
    const passEl = document.getElementById('login-password');
    if (errorEl) {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
    }
    if (userEl) userEl.value = '';
    if (passEl) passEl.value = '';
    // أعد ملء حقول "تذكرني" بعد المسح
    loadRememberMe();
}

async function startAdminApp(initialPage = 'home') {
    setRootViews({ login: false, admin: true, employee: false, officer: false });
    await showPage(initialPage);
    // حفظ FCM token للمدير في Supabase
    _saveFCMTokenForCurrentUser();
    // polling كل 30 ثانية لتحديث إشعارات المدير تلقائياً
    if (_adminPollInterval) clearInterval(_adminPollInterval);
    _adminPollInterval = setInterval(async () => {
        if (!currentUser || currentUser.role !== 'admin') {
            clearInterval(_adminPollInterval);
            _adminPollInterval = null;
            return;
        }
        try {
            const fresh = await window.db.getAdminNotifications();
            if (Array.isArray(fresh) && fresh.length !== adminNotifications.length) {
                adminNotifications = fresh;
                updateBellBadge();
                playNotificationSound();
            }
        } catch(e) { /* silent */ }
    }, 30000);
}

async function startEmployeeApp() {
    setRootViews({ login: false, admin: false, employee: true, officer: false });
    await loadPermissions();
    archiveFiles = await window.db.archiveGetAll();
    employeeNavigate('dashboard');
    loadEmployeeDashboard();
    loadNotifications(); // Update notification badge
    setupEmployeeUI();
    // حفظ FCM token للموظف في Supabase
    _saveFCMTokenForCurrentUser();
}

async function startOfficerApp() {
    setRootViews({ login: false, admin: false, employee: false, officer: true });
    try { await loadPermissions(); } catch(e) { console.error('loadPermissions error:', e); }
    officerNavigate('dashboard');
    loadOfficerDashboard();
    loadOfficerNotifications();
    // حفظ FCM token للضابط في Supabase
    _saveFCMTokenForCurrentUser();
}

function officerNavigate(page) {
    document.querySelectorAll('[id^="off-page-"]').forEach(el => el.style.display = 'none');
    const target = document.getElementById('off-page-' + page);
    if (target) target.style.display = 'block';

    document.querySelectorAll('[data-off-tab]').forEach(tab => tab.classList.remove('active'));
    const activeTab = document.querySelector(`[data-off-tab="${page}"]`);
    if (activeTab) activeTab.classList.add('active');

    if (page === 'dashboard') {
        Promise.all([window.db.getLeaves(), loadPermissions()]).then(([lvs]) => {
            if (lvs) leaves = lvs.map(l => ({ ...l, type: l.type || 'leave', status: normalizeApprovalStatus(l.status) }));
            loadOfficerDashboard();
        });
    }
    if (page === 'archive') loadOfficerArchive();
    if (page === 'requests') {
        Promise.all([window.db.getLeaves(), loadPermissions(), window.db.getOtherRequests()]).then(([lvs, , others]) => {
            if (lvs) leaves = lvs.map(l => ({ ...l, type: l.type || 'leave', status: normalizeApprovalStatus(l.status) }));
            if (others) otherRequests = others;
            loadOfficerRequests();
        });
        setupOfficerRequestsPullToRefresh();
    }
    if (page === 'notifications') { loadOfficerNotifications(); setupOfficerNotificationsPullToRefresh(); }

    updateOfficerNotificationBadge();
}

function loadOfficerDashboard() {
    const user = currentUser;
    if (!user) return;

    const allOfficers = getOfficers();
    const off = allOfficers.find(o => o.id == user.officerId);
    // dashboard officer lookup

    if (!off) {
        const nameEl = document.getElementById('off-dash-name');
        const jobEl  = document.getElementById('off-dash-job');
        const idEl   = document.getElementById('off-dash-id');
        if (nameEl) nameEl.textContent = user.username || 'ضابط';
        if (jobEl)  jobEl.textContent  = 'ضابط';
        if (idEl)   idEl.textContent   = '⚠️ الرجاء ربط الحساب بملف ضابط من لوحة الأدمن';
        return;
    }

    const nameEl = document.getElementById('off-dash-name');
    const jobEl = document.getElementById('off-dash-job');
    const idEl = document.getElementById('off-dash-id');
    if (nameEl) nameEl.textContent = (off.rank ? off.rank + ' ' : '') + (off.name || '');
    if (jobEl) jobEl.textContent = off.position || 'ضابط';
    if (idEl) idEl.textContent = off.military_number ? 'رقم عسكري: ' + off.military_number : '';

    // رصيد الاستئذانات
    const myPermissions = getPermissions().filter(p => {
        const personId = p.person_id != null ? p.person_id : p.employee_id;
        return p.person_type === 'officer' && personId == off.id;
    });
    const now2 = new Date();
    const monthStart = new Date(now2.getFullYear(), now2.getMonth(), 1);
    const monthPerms = myPermissions.filter(p => p.date && new Date(p.date) >= monthStart);
    // المقبول فقط يُحسب من الرصيد، المعلق والمرفوض لا يُحجزان رصيداً
    const activePerms2 = monthPerms.filter(p => normalizeApprovalStatus(p.status) === 'approved');
    const total = 4;
    const used = Math.min(activePerms2.length, total);
    const remaining = Math.max(0, total - used);
    const permPercent = (used / total) * 100;
    const permColor = remaining >= 3 ? '#22c55e' : remaining === 2 ? '#f59e0b' : '#ef4444';
    const permTextEl = document.getElementById('off-perm-text');
    const permBarEl = document.getElementById('off-perm-bar');
    if (permTextEl) permTextEl.textContent = `متبقي ${remaining} من ${total}`;
    if (permBarEl) { permBarEl.style.width = permPercent + '%'; permBarEl.style.background = permColor; }

    // حالة الإجازة
    const myLeaves = getLeaves().filter(l => l.person_type === 'officer' && l.person_id == off.id && normalizeApprovalStatus(l.status) !== 'rejected');
    const statusEl = document.getElementById('off-leave-status');
    if (statusEl) {
        const card = statusEl.closest('.emp-leave-card');
        const subEl = card ? card.querySelector('.emp-leave-content p:nth-child(2)') : null;
        const iconEl = card ? card.querySelector('.emp-leave-icon') : null;
        const activeLeave = myLeaves.find(l => getLeaveStatus(l) === 'جارية' && normalizeApprovalStatus(l.status) === 'approved');
        if (activeLeave) {
            statusEl.textContent = 'إجازة سارية حالياً';
            if (subEl) subEl.textContent = `${activeLeave.leave_type || 'إجازة'} • ${activeLeave.start_date} → ${activeLeave.end_date}`;
            if (iconEl) iconEl.textContent = '🌴';
            if (card) {
                card.style.cursor = 'pointer';
                card.onclick = () => showLeaveDetails(activeLeave.id);
            }
        } else {
            statusEl.textContent = 'لا توجد إجازة نشطة';
            if (subEl) subEl.textContent = 'أنت على رأس العمل حالياً';
            if (iconEl) iconEl.textContent = '✓';
            if (card) { card.style.cursor = ''; card.onclick = null; }
        }
    }

    // آخر الطلبات (الشهر الحالي)
    const now3 = new Date();
    const currentYearMonth = `${now3.getFullYear()}-${String(now3.getMonth() + 1).padStart(2, '0')}`;

    const allMyPermissions = getPermissions().filter(p => {
        const personId = p.person_id != null ? p.person_id : p.employee_id;
        return p.person_type === 'officer' && personId == off.id && normalizeApprovalStatus(p.status) === 'approved';
    });
    const allMyOther = otherRequests
        .filter(r => r.person_type === 'officer' && r.person_id == off.id && normalizeApprovalStatus(r.status) === 'approved');

    const lastRequests = [
        ...myLeaves.map(l => ({
            type: 'leave',
            title: l.leave_type || 'إجازة',
            date: l.start_date || l.date || '',
            status: normalizeApprovalStatus(l.status)
        })),
        ...allMyPermissions.map(p => ({
            type: 'permission',
            title: p.type === 'start' ? 'استئذان بداية دوام' : 'استئذان نهاية دوام',
            date: p.date || '',
            status: normalizeApprovalStatus(p.status)
        })),
        ...allMyOther.map(r => ({
            type: 'other',
            title: r.type || 'طلب آخر',
            date: r.date ? r.date.slice(0, 10) : '',
            status: normalizeApprovalStatus(r.status)
        }))
    ]
        .filter(r => r.date && r.date.startsWith(currentYearMonth))
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
        .slice(0, 3);

    const requestsEl = document.getElementById('off-my-requests');
    if (requestsEl) {
        if (lastRequests.length === 0) {
            requestsEl.innerHTML = '<div class="req-empty">لا توجد طلبات هذا الشهر</div>';
        } else {
            requestsEl.innerHTML = lastRequests.map(r => {
                const statusMeta = getApprovalStatusMeta(r.status);
                const icon = r.type === 'leave' ? '🗓️' : r.type === 'permission' ? '⏱' : '📄';
                const iconClass = r.type === 'leave' ? 'req-icon-leave' : r.type === 'permission' ? 'req-icon-permission' : 'req-icon-other';
                return `<div class="req-item">
                    <div class="req-item-icon ${iconClass}">${icon}</div>
                    <div class="req-item-body">
                        <p class="req-item-title">${r.title || ''}</p>
                        <p class="req-item-date">${r.date || ''}</p>
                    </div>
                    <div class="req-item-right">
                        <span class="emp-status ${statusMeta.className}">${statusMeta.label}</span>
                    </div>
                </div>`;
            }).join('');
        }
    }
}

async function loadOfficerArchive() {
    const user = currentUser;
    if (!user) return;
    const off = getOfficers().find(o => o.id == user.officerId);
    if (!off) return;

    const listEl = document.getElementById('off-archive-list');
    if (!listEl) return;
    listEl.innerHTML = '<p style="color:#8e8e93;text-align:center;font-size:14px;">جارٍ التحميل...</p>';

    currentOfficerArchive = await window.db.officerArchiveGetByOfficer(off.id) || [];

    // تحديث كروت التصنيف
    const setS = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setS('off-arch-my-stat-total', currentOfficerArchive.length);
    setS('off-arch-my-stat-leave',  currentOfficerArchive.filter(f => f.type === 'leave').length);
    setS('off-arch-my-stat-perm',   currentOfficerArchive.filter(f => f.type === 'permission').length);
    setS('off-arch-my-stat-doc',    currentOfficerArchive.filter(f => f.type === 'document').length);

    // إعادة ضبط الفلتر للكل عند التحميل
    const sel = document.getElementById('off-arch-my-type-filter');
    if (sel) sel.value = '';
    document.querySelectorAll('.filter-pills[data-target="off-arch-my-type-filter"] .filter-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.value === '');
    });

    switchOffMyArchiveTab('dashboard');
    renderOffArchiveTypeCards();
    renderOfficerArchiveList();
}

function switchOffMyArchiveTab(tab) {
    ['dashboard','all'].forEach(t => {
        const panel = document.getElementById('off-arch-panel-' + t);
        const btn   = document.getElementById('off-arch-tab-' + t);
        if (panel) panel.style.display = t === tab ? '' : 'none';
        if (btn)   btn.className = 'archive-tab' + (t === tab ? ' active' : '');
    });
}

function filterByCustomTypeOfficer(key) {
    switchOffMyArchiveTab('all');
    const sel = document.getElementById('off-arch-my-type-filter');
    if (sel) sel.value = key;
    document.querySelectorAll('.filter-pills[data-target="off-arch-my-type-filter"] .filter-pill').forEach(p => {
        p.classList.toggle('active', p.dataset.value === key);
    });
    renderOfficerArchiveList();
}

function renderOffArchiveTypeCards() {
    const grid = document.getElementById('off-arch-my-types-grid');
    if (!grid) return;

    const allTypes = [
        ...defaultArchiveTypes,
        ...customArchiveTypes
    ];

    grid.innerHTML = allTypes.map(t => {
        const count = currentOfficerArchive.filter(f => f.type === t.key).length;
        return `<div class="archive-quick-card" onclick="filterByCustomTypeOfficer('${t.key}')" style="border-top:3px solid ${t.color};">
            <h4 class="archive-quick-title">${t.name}</h4>
            <p class="archive-quick-desc">${t.desc || ''}</p>
            <span class="archive-quick-btn" style="color:${t.btnColor||t.color};">${count} ملف ←</span>
        </div>`;
    }).join('') || '<div class="arch-list-empty">لا توجد أنواع</div>';
}

function renderOfficerArchiveList() {
    const listEl = document.getElementById('off-archive-list');
    if (!listEl) return;

    const typeFilter = (document.getElementById('off-arch-my-type-filter')?.value) || '';
    const search = (document.getElementById('off-arch-my-search')?.value || '').toLowerCase();
    let filtered = typeFilter ? currentOfficerArchive.filter(f => f.type === typeFilter) : currentOfficerArchive;
    if (search) filtered = filtered.filter(f => (f.file_name || '').toLowerCase().includes(search) || (f.notes || '').toLowerCase().includes(search));

    if (filtered.length === 0) {
        listEl.innerHTML = '<div class="arch-list-empty">لا توجد ملفات</div>';
        return;
    }

    listEl.innerHTML = filtered.map(f => `<div class="arch-file-item">
            <div class="arch-file-info">
                <div class="arch-file-name">${typeof getFileIcon === 'function' ? getFileIcon(f.file_type) : '📄'} ${f.file_name || 'ملف'}</div>
                <div class="arch-file-meta">
                    ${getArchiveTypeBadge(f.type)}
                    <span>${(f.date || f.created_at || '').slice(0, 10) || '-'}</span>
                    ${f.file_size ? `<span>${f.file_size}</span>` : ''}
                    ${f.notes ? `<span>📌 ${f.notes}</span>` : ''}
                </div>
            </div>
            <div class="arch-file-actions">
                <button class="arch-soft-btn arch-btn-view" onclick="viewOfficerArchiveFile(${f.id})">👁 عرض</button>
                <button class="arch-soft-btn arch-btn-download" onclick="downloadOfficerArchiveFile(${f.id})">⬇️ تحميل</button>
            </div>
        </div>`).join('');
}


async function viewOfficerArchiveFile(id) {
    const file = await window.db.officerArchiveReadFile(id);
    if (!file || !file.data) { showToast('لا يمكن قراءة الملف', 'error'); return; }
    const mimeFromData = (file.data.match(/^data:([^;]+);/) || [])[1] || '';
    const rawType = mimeFromData || file.file_type || '';
    const ext = (file.file_name || '').split('.').pop().toLowerCase();
    const isImage = rawType.includes('image') || ['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext);
    const isPDF   = rawType.includes('pdf') || ext === 'pdf';
    if (isPDF) {
        const blob = dataURLtoBlob(file.data);
        const url  = URL.createObjectURL(blob);
        window.open(url, '_blank');
        return;
    }
    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.id = 'off-arch-view-modal';
    modal.innerHTML = `<div class="modal" style="width:95vw;max-width:600px;max-height:90vh;overflow-y:auto;">
        <div class="modal-header">
            <div><h2>${typeof getFileIcon === 'function' ? getFileIcon(rawType) : '📄'} ${file.file_name}</h2></div>
            <button class="modal-close" onclick="document.getElementById('off-arch-view-modal').remove()">✕</button>
        </div>
        <div style="text-align:center;padding:20px;min-height:200px;">
            ${isImage
                ? `<img src="${file.data}" style="max-width:100%;max-height:70vh;border-radius:8px;">`
                : `<div style="padding:30px 20px;color:#64748b;"><div style="font-size:64px;">📁</div><p>${file.file_name}</p><p style="font-size:13px;color:#94a3b8;">قم بالتحميل لفتح الملف</p></div>`}
        </div>
        <div class="modal-footer">
            <button class="btn btn-primary" onclick="downloadOfficerArchiveFile(${id})">⬇️ تحميل</button>
            <button class="btn btn-danger" onclick="document.getElementById('off-arch-view-modal').remove()">✕ إغلاق</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function downloadOfficerArchiveFile(id) {
    const file = await window.db.officerArchiveReadFile(id);
    if (!file || !file.data) { showToast('لا يمكن قراءة الملف', 'error'); return; }
    const a = document.createElement('a');
    a.href = file.data;
    a.download = file.file_name;
    a.click();
    showToast(`✅ جاري تحميل ${file.file_name}`, 'success');
}

function loadOfficerRequests() {
    const user = currentUser;
    if (!user) return;
    const off = getOfficers().find(o => o.id == user.officerId);
    if (!off) return;

    const listEl = document.getElementById('off-requests-list');
    if (!listEl) return;

    const myLeaves = getLeaves()
        .filter(l => l.person_type === 'officer' && l.person_id == off.id)
        .map(l => ({
            id: l.id,
            requestType: 'leave',
            title: l.leave_type || 'إجازة',
            subtitle: `${l.start_date || ''}${l.end_date ? ' ← ' + l.end_date : ''}`,
            date: l.start_date || l.date || '',
            status: normalizeApprovalStatus(l.status)
        }));

    const myPermissions = getPermissions()
        .filter(p => {
            const personId = p.person_id != null ? p.person_id : p.employee_id;
            return p.person_type === 'officer' && personId == off.id;
        })
        .map(p => ({
            id: p.id,
            requestType: 'permission',
            title: p.type === 'start' ? 'استئذان بداية دوام' : 'استئذان نهاية دوام',
            subtitle: p.notes || 'بدون ملاحظات',
            date: p.date || '',
            status: normalizeApprovalStatus(p.status)
        }));

    const myOtherRequests = otherRequests
        .filter(r => r.person_type === 'officer' && r.person_id == off.id)
        .map(r => ({
            id: r.id,
            requestType: 'other',
            title: r.type || 'طلب آخر',
            subtitle: r.description || '',
            date: r.date ? r.date.slice(0, 10) : '',
            status: normalizeApprovalStatus(r.status)
        }));

    const allRequests = [...myLeaves, ...myPermissions, ...myOtherRequests]
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    if (allRequests.length === 0) {
        listEl.innerHTML = '<p style="color:#8e8e93;text-align:center;font-size:14px;">لا توجد طلبات</p>';
        return;
    }

    listEl.innerHTML = allRequests.map(req => {
        const statusMeta = getApprovalStatusMeta(req.status);
        const icon = req.requestType === 'leave' ? '🗓' : req.requestType === 'permission' ? '⏱' : '📄';
        const isLocked = req.requestType !== 'other' && isApprovedAndNonAdmin(req.status);
        const cardClick = req.requestType === 'leave'
            ? `onclick="showLeaveDetails(${req.id})"`
            : req.requestType === 'permission'
            ? `onclick="editPermission(${req.id})"`
            : '';
        const typeBadge = req.requestType === 'leave' ? 'arch-file-type-leave' : req.requestType === 'permission' ? 'arch-file-type-permission' : 'arch-file-type-other';
        const typeLabel = req.requestType === 'leave' ? 'إجازة' : req.requestType === 'permission' ? 'استئذان' : 'طلب آخر';
        return `<div class="arch-file-item" ${cardClick} style="cursor:${cardClick ? 'pointer' : 'default'};">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                <div class="arch-file-info">
                    <div class="arch-file-name">${icon} ${req.title}</div>
                    <div class="arch-file-meta">
                        <span class="arch-file-type ${typeBadge}">${typeLabel}</span>
                        <span>${req.date}</span>
                        ${req.subtitle ? `<span>${req.subtitle}</span>` : ''}
                    </div>
                </div>
                <div class="arch-file-actions" style="flex-direction:column;align-items:flex-end;gap:4px;">
                    <span class="emp-status ${statusMeta.className}">${statusMeta.label}</span>
                    ${!isLocked && req.requestType !== 'other' ? `<button class="arch-soft-btn arch-btn-delete" onclick="event.stopPropagation();${req.requestType === 'leave' ? `offDeleteLeave(${req.id})` : `offDeletePermission(${req.id})`}">🗑 حذف</button>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');
}

async function offDeleteLeave(id) {
    const leave = getLeaves().find(l => l.id == id);
    if (leave && isApprovedAndNonAdmin(leave.status)) {
        showToast('لا يمكن حذف الإجازة بعد الموافقة عليها من الأدمن', 'error');
        return;
    }
    if (!confirm('هل تريد حذف هذه الإجازة؟')) return;
    await window.db.deleteLeave(id);
    await loadAllData();
    loadOfficerRequests();
    loadOfficerDashboard();
    showToast('تم حذف الإجازة 🗑️', 'warning');
}

async function offDeletePermission(id) {
    const perm = getPermissions().find(p => p.id == id);
    if (perm && isApprovedAndNonAdmin(perm.status)) {
        showToast('لا يمكن حذف الاستئذان بعد الموافقة عليه من الأدمن', 'error');
        return;
    }
    if (!confirm('هل تريد حذف هذا الاستئذان؟')) return;
    const result = await window.db.deleteLeavePermission(id);
    if (result && result.error) { showToast(result.error, 'error'); return; }
    await loadAllData();
    loadOfficerRequests();
    loadOfficerDashboard();
    showToast('تم حذف الاستئذان 🗑️', 'warning');
}

function openOfficerLeaveRequest() {
    if (!currentUser) return;
    const off = getOfficers().find(o => o.id == currentUser.officerId);
    if (!off) { showToast('تعذر تحديد بيانات الضابط', 'error'); return; }
    showAddLeaveModal('officer', off.id);
}

function openOfficerPermissionRequest() {
    if (!currentUser) return;
    const off = getOfficers().find(o => o.id == currentUser.officerId);
    if (!off) { showToast('تعذر تحديد بيانات الضابط', 'error'); return; }
    showAddPermissionModal('officer', off.id);
}

function openOfficerOtherRequestModal() {
    openOtherRequestModal();
}

// ═══════════════════════════════════════
// إدارة حسابات الموظفين والضباط (من الأدمن)
// ═══════════════════════════════════════
function openManageAccountModal(role, personId, personName) {
    const existing = document.getElementById('manage-account-modal');
    if (existing) existing.remove();

    const accounts = accountsCache;
    // للموظفين: ابحث عن حساب بنوع 'employee' أو 'stats' أو 'admin'
    const existing_acc = role === 'employee'
        ? accounts.find(a => (a.role === 'employee' || a.role === 'stats' || a.role === 'admin') && a.person_id == personId)
        : accounts.find(a => (a.role === role || a.role === 'admin') && a.person_id == personId);

    const modal = document.createElement('div');
    modal.className = 'modal-overlay active';
    modal.id = 'manage-account-modal';

    const titleColor = role === 'officer' ? '#1a365d' : '#3d5a1e';
    const roleLabel = role === 'officer' ? 'ضابط' : 'موظف';

    // اختيار نوع الحساب
    const roleSelector = role === 'employee' ? `
        <div class="form-group" style="margin-bottom:12px;">
            <label>نوع الحساب *</label>
            <select id="acc-role" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;">
                <option value="employee" ${(!existing_acc || existing_acc.role === 'employee') ? 'selected' : ''}>موظف — صفحة الموظف</option>
                <option value="stats" ${(existing_acc && existing_acc.role === 'stats') ? 'selected' : ''}>إحصائيات — صفحة الموظف + الإحصائيات</option>
                <option value="admin" ${(existing_acc && existing_acc.role === 'admin') ? 'selected' : ''}>أدمن — لوحة التحكم</option>
            </select>
        </div>` : `
        <div class="form-group" style="margin-bottom:12px;">
            <label>نوع الحساب *</label>
            <select id="acc-role" style="width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;">
                <option value="officer" ${(!existing_acc || existing_acc.role === 'officer') ? 'selected' : ''}>ضابط — صفحة الضابط</option>
                <option value="admin" ${(existing_acc && existing_acc.role === 'admin') ? 'selected' : ''}>أدمن — لوحة التحكم</option>
            </select>
        </div>`;

    const existingRoleLabel = existing_acc
        ? (existing_acc.role === 'stats' ? '📊 إحصائيات' : existing_acc.role === 'admin' ? 'أدمن' : existing_acc.role === 'officer' ? '🎖️ ضابط' : '👤 موظف')
        : '';

    modal.innerHTML = `<div class="modal detail-modal" style="width:100%;max-width:420px;">
    <div class="detail-header" style="background:linear-gradient(135deg,${titleColor} 0%,#5856d6 100%);">
        <button class="detail-close-btn" onclick="closeManageAccountModal()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar" style="font-size:30px;">🔑</div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">حساب ${roleLabel}</h2>
                <p class="detail-header-sub">${personName}</p>
            </div>
        </div>
    </div>
    <div style="padding:16px;">
        ${existing_acc ? `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#166534;">
            ✅ يوجد حساب — اسم المستخدم: <strong>${existing_acc.username}</strong> &nbsp;|&nbsp; النوع: <strong>${existingRoleLabel}</strong>
        </div>` : `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#92400e;">
            ⚠️ لا يوجد حساب لهذا الشخص بعد
        </div>`}
        ${roleSelector}
        <div class="form-group" style="margin-bottom:12px;">
            <label>اسم المستخدم *</label>
            <input type="text" id="acc-username" placeholder="مثال: off3 أو emp5" value="${existing_acc ? existing_acc.username : ''}" autocomplete="off">
        </div>
        <div class="form-group" style="margin-bottom:12px;">
            <label>${existing_acc ? 'كلمة المرور الجديدة (اتركها فارغة للإبقاء)' : 'كلمة المرور *'}</label>
            <input type="password" id="acc-password" placeholder="أدخل كلمة المرور" autocomplete="new-password">
        </div>
        <p id="acc-error" style="color:#dc2626;font-size:13px;display:none;margin:0 0 8px;"></p>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#5856d6;color:white;" onclick="saveManageAccount('${role}',${personId})">
            ${existing_acc ? 'تحديث الحساب' : 'إنشاء الحساب'}
        </button>
        ${existing_acc ? `<button class="btn" style="background:#ff3b30;color:white;" onclick="deleteManageAccount(${existing_acc.id})">حذف الحساب</button>` : ''}
        <button class="btn" style="background:#8e8e93;color:white;" onclick="closeManageAccountModal()">إلغاء</button>
    </div>
    </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) closeManageAccountModal(); });
}

function closeManageAccountModal() {
    const m = document.getElementById('manage-account-modal');
    if (m) m.remove();
}

async function saveManageAccount(role, personId) {
    const username = (document.getElementById('acc-username')?.value || '').trim();
    const password = document.getElementById('acc-password')?.value || '';
    const errEl = document.getElementById('acc-error');
    // اقرأ النوع من الـ dropdown إذا كان موجوداً (للموظفين)
    const roleSelectEl = document.getElementById('acc-role');
    const effectiveRole = roleSelectEl ? roleSelectEl.value : role;

    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!username) { showErr('يرجى إدخال اسم المستخدم'); return; }
    if (username.length < 3) { showErr('اسم المستخدم قصير جداً'); return; }

    const accounts = accountsCache;
    // للموظفين: ابحث بـ person_id بغض النظر عن النوع (employee أو stats أو admin)
    const existing = role === 'employee'
        ? accounts.find(a => (a.role === 'employee' || a.role === 'stats' || a.role === 'admin') && a.person_id == personId)
        : accounts.find(a => (a.role === role || a.role === 'admin') && a.person_id == personId);

    if (existing) {
        if (!password) {
            const res = await window.db.updateAccount(existing.id, { username, password: existing.password, role: effectiveRole });
            if (res && res.error) { showErr(res.error); return; }
        } else {
            if (password.length < 4) { showErr('كلمة المرور يجب أن تكون 4 أحرف على الأقل'); return; }
            const res = await window.db.updateAccount(existing.id, { username, password, role: effectiveRole });
            if (res && res.error) { showErr(res.error); return; }
        }
        showToast('تم تحديث الحساب بنجاح ✅', 'success');
    } else {
        if (!password) { showErr('يرجى إدخال كلمة المرور'); return; }
        if (password.length < 4) { showErr('كلمة المرور يجب أن تكون 4 أحرف على الأقل'); return; }
        const res = await window.db.addAccount({ username, password, role: effectiveRole, personId });
        if (res && res.error) { showErr(res.error); return; }
        showToast('تم إنشاء الحساب بنجاح ✅', 'success');
    }
    accountsCache = await window.db.getAccounts();
    closeManageAccountModal();
}

async function deleteManageAccount(accountId) {
    if (!confirm('هل تريد حذف هذا الحساب؟ لن يتمكن المستخدم من تسجيل الدخول بعدها.')) return;
    await window.db.deleteAccount(accountId);
    accountsCache = await window.db.getAccounts();
    showToast('تم حذف الحساب 🗑️', 'warning');
    closeManageAccountModal();
}

async function loadOfficerNotifications() {
    const user = currentUser;
    if (!user) return;

    const listEl = document.getElementById('off-notification-list');
    if (!listEl) return;

    notificationsCache = await window.db.getNotifications();
    const allNotifications = notificationsCache;
    const myNotifications = allNotifications.filter(n =>
        n.person_id == user.officerId || n.person_id === 'all'
    ).sort((a, b) => new Date(b.date) - new Date(a.date));

    updateOfficerNotificationBadge();

    if (myNotifications.length === 0) {
        listEl.innerHTML = `
            <div class="notification-empty-state">
                <div class="notification-empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg></div>
                <div class="notification-empty-title">لا توجد إشعارات جديدة</div>
                <div class="notification-empty-subtitle">ستظهر هنا إشعارات طلباتك</div>
            </div>`;
        return;
    }

    const statusColor = s => s === 'approved' ? '#16a34a' : s === 'rejected' ? '#dc2626' : '#2563eb';
    const statusBg = s => s === 'approved' ? '#dcfce7' : s === 'rejected' ? '#fee2e2' : '#dbeafe';
    const statusCardBg = s => s === 'approved' ? '#f0fdf4' : s === 'rejected' ? '#fff5f5' : '#eff6ff';
    const statusIcon = s => s === 'approved'
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`
        : s === 'rejected'
        ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`
        : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    const statusLabel = s => s === 'approved' ? 'موافقة' : s === 'rejected' ? 'مرفوض' : 'معلومة';

    listEl.innerHTML = myNotifications.map(n => {
        const color = statusColor(n.status);
        const bg = statusBg(n.status);
        const icon = statusIcon(n.status);
        const label = statusLabel(n.status);
        const isRead = n.read_by && n.read_by.includes(String(user.officerId));
        const dateText = typeof timeAgo === 'function' ? timeAgo(n.date) : (n.date || '');
        const iconClass = n.status === 'approved' ? 'req-icon-leave' : n.status === 'rejected' ? '' : 'req-icon-other';
        const iconStyle = n.status === 'rejected' ? `background:rgba(220,38,38,0.12);` : '';
        const statusCls = n.status === 'approved' ? 'emp-status-accepted' : n.status === 'rejected' ? 'emp-status-rejected' : 'emp-status-info';

        return `<div class="req-item clickable${!isRead ? ' unread' : ''}" onclick="openOfficerNotificationDetail(${n.id})">
            <div class="req-item-icon ${iconClass}" style="${iconStyle}">${icon}</div>
            <div class="req-item-body">
                <p class="req-item-title">${n.title}</p>
                <p class="req-item-date">${dateText}</p>
                ${n.message ? `<p style="font-size:12px;color:#7a8797;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${n.message}</p>` : ''}
            </div>
            <div class="req-item-right">
                <span class="emp-status ${statusCls}">${label}</span>
                ${!isRead ? `<span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block;box-shadow:0 0 0 3px ${color}22;"></span>` : '<span style="width:10px;height:10px;"></span>'}
            </div>
            <span class="req-item-arrow">&#x2039;</span>
        </div>`;
    }).join('');
}

function updateOfficerNotificationBadge() {
    if (!currentUser || currentUser.role !== 'officer') return;
    const count = notificationsCache.filter(n =>
        (n.person_id == currentUser.officerId || n.person_id === 'all') &&
        !(n.read_by && n.read_by.includes(String(currentUser.officerId)))
    ).length;
    const badgeEl = document.getElementById('off-notif-badge');
    if (!badgeEl) return;
    if (count > 0) {
        badgeEl.textContent = count > 9 ? '9+' : count;
        badgeEl.style.display = 'block';
    } else {
        badgeEl.style.display = 'none';
    }
}

async function openOfficerNotificationDetail(id) {
    if (currentUser && currentUser.officerId) {
        await window.db.markNotificationAsRead(id, currentUser.officerId);
        notificationsCache = await window.db.getNotifications();
    }
    openNotificationDetail(id);
    setTimeout(() => updateOfficerNotificationBadge(), 50);
}

async function markAllOfficerNotificationsRead() {
    if (!currentUser) return;
    await window.db.markAllNotificationsAsRead(currentUser.officerId);
    notificationsCache = await window.db.getNotifications();
    setTimeout(() => {
        updateOfficerNotificationBadge();
        loadOfficerNotifications();
    }, 50);
    showToast('تم تحديد جميع الإشعارات كمقروءة ✓', 'success');
}

function openAdminChangePasswordModal() {
    const modal = document.getElementById('admin-password-modal');
    const msgEl = document.getElementById('admin-password-msg');
    if (msgEl) msgEl.textContent = '';
    ['admin-old-password','admin-new-password','admin-confirm-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    if (modal) modal.style.display = 'flex';
}

function closeAdminChangePasswordModal() {
    const modal = document.getElementById('admin-password-modal');
    if (modal) modal.style.display = 'none';
}

async function changeAdminPassword() {
    if (!currentUser) return;
    const oldPass = document.getElementById('admin-old-password')?.value || '';
    const newPass = document.getElementById('admin-new-password')?.value || '';
    const confirmPass = document.getElementById('admin-confirm-password')?.value || '';
    const msgEl = document.getElementById('admin-password-msg');

    const showMsg = (text, ok = false) => {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.style.color = ok ? '#127a3e' : '#b42318';
    };

    if (!oldPass || !newPass || !confirmPass) { showMsg('يرجى تعبئة جميع الحقول'); return; }
    if (newPass.length < 4) { showMsg('كلمة السر الجديدة يجب أن تكون 4 أحرف على الأقل'); return; }
    if (newPass !== confirmPass) { showMsg('تأكيد كلمة السر غير مطابق'); return; }

    const verified = await window.db.findAccount(currentUser.username, oldPass);
    if (!verified) { showMsg('كلمة السر الحالية غير صحيحة'); return; }

    const res = await window.db.updateAccount(verified.id, {
        username: verified.username,
        password: newPass,
        role: verified.role
    });
    if (res && res.error) { showMsg(res.error); return; }

    showMsg('تم تغيير كلمة السر بنجاح', true);
    setTimeout(() => closeAdminChangePasswordModal(), 1500);
}

function openOfficerChangePasswordModal() {
    const modal = document.getElementById('off-password-modal');
    const msgEl = document.getElementById('off-password-msg');
    if (msgEl) msgEl.textContent = '';
    if (modal) modal.style.display = 'flex';
}

function closeOfficerChangePasswordModal() {
    const modal = document.getElementById('off-password-modal');
    ['off-old-password', 'off-new-password', 'off-confirm-password'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const msgEl = document.getElementById('off-password-msg');
    if (msgEl) msgEl.textContent = '';
    if (modal) modal.style.display = 'none';
}

async function changeOfficerPassword() {
    if (!currentUser) return;
    const oldPass = document.getElementById('off-old-password')?.value || '';
    const newPass = document.getElementById('off-new-password')?.value || '';
    const confirmPass = document.getElementById('off-confirm-password')?.value || '';
    const msgEl = document.getElementById('off-password-msg');

    const showMsg = (text, ok = false) => {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.style.color = ok ? '#127a3e' : '#b42318';
    };

    if (!oldPass || !newPass || !confirmPass) { showMsg('يرجى تعبئة جميع الحقول'); return; }
    if (newPass.length < 4) { showMsg('الرقم السري الجديد يجب أن يكون 4 أحرف على الأقل'); return; }
    if (newPass !== confirmPass) { showMsg('تأكيد الرقم السري غير مطابق'); return; }

    const verified = await window.db.findAccount(currentUser.username, oldPass);
    if (!verified) { showMsg('الرقم السري الحالي غير صحيح'); return; }

    const res = await window.db.updateAccount(verified.id, {
        username: verified.username,
        password: newPass,
        role: verified.role
    });
    if (res && res.error) { showMsg(res.error); return; }

    showMsg('تم تغيير الرقم السري بنجاح', true);
    closeOfficerChangePasswordModal();
    window.alert('تم تغيير الرقم السري بنجاح');
}

function openChangePasswordModal() {
    const modal = document.getElementById('emp-password-modal');
    const msgEl = document.getElementById('emp-password-msg');
    if (msgEl) msgEl.textContent = '';
    if (modal) modal.style.display = 'flex';
}

function closeChangePasswordModal() {
    const modal = document.getElementById('emp-password-modal');
    const oldEl = document.getElementById('emp-old-password');
    const newEl = document.getElementById('emp-new-password');
    const confirmEl = document.getElementById('emp-confirm-password');
    const msgEl = document.getElementById('emp-password-msg');

    if (oldEl) oldEl.value = '';
    if (newEl) newEl.value = '';
    if (confirmEl) confirmEl.value = '';
    if (msgEl) msgEl.textContent = '';
    if (modal) modal.style.display = 'none';
}

async function changeEmployeePassword() {
    if (!currentUser) return;

    const oldEl = document.getElementById('emp-old-password');
    const newEl = document.getElementById('emp-new-password');
    const confirmEl = document.getElementById('emp-confirm-password');
    const msgEl = document.getElementById('emp-password-msg');

    const oldPass = oldEl?.value || '';
    const newPass = newEl?.value || '';
    const confirmPass = confirmEl?.value || '';

    const showMsg = (text, ok = false) => {
        if (!msgEl) return;
        msgEl.textContent = text;
        msgEl.style.color = ok ? '#127a3e' : '#b42318';
    };

    if (!oldPass || !newPass || !confirmPass) {
        showMsg('يرجى تعبئة جميع الحقول');
        return;
    }

    if (newPass.length < 4) {
        showMsg('الرقم السري الجديد يجب أن يكون 4 أحرف على الأقل');
        return;
    }

    if (newPass !== confirmPass) {
        showMsg('تأكيد الرقم السري غير مطابق');
        return;
    }

    const verified = await window.db.findAccount(currentUser.username, oldPass);
    if (!verified) {
        showMsg('الرقم السري الحالي غير صحيح');
        return;
    }

    const res = await window.db.updateAccount(verified.id, {
        username: verified.username,
        password: newPass,
        role: verified.role
    });
    if (res && res.error) { showMsg(res.error); return; }

    showMsg('تم تغيير الرقم السري بنجاح', true);
    closeChangePasswordModal();
    window.alert('تم تغيير الرقم السري بنجاح');
}

async function goToStats() {
    if (!currentUser || currentUser.role !== 'stats') return;
    employeeNavigate('statistics');
}

function goBackToEmployee() {
    if (!currentUser) return;
    if (currentUser.role === 'stats' || currentUser.role === 'employee') {
        employeeNavigate('dashboard');
    }
}

function fillTestUser(username) {
    const userEl = document.getElementById('login-username');
    const passEl = document.getElementById('login-password');
    if (userEl) userEl.value = username;
    if (passEl) passEl.value = '1234';
}

function saveRememberMe(username, password, remember) {
    if (remember) {
        localStorage.setItem('rm_u', username);
        localStorage.setItem('rm_p', password);
        localStorage.setItem('rm_on', '1');
    } else {
        localStorage.removeItem('rm_u');
        localStorage.removeItem('rm_p');
        localStorage.removeItem('rm_on');
    }
}

function loadRememberMe() {
    if (localStorage.getItem('rm_on') !== '1') return;
    const u = localStorage.getItem('rm_u');
    const p = localStorage.getItem('rm_p');
    if (!u) return;
    const uEl = document.getElementById('login-username');
    const pEl = document.getElementById('login-password');
    const rEl = document.getElementById('login-remember');
    if (uEl) uEl.value = u;
    if (pEl && p) pEl.value = p;
    if (rEl) rEl.checked = true;
}

function showPostLoginSplash(navigateFn, welcomeName) {
    // Hide login screen
    const loginScreen = document.getElementById('login-screen');
    if (loginScreen) loginScreen.style.display = 'none';

    // Set welcome text
    const welcomeEl = document.getElementById('pls-welcome-text');
    if (welcomeEl) welcomeEl.textContent = welcomeName ? `مرحباً، ${welcomeName}` : 'مرحباً بك';

    // Show splash
    const splash = document.getElementById('post-login-splash');
    if (splash) splash.style.display = 'flex';

    // Navigate after 3 seconds
    setTimeout(async () => {
        if (splash) splash.style.display = 'none';
        await navigateFn();
    }, 3000);
}

async function login() {
    const usernameEl = document.getElementById('login-username');
    const passwordEl = document.getElementById('login-password');
    const errorEl   = document.getElementById('login-error');
    const rememberEl = document.getElementById('login-remember');

    const username = (usernameEl?.value || '').trim();
    const password = passwordEl?.value || '';

    // ─── تحقق من الإغلاق بسبب تجاوز عدد المحاولات ───────────────
    const _now = Date.now();
    const _att = _loginAttempts[username] || { count: 0, lockedUntil: 0 };
    if (_att.lockedUntil > _now) {
        const remaining = Math.ceil((_att.lockedUntil - _now) / 60000);
        if (errorEl) {
            errorEl.textContent = `تم تجاوز عدد المحاولات. حاول مجدداً بعد ${remaining} دقيقة`;
            errorEl.style.display = 'block';
        }
        return;
    }

    // أولاً: تحقق من حسابات DB (ضباط وموظفين وإحصائيات وأدمن)
    const dbAccount = await window.db.findAccount(username, password);
    if (dbAccount) {
        delete _loginAttempts[username];
        if (dbAccount.role === 'officer') {
            currentUser = { username: dbAccount.username, role: 'officer', officerId: dbAccount.personId };
        } else if (dbAccount.role === 'employee') {
            currentUser = { username: dbAccount.username, role: 'employee', employeeId: dbAccount.personId };
        } else if (dbAccount.role === 'stats') {
            currentUser = { username: dbAccount.username, role: 'stats', employeeId: dbAccount.personId };
        } else if (dbAccount.role === 'admin') {
            currentUser = { username: dbAccount.username, role: 'admin' };
        }
        if (currentUser && errorEl) { errorEl.style.display = 'none'; errorEl.textContent = ''; }
        if (currentUser) { saveRememberMe(username, password, rememberEl?.checked); }
        if (currentUser?.role === 'officer') {
            const off = officers.find(o => o.id == currentUser.officerId) || (await window.db.getOfficers()).find(o => o.id == currentUser.officerId);
            showPostLoginSplash(() => startOfficerApp(), off?.name);
            return;
        }
        if (currentUser?.role === 'employee' || currentUser?.role === 'stats') {
            const emp = employees.find(e => e.id == currentUser.employeeId) || (await window.db.getEmployees()).find(e => e.id == currentUser.employeeId);
            showPostLoginSplash(() => startEmployeeApp(), emp?.name);
            return;
        }
        if (currentUser?.role === 'admin') {
            showPostLoginSplash(() => startAdminApp('home'), 'المدير');
            return;
        }
    }

    // فشل المصادقة — زر عداد المحاولات
    _att.count = (_att.count || 0) + 1;
    if (_att.count >= _LOGIN_MAX) {
        _att.lockedUntil = _now + _LOGIN_LOCKOUT_MS;
        _att.count = 0;
    }
    _loginAttempts[username] = _att;
    if (errorEl) {
        errorEl.textContent = _att.lockedUntil > _now
            ? 'تم تجاوز عدد المحاولات. حاول مجدداً بعد 5 دقائق'
            : 'اسم المستخدم أو كلمة المرور غير صحيحة';
        errorEl.style.display = 'block';
    }
}

function logout() {
    currentUser = null;
    if (_adminPollInterval) { clearInterval(_adminPollInterval); _adminPollInterval = null; }
    showLoginScreen();
}

// ═══════════════════════════════════════
// إدارة حسابات الأدمن من الإعدادات
// ═══════════════════════════════════════
async function openAdminAccountsModal() {
    const modal = document.getElementById('admin-accounts-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    await renderAdminAccountsList();
}

function closeAdminAccountsModal() {
    const modal = document.getElementById('admin-accounts-modal');
    if (modal) modal.style.display = 'none';
}

async function renderAdminAccountsList() {
    const listEl = document.getElementById('admin-accounts-list');
    if (!listEl) return;
    accountsCache = await window.db.getAccounts();
    const adminAccounts = accountsCache.filter(a => a.role === 'admin');
    if (adminAccounts.length === 0) {
        listEl.innerHTML = `<div style="text-align:center;color:#9ca3af;font-size:14px;padding:20px;">لا توجد حسابات بعد</div>`;
        return;
    }
    listEl.innerHTML = adminAccounts.map(a => `
        <div style="display:flex;align-items:center;justify-content:space-between;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px 14px;">
            <div style="display:flex;align-items:center;gap:10px;">
                <div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#5856d6,#7c3aed);display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;">👤</div>
                <div>
                    <div style="font-weight:700;font-size:14px;color:#1e293b;">${a.username}</div>
                    <div style="font-size:12px;color:#64748b;">أدمن</div>
                </div>
            </div>
            <div style="display:flex;gap:8px;">
                <button onclick="openEditAdminAccountForm(${a.id})" style="background:#e0e7ff;color:#5856d6;border:none;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer;">تعديل</button>
                <button onclick="deleteAdminAccount(${a.id})" style="background:#fee2e2;color:#dc2626;border:none;border-radius:8px;padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer;">حذف</button>
            </div>
        </div>`).join('');
}

function openAddAdminAccountForm() {
    document.getElementById('admin-acc-form-title').textContent = 'إضافة حساب جديد';
    document.getElementById('admin-acc-edit-id').value = '';
    document.getElementById('admin-acc-username').value = '';
    document.getElementById('admin-acc-password').value = '';
    document.getElementById('admin-acc-pass-label').textContent = 'كلمة المرور *';
    const errEl = document.getElementById('admin-acc-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    document.getElementById('admin-account-form-modal').style.display = 'flex';
}

function openEditAdminAccountForm(accountId) {
    const acc = accountsCache.find(a => a.id === accountId);
    if (!acc) return;
    document.getElementById('admin-acc-form-title').textContent = 'تعديل الحساب';
    document.getElementById('admin-acc-edit-id').value = accountId;
    document.getElementById('admin-acc-username').value = acc.username;
    document.getElementById('admin-acc-password').value = '';
    document.getElementById('admin-acc-pass-label').textContent = 'كلمة المرور الجديدة (اتركها فارغة للإبقاء)';
    const errEl = document.getElementById('admin-acc-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    document.getElementById('admin-account-form-modal').style.display = 'flex';
}

function closeAddAdminAccountForm() {
    document.getElementById('admin-account-form-modal').style.display = 'none';
}

async function saveAdminAccount() {
    const editId = document.getElementById('admin-acc-edit-id').value;
    const username = (document.getElementById('admin-acc-username').value || '').trim();
    const password = document.getElementById('admin-acc-password').value || '';
    const role = document.getElementById('admin-acc-role').value;
    const errEl = document.getElementById('admin-acc-error');
    const showErr = (msg) => { errEl.textContent = msg; errEl.style.display = 'block'; };

    if (!username) { showErr('يرجى إدخال اسم المستخدم'); return; }
    if (username.length < 3) { showErr('اسم المستخدم قصير جداً (3 أحرف على الأقل)'); return; }

    if (editId) {
        const id = parseInt(editId);
        const existing = accountsCache.find(a => a.id === id);
        if (!password) {
            const res = await window.db.updateAccount(id, { username, password: existing?.password, role });
            if (res && res.error) { showErr(res.error); return; }
        } else {
            if (password.length < 4) { showErr('كلمة المرور يجب أن تكون 4 أحرف على الأقل'); return; }
            const res = await window.db.updateAccount(id, { username, password, role });
            if (res && res.error) { showErr(res.error); return; }
        }
        showToast('تم تحديث الحساب بنجاح ✅', 'success');
    } else {
        if (!password) { showErr('يرجى إدخال كلمة المرور'); return; }
        if (password.length < 4) { showErr('كلمة المرور يجب أن تكون 4 أحرف على الأقل'); return; }
        const res = await window.db.addAccount({ username, password, role, personId: null });
        if (res && res.error) { showErr(res.error); return; }
        showToast('تم إنشاء الحساب بنجاح ✅', 'success');
    }

    closeAddAdminAccountForm();
    await renderAdminAccountsList();
}

async function deleteAdminAccount(accountId) {
    if (!confirm('هل تريد حذف هذا الحساب؟')) return;
    await window.db.deleteAccount(accountId);
    showToast('تم حذف الحساب 🗑️', 'warning');
    await renderAdminAccountsList();
}


const STATS_FIELDS = [
    { key: 'private_count', homeId: 'qs-private', statsId: 'quick-private' },
    { key: 'special_transfer_count', homeId: 'qs-special', statsId: 'quick-special' },
    { key: 'general_transfer_count', homeId: 'qs-general', statsId: 'quick-general' },
    { key: 'motorcycles_count', homeId: 'qs-motorcycles', statsId: 'quick-motorcycles' },
    { key: 'color_change_count', homeId: 'qs-color', statsId: 'quick-color' },
    { key: 'towing_count', homeId: 'qs-towing', statsId: 'quick-towing' },
    { key: 'technical_committees_count', homeId: 'qs-technical', statsId: 'quick-technical' },
    { key: 'second_pass_count', homeId: 'qs-second', statsId: 'quick-second' },
    { key: 'third_pass_count', homeId: 'qs-third', statsId: 'quick-third' },
];
const MAIN_KEYS = ['private_count','special_transfer_count','general_transfer_count','motorcycles_count','color_change_count','towing_count'];
const COMMITTEE_KEYS = ['technical_committees_count','second_pass_count','third_pass_count'];

// تحويل الأرقام العربية والإنجليزية إلى أرقام إنجليزية
function parseArabicInt(val) {
    if (!val && val !== 0) return 0;
    const str = String(val)
        .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => d.charCodeAt(0) - 1632)
        .replace(/[۰۱۲۳۴۵۶۷۸۹]/g, d => d.charCodeAt(0) - 1776);
    return parseInt(str) || 0;
}

function normalizeInputToEnglish(input) {
    input.value = input.value
        .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => d.charCodeAt(0) - 1632)
        .replace(/[۰۱۲۳۴۵۶۷۸۹]/g, d => d.charCodeAt(0) - 1776)
        .replace(/[^\d]/g, '');
}

const StatsManager = {
    _timer: null,
    _saving: false,

    // جمع البيانات من نموذج معين
    collectFromForm(prefix) {
        const dateEl = prefix === 'home'
            ? document.getElementById('quick-stats-date')
            : document.getElementById('quick-date');
        const date = dateEl?.value;
        if (!date) return null;
        const data = { date };
        STATS_FIELDS.forEach(f => {
            const id = prefix === 'home' ? f.homeId : f.statsId;
            data[f.key] = parseArabicInt(document.getElementById(id)?.value) || 0;
        });
        return data;
    },

    // مزامنة كل النماذج من البيانات المحلية
    syncAllForms(date) {
        const record = statistics.find(s => s.date === date);
        const data = record || {};
        // مزامنة نموذج الرئيسية
        const homeDate = document.getElementById('quick-stats-date');
        if (homeDate) homeDate.value = date;
        // مزامنة نموذج الإحصائيات
        const statsDate = document.getElementById('quick-date');
        if (statsDate) statsDate.value = date;
        // مزامنة القيم
        STATS_FIELDS.forEach(f => {
            const val = data[f.key] || 0;
            const h = document.getElementById(f.homeId);
            const s = document.getElementById(f.statsId);
            if (h) h.value = val;
            if (s) s.value = val;
        });
        // مزامنة حقول اللجان في النموذج اليومي
        const dtc = document.getElementById('daily-technical-committees');
        const dsp = document.getElementById('daily-second-pass');
        const dtp = document.getElementById('daily-third-pass');
        if (dtc) dtc.value = data.technical_committees_count || 0;
        if (dsp) dsp.value = data.second_pass_count || 0;
        if (dtp) dtp.value = data.third_pass_count || 0;
        // مزامنة تاريخ النموذج اليومي
        const dailyDate = document.getElementById('daily-form-date');
        if (dailyDate) { dailyDate.value = date; lastLoadedDate = null; }
        // تحديث الإجماليات
        this.updateAllTotals();
        // تحديث الحالة
        this.updateAllStatuses(date);
    },

    // تحديث الإجماليات في كلا النموذجين
    updateAllTotals() {
        // إجماليات الرئيسية
        const homeMainIds = ['qs-private','qs-special','qs-general','qs-motorcycles','qs-color','qs-towing'];
        const homeCommIds = ['qs-technical','qs-second','qs-third'];
        const homeTotal = homeMainIds.reduce((s, id) => s + (parseArabicInt(document.getElementById(id)?.value) || 0), 0);
        const htEl = document.getElementById('qs-total');
        if (htEl) htEl.textContent = homeTotal;
        // إجماليات الإحصائيات
        const statsMainIds = ['quick-private','quick-special','quick-general','quick-motorcycles','quick-color','quick-towing'];
        const statsCommIds = ['quick-technical','quick-second','quick-third'];
        const statsTotal = statsMainIds.reduce((s, id) => s + (parseArabicInt(document.getElementById(id)?.value) || 0), 0);
        const statsComm = statsCommIds.reduce((s, id) => s + (parseArabicInt(document.getElementById(id)?.value) || 0), 0);
        const stEl = document.getElementById('quick-total');
        const scEl = document.getElementById('quick-committees-total');
        if (stEl) stEl.textContent = statsTotal;
        if (scEl) scEl.textContent = statsComm;
    },

    // تحديث حالة الحفظ
    updateAllStatuses(date) {
        const exists = statistics.find(s => s.date === date);
        const msg = exists
            ? '<span style="color:#27ae60;">✅ بيانات موجودة</span>'
            : '<span style="color:#3498db;">🆕 إدخال جديد</span>';
        const s1 = document.getElementById('quick-stats-status');
        const s2 = document.getElementById('quick-stats-status2');
        if (s1) s1.innerHTML = msg;
        if (s2) s2.innerHTML = msg;
    },

    // حفظ تلقائي مع تأخير
    autoSave(prefix) {
        this.updateAllTotals();
        clearTimeout(this._timer);
        // إظهار حالة "جاري الحفظ"
        const s1 = document.getElementById('quick-stats-status');
        const s2 = document.getElementById('quick-stats-status2');
        const savingMsg = '<span style="color:#f39c12;">⏳ جاري الحفظ...</span>';
        if (s1) s1.innerHTML = savingMsg;
        if (s2) s2.innerHTML = savingMsg;

        this._timer = setTimeout(async () => {
            const data = this.collectFromForm(prefix);
            if (!data || !data.date) return;
            try {
                this._saving = true;
                await window.db.upsertStatistics(data);
                // تحديث الكاش المحلي
                const idx = statistics.findIndex(s => s.date === data.date);
                if (idx >= 0) {
                    Object.assign(statistics[idx], data);
                } else {
                    statistics.push({ ...data, created_at: new Date().toISOString() });
                    statistics.sort((a, b) => b.date.localeCompare(a.date));
                }
                // مزامنة النموذج الآخر
                this.syncAllForms(data.date);
                // تحديث العروض
                renderDailyForm();
                renderStatisticsTable();
                renderWeeklyForm();
                updateStatisticsKPIs();
                renderHomeChart(currentChartMode);
                // حالة "تم الحفظ"
                const savedMsg = '<span style="color:#27ae60;">✅ تم الحفظ</span>';
                if (s1) s1.innerHTML = savedMsg;
                if (s2) s2.innerHTML = savedMsg;
            } catch(e) {
                console.error('خطأ في الحفظ التلقائي:', e);
                const errMsg = '<span style="color:#e74c3c;">❌ خطأ في الحفظ</span>';
                if (s1) s1.innerHTML = errMsg;
                if (s2) s2.innerHTML = errMsg;
            } finally {
                this._saving = false;
            }
        }, 300);
    },

    // حفظ تلقائي لحقول اللجان في النموذج اليومي
    autoSaveCommittee() {
        clearTimeout(this._timer);
        this._timer = setTimeout(async () => {
            const date = document.getElementById('daily-form-date')?.value;
            if (!date) return;
            const existing = statistics.find(s => s.date === date);
            if (!existing) return; // لا يمكن حفظ لجان بدون بيانات أساسية
            const data = {
                ...existing,
                technical_committees_count: parseArabicInt(document.getElementById('daily-technical-committees')?.value),
                second_pass_count: parseArabicInt(document.getElementById('daily-second-pass')?.value),
                third_pass_count: parseArabicInt(document.getElementById('daily-third-pass')?.value)
            };
            try {
                await window.db.upsertStatistics(data);
                Object.assign(existing, data);
                this.syncAllForms(date);
                renderDailyForm();
                renderStatisticsTable();
            } catch(e) {
                console.error('خطأ في حفظ اللجان:', e);
            }
        }, 300);
    },

    // تحميل بيانات تاريخ معين
    loadDate(date) {
        if (!date) return;
        this.syncAllForms(date);
        renderDailyForm();
    },

    // تغيير التاريخ من أي نموذج
    onDateChange(source) {
        let date;
        if (source === 'home') date = document.getElementById('quick-stats-date')?.value;
        else if (source === 'stats') date = document.getElementById('quick-date')?.value;
        else if (source === 'daily') date = document.getElementById('daily-form-date')?.value;
        if (!date) return;
        this.loadDate(date);
    }
};

// ═══════════════════════════════════════
// تحميل البيانات من SQLite
// ═══════════════════════════════════════
async function loadAllData() {
    try {
        const [emps, offs, lvs, stats, perms, archive, other, accs, notifs, adminNotifs, settings] = await Promise.all([
            window.db.getEmployees(),
            window.db.getOfficers(),
            window.db.getLeaves(),
            window.db.getStatistics(),
            window.db.getLeavePermissions(),
            window.db.archiveGetAll(),
            window.db.getOtherRequests(),
            window.db.getAccounts(),
            window.db.getNotifications(),
            window.db.getAdminNotifications(),
            window.db.getAppSettings()
        ]);
        employees          = emps.sort((a,b) => (a.name||'').localeCompare(b.name||'', 'ar'));
        officers           = offs;
        leaves             = lvs.map(l => ({ ...l, type: l.type || 'leave', status: normalizeApprovalStatus(l.status) }));
        statistics         = stats;
        leavePermissions   = perms;
        archiveFiles       = archive;
        otherRequests      = other;
        accountsCache      = accs;
        notificationsCache = notifs;
        adminNotifications = adminNotifs;
        appSettings        = settings || {};
        // Supabase data loaded
        updateBellBadge();
    } catch(e) {
        console.error('❌ خطأ في تحميل البيانات:', e);
    }
}

// ═══════════════════════════════════════
// Bottom Navigation
// ═══════════════════════════════════════
function bottomNavGo(page) {
    showPage(page);
}
function syncBottomNav(page) {
    var items = document.querySelectorAll('.bottom-nav-item');
    items.forEach(function(el) {
        el.classList.toggle('active', el.getAttribute('data-page') === page);
    });
}

// ═══════════════════════════════════════
// التنقل بين الصفحات - iOS Style
// ═══════════════════════════════════════
let _currentPage = '';
let _isNavigating = false;

function showArchiveChoice() {
    const existing = document.getElementById('archive-choice-modal');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'archive-choice-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:9999;display:flex;align-items:flex-end;justify-content:center;';
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `<div style="background:var(--card,#fff);border-radius:16px 16px 0 0;width:100%;max-width:400px;padding:20px 16px calc(20px + env(safe-area-inset-bottom));animation:slideUp .25s ease;">
        <div style="width:36px;height:4px;background:#d1d5db;border-radius:4px;margin:0 auto 16px;"></div>
        <div style="font-size:16px;font-weight:700;text-align:center;margin-bottom:14px;color:var(--text,#1e293b);">اختر الأرشيف</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
            <button onclick="document.getElementById('archive-choice-modal').remove();showPage('files')" style="padding:14px;font-size:15px;font-weight:600;border:none;border-radius:12px;background:linear-gradient(135deg,#556b2f,#6b8e23);color:white;cursor:pointer;">أرشيف الموظفين</button>
            <button onclick="document.getElementById('archive-choice-modal').remove();showPage('officer-files')" style="padding:14px;font-size:15px;font-weight:600;border:none;border-radius:12px;background:linear-gradient(135deg,#1a365d,#2980b9);color:white;cursor:pointer;">أرشيف الضباط</button>
        </div>
    </div>`;
    document.body.appendChild(overlay);
}

async function showPage(page) {
    if (!currentUser) return;

    const role = currentUser.role;

    // employee: ممنوع جميع صفحات الأدمن
    if (role === 'employee') return;

    // stats: مسموح صفحة الإحصائيات فقط
    if (role === 'stats' && page !== 'statistics') return;

    // admin: مسموح كل الصفحات (لا حظر)

    const currentPageEl = document.getElementById('page-' + _currentPage);
    // منع الضغط المتكرر على نفس الصفحة
    if (page === _currentPage && currentPageEl && currentPageEl.classList.contains('active')) return;
    // منع التنقل أثناء الأنيميشن
    if (_isNavigating) return;
    _isNavigating = true;

    const oldPage = document.getElementById('page-' + _currentPage);
    // تنظيف pull-to-refresh عند مغادرة صفحة الإشعارات
    if (_currentPage === 'notifications' && oldPage && oldPage._ptrCleanup) {
        oldPage._ptrCleanup();
    }

    const newPage = document.getElementById('page-' + page);
    if (!newPage) {
        _isNavigating = false;
        return;
    }

    // تحميل البيانات
    // ملاحظة: تم إزالة await loadAllData() من هنا لتحسين سرعة التنقل.
    // البيانات تُحمَّل عند الدخول وبعد كل عملية إضافة/تعديل/حذف.
    syncBottomNav(page);

    // إخراج الصفحة القديمة (slide left + fade)
    if (oldPage && oldPage !== newPage) {
        oldPage.classList.remove('active');
        oldPage.classList.add('page-exit');
    }

    // تجهيز الصفحة الجديدة (تبدأ من اليمين)
    newPage.style.transition = 'none';
    newPage.style.display = 'block';
    newPage.style.opacity = '0';
    newPage.style.transform = 'translateX(30px)';
    newPage.style.position = 'relative';
    newPage.classList.remove('page-exit');

    // force reflow
    newPage.offsetHeight;

    // إدخال الصفحة الجديدة (slide in + fade in)
    newPage.style.transition = '';
    newPage.classList.add('active');
    newPage.style.opacity = '';
    newPage.style.transform = '';

    // تنفيذ عمليات الصفحة
    if (page === 'home')             updateHome();
    if (page === 'officers')         renderOfficers();
    if (page === 'add-officer-page') clearOfficerForm();
    if (page === 'employees')        setEmployeesPeriodFilter('all');
    if (page === 'emp-dashboard')    { await loadPermissions(); renderEmpDashboard(); }
    if (page === 'files')            initFilesPage();
    if (page === 'officer-files')    initOfficerFilesPage();
    if (page === 'statistics')       await initStatisticsPage();
    if (page === 'leaves')           renderLeaves();
    if (page === 'add-leave-page')   initLeaveForm();
    if (page === 'reports')          renderReports();
    if (page === 'backups')          renderBackups();
    if (page === 'settings')         renderSettings();
    if (page === 'permissions')      renderPermissions();
    if (page === 'add-permission-page') initPermissionForm();
    if (page === 'notifications')    { renderNotificationsPage(); setupNotificationsPullToRefresh(); }
    if (page === 'profile') {
        const d = document.getElementById('profile-current-date');
        if (d) d.textContent = new Date().toLocaleDateString('ar-u-ca-gregory-nu-latn',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
    }

    window.scrollTo(0, 0);

    // تنظيف بعد انتهاء الأنيميشن
    setTimeout(() => {
        if (oldPage && oldPage !== newPage) {
            oldPage.classList.remove('page-exit');
            oldPage.style.display = '';
        }
        _currentPage = page;
        _isNavigating = false;
    }, 320);
}

// ═══════════════════════════════════════
// الرئيسية
// ═══════════════════════════════════════
function updateHome() {
    const dateEl = document.getElementById('current-date');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('ar-u-ca-gregory-nu-latn',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
    const officersOnLeave = officers.filter(o => leaves.some(l => l.person_type === 'officer' && l.person_id == o.id && getLeaveStatus(l) === 'جارية' && normalizeApprovalStatus(l.status) !== 'rejected'));
    const employeesOnLeave = employees.filter(e => leaves.some(l => l.person_type === 'employee' && l.person_id == e.id && getLeaveStatus(l) === 'جارية' && normalizeApprovalStatus(l.status) !== 'rejected'));
    document.getElementById('stat-officers').textContent = officers.length - officersOnLeave.length;
    document.getElementById('stat-employees').textContent = employees.length - employeesOnLeave.length;
    document.getElementById('stat-officers-on-leave').textContent = officersOnLeave.length;
    document.getElementById('stat-employees-on-leave').textContent = employeesOnLeave.length;
    switchChartMode(currentChartMode);
    initQuickStats();
}

const chartCategories=[
    {key:'private_count',        label:'خصوصي',     icon:'', color:'#2980b9'},
    {key:'special_transfer_count',label:'نقل خاص',  icon:'', color:'#27ae60'},
    {key:'general_transfer_count',label:'نقل عام',  icon:'', color:'#e67e22'},
    {key:'motorcycles_count',    label:'دراجات',     icon:'', color:'#8e44ad'},
    {key:'color_change_count',   label:'تغيير لون', icon:'', color:'#e74c3c'},
    {key:'towing_count',         label:'يسمح بالجر',icon:'', color:'#16a085'},
    {key:'technical_committees_count',label:'مركبات اللجان الفنية',icon:'',color:'#f39c12'},
    {key:'second_pass_count',    label:'مركبات اجتازت الفحص ثاني مرة',   icon:'', color:'#3498db'},
    {key:'third_pass_count',     label:'مركبات اجتازت الفحص ثالث مرة',   icon:'', color:'#1abc9c'}
];
let currentChartMode='daily';
function loadDailyData(){ switchChartMode('daily'); }
function loadWeeklyData(){ switchChartMode('weekly'); }
function loadMonthlyData(){ switchChartMode('monthly'); }
function switchChartMode(mode){
    currentChartMode=mode;
    document.querySelectorAll('input[name="period"]').forEach(radio=>{
        radio.checked = radio.value === mode;
    });
    const dateInput=document.getElementById('chart-date-input');
    if(dateInput){
        if(mode==='monthly'){
            dateInput.type='month';
            const _nm=new Date();
            dateInput.value=_nm.getFullYear()+'-'+String(_nm.getMonth()+1).padStart(2,'0');
            dateInput.style.background='';
        } else if(mode==='weekly'){
            dateInput.type='date';
            // ضبط التاريخ على يوم الأحد
            const d=new Date();
            const day=d.getDay();
            d.setDate(d.getDate()-(day>=0&&day<=4?day:day===5?5:6));
            dateInput.value=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
            dateInput.style.background='rgba(41,128,185,0.1)';
        } else {
            dateInput.type='date';
            const _nd=new Date();
            dateInput.value=[_nd.getFullYear(),String(_nd.getMonth()+1).padStart(2,'0'),String(_nd.getDate()).padStart(2,'0')].join('-');
            dateInput.style.background='';
        }
    }
    renderHomeChart(mode);
}
function renderHomeChart(mode){
    const dateInput=document.getElementById('chart-date-input');
    let labels=[];
    let dateLabel='';
    const catData={};
    chartCategories.forEach(c=>catData[c.key]=[]);

    function collectPeriod(statsArr){
        chartCategories.forEach(c=>{
            let total=0;
            statsArr.forEach(s=>total+=(s[c.key]||0));
            catData[c.key].push(total);
        });
    }

    if(mode==='daily'){
        const _td=new Date();
        const _todayStr=[_td.getFullYear(),String(_td.getMonth()+1).padStart(2,'0'),String(_td.getDate()).padStart(2,'0')].join('-');
        const dateVal=dateInput&&dateInput.value?dateInput.value:_todayStr;
        if(dateInput&&!dateInput.value) dateInput.value=dateVal;
        const s=statistics.find(x=>x.date===dateVal);
        collectPeriod(s?[s]:[]);
    } else if(mode==='weekly'){
        const today2=new Date();
        const todayStr=[today2.getFullYear(),String(today2.getMonth()+1).padStart(2,'0'),String(today2.getDate()).padStart(2,'0')].join('-');
        const dateVal=dateInput&&dateInput.value?dateInput.value:todayStr;
        if(dateInput&&!dateInput.value) dateInput.value=dateVal;
        const today=new Date(dateVal+'T00:00:00');
        // الأسبوع يبدأ الأحد (0) وينتهي الخميس (4)
        const day=today.getDay();
        const weekStart=new Date(today);
        weekStart.setDate(weekStart.getDate()-(day>=0&&day<=4?day:day===5?5:6));
        const arr=[];
        for(let i=0;i<5;i++){
            const d=new Date(weekStart);d.setDate(d.getDate()+i);
            const ds=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
            const s=statistics.find(x=>x.date===ds);
            if(s)arr.push(s);
        }
        collectPeriod(arr);
    } else {
        const _tm=new Date();
        const _monthDefault=_tm.getFullYear()+'-'+String(_tm.getMonth()+1).padStart(2,'0');
        const monthVal=dateInput&&dateInput.value?dateInput.value:_monthDefault;
        if(dateInput&&!dateInput.value) dateInput.value=monthVal;
        collectPeriod(statistics.filter(s=>s.date&&s.date.startsWith(monthVal)));
    }

    // Date label removed - using input instead

    // Summary cards
    const cardsEl=document.getElementById('chart-summary-cards');
    if(cardsEl){
        const totals=chartCategories.map(c=>({...c,total:catData[c.key].reduce((a,b)=>a+b,0)}));
        const committeesKeys=['technical_committees_count','second_pass_count','third_pass_count'];
        const grandTotal=totals.filter(t=>!committeesKeys.includes(t.key)).reduce((a,t)=>a+t.total,0);
        cardsEl.innerHTML=`<div style="background:linear-gradient(135deg,#2980b9,#5dade2);padding:5px;border-radius:6px;text-align:center;color:white;grid-column:span 3;box-shadow:0 2px 3px rgba(41,128,185,0.3);transition:transform 0.2s;"><div style="font-size:10px;opacity:0.8;">الإجمالي</div><div style="font-size:16px;font-weight:bold;text-shadow:0 1px 2px rgba(0,0,0,0.2);">${grandTotal}</div></div>`
            +totals.map(t=>`<div style="background:white;padding:4px;border-radius:5px;text-align:center;border-right:2px solid ${t.color};box-shadow:0 2px 4px rgba(0,0,0,0.08);transition:transform 0.2s,box-shadow 0.2s;cursor:default;" onmouseenter="this.style.transform='translateY(-2px)'" onmouseleave="this.style.transform='translateY(0)'"><div style="font-size:11px;color:#555;font-weight:bold;">${t.icon} ${t.label}</div><div style="font-size:14px;font-weight:bold;color:#2980b9;">${t.total}</div></div>`).join('');
    }
}

// ═══════════════════════════════════════
// الإدخال السريع للإحصائية (يستخدم StatsManager)
// ═══════════════════════════════════════
async function resetAllStatistics(){
    if(!confirm('هل أنت متأكد من تصفير جميع بيانات الإحصائيات؟\nسيتم حذف جميع السجلات نهائياً!')) return;
    try {
        await window.db.clearAllStatistics();
        statistics = [];
        // تصفير الحقول
        STATS_FIELDS.forEach(f => {
            const h = document.getElementById(f.homeId);
            const s = document.getElementById(f.statsId);
            if(h) h.value = 0;
            if(s) s.value = 0;
        });
        StatsManager.updateAllTotals();
        renderHomeChart(currentChartMode);
        renderDailyForm();
        renderStatisticsTable();
        renderWeeklyForm();
        updateStatisticsKPIs();
        alert('✅ تم تصفير جميع بيانات الإحصائيات بنجاح');
    } catch(e) {
        console.error('خطأ في التصفير:', e);
        alert('❌ حدث خطأ أثناء التصفير');
    }
}

function initQuickStats(){
    const _iqd=new Date();
    const today=[_iqd.getFullYear(),String(_iqd.getMonth()+1).padStart(2,'0'),String(_iqd.getDate()).padStart(2,'0')].join('-');
    const homeDate = document.getElementById('quick-stats-date');
    if (homeDate) {
        homeDate.value = today;
        StatsManager.loadDate(today);
    }
}

// دوال التوافقية (تستدعيها الكودات القديمة)
function updateQuickStatsTotal() { StatsManager.updateAllTotals(); }
function updateQuickTotal() { StatsManager.updateAllTotals(); }
function loadQuickStatsForDate(date) { StatsManager.loadDate(date); }
function loadQuickStatsForDate2(date) { StatsManager.loadDate(date); }
function syncStatsQuickEntry(date) { StatsManager.syncAllForms(date); }
function syncHomeQuickStats(date) { StatsManager.syncAllForms(date); }
function syncDailyForm(date) { StatsManager.syncAllForms(date); }
function onDailyFormDateChange() { StatsManager.onDateChange('daily'); }

async function saveQuickStats(){
    const data = StatsManager.collectFromForm('home');
    if (!data || !data.date) { showToast('أدخل التاريخ', 'error'); return; }
    await window.db.upsertStatistics(data);
    const idx = statistics.findIndex(s => s.date === data.date);
    if (idx >= 0) Object.assign(statistics[idx], data);
    else { statistics.push({...data, created_at: new Date().toISOString()}); statistics.sort((a,b) => b.date.localeCompare(a.date)); }
    StatsManager.syncAllForms(data.date);
    renderStatisticsTable(); renderWeeklyForm(); renderDailyForm(); updateStatisticsKPIs();
    showToast('✅ تم حفظ الإحصائية!', 'success');
}

async function saveQuickStatistics(){
    const btn = document.getElementById('btn-save-quick-stats');
    const data = StatsManager.collectFromForm('stats');
    if (!data || !data.date) { showToast('اختر التاريخ', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '⏳ جاري الحفظ...'; btn.style.opacity = '0.7'; }
    try {
        await window.db.upsertStatistics(data);
        const idx = statistics.findIndex(s => s.date === data.date);
        if (idx >= 0) Object.assign(statistics[idx], data);
        else { statistics.push({...data, created_at: new Date().toISOString()}); statistics.sort((a,b) => b.date.localeCompare(a.date)); }
        StatsManager.syncAllForms(data.date);
        renderStatisticsTable(); renderWeeklyForm(); renderDailyForm(); await updateStatisticsKPIs();
        showToast('✅ تم حفظ الإحصائية!', 'success');
        const s2 = document.getElementById('quick-stats-status2');
        if (s2) { s2.innerHTML = '<span style="color:#27ae60;">✅ تم الحفظ</span>'; }
    } catch(e) {
        showToast('❌ خطأ في الحفظ', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '💾 حفظ الإحصائية'; btn.style.opacity = '1'; }
    }
}

function adjustStat(id, delta) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = Math.max(0, (parseInt(el.value) || 0) + delta);
    normalizeInputToEnglish(el);
    StatsManager.updateAllTotals();
}

async function saveDailyFormData() {
    StatsManager.autoSaveCommittee();
}

// ═══════════════════════════════════════
// دوال مساعدة
// ═══════════════════════════════════════
function getRankBadge(r){return`<span class="rank-badge rank-${r||'ملازم'}">${r||'-'}</span>`;}
function getStatusBadge(s){return s==='نشط'?'badge-success':s==='إجازة'?'badge-info':s==='موقوف'?'badge-warning':'badge-danger';}
function getOfficerStatusBadge(s){return s==='نشط'?'badge-success':s==='إجازة'?'badge-info':s==='مأمورية'?'badge-warning':'badge-dark';}
function getLeaveTypeIcon(t){return t==='دورية'?'🔄':t==='إدارية'?'📋':t==='دراسية'?'📚':t==='طارئة'?'⚡':t==='حج'?'🕌':t==='مرضية'?'🏥':'📋';}
function getLeaveStatus(l){
    const t=new Date();t.setHours(0,0,0,0);
    const s=new Date(l.start_date||l.startDate);s.setHours(0,0,0,0);
    const e=new Date(l.end_date||l.endDate);e.setHours(0,0,0,0);
    return t<s?'قادمة':t<=e?'جارية':'منتهية';
}
function getLeaveStatusBadge(s){return s==='جارية'?'badge-success':s==='قادمة'?'badge-warning':'badge-danger';}
function formatFileSize(b){return b<1024?b+' B':b<1048576?(b/1024).toFixed(1)+' KB':(b/1048576).toFixed(1)+' MB';}

// ═══════════════════════════════════════
// لوحة تحكم الموظفين
// ═══════════════════════════════════════
function renderEmpDashboard() {
    // تحديث التاريخ
    const dateEl = document.getElementById('emp-dash-date');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('ar-u-ca-gregory-nu-latn', {weekday:'long', year:'numeric', month:'long', day:'numeric'});

    const today = new Date(); today.setHours(0,0,0,0);
    const currentMonth = new Date().toISOString().substring(0, 7);

    // حساب الإجازات الجارية والقادمة للموظفين فقط
    const onLeaveNow = employees.filter(e =>
        leaves.some(l => l.person_id == e.id && l.person_type === 'employee' && getLeaveStatus(l) === 'جارية' && normalizeApprovalStatus(l.status) !== 'rejected')
    );
    const upcomingLeaves = leaves.filter(l =>
        l.person_type === 'employee' && getLeaveStatus(l) === 'قادمة' && normalizeApprovalStatus(l.status) !== 'rejected'
    ).sort((a, b) => (a.start_date||'').localeCompare(b.start_date||''));

    // استئذانات هذا الشهر
    const monthPerms = leavePermissions.filter(p =>
        p.person_type !== 'officer' && (p.date||'').startsWith(currentMonth)
    );

    // توزيع الفترات
    const morningCount = employees.filter(e => e.shift === 'morning').length;
    const eveningCount = employees.filter(e => e.shift === 'evening').length;
    const unsetCount   = employees.filter(e => !e.shift).length;
    const total = employees.length || 1;

    // تحديث KPI
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setEl('edash-total', employees.length);
    setEl('edash-present', employees.length - onLeaveNow.length);
    setEl('edash-on-leave', onLeaveNow.length);
    setEl('edash-perms-month', monthPerms.length);
    setEl('edash-on-leave-badge', onLeaveNow.length);

    // شريط توزيع الفترات
    setEl('edash-morning-count', morningCount);
    setEl('edash-evening-count', eveningCount);
    setEl('edash-unset-count', unsetCount);
    const mPct = Math.round(morningCount / total * 100);
    const ePct = Math.round(eveningCount / total * 100);
    const uPct = 100 - mPct - ePct;
    const mBar = document.getElementById('edash-bar-morning');
    const eBar = document.getElementById('edash-bar-evening');
    const uBar = document.getElementById('edash-bar-unset');
    if (mBar) mBar.style.width = mPct + '%';
    if (eBar) eBar.style.width = ePct + '%';
    if (uBar) uBar.style.width = uPct + '%';
    setEl('edash-bar-morning-pct', mPct + '%');
    setEl('edash-bar-evening-pct', ePct + '%');
    setEl('edash-bar-unset-pct', uPct + '%');

    // قائمة المجازين
    const leaveListEl = document.getElementById('edash-on-leave-list');
    if (leaveListEl) {
        if (onLeaveNow.length === 0) {
            leaveListEl.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:20px;font-size:14px;">لا يوجد موظفون في إجازة</div>';
        } else {
            leaveListEl.innerHTML = onLeaveNow.map(e => {
                const lv = leaves.find(l => l.person_id == e.id && l.person_type === 'employee' && getLeaveStatus(l) === 'جارية');
                const endDate = new Date((lv.end_date||lv.endDate) + 'T00:00:00');
                const diff = Math.ceil((endDate - today) / 86400000) + 1;
                const shiftLabel = getEmployeeShiftLabel(e.shift);
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f1f5f9;" onclick="showEmployeeDetails(${e.id})" style="cursor:pointer;">
                    <div>
                        <div style="font-size:14px;font-weight:700;color:#1c1c1e;">${e.name}</div>
                        <div style="font-size:12px;color:#8e8e93;margin-top:2px;">${lv.leave_type||''} ${shiftLabel ? '• '+shiftLabel : ''}</div>
                    </div>
                    <div style="text-align:left;">
                        <div style="font-size:13px;font-weight:700;color:#ff3b30;">${diff} يوم</div>
                        <div style="font-size:11px;color:#94a3b8;">ينتهي ${lv.end_date||lv.endDate||''}</div>
                    </div>
                </div>`;
            }).join('');
        }
    }

    // استئذانات الشهر مجمّعة بالموظف
    const monthLabel = document.getElementById('edash-month-label');
    if (monthLabel) {
        const d = new Date();
        monthLabel.textContent = d.toLocaleDateString('ar-u-ca-gregory-nu-latn', {month:'long', year:'numeric'});
    }
    const permsListEl = document.getElementById('edash-perms-list');
    if (permsListEl) {
        if (monthPerms.length === 0) {
            permsListEl.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:20px;font-size:14px;">لا توجد استئذانات هذا الشهر</div>';
        } else {
            // تجميع حسب الموظف
            const byEmp = {};
            monthPerms.forEach(p => {
                const key = p.employee_id;
                if (!byEmp[key]) byEmp[key] = { name: p.employee_name || '---', count: 0 };
                byEmp[key].count++;
            });
            const sorted = Object.values(byEmp).sort((a, b) => b.count - a.count);
            permsListEl.innerHTML = sorted.map(r => {
                const pct = Math.round(r.count / 4 * 100);
                const barColor = r.count >= 4 ? '#ff3b30' : r.count >= 3 ? '#ff9500' : '#34c759';
                return `<div style="margin-bottom:10px;">
                    <div style="display:flex;justify-content:space-between;margin-bottom:3px;">
                        <span style="font-size:13px;font-weight:600;color:#1c1c1e;">${r.name}</span>
                        <span style="font-size:13px;font-weight:700;color:${barColor};">${r.count} / 4</span>
                    </div>
                    <div style="height:6px;background:#f2f2f7;border-radius:4px;overflow:hidden;">
                        <div style="width:${Math.min(pct,100)}%;height:100%;background:${barColor};border-radius:4px;transition:width 0.4s;"></div>
                    </div>
                </div>`;
            }).join('');
        }
    }

    // الإجازات القادمة
    const upcomingEl = document.getElementById('edash-upcoming-leaves');
    if (upcomingEl) {
        if (upcomingLeaves.length === 0) {
            upcomingEl.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:20px;font-size:14px;">لا توجد إجازات قادمة</div>';
        } else {
            upcomingEl.innerHTML = upcomingLeaves.slice(0, 10).map(l => {
                const emp = employees.find(e => e.id == l.person_id);
                const empName = emp ? emp.name : '---';
                const startDate = new Date((l.start_date||l.startDate) + 'T00:00:00');
                const diffDays = Math.ceil((startDate - today) / 86400000);
                return `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f1f5f9;">
                    <div>
                        <div style="font-size:14px;font-weight:700;color:#1c1c1e;">${empName}</div>
                        <div style="font-size:12px;color:#8e8e93;margin-top:2px;">${l.leave_type||''} — ${l.start_date||l.startDate||''}</div>
                    </div>
                    <div style="text-align:left;">
                        <span style="background:#e8f5e9;color:#27ae60;font-size:12px;font-weight:700;padding:3px 8px;border-radius:8px;">بعد ${diffDays} يوم</span>
                    </div>
                </div>`;
            }).join('');
        }
    }
}

// ═══════════════════════════════════════
// الضباط
// ═══════════════════════════════════════
function renderOfficers(list=officers) {
    const container = document.getElementById('officers-cards');
    if(!container) return;
    if(list.length === 0){
        container.innerHTML = '<div class="person-cards-empty">لا يوجد ضباط</div>';
        return;
    }
    container.innerHTML = list.map((o,i)=>{
        const activeLeave = leaves.find(l => l.person_id == o.id && l.person_type === 'officer' && getLeaveStatus(l) === 'جارية');
        const badgeClass = activeLeave ? 'on-leave' : 'on-duty';
        const badgeText = activeLeave ? 'إجازة' : 'متواجد';
        const badgeClick = activeLeave ? `onclick="event.stopPropagation();showLeaveDetails(${activeLeave.id})"` : '';
        const initials = (o.name||'').split(' ').slice(0,2).map(w=>w[0]||'').join('');
        return `<div class="person-card">
            <span class="person-card-num">#${i+1}</span>
            <div class="person-card-top" onclick="showOfficerDetails(${o.id})">
                <div class="person-card-info">
                    <div class="person-card-name">${o.rank ? o.rank+' ' : ''}${o.name}</div>
                    <div class="person-card-sub">${o.position || ''}</div>
                </div>
                <span class="person-card-badge ${badgeClass}" ${badgeClick}>${badgeText}</span>
            </div>
            <div class="person-card-details" onclick="showOfficerDetails(${o.id})">
                <div class="person-card-detail"><span class="person-card-detail-label">العسكري</span><span class="person-card-detail-value">${o.military_number||'-'}</span></div>
                <div class="person-card-detail"><span class="person-card-detail-label">المدني</span><span class="person-card-detail-value">${o.civil_number||'-'}</span></div>
            </div>
        </div>`;
    }).join('');
}

async function saveOfficer() {
    const name = document.getElementById('off-name').value.trim();
    if (!name) { showModalError('add-officer-modal','يرجى إدخال اسم الضابط'); return; }
    await window.db.addOfficer({
        name,
        rank:            document.getElementById('off-rank').value,
        position:        document.getElementById('off-position').value,
        military_number: document.getElementById('off-military-number').value,
        civil_number:    document.getElementById('off-civil-number').value,
        phone:           document.getElementById('off-phone').value,
        hire_date:       document.getElementById('off-hire-date').value
    });
    closeAddOfficerModal();
    await loadAllData();
    renderOfficers();
    updateHome();
    showToast(`✅ تم إضافة ${name}!`,'success');
}

function showAddOfficerModal(){
    const existing=document.getElementById('add-officer-modal');if(existing)existing.remove();
    const modal=document.createElement('div');modal.className='modal-overlay active';modal.id='add-officer-modal';
    modal.innerHTML=`<div class="modal detail-modal" style="width:100%;max-width:600px;">
    <div class="detail-header" style="background:linear-gradient(135deg,#1a365d 0%,#1e40af 100%);">
        <button class="detail-close-btn" onclick="closeAddOfficerModal()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar" style="font-size:34px;"> </div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">إضافة ضابط جديد</h2>
                <p class="detail-header-sub">تسجيل ضابط جديد في النظام</p>
            </div>
        </div>
    </div>
    <div style="padding:16px;">
        <div class="form-group" style="margin-bottom:12px;"><label>الاسم الكامل *</label><input type="text" id="off-name" placeholder="أدخل الاسم الكامل"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>الرتبة</label>
            <select id="off-rank">
                <option value="">-- اختر --</option>
                <option value="عقيد">عقيد</option>
                <option value="مقدم">مقدم</option>
                <option value="رائد">رائد</option>
                <option value="نقيب">نقيب</option>
                <option value="ملازم أول">ملازم أول</option>
                <option value="ملازم">ملازم</option>
            </select>
        </div>
        <div class="form-group" style="margin-bottom:12px;"><label>المنصب</label><input type="text" id="off-position"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>الرقم العسكري</label><input type="text" id="off-military-number"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>الرقم المدني</label><input type="text" id="off-civil-number"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>الهاتف</label><input type="tel" id="off-phone"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>تاريخ التعيين</label><input type="date" id="off-hire-date"></div>
    </div>
    <div class="detail-footer">
        <button class="btn btn-primary" style="background:#007aff;color:white;" onclick="saveOfficer()">حفظ الضابط</button>
        <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;" onclick="closeAddOfficerModal()">إلغاء</button>
    </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)closeAddOfficerModal();});
}

function closeAddOfficerModal(){const m=document.getElementById('add-officer-modal');if(m)m.remove();}

function clearOfficerForm() {
    const el=id=>document.getElementById(id);
    ['off-name','off-position','off-military-number','off-civil-number','off-phone','off-hire-date'].forEach(id=>{if(el(id))el(id).value='';});
    if(el('off-rank'))el('off-rank').value='';
}

function editOfficer(id) {
    const o = officers.find(x=>x.id===id); if(!o)return;
    const existing=document.getElementById('edit-officer-modal');if(existing)existing.remove();
    const modal=document.createElement('div');modal.className='modal-overlay active';modal.id='edit-officer-modal';

    const rankOptions = ['عقيد','مقدم','رائد','نقيب','ملازم أول','ملازم']
        .map(r=>`<option value="${r}"${o.rank===r?' selected':''}>${r}</option>`).join('');
    modal.innerHTML=`<div class="modal detail-modal" style="width:600px;">
    <div class="detail-header" style="background:linear-gradient(135deg,#1a365d 0%,#1e40af 100%);">
        <button class="detail-close-btn" onclick="closeEditOfficerModal()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar" style="font-size:34px;">✏️</div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">تعديل بيانات ضابط</h2>
                <p class="detail-header-sub">${o.name}</p>
            </div>
        </div>
    </div>
    <div style="padding:24px 28px;">
        <input type="hidden" id="edit-off-id" value="${o.id}">
        <div class="form-group" style="margin-bottom:14px;"><label>الاسم الكامل *</label><input type="text" id="edit-off-name" value="${o.name||''}"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>الرتبة</label>
                <select id="edit-off-rank">${rankOptions}</select>
            </div>
            <div class="form-group"><label>المنصب</label><input type="text" id="edit-off-position" value="${o.position||''}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>الرقم العسكري</label><input type="text" id="edit-off-military-number" value="${o.military_number||''}"></div>
            <div class="form-group"><label>الرقم المدني</label><input type="text" id="edit-off-civil-number" value="${o.civil_number||''}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>الهاتف</label><input type="tel" id="edit-off-phone" value="${o.phone||''}"></div>
            <div class="form-group"><label>تاريخ التعيين</label><input type="date" id="edit-off-hire-date" value="${o.hire_date||''}"></div>
        </div>
    </div>
    <div class="detail-footer">
        <button class="btn btn-primary" onclick="updateOfficer()">💾 حفظ التعديلات</button>
        <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;" onclick="closeEditOfficerModal()">إلغاء</button>
    </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)closeEditOfficerModal();});
}

function closeEditOfficerModal(){const m=document.getElementById('edit-officer-modal');if(m)m.remove();}

async function updateOfficer() {
    const id = parseInt(document.getElementById('edit-off-id').value);
    await window.db.updateOfficer(id, {
        name:            document.getElementById('edit-off-name').value,
        rank:            document.getElementById('edit-off-rank').value,
        position:        document.getElementById('edit-off-position').value,
        military_number: document.getElementById('edit-off-military-number').value,
        civil_number:    document.getElementById('edit-off-civil-number').value,
        phone:           document.getElementById('edit-off-phone').value,
        hire_date:       document.getElementById('edit-off-hire-date').value
    });
    closeEditOfficerModal();
    await loadAllData();
    renderOfficers();
    updateHome();
    showToast('✅ تم التعديل!','success');
}

async function deleteOfficer(id) {
    const o = officers.find(x=>x.id===id); if(!o)return;
    if (confirm(`حذف ${o.name}؟`)) {
        await window.db.deleteOfficer(id);
        await loadAllData();
        renderOfficers();
        updateHome();
        showToast('🗑️ تم الحذف','warning');
    }
}

function searchOfficers(q) {
    renderOfficers(officers.filter(o=>o.name.includes(q)||(o.rank&&o.rank.includes(q))||(o.military_number&&o.military_number.includes(q))));
}

function exportOfficers() {
    let csv='رقم,الاسم,الرتبة,المنصب,الرقم_العسكري,الرقم_المدني,الهاتف\n';
    officers.forEach((o,i)=>csv+=`${i+1},"${o.name}","${o.rank||''}","${o.position||''}","${o.military_number||''}","${o.civil_number||''}","${o.phone||''}"\n`);
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'}));a.download=`Officers_${Date.now()}.csv`;a.click();
    showToast('✅ تم التصدير!','success');
}

function importOfficersCSV(){
    var input=document.createElement('input');
    input.type='file';input.accept='.csv,.txt,*/*';
    input.style.position='fixed';input.style.top='-9999px';input.style.opacity='0';
    document.body.appendChild(input);
    input.onchange=function(){
        var file=input.files[0];document.body.removeChild(input);
        if(!file){return;}
        var reader=new FileReader();
        reader.onload=function(){
            (async function(){
                try{
                    var text=reader.result;
                    var lines=text.split(/\r?\n/).filter(function(l){return l.trim();});
                    if(lines.length<2){showToast('❌ الملف فارغ','error');return;}
                    var added=0,skipped=0;
                    var addPromises=[];
                    for(var i=1;i<lines.length;i++){
                        var cols=parseCSVLine(lines[i]);
                        if(cols.length<2||!cols[1].trim())continue;
                        var name=cols[1].trim();
                        if(officers.find(function(o){return o.name===name;})){skipped++;continue;}
                        addPromises.push(window.db.addOfficer({
                            name:name,
                            rank:cols[2]?cols[2].trim():'',
                            position:cols[3]?cols[3].trim():'',
                            military_number:cols[4]?cols[4].trim():'',
                            civil_number:cols[5]?cols[5].trim():'',
                            phone:cols[6]?cols[6].trim():''
                        }));
                        added++;
                    }
                    await Promise.all(addPromises);
                    await loadAllData();
                    renderOfficers();
                    showToast('✅ تم استيراد '+added+' ضابط'+( skipped?' (تم تخطي '+skipped+' مكرر)':''),'success');
                }catch(err){
                    console.error('CSV import error:',err);
                    showToast('❌ خطأ: '+err.message,'error');
                }
            })();
        };
        reader.readAsText(file);
    };
    setTimeout(function(){input.click();},100);
}

async function showOfficerDetails(id) {
    const o=officers.find(x=>x.id===id);if(!o)return;
    const offFiles=officerArchiveFiles.filter(f=>f.officer_id===o.id);
    const offLeaves=leaves.filter(l=>l.person_id==o.id&&l.person_type==='officer'&&getLeaveStatus(l)!=='منتهية'&&normalizeApprovalStatus(l.status)!=='rejected');
    const offPerms=leavePermissions.filter(p=>p.employee_id==o.id&&p.person_type==='officer');
    const offNotes=await window.db.getNotes(o.id);

    const filesList=offFiles.map(f=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f1f5f9;"><span style="color:#334155;font-size:15px;">${getFileIcon(f.file_type)} ${f.file_name}</span>${getArchiveTypeBadge(f.type)}</div>`).join('');

    const dataFields = [
        ['الاسم', o.name],
        ['الرتبة', o.rank||'-'],
        ['المنصب', o.position||'-'],
        ['الرقم العسكري', o.military_number||'-'],
        ['الرقم المدني', o.civil_number||'-'],
        ['الهاتف', o.phone||'-']
    ].map(([label, value]) => {
        const fullWidth = label === 'الاسم' ? 'grid-column:1/-1;' : '';
        return `<div class="data-field" style="${fullWidth}"><div style="flex:1;"><div class="data-field-label">${label}</div><div class="data-field-value">${value}</div></div></div>`;
    }).join('');

    let leavesHtml = '';
    if(offLeaves.length===0) {
        leavesHtml = `<div class="detail-empty"><div class="detail-empty-icon">📋</div><div class="detail-empty-text">لا توجد إجازات حالية</div><button class="btn btn-primary" style="border-radius:10px;" onclick="openAddLeaveForPerson(${o.id},'officer')">إضافة إجازة</button></div>`;
    } else {
        leavesHtml = '<div style="max-height:320px;overflow-y:auto;padding:2px;">' + offLeaves.map(l=>`<div class="leave-card" onclick="closeOfficerDetails();showLeaveDetails(${l.id})"><div class="leave-card-info"><strong>${l.leave_type}</strong><div class="leave-date">${l.start_date} ← ${l.end_date}</div></div><div class="leave-card-stats"><div class="leave-card-days">${l.days}</div><div class="leave-card-label">يوم</div><span class="badge ${getLeaveStatusBadge(getLeaveStatus(l))}" style="font-size:12px;">${getLeaveStatus(l)}</span></div></div>`).join('') + '</div>';
    }

    let permsHtml = '';
    if(offPerms.length===0) {
        permsHtml = `<div class="detail-empty"><div class="detail-empty-icon">🕐</div><div class="detail-empty-text">لا توجد استئذانات</div></div>`;
    } else {
        permsHtml = '<div style="max-height:320px;overflow-y:auto;padding:2px;">' + offPerms.map(p=>`<div class="perm-card"><div><strong style="color:#1e293b;font-size:15px;">${p.type==='start'?'تأخير بداية':'باقي الزام'}</strong><div style="color:#94a3b8;font-size:14px;margin-top:2px;">${p.date}</div></div></div>`).join('') + '</div>';
    }

    const modal=document.createElement('div');modal.className='modal-overlay active';modal.id='officer-details-modal';
    modal.innerHTML=`<div class="modal detail-modal">
    <div class="detail-header" style="background:linear-gradient(135deg,#1a365d 0%,#1e40af 100%);">
        <button class="detail-close-btn" onclick="closeOfficerDetails()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar">👮</div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">${o.name}</h2>
                <p class="detail-header-sub">${o.position||'غير محدد'}</p>
                <div class="detail-header-badges">
                    ${o.rank ? `<span class="detail-badge">${o.rank}</span>` : ''}
                    <span class="detail-badge ${offLeaves.some(l=>getLeaveStatus(l)==='جارية')?'warning':'success'}">${offLeaves.some(l=>getLeaveStatus(l)==='جارية')?'إجازة':'متواجد'}</span>
                </div>
            </div>
            <div class="detail-id-card">
                <div class="detail-id-label">الرقم المدني</div>
                <div class="detail-id-value">${o.civil_number||'-'}</div>
            </div>
        </div>
    </div>
    <div class="detail-tabs">
        <button class="detail-tab active" id="btn-offtab-info" onclick="switchOfficerTab('offtab-info')">البيانات</button>
        <button class="detail-tab" id="btn-offtab-leaves" onclick="switchOfficerTab('offtab-leaves')">الإجازات <span class="tab-count">${offLeaves.length}</span></button>
        <button class="detail-tab" id="btn-offtab-perms" onclick="switchOfficerTab('offtab-perms')">الاستئذانات <span class="tab-count">${offPerms.length}</span></button>
        <button class="detail-tab" id="btn-offtab-files" onclick="switchOfficerTab('offtab-files')">الملفات <span class="tab-count">${offFiles.length}</span></button>
        <button class="detail-tab" id="btn-offtab-notes" onclick="switchOfficerTab('offtab-notes')">الملاحظات <span class="tab-count">${offNotes.length}</span></button>
    </div>
    <div class="modal-body" style="padding:12px 14px;overflow-y:auto;flex:1;">
        <div id="offtab-info">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                ${dataFields}
            </div>
        </div>
        <div id="offtab-leaves" style="display:none;">
            ${leavesHtml}
        </div>
        <div id="offtab-perms" style="display:none;">
            ${permsHtml}
        </div>
        <div id="offtab-files" style="display:none;">
            <div style="max-height:320px;overflow-y:auto;border-radius:12px;border:1px solid #e2e8f0;">${filesList||'<div class="detail-empty"><div class="detail-empty-icon">📁</div><div class="detail-empty-text">لا توجد ملفات</div></div>'}</div>
        </div>
        <div id="offtab-notes" style="display:none;">
            <div class="note-add-area">
                <textarea id="new-note-text-off-${o.id}" placeholder="اكتب ملاحظتك هنا..."></textarea>
                <div style="display:flex;justify-content:flex-end;margin-top:10px;">
                    <button class="btn btn-primary" style="border-radius:10px;font-size:14px;padding:7px 16px;" onclick="addOfficerNote(${o.id})">حفظ الملاحظة</button>
                </div>
            </div>
            <div id="notes-list-off-${o.id}">${renderNotesList(offNotes,'off-'+o.id)}</div>
        </div>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#007aff;color:white;" onclick="closeOfficerDetails();editOfficer(${o.id})">تعديل</button>
        <button class="btn" style="background:#ff9500;color:white;" onclick="openAddLeaveForPerson(${o.id},'officer')">إضافة إجازة</button>
        <button class="btn" style="background:#5856d6;color:white;" onclick="openManageAccountModal('officer',${o.id},'${(o.name||'').replace(/'/g,"\\'")}')">🔑 حساب</button>
        <button class="btn btn-spacer" style="background:#ff3b30;color:white;" onclick="closeOfficerDetails();deleteOfficer(${o.id})">حذف</button>
        <button class="btn" style="background:#8e8e93;color:white;" onclick="closeOfficerDetails()">إغلاق</button>
    </div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)closeOfficerDetails();});
}

function switchOfficerTab(tabId){
    ['offtab-info','offtab-files','offtab-leaves','offtab-perms','offtab-notes'].forEach(id=>{
        const el=document.getElementById(id);if(el)el.style.display='none';
        const btn=document.getElementById('btn-'+id);if(btn)btn.className='detail-tab';
    });
    document.getElementById(tabId).style.display='block';
    document.getElementById('btn-'+tabId).className='detail-tab active';
}

async function addOfficerNote(offId){
    const textarea=document.getElementById(`new-note-text-off-${offId}`);
    const text=textarea.value.trim();
    if(!text){showToast('اكتب الملاحظة أولاً','error');return;}
    await window.db.addNote(offId,text);
    textarea.value='';
    const notes=await window.db.getNotes(offId);
    const list=document.getElementById(`notes-list-off-${offId}`);
    if(list)list.innerHTML=renderNotesList(notes,'off-'+offId);
    showToast('✅ تم حفظ الملاحظة!','success');
}

function closeOfficerDetails() {
    const m=document.getElementById('officer-details-modal');
    if(m) m.remove();
}

async function openAddLeaveForPerson(id, type) {
    await loadAllData();
    showAddLeaveModal(type, id);
}

async function deleteLeaveFromDetails(id) {
    if(!confirm('حذف الإجازة؟')) return;
    await window.db.deleteLeave(id);
    leaves = await window.db.getLeaves();
    updateHome();
    showToast('تم حذف الإجازة','warning');
}

// ═══════════════════════════════════════
// دوال مساعدة عامة
// ═══════════════════════════════════════
function copyToClipboard(text, label='') {
    navigator.clipboard.writeText(text).then(() => {
        showToast(`✅ تم نسخ ${label || 'البيانات'}!`, 'success');
    }).catch(() => {
        // للمتصفحات القديمة
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast(`✅ تم نسخ ${label || 'البيانات'}!`, 'success');
    });
}

// ═══════════════════════════════════════
// الموظفين
// ═══════════════════════════════════════
function getEffectiveStatus(e) {
    const hasActiveLeave = leaves.some(l => l.person_id == e.id && l.person_type === 'employee' && getLeaveStatus(l) === 'جارية');
    return hasActiveLeave ? 'إجازة' : (e.status || 'نشط');
}
let employeesPeriodFilter = 'all';

function getEmployeeShiftLabel(shift) {
    return shift === 'morning' ? 'صبح' : shift === 'evening' ? 'عصر' : '';
}

function applyEmployeesFilters() {
    const searchInput = document.getElementById('employees-search-input');
    const q = ((searchInput && searchInput.value) || '').trim();
    return employees.filter(e => {
        const matchesPeriod = employeesPeriodFilter === 'all' || (e.shift || '') === employeesPeriodFilter;
        const matchesSearch = !q || e.name.includes(q) || (e.department && e.department.includes(q)) || (e.phone && e.phone.includes(q)) || (e.position && e.position.includes(q)) || (getEmployeeShiftLabel(e.shift) && getEmployeeShiftLabel(e.shift).includes(q));
        return matchesPeriod && matchesSearch;
    });
}

function setEmployeesPeriodFilter(period) {
    employeesPeriodFilter = period;
    [['all','employees-filter-all'],['morning','employees-filter-morning'],['evening','employees-filter-evening']].forEach(([value, id]) => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('active', value === period);
    });
    renderEmployees();
}

function renderEmployees(list) {
    const employeeList = arguments.length ? list : applyEmployeesFilters();
    const container = document.getElementById('employees-cards');
    if(!container) return;
    if(employeeList.length === 0){
        container.innerHTML = '<div class="person-cards-empty">لا يوجد موظفين</div>';
        return;
    }
    container.innerHTML = employeeList.map((e,i)=>{
        const activeLeave = leaves.find(l => l.person_id == e.id && l.person_type === 'employee' && getLeaveStatus(l) === 'جارية');
        const badgeClass = activeLeave ? 'on-leave' : 'on-duty';
        const badgeText = activeLeave ? 'إجازة' : 'متواجد';
        const badgeClick = activeLeave ? `onclick="event.stopPropagation();showLeaveDetails(${activeLeave.id})"` : '';
        const initials = (e.name||'').split(' ').slice(0,2).map(w=>w[0]||'').join('');
        const shiftLabel = getEmployeeShiftLabel(e.shift);
        return `<div class="person-card employee-card">
            <span class="person-card-num">#${i+1}</span>
            <div class="person-card-top" onclick="showEmployeeDetails(${e.id})">
                <div class="person-card-info">
                    <div class="person-card-name">${e.name}</div>
                    <div class="person-card-sub">${e.department||''}${e.position ? ' • '+e.position : ''}${shiftLabel ? ' • '+shiftLabel : ''}</div>
                </div>
                <span class="person-card-badge ${badgeClass}" ${badgeClick}>${badgeText}</span>
            </div>
            <div class="person-card-details" onclick="showEmployeeDetails(${e.id})">
                <div class="person-card-detail"><span class="person-card-detail-label">المدني</span><span class="person-card-detail-value">${e.number||'-'}</span></div>
                <div class="person-card-detail"><span class="person-card-detail-label">الهاتف</span><span class="person-card-detail-value">${e.phone||'-'}</span></div>
            </div>
        </div>`;
    }).join('');
}

async function saveEmployee() {
    const name = document.getElementById('new-emp-name').value.trim();
    if (!name) { showModalError('add-employee-modal','يرجى إدخال اسم الموظف'); return; }
    await window.db.addEmployee({
        name,
        number:     document.getElementById('new-emp-number').value,
        department: document.getElementById('new-emp-department').value,
        shift:      document.getElementById('new-emp-shift').value,
        position:   document.getElementById('new-emp-position').value,
        hire_date:  document.getElementById('new-emp-hire-date').value,
        phone:      document.getElementById('new-emp-phone').value,
        status:     'نشط'
    });
    closeAddEmployeeModal();
    await loadAllData();
    renderEmployees();
    updateHome();
    showToast(`✅ تم إضافة ${name}!`,'success');
}

function showAddEmployeeModal(){
    const existing=document.getElementById('add-employee-modal');if(existing)existing.remove();
    const modal=document.createElement('div');modal.className='modal-overlay active';modal.id='add-employee-modal';
    modal.innerHTML=`<div class="modal detail-modal" style="width:100%;max-width:600px;">
    <div class="detail-header" style="background:linear-gradient(135deg,#2d3a1a 0%,#556b2f 100%);">
        <button class="detail-close-btn" onclick="closeAddEmployeeModal()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar" style="font-size:34px;"> </div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">إضافة موظف جديد</h2>
                <p class="detail-header-sub">تسجيل موظف جديد في النظام</p>
            </div>
        </div>
    </div>
    <div style="padding:16px;">
        <div class="form-group" style="margin-bottom:12px;"><label>الاسم *</label><input type="text" id="new-emp-name"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>الرقم المدني</label><input type="text" id="new-emp-number"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>القسم</label><input type="text" id="new-emp-department"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>الفترة</label><select id="new-emp-shift"><option value="">غير محدد</option><option value="morning">فترة الصبح</option><option value="evening">فترة العصر</option></select></div>
        <div class="form-group" style="margin-bottom:12px;"><label>المسمى</label><input type="text" id="new-emp-position"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>تاريخ التوظيف</label><input type="date" id="new-emp-hire-date"></div>
        <div class="form-group" style="margin-bottom:12px;"><label>الهاتف</label><input type="tel" id="new-emp-phone"></div>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#556b2f;color:white;" onclick="saveEmployee()">حفظ الموظف</button>
        <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;" onclick="closeAddEmployeeModal()">إلغاء</button>
    </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)closeAddEmployeeModal();});
}

function closeAddEmployeeModal(){const m=document.getElementById('add-employee-modal');if(m)m.remove();}

function editEmployee(id) {
    const emp=employees.find(e=>e.id===id);if(!emp)return;
    const existing=document.getElementById('edit-employee-modal');if(existing)existing.remove();
    const modal=document.createElement('div');modal.className='modal-overlay active';modal.id='edit-employee-modal';

    modal.innerHTML=`<div class="modal detail-modal" style="width:600px;">
    <div class="detail-header" style="background:linear-gradient(135deg,#2d3a1a 0%,#556b2f 100%);">
        <button class="detail-close-btn" onclick="closeEditEmployeeModal()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar" style="font-size:34px;">✏️</div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">تعديل بيانات موظف</h2>
                <p class="detail-header-sub">${emp.name}</p>
            </div>
        </div>
    </div>
    <div style="padding:24px 28px;">
        <input type="hidden" id="edit-emp-id" value="${emp.id}">
        <div class="form-group" style="margin-bottom:14px;"><label>الاسم *</label><input type="text" id="edit-emp-name" value="${emp.name||''}"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>الرقم المدني</label><input type="text" id="edit-emp-number" value="${emp.number||''}"></div>
            <div class="form-group"><label>القسم</label><input type="text" id="edit-emp-department" value="${emp.department||''}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>الفترة</label><select id="edit-emp-shift"><option value="" ${!emp.shift ? 'selected' : ''}>غير محدد</option><option value="morning" ${emp.shift==='morning' ? 'selected' : ''}>فترة الصبح</option><option value="evening" ${emp.shift==='evening' ? 'selected' : ''}>فترة العصر</option></select></div>
            <div class="form-group"><label>المسمى</label><input type="text" id="edit-emp-position" value="${emp.position||''}"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>تاريخ التوظيف</label><input type="date" id="edit-emp-hire-date" value="${emp.hire_date||''}"></div>
            <div class="form-group"><label>الهاتف</label><input type="tel" id="edit-emp-phone" value="${emp.phone||''}"></div>
        </div>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#556b2f;color:white;" onclick="updateEmployee()">💾 حفظ التعديلات</button>
        <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;" onclick="closeEditEmployeeModal()">إلغاء</button>
    </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)closeEditEmployeeModal();});
}

function closeEditEmployeeModal(){const m=document.getElementById('edit-employee-modal');if(m)m.remove();}

async function updateEmployee() {
    const id = parseInt(document.getElementById('edit-emp-id').value);
    await window.db.updateEmployee(id, {
        name:       document.getElementById('edit-emp-name').value,
        number:     document.getElementById('edit-emp-number').value,
        department: document.getElementById('edit-emp-department').value,
        shift:      document.getElementById('edit-emp-shift').value,
        position:   document.getElementById('edit-emp-position').value,
        hire_date:  document.getElementById('edit-emp-hire-date').value,
        phone:      document.getElementById('edit-emp-phone').value
    });
    closeEditEmployeeModal();
    await loadAllData();
    renderEmployees();
    updateHome();
    showToast('✅ تم التعديل!','success');
}

async function deleteEmployee(id) {
    const emp=employees.find(e=>e.id===id);if(!emp)return;
    if(confirm(`حذف ${emp.name}؟`)){
        await window.db.deleteEmployee(id);
        await loadAllData();
        renderEmployees();
        updateHome();
        showToast('🗑️ تم الحذف','warning');
    }
}

function searchEmployees(q){renderEmployees();}

function exportEmployees(){
    let csv='رقم,الاسم,الرقم,القسم,الفترة,المسمى,الهاتف,الحالة\n';
    employees.forEach((e,i)=>csv+=`${i+1},"${e.name}","${e.number||''}","${e.department||''}","${getEmployeeShiftLabel(e.shift)||''}","${e.position||''}","${e.phone||''}","${e.status||''}"\n`);
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'}));a.download=`Employees_${Date.now()}.csv`;a.click();
    showToast('✅ تم التصدير!','success');
}

function printEmployeesList(){
    const filtered = applyEmployeesFilters();
    if(filtered.length === 0){
        showToast('لا توجد بيانات موظفين للطباعة','error');
        return;
    }
    const searchInput = document.getElementById('employees-search-input');
    const searchText = ((searchInput && searchInput.value) || '').trim();
    const filterLabel = employeesPeriodFilter === 'morning' ? 'فترة الصبح' : employeesPeriodFilter === 'evening' ? 'فترة العصر' : 'الكل';
    const printData = {
        title: 'قائمة الموظفين',
        filterLabel: filterLabel,
        searchText: searchText,
        rows: filtered.map(function(emp, index){
            return {
                index: index + 1,
                name: emp.name || '-',
                number: emp.number || '-',
                department: emp.department || '-',
                shift: getEmployeeShiftLabel(emp.shift) || '-',
                position: emp.position || '-',
                phone: emp.phone || '-'
            };
        })
    };
    window.db.printEmployeesListReport(printData).then(function(res){
        if(res && res.cancelled) showToast('تم إلغاء الطباعة','error');
        else showToast('تم إرسال قائمة الموظفين إلى الطابعة','success');
    }).catch(function(err){
        console.error('Employee print error:', err);
        showToast('حدث خطأ أثناء طباعة الموظفين','error');
    });
}

function importEmployeesCSV(){
    var input=document.createElement('input');
    input.type='file';input.accept='.csv,.txt,*/*';
    input.style.position='fixed';input.style.top='-9999px';input.style.opacity='0';
    document.body.appendChild(input);
    input.onchange=function(){
        var file=input.files[0];document.body.removeChild(input);
        if(!file){return;}
        var reader=new FileReader();
        reader.onload=function(){
            (async function(){
                try{
                    var text=reader.result;
                    var lines=text.split(/\r?\n/).filter(function(l){return l.trim();});
                    if(lines.length<2){showToast('❌ الملف فارغ','error');return;}
                    var added=0,skipped=0;
                    var addPromises=[];
                    for(var i=1;i<lines.length;i++){
                        var cols=parseCSVLine(lines[i]);
                        if(cols.length<2||!cols[1].trim())continue;
                        var name=cols[1].trim();
                        if(employees.find(function(e){return e.name===name;})){skipped++;continue;}
                        addPromises.push(window.db.addEmployee({
                            name:name,
                            number:cols[2]?cols[2].trim():'',
                            department:cols[3]?cols[3].trim():'',
                            shift:cols[4]&&(cols[4].trim()==='فترة الصبح'||cols[4].trim()==='صبح')?'morning':cols[4]&&(cols[4].trim()==='فترة العصر'||cols[4].trim()==='عصر')?'evening':'',
                            position:cols[5]?cols[5].trim():'',
                            phone:cols[6]?cols[6].trim():'',
                            status:cols[7]?cols[7].trim():'نشط'
                        }));
                        added++;
                    }
                    await Promise.all(addPromises);
                    await loadAllData();
                    renderEmployees();
                    showToast('✅ تم استيراد '+added+' موظف'+(skipped?' (تم تخطي '+skipped+' مكرر)':''),'success');
                }catch(err){
                    console.error('CSV import error:',err);
                    showToast('❌ خطأ: '+err.message,'error');
                }
            })();
        };
        reader.readAsText(file);
    };
    setTimeout(function(){input.click();},100);
}

// تحليل سطر CSV مع دعم الأعمدة بين علامات اقتباس
function parseCSVLine(line){
    var result=[],current='',inQuotes=false;
    for(var i=0;i<line.length;i++){
        var ch=line[i];
        if(inQuotes){
            if(ch==='"'){if(i+1<line.length&&line[i+1]==='"'){current+='"';i++;}else{inQuotes=false;}}
            else{current+=ch;}
        }else{
            if(ch==='"'){inQuotes=true;}
            else if(ch===','){result.push(current);current='';}
            else{current+=ch;}
        }
    }
    result.push(current);
    return result;
}

async function showEmployeeDetails(id) {
    const emp=employees.find(e=>e.id===id);if(!emp)return;
    const empFiles=archiveFiles.filter(f=>f.employee_id===emp.id);
    const empLeaves=leaves.filter(l=>l.person_id==emp.id&&l.person_type==='employee'&&getLeaveStatus(l)!=='منتهية'&&normalizeApprovalStatus(l.status)!=='rejected');
    const empPerms=leavePermissions.filter(p=>p.employee_id==emp.id&&p.person_type==='employee');
    const empNotes=await window.db.getNotes(emp.id);

    const filesList=empFiles.map(f=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-bottom:1px solid #f1f5f9;"><span style="color:#334155;font-size:15px;">${getFileIcon(f.file_type)} ${f.file_name}</span>${getArchiveTypeBadge(f.type)}</div>`).join('');

    const dataFields = [
        ['الاسم', emp.name],
        ['الرقم المدني', emp.number||'-'],
        ['القسم', emp.department||'-'],
        ['الفترة', getEmployeeShiftLabel(emp.shift)||'-'],
        ['المسمى الوظيفي', emp.position||'-'],
        ['تاريخ التوظيف', emp.hire_date||'-'],
        ['الهاتف', emp.phone||'-']
    ].map(([label, value]) => {
        const fullWidth = label === 'الاسم' ? 'grid-column:1/-1;' : '';
        return `<div class="data-field" style="${fullWidth}"><div style="flex:1;"><div class="data-field-label">${label}</div><div class="data-field-value">${value}</div></div></div>`;
    }).join('');

    let leavesHtml = '';
    if(empLeaves.length===0) {
        leavesHtml = `<div class="detail-empty"><div class="detail-empty-icon">📋</div><div class="detail-empty-text">لا توجد إجازات حالية</div><button class="btn" style="background:#556b2f;color:white;border-radius:10px;" onclick="openAddLeaveForPerson(${emp.id},'employee')">إضافة إجازة</button></div>`;
    } else {
        leavesHtml = '<div style="max-height:320px;overflow-y:auto;padding:2px;">' + empLeaves.map(l=>`<div class="leave-card" onclick="closeEmployeeDetails();showLeaveDetails(${l.id})"><div class="leave-card-info"><strong>${l.leave_type}</strong><div class="leave-date">${l.start_date} ← ${l.end_date}</div></div><div class="leave-card-stats"><div class="leave-card-days">${l.days}</div><div class="leave-card-label">يوم</div><span class="badge ${getLeaveStatusBadge(getLeaveStatus(l))}" style="font-size:12px;">${getLeaveStatus(l)}</span></div></div>`).join('') + '</div>';
    }

    let permsHtml = '';
    if(empPerms.length===0) {
        permsHtml = `<div class="detail-empty"><div class="detail-empty-icon">🕐</div><div class="detail-empty-text">لا توجد استئذانات</div></div>`;
    } else {
        permsHtml = '<div style="max-height:320px;overflow-y:auto;padding:2px;">' + empPerms.map(p=>`<div class="perm-card"><div><strong style="color:#1e293b;font-size:15px;">${p.type==='start'?'بداية الدوام':'نهاية الدوام'}</strong><div style="color:#94a3b8;font-size:14px;margin-top:2px;">${p.date}</div></div></div>`).join('') + '</div>';
    }

    const modal=document.createElement('div');modal.className='modal-overlay active';modal.id='employee-details-modal';
    modal.innerHTML=`<div class="modal detail-modal">
    <div class="detail-header" style="background:linear-gradient(135deg,#2d3a1a 0%,#556b2f 100%);">
        <button class="detail-close-btn" onclick="closeEmployeeDetails()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar">👤</div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">${emp.name}</h2>
                <p class="detail-header-sub">${emp.position||'-'} — ${emp.department||'-'}</p>
                <div class="detail-header-badges">
                    <span class="detail-badge ${leaves.some(l=>l.person_id==emp.id&&l.person_type==='employee'&&getLeaveStatus(l)==='جارية')?'warning':'success'}">${leaves.some(l=>l.person_id==emp.id&&l.person_type==='employee'&&getLeaveStatus(l)==='جارية')?'إجازة':'متواجد'}</span>
                </div>
            </div>
            <div class="detail-id-card">
                <div class="detail-id-label">الرقم المدني</div>
                <div class="detail-id-value">${emp.number||'-'}</div>
            </div>
        </div>
    </div>
    <div class="detail-tabs">
        <button class="detail-tab active" id="btn-tab-info" onclick="switchTab('tab-info')">البيانات</button>
        <button class="detail-tab" id="btn-tab-leaves" onclick="switchTab('tab-leaves')">الإجازات <span class="tab-count">${empLeaves.length}</span></button>
        <button class="detail-tab" id="btn-tab-perms" onclick="switchTab('tab-perms')">الاستئذانات <span class="tab-count">${empPerms.length}</span></button>
        <button class="detail-tab" id="btn-tab-files" onclick="switchTab('tab-files')">الملفات <span class="tab-count">${empFiles.length}</span></button>
        <button class="detail-tab" id="btn-tab-notes" onclick="switchTab('tab-notes')">الملاحظات <span class="tab-count">${empNotes.length}</span></button>
    </div>
    <div class="modal-body" style="padding:12px 14px;overflow-y:auto;flex:1;">
        <div id="tab-info">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                ${dataFields}
            </div>
        </div>
        <div id="tab-leaves" style="display:none;">
            ${leavesHtml}
        </div>
        <div id="tab-perms" style="display:none;">
            ${permsHtml}
        </div>
        <div id="tab-files" style="display:none;">
            <div style="max-height:320px;overflow-y:auto;border-radius:12px;border:1px solid #e2e8f0;">${filesList||'<div class="detail-empty"><div class="detail-empty-icon">📁</div><div class="detail-empty-text">لا توجد ملفات</div></div>'}</div>
        </div>
        <div id="tab-notes" style="display:none;">
            <div class="note-add-area">
                <textarea id="new-note-text-${emp.id}" placeholder="اكتب ملاحظتك هنا..."></textarea>
                <div style="display:flex;justify-content:flex-end;margin-top:10px;">
                    <button class="btn" style="background:#556b2f;color:white;border-radius:10px;font-size:14px;padding:7px 16px;" onclick="addNote(${emp.id})">حفظ الملاحظة</button>
                </div>
            </div>
            <div id="notes-list-${emp.id}">${renderNotesList(empNotes,emp.id)}</div>
        </div>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#007aff;color:white;" onclick="closeEmployeeDetails();editEmployee(${emp.id})">تعديل</button>
        <button class="btn" style="background:#ff9500;color:white;" onclick="openAddLeaveForPerson(${emp.id},'employee')">إضافة إجازة</button>
        <button class="btn" style="background:#5856d6;color:white;" onclick="openManageAccountModal('employee',${emp.id},'${(emp.name||'').replace(/'/g,"\\'")}')">🔑 حساب</button>
        <button class="btn btn-spacer" style="background:#ff3b30;color:white;" onclick="closeEmployeeDetails();deleteEmployee(${emp.id})">حذف</button>
        <button class="btn" style="background:#8e8e93;color:white;" onclick="closeEmployeeDetails()">إغلاق</button>
    </div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)closeEmployeeDetails();});
}

function closeEmployeeDetails(){const m=document.getElementById('employee-details-modal');if(m)m.remove();}

function switchTab(tabId){
    ['tab-info','tab-files','tab-leaves','tab-perms','tab-notes'].forEach(id=>{
        const el=document.getElementById(id);if(el)el.style.display='none';
        const btn=document.getElementById('btn-'+id);if(btn)btn.className='detail-tab';
    });
    document.getElementById(tabId).style.display='block';
    document.getElementById('btn-'+tabId).className='detail-tab active';
}

function renderNotesList(notesList, empId){
    if(notesList.length===0) return '<div class="detail-empty"><div class="detail-empty-icon">📝</div><div class="detail-empty-text">لا توجد ملاحظات</div></div>';
    return notesList.map(note=>`
        <div style="background:white;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <span style="font-size:13px;color:#94a3b8;">${note.created_at}</span>
                <button onclick="deleteNote(${note.id},'${empId}')" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:16px;padding:2px 6px;border-radius:6px;transition:background 0.2s;" onmouseover="this.style.background='#fef2f2'" onmouseout="this.style.background='none'">حذف</button>
            </div>
            <div style="color:#334155;font-size:15px;background:#f8fafc;padding:10px 12px;border-radius:8px;line-height:1.6;">${note.text}</div>
        </div>`).join('');
}

async function addNote(empId){
    const textarea=document.getElementById(`new-note-text-${empId}`);
    const text=textarea.value.trim();
    if(!text){showToast('اكتب الملاحظة أولاً','error');return;}
    await window.db.addNote(empId,text);
    textarea.value='';
    const notes=await window.db.getNotes(empId);
    const list=document.getElementById(`notes-list-${empId}`);
    if(list)list.innerHTML=renderNotesList(notes,empId);
    showToast('✅ تم حفظ الملاحظة!','success');
}

async function deleteNote(noteId,empId){
    if(confirm('حذف الملاحظة؟')){
        await window.db.deleteNote(noteId);
        const numericId=String(empId).replace('off-','');
        const notes=await window.db.getNotes(Number(numericId));
        const list=document.getElementById(`notes-list-${empId}`);
        if(list)list.innerHTML=renderNotesList(notes,empId);
        showToast('🗑️ تم الحذف','warning');
    }
}

// ═══════════════════════════════════════
// نظام أرشفة الموظفين
// ═══════════════════════════════════════
let currentArchiveEmployee = null;
let currentEmpArchive = [];

async function initFilesPage(){
    await loadAllData();
    archiveFiles = await window.db.archiveGetAll();
    await loadCustomTypes();
    switchArchiveTab('dashboard');
}

function switchArchiveTab(tab){
    ['dashboard','employees','all'].forEach(t=>{
        document.getElementById('arch-panel-'+t).style.display='none';
        document.getElementById('arch-tab-'+t).className='archive-tab';
    });
    document.getElementById('arch-panel-employee-detail').style.display='none';
    document.getElementById('arch-panel-'+tab).style.display='block';
    document.getElementById('arch-tab-'+tab).className='archive-tab active';
    // تحديث الإحصائيات
    document.getElementById('arch-stat-employees').textContent=employees.length;
    document.getElementById('arch-stat-files').textContent=archiveFiles.length;
    document.getElementById('arch-stat-leaves').textContent=archiveFiles.filter(f=>f.type==='leave').length;
    document.getElementById('arch-stat-perms').textContent=archiveFiles.filter(f=>f.type==='permission').length;
    if(tab==='dashboard') renderArchiveDashboard();
    if(tab==='employees') renderArchiveEmployees();
    if(tab==='all') initArchiveAllTab();
}

async function renderArchiveDashboard(){
    await renderCustomTypeCards();
}

let customArchiveTypes = [];

async function loadCustomTypes(){
    customArchiveTypes = await window.db.customTypesGetAll();
}

const defaultArchiveTypes = [
    {key:'leave', name:'الإجازات', desc:'إجازات دورية، مرضية، إدارية', color:'#2ecc71', btnColor:'#16a34a'},
    {key:'permission', name:'الاستئذانات', desc:'طلبات الاستئذان والمغادرات', color:'#f39c12', btnColor:'#d97706'},
    {key:'document', name:'المستندات', desc:'عقود، تقارير، مدنية، مراسلات', color:'#3498db', btnColor:'#2563eb'}
];

function getHiddenTypes() { return appSettings.hiddenArchiveTypes || []; }
async function setHiddenTypes(arr) { appSettings.hiddenArchiveTypes = arr; await window.db.saveAppSettings({ hiddenArchiveTypes: arr }); }

async function renderCustomTypeCards(){
    await loadCustomTypes();
    const hidden = getHiddenTypes();
    
    // بطاقات الأنواع الأساسية
    const builtinCards = defaultArchiveTypes.filter(t=>!hidden.includes(t.key)).map(t=>`<div class="archive-quick-card" onclick="filterByCustomType('${t.key}')" style="border-top:3px solid ${t.color};position:relative;">
            <button onclick="event.stopPropagation();hideBuiltinType('${t.key}')" style="position:absolute;top:8px;left:8px;background:none;border:none;color:#cbd5e1;cursor:pointer;font-size:18px;padding:2px 6px;border-radius:4px;" onmouseover="this.style.color='#ef4444'" onmouseout="this.style.color='#cbd5e1'">✕</button>
            <h4 class="archive-quick-title">${t.name}</h4>
            <p class="archive-quick-desc">${t.desc}</p>
            <span class="archive-quick-btn" style="color:${t.btnColor};">عرض الملفات ←</span>
        </div>`).join('');
    
    // بطاقات الأنواع المخصصة
    const customCards = customArchiveTypes.map(t=>`<div class="archive-quick-card" onclick="filterByCustomType('${t.key}')" style="border-top:3px solid ${t.color};position:relative;">
            <button onclick="event.stopPropagation();deleteCustomType(${t.id})" style="position:absolute;top:8px;left:8px;background:none;border:none;color:#cbd5e1;cursor:pointer;font-size:18px;padding:2px 6px;border-radius:4px;" onmouseover="this.style.color='#ef4444'" onmouseout="this.style.color='#cbd5e1'">✕</button>
            <h4 class="archive-quick-title">${t.name}</h4>
            <span class="archive-quick-btn" style="color:${t.color};">عرض الملفات ←</span>
        </div>`).join('');
    
    // زر الإضافة + زر استعادة المخفية
    const addBtn = `<div class="archive-quick-card" onclick="showAddCustomTypeModal()" style="border-top:3px solid #9ca3af;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;">
            <h4 class="archive-quick-title" style="font-size:30px;margin-bottom:4px;color:#9ca3af;">+</h4>
            <p class="archive-quick-desc" style="margin:0;">إضافة نوع ملف جديد</p>
        </div>`;
    const restoreBtn = hidden.length>0 ? `<div class="archive-quick-card" onclick="restoreHiddenTypes()" style="border-top:3px solid #9ca3af;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;">
            <h4 class="archive-quick-title" style="font-size:22px;margin-bottom:4px;color:#9ca3af;">↩</h4>
            <p class="archive-quick-desc" style="margin:0;">استعادة الأنواع المخفية (${hidden.length})</p>
        </div>` : '';
    
    const allCards = builtinCards + customCards + addBtn + restoreBtn;
    
    const empGrid = document.getElementById('arch-all-types-grid');
    const offGrid = document.getElementById('off-arch-all-types-grid');
    if(empGrid) empGrid.innerHTML = allCards;
    if(offGrid) offGrid.innerHTML = allCards.replace(/filterByCustomType/g,'filterByCustomTypeOff');
    updateTypeFilters();
    updateUploadTypeOptions();
}

function hideBuiltinType(key){
    if(!confirm('إخفاء هذا النوع من لوحة التحكم؟')) return;
    const hidden = getHiddenTypes();
    if(!hidden.includes(key)) hidden.push(key);
    setHiddenTypes(hidden).then(() => renderCustomTypeCards());
    showToast('تم الإخفاء - يمكنك الاستعادة من زر "استعادة"','success');
}

function restoreHiddenTypes(){
    setHiddenTypes([]).then(() => renderCustomTypeCards());
    showToast('تم استعادة جميع الأنواع','success');
}

function filterByCustomType(key){
    switchArchiveTab('all');
    document.getElementById('arch-type-filter').value=key;
    renderArchiveAll();
}
function filterByCustomTypeOff(key){
    switchOffArchiveTab('all');
    document.getElementById('off-arch-type-filter').value=key;
    renderOffArchiveAll();
}

function showAddCustomTypeModal(){
    const colors = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db','#9b59b6','#e84393','#6b7280','#1e40af'];
    const modal = document.createElement('div');
    modal.className='modal-overlay active';
    modal.id='add-custom-type-modal';
    modal.innerHTML=`<div class="modal" style="max-width:450px;">
        <div class="modal-header"><h2>إضافة نوع ملف جديد</h2><button class="modal-close" onclick="document.getElementById('add-custom-type-modal').remove()">✕</button></div>
        <div style="margin-bottom:18px;">
            <label style="font-size:15px;font-weight:bold;color:#555;display:block;margin-bottom:8px;">اسم النوع</label>
            <input type="text" id="custom-type-name" placeholder="مثال: تقرير طبي، شهادة..." style="width:100%;padding:12px;border:2px solid #e0e0e0;border-radius:8px;font-size:16px;" autofocus>
        </div>
        <div style="margin-bottom:18px;">
            <label style="font-size:15px;font-weight:bold;color:#555;display:block;margin-bottom:8px;">اللون</label>
            <div id="color-picker-grid" style="display:flex;flex-wrap:wrap;gap:10px;">
                ${colors.map((c,i)=>`<div onclick="selectCustomTypeColor('${c}')" class="custom-color-opt" data-color="${c}" style="width:36px;height:36px;border-radius:10px;background:${c};cursor:pointer;border:3px solid ${i===0?'#1e293b':'transparent'};transition:border .15s;"></div>`).join('')}
            </div>
        </div>
        <div class="modal-footer">
            <button class="arch-soft-btn arch-btn-delete" onclick="document.getElementById('add-custom-type-modal').remove()">إلغاء</button>
            <button class="arch-soft-btn arch-btn-view" onclick="saveCustomType()">حفظ</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    window._selectedCustomColor = colors[0];
}

function selectCustomTypeColor(c){
    window._selectedCustomColor = c;
    document.querySelectorAll('.custom-color-opt').forEach(el=>{
        el.style.border = el.dataset.color===c ? '3px solid #1e293b' : '3px solid transparent';
    });
}

async function saveCustomType(){
    const name = document.getElementById('custom-type-name')?.value.trim();
    if(!name){showToast('أدخل اسم النوع','error');return;}
    const key = 'custom_'+Date.now();
    const color = window._selectedCustomColor || '#6b7280';
    await window.db.customTypesAdd({key, name, color});
    document.getElementById('add-custom-type-modal')?.remove();
    showToast('تم إضافة النوع بنجاح','success');
    await renderCustomTypeCards();
}

async function deleteCustomType(id){
    if(!confirm('حذف هذا النوع؟')) return;
    await window.db.customTypesDelete(id);
    showToast('تم حذف النوع','warning');
    await renderCustomTypeCards();
}

function updateTypeFilters(){
    const customOpts = customArchiveTypes.map(t=>`<option value="${t.key}">${t.name}</option>`).join('');
    ['arch-type-filter','off-arch-type-filter','off-arch-type-detail-filter'].forEach(id=>{
        const sel = document.getElementById(id);
        if(!sel) return;
        // remove old custom options
        sel.querySelectorAll('option[data-custom]').forEach(o=>o.remove());
        // add new
        customOpts && sel.insertAdjacentHTML('beforeend', customOpts.replace(/<option/g,'<option data-custom="1"'));
    });
}

function updateUploadTypeOptions(){
    const customOpts = customArchiveTypes.map(t=>`<option value="${t.key}" data-custom="1">${t.name}</option>`).join('');
    ['arch-upload-type','off-arch-upload-type'].forEach(id=>{
        const sel = document.getElementById(id);
        if(!sel) return;
        sel.querySelectorAll('option[data-custom]').forEach(o=>o.remove());
        const customOpt = sel.querySelector('option[value="custom"]');
        if(customOpt) customOpt.insertAdjacentHTML('beforebegin', customOpts);
    });
}

function renderArchiveEmployees(){
    const search = (document.getElementById('arch-emp-search')?.value||'').toLowerCase();
    const empList = employees.filter(e=>!search||e.name.toLowerCase().includes(search));
    
    const empFileCounts = {};
    archiveFiles.forEach(f=>{
        if(!empFileCounts[f.employee_id]) empFileCounts[f.employee_id]={total:0,leave:0,permission:0,document:0};
        empFileCounts[f.employee_id].total++;
        empFileCounts[f.employee_id][f.type]=(empFileCounts[f.employee_id][f.type]||0)+1;
    });
    
    document.getElementById('arch-employees-grid').innerHTML = empList.length===0
        ? '<div style="grid-column:1/-1;" class="archive-empty">لا يوجد موظفين</div>'
        : empList.map(e=>{
            const counts = empFileCounts[e.id]||{total:0,leave:0,permission:0,document:0};
            return `<div onclick="showArchiveEmployeeDetail(${e.id})" class="archive-quick-card" style="border-top:3px solid ${counts.total>0?'#6b8e23':'#e2e8f0'};">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <h4 style="color:#1e293b;margin:0;font-size:16px;font-weight:600;">${e.name}</h4>
                    <span style="background:${counts.total>0?'#6b8e23':'#cbd5e1'};color:white;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:bold;">${counts.total}</span>
                </div>
                <div style="color:#94a3b8;font-size:14px;margin-bottom:10px;">${e.department||'-'} | ${e.position||'-'}</div>
                <div style="display:flex;gap:8px;font-size:13px;">
                    <span style="background:#f0fdf4;color:#16a34a;padding:3px 8px;border-radius:6px;">إجازة ${counts.leave}</span>
                    <span style="background:#fffbeb;color:#d97706;padding:3px 8px;border-radius:6px;">استئذان ${counts.permission}</span>
                    <span style="background:#eff6ff;color:#2563eb;padding:3px 8px;border-radius:6px;">مستند ${counts.document}</span>
                </div>
            </div>`;
        }).join('');
}

async function initArchiveAllTab(){
    const empSel = document.getElementById('arch-emp-filter');
    empSel.innerHTML = '<option value="">-- الكل --</option>';
    employees.forEach(e=>empSel.innerHTML+=`<option value="${e.id}">${e.name}</option>`);
    renderArchiveAll();
}

async function renderArchiveAll(){
    const empId = document.getElementById('arch-emp-filter')?.value;
    const type = document.getElementById('arch-type-filter')?.value;
    const search = (document.getElementById('arch-file-search')?.value||'').toLowerCase();
    
    let filtered = archiveFiles.filter(f=>
        (!empId||f.employee_id==empId)&&
        (!type||f.type===type)&&
        (!search||f.file_name.toLowerCase().includes(search)||(f.employee_name||'').toLowerCase().includes(search)||(f.notes||'').toLowerCase().includes(search))
    );
    
    document.getElementById('arch-all-table').innerHTML = filtered.length===0
        ? '<div class="arch-list-empty">لا توجد ملفات</div>'
        : filtered.map(f=>`<div class="arch-file-item">
            <div class="arch-file-info">
                <div class="arch-file-name">${f.file_name}</div>
                <div class="arch-file-meta">
                    ${getArchiveTypeBadge(f.type)}
                    <span style="cursor:pointer;color:#3b82f6;" onclick="showArchiveEmployeeDetail(${f.employee_id})">${f.employee_name||'غير محدد'}</span>
                    <span>${f.file_size||'-'}</span>
                    <span>${f.created_at||'-'}</span>
                    ${f.notes?`<span>${f.notes}</span>`:''}
                </div>
            </div>
            <div class="arch-file-actions">
                <button class="arch-soft-btn arch-btn-view" onclick="viewArchiveFile(${f.id})">عرض</button>
                <button class="arch-soft-btn arch-btn-download" onclick="downloadArchiveFile(${f.id})">تحميل</button>
                <button class="arch-soft-btn arch-btn-delete" onclick="deleteArchiveFile(${f.id})">حذف</button>
            </div>
        </div>`).join('');
}

async function showArchiveEmployeeDetail(empId){
    currentArchiveEmployee = empId;
    const emp = employees.find(e=>e.id==empId);
    if(!emp){showToast('الموظف غير موجود','error');return;}
    
    ['dashboard','employees','all'].forEach(t=>{
        document.getElementById('arch-panel-'+t).style.display='none';
        document.getElementById('arch-tab-'+t).className='archive-tab';
    });
    document.getElementById('arch-panel-employee-detail').style.display='block';
    
    document.getElementById('arch-emp-name').textContent = emp.name;
    document.getElementById('arch-emp-info').textContent = `${emp.department||'-'} | ${emp.position||'-'} | الرقم: ${emp.number||'-'}`;
    
    const empFiles = await window.db.archiveGetByEmployee(empId);
    document.getElementById('arch-emp-file-count').textContent = empFiles.length;
    document.getElementById('arch-emp-leave-count').textContent = empFiles.filter(f=>f.type==='leave').length;
    document.getElementById('arch-emp-perm-count').textContent = empFiles.filter(f=>f.type==='permission').length;
    document.getElementById('arch-emp-doc-count').textContent = empFiles.filter(f=>f.type==='document').length;
    
    renderEmployeeFiles();
}

async function renderEmployeeFiles(){
    if(!currentArchiveEmployee) return;
    const typeFilter = document.getElementById('arch-emp-type-filter')?.value;
    let empFiles = await window.db.archiveGetByEmployee(currentArchiveEmployee);
    if(typeFilter) empFiles = empFiles.filter(f=>f.type===typeFilter);
    
    document.getElementById('arch-emp-files-table').innerHTML = empFiles.length===0
        ? '<div class="arch-list-empty">لا توجد ملفات<br><br><button class="arch-soft-btn arch-btn-view" onclick="archiveUploadForCurrentEmployee()">رفع ملف</button></div>'
        : empFiles.map(f=>`<div class="arch-file-item">
            <div class="arch-file-info">
                <div class="arch-file-name">${f.file_name}</div>
                <div class="arch-file-meta">
                    ${getArchiveTypeBadge(f.type)}
                    <span>${f.file_size||'-'}</span>
                    <span>${f.created_at||'-'}</span>
                    ${f.notes?`<span>${f.notes}</span>`:''}
                </div>
            </div>
            <div class="arch-file-actions">
                <button class="arch-soft-btn arch-btn-view" onclick="viewArchiveFile(${f.id})">عرض</button>
                <button class="arch-soft-btn arch-btn-download" onclick="downloadArchiveFile(${f.id})">تحميل</button>
                <button class="arch-soft-btn arch-btn-delete" onclick="deleteArchiveFile(${f.id})">حذف</button>
            </div>
        </div>`).join('');
}

function getArchiveTypeBadge(type){
    if(type==='leave') return '<span class="arch-file-type arch-file-type-leave">إجازة</span>';
    if(type==='permission') return '<span class="arch-file-type arch-file-type-permission">استئذان</span>';
    if(type==='document') return '<span class="arch-file-type arch-file-type-document">مستند</span>';
    const custom = customArchiveTypes.find(t=>t.key===type);
    if(custom) return `<span class="arch-file-type" style="background:${custom.color}20;color:${custom.color};">${custom.name}</span>`;
    return `<span class="arch-file-type arch-file-type-other">${type||'أخرى'}</span>`;
}

function getArchiveTypeColor(type){
    if(type==='leave') return '#2ecc71';
    if(type==='permission') return '#f39c12';
    return '#3498db';
}

async function archiveUploadFile(preselectedEmpId=null, preselectedType=null){
    await ensureDataLoaded({ employees: true, officers: false });
    const existing=document.getElementById('archive-upload-modal');if(existing)existing.remove();
    const typeOpts = defaultArchiveTypes.filter(t=>!getHiddenTypes().includes(t.key)).map(t=>`<option value="${t.key}" ${preselectedType===t.key?'selected':''}>${t.name}</option>`).join('')
        + customArchiveTypes.map(t=>`<option value="${t.key}" ${preselectedType===t.key?'selected':''}>${t.name}</option>`).join('')
        + '<option value="custom">نوع آخر...</option>';
    const modal=document.createElement('div');
    modal.className='modal-overlay active';modal.id='archive-upload-modal';
    modal.innerHTML=`<div class="modal detail-modal">
    <div class="detail-header" style="background:linear-gradient(135deg,#3d5a1e 0%,#6b8e23 100%);">
        <button class="detail-close-btn" onclick="closeArchiveUpload()">✕</button>
        <div class="detail-header-content">
            <div class="detail-header-info">
                <h2 class="detail-header-name">رفع ملف للأرشيف</h2>
                <p class="detail-header-sub">رفع ملف جديد لأرشيف الموظفين</p>
            </div>
        </div>
    </div>
    <div style="padding:24px 28px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>الموظف *</label>
                <select id="arch-upload-emp">
                    <option value="">-- اختر الموظف --</option>
                    ${employees.map(e=>`<option value="${e.id}" ${preselectedEmpId==e.id?'selected':''}>${e.name}</option>`).join('')}
                </select>
            </div>
            <div class="form-group"><label>نوع الملف *</label>
                <select id="arch-upload-type" onchange="toggleCustomType('arch-upload')">
                    ${typeOpts}
                </select>
                <input type="text" id="arch-upload-custom-type" placeholder="اكتب نوع الملف..." style="display:none;margin-top:8px;">
            </div>
        </div>
        <div class="form-group" style="margin-bottom:14px;"><label>ملاحظات</label>
            <input type="text" id="arch-upload-notes" placeholder="ملاحظة اختيارية...">
        </div>
        <div style="margin-bottom:14px;">
            <label style="font-weight:600;color:#3d5a1e;display:block;margin-bottom:6px;font-size:15px;">اختر الملفات *</label>
            <div id="arch-drop-zone" style="border:2px dashed #d1d5db;border-radius:12px;padding:24px;text-align:center;cursor:pointer;transition:all 0.3s;background:#f8fafc;" onclick="document.getElementById('arch-upload-files').click()">
                <div style="color:#94a3b8;font-size:15px;">اسحب الملفات هنا أو اضغط للاختيار</div>
                <div style="font-size:13px;color:#cbd5e1;margin-top:4px;">pdf, jpg, png, doc, docx, xlsx (الحد 10MB)</div>
            </div>
            <input type="file" id="arch-upload-files" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xlsx,.tiff" style="display:none;">
            <div id="arch-files-preview" style="margin-top:10px;"></div>
        </div>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#6b8e23;color:white;" id="arch-upload-btn" onclick="processArchiveUpload()">رفع</button>
        <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;" onclick="closeArchiveUpload()">إلغاء</button>
    </div>
    </div>`;
    document.body.appendChild(modal);
    
    const dropZone=document.getElementById('arch-drop-zone');
    const filesInput=document.getElementById('arch-upload-files');
    
    function updatePreview(){
        const files=Array.from(filesInput.files);
        document.getElementById('arch-upload-btn').textContent=`رفع (${files.length} ملف)`;
        document.getElementById('arch-files-preview').innerHTML=files.map(f=>`
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">
                <div><div style="font-weight:600;font-size:14px;color:#1e293b;">${f.name}</div><div style="font-size:13px;color:#94a3b8;">${formatFileSize(f.size)}</div></div>
            </div>
        `).join('');
    }
    
    dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.style.borderColor='#6b8e23';dropZone.style.background='#f0fdf4';});
    dropZone.addEventListener('dragleave',()=>{dropZone.style.borderColor='#d1d5db';dropZone.style.background='#f8fafc';});
    dropZone.addEventListener('drop',e=>{e.preventDefault();filesInput.files=e.dataTransfer.files;updatePreview();dropZone.style.borderColor='#d1d5db';dropZone.style.background='#f8fafc';});
    filesInput.addEventListener('change',updatePreview);
    modal.addEventListener('click',e=>{if(e.target===modal)closeArchiveUpload();});
}

function closeArchiveUpload(){
    const m=document.getElementById('archive-upload-modal');if(m)m.remove();
}

function toggleCustomType(prefix){
    const sel=document.getElementById(prefix+'-type');
    const inp=document.getElementById(prefix+'-custom-type');
    inp.style.display=sel.value==='custom'?'block':'none';
    if(sel.value==='custom') inp.focus();
}

function archiveUploadForCurrentEmployee(){
    archiveUploadFile(currentArchiveEmployee);
}

async function processArchiveUpload(){
    const empId=document.getElementById('arch-upload-emp').value;
    let type=document.getElementById('arch-upload-type').value;
    if(type==='custom'){
        type=document.getElementById('arch-upload-custom-type').value.trim();
        if(!type){showToast('اكتب نوع الملف','error');return;}
    }
    const notes=document.getElementById('arch-upload-notes').value;
    const filesEl=document.getElementById('arch-upload-files');
    
    if(!empId){showToast('اختر الموظف أولاً','error');return;}
    const selectedFiles=Array.from(filesEl.files);
    if(selectedFiles.length===0){showToast('اختر ملف واحد على الأقل','error');return;}
    
    closeArchiveUpload();
    
    let processed=0, failed=0;
    for(const file of selectedFiles){
        const prep = await prepareFileForUpload(file);
        if (!prep) { failed++; continue; }
        try{
            const newArchive = {
                person_id: parseInt(empId),
                employee_id: parseInt(empId),
                date: new Date().toISOString().slice(0, 10),
                status: 'pending',
                type,
                file_name: prep.name,
                file_data: prep.dataUrl,
                file_size: formatFileSize(prep.size),
                file_type: file.type,
                notes
            };
            await window.db.archiveUpload({
                employee_id: parseInt(empId),
                person_id: parseInt(empId),
                date: newArchive.date,
                status: newArchive.status,
                type,
                file_name: prep.name,
                file_data: prep.dataUrl,
                file_size: formatFileSize(prep.size),
                file_type: file.type,
                notes
            });
            addArchive(newArchive);
            processed++;
        }catch(err){
            failed++;
            console.error('Upload error:', err);
        }
    }
    
    archiveFiles = await window.db.archiveGetAll();
    
    if(document.getElementById('arch-panel-employee-detail').style.display!=='none'){
        showArchiveEmployeeDetail(empId);
    }
    
    showToast(`✅ تم رفع ${processed} ملف بنجاح${failed>0?' (فشل '+failed+')':''}`, processed>0?'success':'error');
}

async function viewArchiveFile(id){
    const file=await window.db.archiveReadFile(id);
    if(!file||!file.data){showToast('لا يمكن قراءة الملف','error');return;}

    // استخرج نوع MIME من data URL أو file_type أو الامتداد
    const mimeFromData = (file.data.match(/^data:([^;]+);/) || [])[1] || '';
    const rawType = mimeFromData || file.file_type || '';
    const ext = (file.file_name || '').split('.').pop().toLowerCase();
    const isImage = rawType.includes('image') || ['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext);
    const isPDF   = rawType.includes('pdf')   || ext === 'pdf';

    // PDF: فتح في تاب جديد لأن iframe لا يعمل على الموبايل
    if (isPDF) {
        const blob = dataURLtoBlob(file.data);
        const url  = URL.createObjectURL(blob);
        window.open(url, '_blank');
        showToast('📄 جارٍ فتح ملف PDF', 'info');
        return;
    }

    const officeExts = ['xlsx','xls','doc','docx','ppt','pptx','csv'];
    const isOffice = officeExts.includes(ext);
    const officeIconMap = { xlsx:'📊', xls:'📊', doc:'📝', docx:'📝', ppt:'📑', pptx:'📑', csv:'📋' };
    const officeIcon = officeIconMap[ext] || '📁';

    const modal=document.createElement('div');
    modal.className='modal-overlay active';modal.id='arch-view-modal';
    modal.innerHTML=`<div class="modal" style="width:95vw;max-width:600px;max-height:90vh;overflow-y:auto;">
        <div class="modal-header">
            <div><h2>${getFileIcon(rawType)} ${file.file_name}</h2>
            <div style="font-size:14px;color:#999;margin-top:5px;">${getArchiveTypeBadge(file.type)} | 📅 ${(file.created_at||'').slice(0,10)||'-'}</div></div>
            <button class="modal-close" onclick="document.getElementById('arch-view-modal').remove()">✕</button>
        </div>
        <div style="text-align:center;padding:20px;min-height:200px;">
            ${isImage
                ? `<img src="${file.data}" style="max-width:100%;max-height:70vh;border-radius:8px;box-shadow:0 2px 15px rgba(0,0,0,0.1);">`
                : `<div style="padding:30px 20px;color:#64748b;">
                    <div style="font-size:64px;margin-bottom:12px;">${isOffice ? officeIcon : '📁'}</div>
                    <p style="font-size:15px;font-weight:600;margin-bottom:6px;">${file.file_name}</p>
                    <p style="font-size:13px;color:#94a3b8;margin-bottom:20px;">هذا النوع لا يمكن معاينته — قم بالتحميل لفتحه</p>
                  </div>`}
        </div>
        <div class="modal-footer">
            <button class="btn btn-primary" onclick="downloadArchiveFile(${id})">⬇️ تحميل</button>
            ${isImage ? `<button class="print-btn-neo" onclick="printArchiveFile(${id})">🖨️ طباعة</button>` : ''}
            <button class="btn btn-danger" onclick="document.getElementById('arch-view-modal').remove()">✕ إغلاق</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
}

function dataURLtoBlob(dataURL) {
    const [header, base64] = dataURL.split(',');
    const mime = (header.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
    const binary = atob(base64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

async function downloadArchiveFile(id){
    const file=await window.db.archiveReadFile(id);
    if(!file||!file.data){showToast('لا يمكن قراءة الملف','error');return;}
    const a=document.createElement('a');
    a.href=file.data;
    a.download=file.file_name;
    a.click();
    showToast(`✅ جاري تحميل ${file.file_name}`,'success');
}

async function printArchiveFile(id){
    const file=await window.db.archiveReadFile(id);
    if(!file||!file.data){showToast('لا يمكن قراءة الملف','error');return;}
    const isImage=file.file_type&&file.file_type.includes('image');
    if(isImage){
        const printWindow=window.open('','print');
        printWindow.document.write(`<!DOCTYPE html><html dir="rtl"><head><title>طباعة</title><style>body{margin:0;padding:10px;text-align:center;}img{max-width:95%;max-height:95vh;}@media print{body{padding:0;}}</style></head><body><img src="${file.data}"></body></html>`);
        printWindow.document.close();
        printWindow.print();
    }else{
        const printWindow=window.open(file.data,'print');
        if(printWindow) printWindow.print();
    }
    showToast('🖨️ فتح نافذة الطباعة','success');
}

async function deleteArchiveFile(id){
    if(!confirm('هل تريد حذف هذا الملف؟')) return;
    await window.db.archiveDelete(id);
    archiveFiles = await window.db.archiveGetAll();
    
    if(document.getElementById('arch-panel-employee-detail').style.display!=='none' && currentArchiveEmployee){
        showArchiveEmployeeDetail(currentArchiveEmployee);
    } else if(document.getElementById('arch-panel-all').style.display!=='none'){
        renderArchiveAll();
    } else {
        renderArchiveDashboard();
    }
    showToast('🗑️ تم حذف الملف','warning');
}

async function archiveScanFolder(){
    showToast('📠 جاري فتح مجلد الماسح الضوئي...','info');
    const scannedFiles = await window.db.archiveScanFolder();
    if(!scannedFiles||scannedFiles.length===0){
        showToast('لا توجد ملفات في المجلد المحدد','error');
        return;
    }
    
    const modal=document.createElement('div');
    modal.className='modal-overlay active';modal.id='scan-modal';
    modal.innerHTML=`<div class="modal" style="max-width:600px;">
        <div class="modal-header"><h2>📠 ملفات الماسح الضوئي (${scannedFiles.length} ملف)</h2><button class="modal-close" onclick="document.getElementById('scan-modal').remove()">✕</button></div>
        <div style="margin-bottom:15px;">
            <label style="font-size:15px;font-weight:bold;color:#555;display:block;margin-bottom:8px;">👤 اختر الموظف *</label>
            <select id="scan-emp" style="width:100%;padding:12px;border:2px solid #e0e0e0;border-radius:8px;font-size:16px;">
                <option value="">-- اختر الموظف --</option>
                ${employees.map(e=>`<option value="${e.id}">${e.name}</option>`).join('')}
            </select>
        </div>
        <div style="margin-bottom:15px;">
            <label style="font-size:15px;font-weight:bold;color:#555;display:block;margin-bottom:8px;">📂 نوع الملف *</label>
            <select id="scan-type" style="width:100%;padding:12px;border:2px solid #e0e0e0;border-radius:8px;font-size:16px;">
                <option value="leave">🏖️ إجازة</option>
                <option value="permission">📋 استئذان</option>
                <option value="document">📄 مستند</option>
            </select>
        </div>
        <div style="max-height:250px;overflow-y:auto;margin-bottom:15px;">
            ${scannedFiles.map((f,i)=>`<div style="background:#f8f9ff;padding:10px;border-radius:8px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">
                <input type="checkbox" id="scan-file-${i}" checked style="width:18px;height:18px;">
                <span>${getFileIcon(f.type)} ${f.name} (${formatFileSize(f.size)})</span>
            </div>`).join('')}
        </div>
        <div class="modal-footer">
            <button class="btn btn-danger" onclick="document.getElementById('scan-modal').remove()">❌ إلغاء</button>
            <button class="btn btn-success" onclick="processScanUpload(${JSON.stringify(scannedFiles).replace(/"/g,'&quot;')})">⬆️ استيراد المحدد</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
}

async function processScanUpload(scannedFiles){
    const empId=document.getElementById('scan-emp').value;
    const type=document.getElementById('scan-type').value;
    if(!empId){showToast('اختر الموظف أولاً','error');return;}
    
    let processed=0;
    for(let i=0;i<scannedFiles.length;i++){
        const cb=document.getElementById('scan-file-'+i);
        if(!cb||!cb.checked) continue;
        const f=scannedFiles[i];
        try{
            await window.db.archiveUpload({
                employee_id: parseInt(empId),
                type,
                file_name: f.name,
                file_data: f.data,
                file_size: formatFileSize(f.size),
                file_type: f.type,
                notes: 'تم استيراده من الماسح الضوئي'
            });
            processed++;
        }catch(err){console.error(err);}
    }
    
    document.getElementById('scan-modal').remove();
    archiveFiles = await window.db.archiveGetAll();
    renderArchiveDashboard();
    showToast(`✅ تم استيراد ${processed} ملف من الماسح الضوئي`,'success');
}

// الدوال المساعدة القديمة (للتوافق)
function getFileIcon(typeStr){
    if(!typeStr)return'📄';
    if(typeStr.includes('pdf'))return'📕';
    if(typeStr.includes('image'))return'🖼️';
    if(typeStr.includes('word')||typeStr.includes('document'))return'📘';
    if(typeStr.includes('sheet')||typeStr.includes('excel'))return'📗';
    if(typeStr.includes('text'))return'📝';
    return'📄';
}

function renderSettings(){
    const s = appSettings;

    const usernameEl = document.getElementById('settings-username-display');
    if (usernameEl) usernameEl.textContent = s.username || 'المشرف';
    const buildEl = document.getElementById('settings-build-date');
    if (buildEl) buildEl.textContent = new Date().toLocaleDateString('ar-u-ca-gregory-nu-latn',{year:'numeric',month:'long',day:'numeric'});
}

async function _saveSettings(patch){
    Object.assign(appSettings, patch);
    await window.db.saveAppSettings(appSettings);
}

async function settingsEditName(){
    const name = prompt('اسم المستخدم:', appSettings.username || 'المشرف');
    if(name !== null && name.trim()){
        await _saveSettings({username: name.trim()});
        const el = document.getElementById('settings-username-display');
        if (el) el.textContent = name.trim();
    }
}

async function settingsEditRole(){
    const role = prompt('المسمى الوظيفي:', appSettings.role || 'مشرف النظام');
    if(role !== null && role.trim()){
        await _saveSettings({role: role.trim()});
        const el = document.getElementById('settings-role-display');
        if (el) el.textContent = role.trim();
    }
}

async function settingsEditDefaultLeave(){
    const days = prompt('مدة الإجازة الافتراضية (أيام):', appSettings.defaultLeave || 30);
    if(days !== null && !isNaN(days) && Number(days) > 0){
        await _saveSettings({defaultLeave: Number(days)});
        const el = document.getElementById('settings-default-leave-display');
        if (el) el.textContent = Number(days) + ' يوم';
    }
}

async function settingsShowStorageInfo(){
    const counts = [
        'الضباط: ' + officers.length,
        'الموظفين: ' + employees.length,
        'الإجازات: ' + leaves.length,
        'الاستئذانات: ' + leavePermissions.length,
        'الطلبات الأخرى: ' + otherRequests.length,
        'ملفات الأرشيف: ' + archiveFiles.length
    ];
    alert('إحصائيات البيانات (Supabase)\n\n' + counts.join('\n'));
}

async function settingsShowDataCount(){
    const counts = [
        'الضباط: ' + officers.length,
        'الموظفين: ' + employees.length,
        'الإجازات: ' + leaves.length,
        'الاستئذانات: ' + (typeof permissions_data !== 'undefined' ? permissions_data.length : 0)
    ];
    alert('إحصائيات البيانات\n\n' + counts.join('\n'));
}

async function settingsResetAll(){
    if(!confirm('⚠️ هل أنت متأكد من مسح جميع البيانات؟\n\nهذا الإجراء لا يمكن التراجع عنه!')) return;
    if(!confirm('تأكيد نهائي: سيتم حذف كل البيانات نهائياً. متأكد؟')) return;
    await window.db.resetAllData();
    location.reload();
}

function renderCategories(){}

// ═══════════════════════════════════════
// نظام أرشفة الضباط
// ═══════════════════════════════════════
let officerArchiveFiles = [];
let currentArchiveOfficer = null;

async function initOfficerFilesPage(){
    await loadAllData();
    officerArchiveFiles = await window.db.officerArchiveGetAll();
    await loadCustomTypes();
    switchOffArchiveTab('dashboard');
}

function switchOffArchiveTab(tab){
    ['dashboard','officers','all'].forEach(t=>{
        document.getElementById('off-arch-panel-'+t).style.display='none';
        document.getElementById('off-arch-tab-'+t).className='archive-tab';
    });
    document.getElementById('off-arch-panel-officer-detail').style.display='none';
    document.getElementById('off-arch-panel-'+tab).style.display='block';
    document.getElementById('off-arch-tab-'+tab).className='archive-tab active';
    // تحديث الإحصائيات
    document.getElementById('off-arch-stat-officers').textContent=officers.length;
    document.getElementById('off-arch-stat-files').textContent=officerArchiveFiles.length;
    document.getElementById('off-arch-stat-leaves').textContent=officerArchiveFiles.filter(f=>f.type==='leave').length;
    document.getElementById('off-arch-stat-perms').textContent=officerArchiveFiles.filter(f=>f.type==='permission').length;
    if(tab==='dashboard') renderOffArchiveDashboard();
    if(tab==='officers') renderOffArchiveOfficers();
    if(tab==='all') initOffArchiveAllTab();
}

async function renderOffArchiveDashboard(){
    await renderCustomTypeCards();
}

function renderOffArchiveOfficers(){
    const search = (document.getElementById('off-arch-search')?.value||'').toLowerCase();
    const offList = officers.filter(o=>!search||o.name.toLowerCase().includes(search)||(o.rank&&o.rank.toLowerCase().includes(search)));
    
    const offFileCounts = {};
    officerArchiveFiles.forEach(f=>{
        if(!offFileCounts[f.officer_id]) offFileCounts[f.officer_id]={total:0,leave:0,permission:0,document:0};
        offFileCounts[f.officer_id].total++;
        offFileCounts[f.officer_id][f.type]=(offFileCounts[f.officer_id][f.type]||0)+1;
    });
    
    // ترتيب حسب الأقدمية
    const sorted = [...offList].sort((a,b)=>getRankIndex(a.rank)-getRankIndex(b.rank));
    
    document.getElementById('off-arch-officers-grid').innerHTML = sorted.length===0
        ? '<div style="grid-column:1/-1;" class="archive-empty">لا يوجد ضباط</div>'
        : sorted.map(o=>{
            const counts = offFileCounts[o.id]||{total:0,leave:0,permission:0,document:0};
            const rankLabel = o.rank ? o.rank + ' ' : '';
            return `<div onclick="showOffArchiveOfficerDetail(${o.id})" class="archive-quick-card" style="border-top:3px solid ${counts.total>0?'#1e40af':'#e2e8f0'};">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                    <h4 style="color:#1e293b;margin:0;font-size:16px;font-weight:600;">${rankLabel}${o.name}</h4>
                    <span style="background:${counts.total>0?'#1e40af':'#cbd5e1'};color:white;padding:3px 10px;border-radius:20px;font-size:13px;font-weight:bold;">${counts.total}</span>
                </div>
                <div style="color:#94a3b8;font-size:14px;margin-bottom:10px;">${o.position||'-'}</div>
                <div style="display:flex;gap:8px;font-size:13px;">
                    <span style="background:#f0fdf4;color:#16a34a;padding:3px 8px;border-radius:6px;">إجازة ${counts.leave}</span>
                    <span style="background:#fffbeb;color:#d97706;padding:3px 8px;border-radius:6px;">استئذان ${counts.permission}</span>
                    <span style="background:#eff6ff;color:#2563eb;padding:3px 8px;border-radius:6px;">مستند ${counts.document}</span>
                </div>
            </div>`;
        }).join('');
}

function initOffArchiveAllTab(){
    const offSel = document.getElementById('off-arch-off-filter');
    offSel.innerHTML = '<option value="">-- الكل --</option>';
    const sorted = [...officers].sort((a,b)=>getRankIndex(a.rank)-getRankIndex(b.rank));
    sorted.forEach(o=>offSel.innerHTML+=`<option value="${o.id}">${o.rank?o.rank+' ':''}${o.name}</option>`);
    renderOffArchiveAll();
}

function renderOffArchiveAll(){
    const offId = document.getElementById('off-arch-off-filter')?.value;
    const type = document.getElementById('off-arch-type-filter')?.value;
    const search = (document.getElementById('off-arch-file-search')?.value||'').toLowerCase();
    
    let filtered = officerArchiveFiles.filter(f=>
        (!offId||f.officer_id==offId)&&
        (!type||f.type===type)&&
        (!search||f.file_name.toLowerCase().includes(search)||(f.officer_name||'').toLowerCase().includes(search)||(f.notes||'').toLowerCase().includes(search))
    );
    
    document.getElementById('off-arch-all-table').innerHTML = filtered.length===0
        ? '<div class="arch-list-empty">لا توجد ملفات</div>'
        : filtered.map(f=>`<div class="arch-file-item">
            <div class="arch-file-info">
                <div class="arch-file-name">${f.file_name}</div>
                <div class="arch-file-meta">
                    ${getArchiveTypeBadge(f.type)}
                    <span style="cursor:pointer;color:#3b82f6;" onclick="showOffArchiveOfficerDetail(${f.officer_id})">${f.officer_rank?f.officer_rank+' ':''}${f.officer_name||'غير محدد'}</span>
                    <span>${f.file_size||'-'}</span>
                    <span>${f.created_at||'-'}</span>
                    ${f.notes?`<span>${f.notes}</span>`:''}
                </div>
            </div>
            <div class="arch-file-actions">
                <button class="arch-soft-btn arch-btn-view" onclick="viewOffArchiveFile(${f.id})">عرض</button>
                <button class="arch-soft-btn arch-btn-download" onclick="downloadOffArchiveFile(${f.id})">تحميل</button>
                <button class="arch-soft-btn arch-btn-delete" onclick="deleteOffArchiveFile(${f.id})">حذف</button>
            </div>
        </div>`).join('');
}

async function showOffArchiveOfficerDetail(offId){
    currentArchiveOfficer = offId;
    const off = officers.find(o=>o.id==offId);
    if(!off){showToast('الضابط غير موجود','error');return;}
    
    ['dashboard','officers','all'].forEach(t=>{
        document.getElementById('off-arch-panel-'+t).style.display='none';
        document.getElementById('off-arch-tab-'+t).className='archive-tab';
    });
    document.getElementById('off-arch-panel-officer-detail').style.display='block';
    
    const rankLabel = off.rank ? off.rank + ' ' : '';
    document.getElementById('off-arch-name').textContent = rankLabel + off.name;
    document.getElementById('off-arch-info').textContent = `${off.position||'-'}`;
    
    const offFiles = await window.db.officerArchiveGetByOfficer(offId);
    document.getElementById('off-arch-file-count').textContent = offFiles.length;
    document.getElementById('off-arch-leave-count').textContent = offFiles.filter(f=>f.type==='leave').length;
    document.getElementById('off-arch-perm-count').textContent = offFiles.filter(f=>f.type==='permission').length;
    document.getElementById('off-arch-doc-count').textContent = offFiles.filter(f=>f.type==='document').length;
    
    renderOfficerDetailFiles();
}

async function renderOfficerDetailFiles(){
    if(!currentArchiveOfficer) return;
    const typeFilter = document.getElementById('off-arch-type-detail-filter')?.value;
    let offFiles = await window.db.officerArchiveGetByOfficer(currentArchiveOfficer);
    if(typeFilter) offFiles = offFiles.filter(f=>f.type===typeFilter);
    
    document.getElementById('off-arch-detail-table').innerHTML = offFiles.length===0
        ? '<div class="arch-list-empty">لا توجد ملفات<br><br><button class="arch-soft-btn arch-btn-view" onclick="offArchiveUploadForCurrentOfficer()">رفع ملف</button></div>'
        : offFiles.map(f=>`<div class="arch-file-item">
            <div class="arch-file-info">
                <div class="arch-file-name">${f.file_name}</div>
                <div class="arch-file-meta">
                    ${getArchiveTypeBadge(f.type)}
                    <span>${f.file_size||'-'}</span>
                    <span>${f.created_at||'-'}</span>
                    ${f.notes?`<span>${f.notes}</span>`:''}
                </div>
            </div>
            <div class="arch-file-actions">
                <button class="arch-soft-btn arch-btn-view" onclick="viewOffArchiveFile(${f.id})">عرض</button>
                <button class="arch-soft-btn arch-btn-download" onclick="downloadOffArchiveFile(${f.id})">تحميل</button>
                <button class="arch-soft-btn arch-btn-delete" onclick="deleteOffArchiveFile(${f.id})">حذف</button>
            </div>
        </div>`).join('');
}

async function offArchiveUploadFile(preselectedOffId=null, preselectedType=null){
    await ensureDataLoaded({ employees: false, officers: true });
    const existing=document.getElementById('off-archive-upload-modal');if(existing)existing.remove();
    const sorted = [...officers].sort((a,b)=>getRankIndex(a.rank)-getRankIndex(b.rank));
    const typeOpts = defaultArchiveTypes.filter(t=>!getHiddenTypes().includes(t.key)).map(t=>`<option value="${t.key}" ${preselectedType===t.key?'selected':''}>${t.name}</option>`).join('')
        + customArchiveTypes.map(t=>`<option value="${t.key}" ${preselectedType===t.key?'selected':''}>${t.name}</option>`).join('')
        + '<option value="custom">نوع آخر...</option>';
    const modal=document.createElement('div');
    modal.className='modal-overlay active';modal.id='off-archive-upload-modal';
    modal.innerHTML=`<div class="modal detail-modal">
    <div class="detail-header" style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);">
        <button class="detail-close-btn" onclick="closeOffArchiveUpload()">✕</button>
        <div class="detail-header-content">
            <div class="detail-header-info">
                <h2 class="detail-header-name">رفع ملف لأرشيف الضباط</h2>
                <p class="detail-header-sub">رفع ملف جديد لأرشيف الضباط</p>
            </div>
        </div>
    </div>
    <div style="padding:24px 28px;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>الضابط *</label>
                <select id="off-arch-upload-off">
                    <option value="">-- اختر الضابط --</option>
                    ${sorted.map(o=>`<option value="${o.id}" ${preselectedOffId==o.id?'selected':''}>${o.rank?o.rank+' ':''}${o.name}</option>`).join('')}
                </select>
            </div>
            <div class="form-group"><label>نوع الملف *</label>
                <select id="off-arch-upload-type" onchange="toggleCustomType('off-arch-upload')">
                    ${typeOpts}
                </select>
                <input type="text" id="off-arch-upload-custom-type" placeholder="اكتب نوع الملف..." style="display:none;margin-top:8px;">
            </div>
        </div>
        <div class="form-group" style="margin-bottom:14px;"><label>ملاحظات</label>
            <input type="text" id="off-arch-upload-notes" placeholder="ملاحظة اختيارية...">
        </div>
        <div style="margin-bottom:14px;">
            <label style="font-weight:600;color:#1e3a5f;display:block;margin-bottom:6px;font-size:15px;">اختر الملفات *</label>
            <div id="off-arch-drop-zone" style="border:2px dashed #d1d5db;border-radius:12px;padding:24px;text-align:center;cursor:pointer;transition:all 0.3s;background:#f8fafc;" onclick="document.getElementById('off-arch-upload-files').click()">
                <div style="color:#94a3b8;font-size:15px;">اسحب الملفات هنا أو اضغط للاختيار</div>
                <div style="font-size:13px;color:#cbd5e1;margin-top:4px;">pdf, jpg, png, doc, docx, xlsx (الحد 10MB)</div>
            </div>
            <input type="file" id="off-arch-upload-files" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xlsx,.tiff" style="display:none;">
            <div id="off-arch-files-preview" style="margin-top:10px;"></div>
        </div>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#2563eb;color:white;" id="off-arch-upload-btn" onclick="processOffArchiveUpload()">رفع</button>
        <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;" onclick="closeOffArchiveUpload()">إلغاء</button>
    </div>
    </div>`;
    document.body.appendChild(modal);
    
    const dropZone=document.getElementById('off-arch-drop-zone');
    const filesInput=document.getElementById('off-arch-upload-files');
    
    function updatePreview(){
        const files=Array.from(filesInput.files);
        document.getElementById('off-arch-upload-btn').textContent=`رفع (${files.length} ملف)`;
        document.getElementById('off-arch-files-preview').innerHTML=files.map(f=>`
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;margin-bottom:6px;display:flex;align-items:center;gap:10px;">
                <div><div style="font-weight:600;font-size:14px;color:#1e293b;">${f.name}</div><div style="font-size:13px;color:#94a3b8;">${formatFileSize(f.size)}</div></div>
            </div>
        `).join('');
    }
    
    dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.style.borderColor='#2563eb';dropZone.style.background='#eff6ff';});
    dropZone.addEventListener('dragleave',()=>{dropZone.style.borderColor='#d1d5db';dropZone.style.background='#f8fafc';});
    dropZone.addEventListener('drop',e=>{e.preventDefault();filesInput.files=e.dataTransfer.files;updatePreview();dropZone.style.borderColor='#d1d5db';dropZone.style.background='#f8fafc';});
    filesInput.addEventListener('change',updatePreview);
    modal.addEventListener('click',e=>{if(e.target===modal)closeOffArchiveUpload();});
}

function closeOffArchiveUpload(){
    const m=document.getElementById('off-archive-upload-modal');if(m)m.remove();
}

function offArchiveUploadForCurrentOfficer(){
    offArchiveUploadFile(currentArchiveOfficer);
}

async function processOffArchiveUpload(){
    const offId=document.getElementById('off-arch-upload-off').value;
    let type=document.getElementById('off-arch-upload-type').value;
    if(type==='custom'){
        type=document.getElementById('off-arch-upload-custom-type').value.trim();
        if(!type){showToast('اكتب نوع الملف','error');return;}
    }
    const notes=document.getElementById('off-arch-upload-notes').value;
    const filesEl=document.getElementById('off-arch-upload-files');
    
    if(!offId){showToast('اختر الضابط أولاً','error');return;}
    const selectedFiles=Array.from(filesEl.files);
    if(selectedFiles.length===0){showToast('اختر ملف واحد على الأقل','error');return;}
    
    closeOffArchiveUpload();
    
    let processed=0, failed=0;
    for(const file of selectedFiles){
        const prep = await prepareFileForUpload(file);
        if (!prep) { failed++; continue; }
        try{
            await window.db.officerArchiveUpload({
                officer_id: parseInt(offId),
                type,
                file_name: prep.name,
                file_data: prep.dataUrl,
                file_size: formatFileSize(prep.size),
                file_type: file.type,
                notes
            });
            processed++;
        }catch(err){
            failed++;
            console.error('Officer upload error:', err);
        }
    }
    
    officerArchiveFiles = await window.db.officerArchiveGetAll();
    
    if(document.getElementById('off-arch-panel-officer-detail').style.display!=='none'){
        showOffArchiveOfficerDetail(offId);
    }
    
    showToast(`✅ تم رفع ${processed} ملف بنجاح${failed>0?' (فشل '+failed+')':''}`, processed>0?'success':'error');
}

async function viewOffArchiveFile(id){
    const file=await window.db.officerArchiveReadFile(id);
    if(!file||!file.data){showToast('لا يمكن قراءة الملف','error');return;}
    
    const isImage=file.file_type&&file.file_type.includes('image');
    const isPDF=file.file_type&&file.file_type.includes('pdf');
    
    const modal=document.createElement('div');
    modal.className='modal-overlay active';modal.id='off-arch-view-modal';
    modal.innerHTML=`<div class="modal" style="width:950px;max-width:95%;max-height:90vh;overflow-y:auto;">
        <div class="modal-header">
            <div><h2>${getFileIcon(file.file_type)} ${file.file_name}</h2>
            <div style="font-size:14px;color:#999;margin-top:5px;">${getArchiveTypeBadge(file.type)} | 📊 ${file.file_size||'-'} | 📅 ${file.created_at||'-'}</div></div>
            <button class="modal-close" onclick="document.getElementById('off-arch-view-modal').remove()">✕</button>
        </div>
        <div style="text-align:center;padding:20px;min-height:300px;">
            ${isImage?`<img src="${file.data}" style="max-width:100%;max-height:500px;border-radius:8px;box-shadow:0 2px 15px rgba(0,0,0,0.1);">`:
              isPDF?`<iframe src="${file.data}" style="width:100%;height:500px;border:none;border-radius:8px;"></iframe>`:
              `<div style="padding:60px;color:#999;"><div style="font-size:82px;margin-bottom:20px;">${getFileIcon(file.file_type)}</div><p>لا يمكن عرض هذا النوع مباشرة</p></div>`}
        </div>
        <div class="modal-footer">
            <button class="btn btn-primary" onclick="downloadOffArchiveFile(${file.id})">⬇️ تحميل</button>
            ${isImage||isPDF?`<button class="btn btn-info" onclick="printArchiveFile(${file.id})">🖨️ طباعة</button>`:''}
            <button class="btn btn-danger" onclick="document.getElementById('off-arch-view-modal').remove()">✕ إغلاق</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)modal.remove();});
}

async function downloadOffArchiveFile(id){
    const file=await window.db.officerArchiveReadFile(id);
    if(!file||!file.data){showToast('لا يمكن قراءة الملف','error');return;}
    const a=document.createElement('a');
    a.href=file.data;
    a.download=file.file_name;
    a.click();
    showToast(`✅ جاري تحميل ${file.file_name}`,'success');
}

async function deleteOffArchiveFile(id){
    if(!confirm('هل تريد حذف هذا الملف؟')) return;
    await window.db.officerArchiveDelete(id);
    officerArchiveFiles = await window.db.officerArchiveGetAll();
    
    if(document.getElementById('off-arch-panel-officer-detail').style.display!=='none' && currentArchiveOfficer){
        showOffArchiveOfficerDetail(currentArchiveOfficer);
    } else if(document.getElementById('off-arch-panel-all').style.display!=='none'){
        renderOffArchiveAll();
    } else {
        renderOffArchiveDashboard();
    }
    showToast('🗑️ تم حذف الملف','warning');
}

// ═══════════════════════════════════════
// الإحصائيات
// ═══════════════════════════════════════
let chartsInstance = {};

async function initStatisticsPage() {
    initQuickDateInput();
    // ضبط التواريخ الافتراضية بدون رسم فوري
    const today = new Date();
    const dayOfWeek = today.getDay();
    const weekStart = new Date(today); weekStart.setDate(today.getDate() - dayOfWeek);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekStart.getDate() + 4);
    const fmt = d => [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
    const wStartEl = document.getElementById('weekly-form-start');
    const wEndEl   = document.getElementById('weekly-form-end');
    const mMonthEl = document.getElementById('monthly-form-month');
    if (wStartEl) wStartEl.value = fmt(weekStart);
    if (wEndEl)   wEndEl.value   = fmt(weekEnd);
    if (mMonthEl) mMonthEl.value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;

    switchStatisticsTab('daily-form');
    renderDailyForm();

    // جلب البيانات مرة واحدة وعرض جميع التبويبات
    try {
        const fresh = await window.db.getStatistics();
        if (Array.isArray(fresh)) statistics = fresh;
    } catch (e) {
        console.error('فشل تحديث الإحصائيات:', e);
    }
    renderDailyForm();
    // الأسبوع والشهر يجلبان بياناتهما عند فتح التبويب (renderWeeklyForm/renderMonthlyForm)
}

async function updateStatisticsKPIs() {}

function renderStatisticsTable() {}

function renderStatisticsCharts() {}

function filterStatistics() {
    const start = document.getElementById('stat-filter-start').value;
    const end = document.getElementById('stat-filter-end').value;
    const type = document.getElementById('stat-filter-type').value;
    
    let filtered = statistics;
    if (start) filtered = filtered.filter(s => s.date >= start);
    if (end) filtered = filtered.filter(s => s.date <= end);
    
    // إذا كان هناك فلتر على نوع المعاملة، عرض فقط الأيام التي بها معاملات من هذا النوع
    // (هذا اختياري - يمكن تركه كما هو)
    
    document.getElementById('statistics-table').innerHTML = filtered.length === 0
        ? '<tr><td colspan="15" style="color:#999;padding:30px;text-align:center;">لا توجد بيانات مطابقة</td></tr>'
        : filtered.map((s, i) => {
            const total = (s.private_count || 0) + (s.special_transfer_count || 0) + (s.general_transfer_count || 0) +
                         (s.motorcycles_count || 0) + (s.color_change_count || 0) + (s.towing_count || 0);
            const committeesTotal = (s.technical_committees_count || 0) + (s.second_pass_count || 0) + (s.third_pass_count || 0);
            const createdAt = s.created_at ? s.created_at.split(' ')[0] : '-';
            return `<tr>
                <td>${i+1}</td>
                <td>${s.date}</td>
                <td style="color:#888;font-size:14px;">${createdAt}</td>
                <td>${s.private_count || 0}</td>
                <td>${s.special_transfer_count || 0}</td>
                <td>${s.general_transfer_count || 0}</td>
                <td>${s.motorcycles_count || 0}</td>
                <td>${s.color_change_count || 0}</td>
                <td>${s.towing_count || 0}</td>
                <td><strong style="color:#3498db;">${total}</strong></td>
                <td style="color:#2980b9;">${s.technical_committees_count || 0}</td>
                <td style="color:#2980b9;">${s.second_pass_count || 0}</td>
                <td style="color:#2980b9;">${s.third_pass_count || 0}</td>
                <td><strong style="color:#2980b9;">${committeesTotal}</strong></td>
                <td><button class="btn btn-primary" style="font-size:13px;padding:5px 8px;" onclick="editStatistics('${s.date}')">✏️</button> 
                    <button class="btn btn-danger" style="font-size:13px;padding:5px 8px;" onclick="deleteStatistics('${s.date}')">🗑️</button></td>
            </tr>`;
        }).join('');
}

function resetFilters() {
    document.getElementById('stat-filter-start').value = '';
    document.getElementById('stat-filter-end').value = '';
    document.getElementById('stat-filter-type').value = '';
    renderStatisticsTable();
}

async function saveDailyStatistics() {
    const date = document.getElementById('stats-date').value;
    if (!date) { showToast('أدخل التاريخ', 'error'); return; }
    
    const data = {
        date,
        private_count: parseInt(document.getElementById('stats-private').value) || 0,
        special_transfer_count: parseInt(document.getElementById('stats-special-transfer').value) || 0,
        general_transfer_count: parseInt(document.getElementById('stats-general-transfer').value) || 0,
        motorcycles_count: parseInt(document.getElementById('stats-motorcycles').value) || 0,
        color_change_count: parseInt(document.getElementById('stats-color-change').value) || 0,
        towing_count: parseInt(document.getElementById('stats-towing').value) || 0,
        technical_committees_count: parseInt(document.getElementById('stats-technical-committees').value) || 0,
        second_pass_count: parseInt(document.getElementById('stats-second-pass').value) || 0,
        third_pass_count: parseInt(document.getElementById('stats-third-pass').value) || 0
    };
    
    await window.db.upsertStatistics(data);
    // تحديث الكاش المحلي
    const idx = statistics.findIndex(s => s.date === date);
    if (idx >= 0) Object.assign(statistics[idx], data);
    else { statistics.push({...data, created_at: new Date().toISOString()}); statistics.sort((a,b) => b.date.localeCompare(a.date)); }
    
    showToast('✅ تم حفظ البيانات!', 'success');
    closeModal('add-daily-stats-modal');
    StatsManager.syncAllForms(date);
    renderStatisticsTable();
    renderDailyForm();
    renderWeeklyForm();
    await updateStatisticsKPIs();
}

function updateStatisticsPreview() {
    const p = parseInt(document.getElementById('stats-private').value) || 0;
    const s = parseInt(document.getElementById('stats-special-transfer').value) || 0;
    const g = parseInt(document.getElementById('stats-general-transfer').value) || 0;
    const m = parseInt(document.getElementById('stats-motorcycles').value) || 0;
    const c = parseInt(document.getElementById('stats-color-change').value) || 0;
    const t = parseInt(document.getElementById('stats-towing').value) || 0;
    const tc = parseInt(document.getElementById('stats-technical-committees').value) || 0;
    const sp = parseInt(document.getElementById('stats-second-pass').value) || 0;
    const tp = parseInt(document.getElementById('stats-third-pass').value) || 0;
    const total = p + s + g + m + c + t;
    const committeesTotal = tc + sp + tp;
    document.getElementById('stats-preview-total').textContent = total;
    document.getElementById('stats-preview-committees').textContent = committeesTotal;
}

function editStatistics(date) {
    const stat = statistics.find(s => s.date === date);
    if (!stat) return;
    document.getElementById('stats-date').value = stat.date;
    document.getElementById('stats-private').value = stat.private_count || '';
    document.getElementById('stats-special-transfer').value = stat.special_transfer_count || '';
    document.getElementById('stats-general-transfer').value = stat.general_transfer_count || '';
    document.getElementById('stats-motorcycles').value = stat.motorcycles_count || '';
    document.getElementById('stats-color-change').value = stat.color_change_count || '';
    document.getElementById('stats-towing').value = stat.towing_count || '';
    document.getElementById('stats-technical-committees').value = stat.technical_committees_count || '';
    document.getElementById('stats-second-pass').value = stat.second_pass_count || '';
    document.getElementById('stats-third-pass').value = stat.third_pass_count || '';
    updateStatisticsPreview();
    openModal('add-daily-stats-modal');
}

async function deleteStatistics(date) {
    if (!confirm(`حذف بيانات ${date}؟`)) return;
    await window.db.deleteStatistics(date);
    statistics = statistics.filter(s => s.date !== date);
    renderStatisticsTable();
    await updateStatisticsKPIs();
    showToast('🗑️ تم الحذف', 'warning');
}

async function exportStatisticsReport() {
    const filtered = statistics.sort((a,b) => a.date.localeCompare(b.date));
    let csv = 'التاريخ,خصوصي,نقل خاص,نقل عام,دراجات نارية,تغيير لون,يسمح بالجر,الإجمالي\n';
    filtered.forEach(s => {
        const total = (s.private_count || 0) + (s.special_transfer_count || 0) + (s.general_transfer_count || 0) +
                     (s.motorcycles_count || 0) + (s.color_change_count || 0) + (s.towing_count || 0);
        csv += `"${s.date}",${s.private_count || 0},${s.special_transfer_count || 0},${s.general_transfer_count || 0},${s.motorcycles_count || 0},${s.color_change_count || 0},${s.towing_count || 0},${total}\n`;
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8;'}));
    a.download = `statistics_${Date.now()}.csv`;
    a.click();
    showToast('✅ تم تصدير التقرير!', 'success');
}

// ═══════════════════════════════════════
// دوال الإدخال السريع والنماذج الجديدة
// ═══════════════════════════════════════

// تحديث الإجمالي في الإدخال السريع (صفحة الإحصائيات) - موجه إلى StatsManager
// (الدوال القديمة أصبحت تستدعي StatsManager مباشرة)

// تهيئة تاريخ الإدخال السريع
function initQuickDateInput() {
    const _iqdi=new Date();
    const today=[_iqdi.getFullYear(),String(_iqdi.getMonth()+1).padStart(2,'0'),String(_iqdi.getDate()).padStart(2,'0')].join('-');
    const dateEl = document.getElementById('quick-date');
    dateEl.value = today;
    StatsManager.loadDate(today);
    // مزامنة النموذج اليومي بنفس التاريخ
    const dailyEl = document.getElementById('daily-form-date');
    if(dailyEl) {
        dailyEl.value = today;
        lastLoadedDate = null;
    }
}

// Stepper +/- function
function stepValue(id, delta) {
    const el = document.getElementById(id);
    if (!el) return;
    let v = (parseInt(el.value) || 0) + delta;
    if (v < 0) v = 0;
    el.value = v;
    el.dispatchEvent(new Event('input'));
}

// التبديل بين التبويبات
function switchStatisticsTab(tabName) {
    // إخفاء جميع التبويبات
    ['tab-daily-form','tab-weekly-form','tab-monthly-form'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    
    // إظهار التبويب المختار
    const tab = document.getElementById('tab-' + tabName);
    if (tab) tab.style.display = 'block';
    
    // تحديث الأزرار
    ['btn-daily-form','btn-weekly-form','btn-monthly-form'].forEach(id => {
        document.getElementById(id).classList.remove('active');
    });
    document.getElementById('btn-' + tabName).classList.add('active');
    
    // تحميل الأسبوع الحالي تلقائياً عند فتح التبويب الأسبوعي
    if (tabName === 'weekly-form') {
        setCurrentWeek();
    }
    // تحميل الشهر الحالي تلقائياً عند فتح التبويب الشهري
    if (tabName === 'monthly-form') {
        setCurrentMonth();
    }
}

// متغير لتتبع آخر تاريخ تم تحميل بيانته
let lastLoadedDate = null;

// رسم النموذج اليومي الرسمي
function renderDailyForm() {
    const dateInput = document.getElementById('daily-form-date');
    const date = dateInput.value;
    const container = document.getElementById('daily-form-cards');
    
    if (!date) {
        container.innerHTML = '<div class="stat-empty-msg">اختر تاريخاً لعرض البيانات</div>';
        lastLoadedDate = null;
        return;
    }
    
    const dayData = statistics.find(s => s.date === date);
    lastLoadedDate = date;
    
    const types = [
        {name: 'خصوصي', key: 'private_count', color: '#007aff'},
        {name: 'نقل خاص', key: 'special_transfer_count', color: '#5856d6'},
        {name: 'نقل عام', key: 'general_transfer_count', color: '#34c759'},
        {name: 'دراجات نارية', key: 'motorcycles_count', color: '#ff9500'},
        {name: 'تغيير لون', key: 'color_change_count', color: '#af52de'},
        {name: 'يسمح بالجر', key: 'towing_count', color: '#ff3b30'}
    ];
    
    let html = '';
    let grandTotal = 0;
    
    types.forEach(type => {
        const value = dayData ? (dayData[type.key] || 0) : 0;
        grandTotal += value;
        html += `<div class="stat-card">
            <div class="stat-card-right">
                <span class="stat-card-icon" style="background:${type.color}15;color:${type.color};"></span>
                <span class="stat-card-name">${type.name}</span>
            </div>
            <span class="stat-card-value">${value}</span>
        </div>`;
    });
    
    // البيانات الإضافية
    const technicalCommittees = dayData ? (dayData.technical_committees_count || 0) : 0;
    const secondPass = dayData ? (dayData.second_pass_count || 0) : 0;
    const thirdPass = dayData ? (dayData.third_pass_count || 0) : 0;
    
    html += `<div class="stat-card stat-card-extra">
        <div class="stat-card-right"><span class="stat-card-icon" style="background:#ff950015;color:#ff9500;"></span><span class="stat-card-name">مركبات اللجان الفنية</span></div>
        <span class="stat-card-value">${technicalCommittees}</span>
    </div>`;
    html += `<div class="stat-card stat-card-extra">
        <div class="stat-card-right"><span class="stat-card-icon" style="background:#34c75915;color:#34c759;"></span><span class="stat-card-name">اجتازت ثاني مرة</span></div>
        <span class="stat-card-value">${secondPass}</span>
    </div>`;
    html += `<div class="stat-card stat-card-extra">
        <div class="stat-card-right"><span class="stat-card-icon" style="background:#007aff15;color:#007aff;"></span><span class="stat-card-name">اجتازت ثالث مرة</span></div>
        <span class="stat-card-value">${thirdPass}</span>
    </div>`;
    
    // بطاقة الإجمالي
    html += `<div class="stat-card-total">
        <span>الإجمالي</span>
        <span class="stat-card-total-value">${grandTotal}</span>
    </div>`;
    
    container.innerHTML = html;
}

// رسم النموذج الأسبوعي الرسمي
async function renderWeeklyForm() {
    const startInput = document.getElementById('weekly-form-start').value;
    const endInput = document.getElementById('weekly-form-end').value;
    const container = document.getElementById('weekly-form-cards');
    
    if (!startInput || !endInput) {
        container.innerHTML = '<div class="stat-empty-msg">اختر نطاق تواريخ لعرض البيانات الأسبوعية</div>';
        return;
    }

    // جلب أحدث الإحصائيات من السيرفر
    container.innerHTML = '<div class="stat-empty-msg">⏳ جاري التحميل...</div>';
    try {
        const fresh = await window.db.getStatistics();
        if (Array.isArray(fresh)) statistics = fresh;
    } catch (e) {
        console.error('فشل جلب الإحصائيات الأسبوعية:', e);
    }
    
    const dayNames = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
    const types = [
        {name: 'خصوصي', key: 'private_count', color: '#007aff'},
        {name: 'نقل خاص', key: 'special_transfer_count', color: '#5856d6'},
        {name: 'نقل عام', key: 'general_transfer_count', color: '#34c759'},
        {name: 'دراجات نارية', key: 'motorcycles_count', color: '#ff9500'},
        {name: 'تغيير لون', key: 'color_change_count', color: '#af52de'},
        {name: 'يسمح بالجر', key: 'towing_count', color: '#ff3b30'}
    ];
    
    const currentDate = new Date(startInput);
    const endDate = new Date(endInput);
    let dates = [];
    while (currentDate <= endDate) {
        const ds=[currentDate.getFullYear(),String(currentDate.getMonth()+1).padStart(2,'0'),String(currentDate.getDate()).padStart(2,'0')].join('-');
        dates.push(ds);
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    if (dates.length === 0) {
        container.innerHTML = '<div class="stat-empty-msg">لا توجد أيام في النطاق المختار</div>';
        return;
    }
    
    let html = '';
    let grandTotal = 0;
    
    types.forEach(type => {
        let typeTotal = 0;
        let daysHtml = '';
        dates.forEach(date => {
            const dayData = statistics.find(s => s.date === date);
            const value = dayData ? (dayData[type.key] || 0) : 0;
            typeTotal += value;
            const dayName = dayNames[new Date(date).getDay()];
            daysHtml += `<div class="stat-detail-row">
                <span class="stat-detail-label">${dayName}</span>
                <span class="stat-detail-value">${value}</span>
            </div>`;
        });
        grandTotal += typeTotal;
        
        html += `<div class="stat-card-expandable">
            <div class="stat-card-header" onclick="this.parentElement.classList.toggle('open')">
                <div class="stat-card-right">
                    <span class="stat-card-icon" style="background:${type.color}15;color:${type.color};"></span>
                    <span class="stat-card-name">${type.name}</span>
                </div>
                <div class="stat-card-header-right">
                    <span class="stat-card-value">${typeTotal}</span>
                    <span class="stat-card-chevron">‹</span>
                </div>
            </div>
            <div class="stat-card-details">${daysHtml}</div>
        </div>`;
    });
    
    html += `<div class="stat-card-total">
        <span>إجمالي الأسبوع</span>
        <span class="stat-card-total-value">${grandTotal}</span>
    </div>`;
    
    container.innerHTML = html;
}

// ═══════════════════════════════════════
// دوال الطباعة
// ═══════════════════════════════════════
function printDailyForm() {
    const dateInput = document.getElementById('daily-form-date').value;
    if (!dateInput) {
        showToast('❌ اختر تاريخاً أولاً', 'error');
        return;
    }
    
    // جلب بيانات اليوم
    const dayData = statistics.find(s => s.date === dateInput);
    
    if (!dayData) {
        showToast('❌ لا توجد بيانات لهذا اليوم', 'error');
        return;
    }
    
    // تحضير البيانات للطباعة
    const dailyData = {
        date: dateInput,
        counts: {
            private: dayData.private_count || 0,
            special: dayData.special_transfer_count || 0,
            general: dayData.general_transfer_count || 0,
            motorcycles: dayData.motorcycles_count || 0,
            towing: dayData.towing_count || 0,
            color: dayData.color_change_count || 0
        },
        additionalInfo: {
            technicalCommittees: dayData.technical_committees_count || 0,
            secondPass: dayData.second_pass_count || 0,
            thirdPass: dayData.third_pass_count || 0
        }
    };
    
    // استدعاء الطباعة عبر IPC
    window.db.printDailyForm(dailyData).then((res) => {
        if(res && res.cancelled) showToast('تم إلغاء الطباعة', 'error');
        else showToast('✅ تم إرسال النموذج إلى الطابعة', 'success');
    }).catch(err => {
        console.error('خطأ في الطباعة:', err);
        showToast('❌ حدث خطأ أثناء الطباعة', 'error');
    });
}

function printWeeklyForm() {
    const startInput = document.getElementById('weekly-form-start').value;
    const endInput = document.getElementById('weekly-form-end').value;
    
    if (!startInput || !endInput) {
        showToast('❌ اختر نطاق تواريخ أولاً', 'error');
        return;
    }
    
    // جمع البيانات من الجدول الحالي
    const weeklyData = collectWeeklyPrintData(startInput, endInput);
    
    // إرسال البيانات للطباعة عبر IPC
    window.db.printWeeklyForm(weeklyData).then((res) => {
        if(res && res.cancelled) showToast('تم إلغاء الطباعة', 'error');
        else showToast('✅ تم الطباعة بنجاح!', 'success');
    }).catch(err => {
        showToast('❌ حدث خطأ في الطباعة', 'error');
        console.error(err);
    });
}

function collectWeeklyPrintData(startDate, endDate) {
    // جلب البيانات من الإحصائيات
    const weekStats = statistics.filter(s => s.date >= startDate && s.date <= endDate);
    
    // تصفية الأيام (الأحد - الخميس فقط)
    let currentDate = new Date(startDate);
    const endDateObj = new Date(endDate);
    let dates = [];
    
    while (currentDate <= endDateObj) {
        const ds=[currentDate.getFullYear(),String(currentDate.getMonth()+1).padStart(2,'0'),String(currentDate.getDate()).padStart(2,'0')].join('-');
        dates.push(ds);
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    dates = dates.filter(date => {
        const dayOfWeek = new Date(date+'T00:00:00').getDay();
        return dayOfWeek !== 6 && dayOfWeek !== 5; // 6=السبت، 5=الجمعة
    });
    
    // تنظيم البيانات حسب الأيام
    const dailyData = {};
    const days = ['sun', 'mon', 'tue', 'wed', 'thu'];
    const typeKeys = [
        { day: 'sun', type: 'private', key: 'private_count' },
        { day: 'sun', type: 'special', key: 'special_transfer_count' },
        { day: 'sun', type: 'general', key: 'general_transfer_count' },
        { day: 'sun', type: 'motorcycles', key: 'motorcycles_count' },
        { day: 'sun', type: 'color', key: 'color_change_count' },
        { day: 'sun', type: 'towing', key: 'towing_count' }
    ];
    
    // بناء خريطة البيانات
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu'];
    
    dayNames.forEach(dayName => {
        dailyData[dayName] = {
            private: 0,
            special: 0,
            general: 0,
            motorcycles: 0,
            color: 0,
            towing: 0
        };
    });
    
    // ملء البيانات
    let dayIndex = 0;
    dates.forEach(date => {
        const dayData = statistics.find(s => s.date === date);
        if (dayData && dayIndex < 5) {
            const dayKey = dayNames[dayIndex];
            dailyData[dayKey] = {
                private: dayData.private_count || 0,
                special: dayData.special_transfer_count || 0,
                general: dayData.general_transfer_count || 0,
                motorcycles: dayData.motorcycles_count || 0,
                color: dayData.color_change_count || 0,
                towing: dayData.towing_count || 0
            };
            dayIndex++;
        }
    });
    
    return {
        startDate,
        endDate,
        dailyData
    };
}

// اختيار الأسبوع الحالي (الأحد - السبت)
function setCurrentWeek() {
    const today = new Date();
    const dayOfWeek = today.getDay(); // 0=أحد, 1=اثنين, ... 6=سبت
    
    // حساب بداية الأسبوع (الأحد)
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - dayOfWeek); // الرجوع إلى الأحد
    
    // نهاية الأسبوع (السبت)
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6); // الأحد + 6 = السبت
    
    document.getElementById('weekly-form-start').value = [weekStart.getFullYear(),String(weekStart.getMonth()+1).padStart(2,'0'),String(weekStart.getDate()).padStart(2,'0')].join('-');
    document.getElementById('weekly-form-end').value = [weekEnd.getFullYear(),String(weekEnd.getMonth()+1).padStart(2,'0'),String(weekEnd.getDate()).padStart(2,'0')].join('-');
    
    renderWeeklyForm();
}

// ═══════════════════════════════════════
// الإحصائية الشهرية
// ═══════════════════════════════════════
function setCurrentMonth() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    document.getElementById('monthly-form-month').value = `${year}-${month}`;
    return renderMonthlyForm();
}

function getWeeksInMonth(year, month) {
    // تقسيم الشهر إلى أسابيع (جميع الأيام من الأحد إلى السبت)
    const firstDay = new Date(year, month - 1, 1);
    const lastDay  = new Date(year, month, 0);

    const weeks = [];
    let currentWeek = null;
    let currentDate = new Date(firstDay);

    function toLocalDateStr(d) {
        return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
    }

    while (currentDate <= lastDay) {
        const dow = currentDate.getDay(); // 0=أحد ... 6=سبت

        // ابدأ أسبوعاً جديداً عند كل أحد أو عند أول يوم بالشهر
        if (dow === 0 || currentDate.getTime() === firstDay.getTime()) {
            if (currentWeek && currentWeek.some(d => d !== null)) weeks.push(currentWeek);
            currentWeek = [null, null, null, null, null, null, null]; // الأحد→السبت
        }

        // أضف كل أيام الأسبوع (أحد=0 إلى سبت=6)
        if (currentWeek) {
            currentWeek[dow] = toLocalDateStr(currentDate);
        }

        currentDate.setDate(currentDate.getDate() + 1);
    }

    // أضف الأسبوع الأخير
    if (currentWeek && currentWeek.some(d => d !== null)) weeks.push(currentWeek);

    return weeks;
}

async function renderMonthlyForm() {
    const monthInput = document.getElementById('monthly-form-month').value;
    const container = document.getElementById('monthly-form-cards');
    
    if (!monthInput) {
        container.innerHTML = '<div class="stat-empty-msg">اختر شهراً لعرض الإحصائيات الشهرية</div>';
        return;
    }

    // جلب أحدث الإحصائيات من السيرفر قبل العرض
    container.innerHTML = '<div class="stat-empty-msg">⏳ جاري التحميل...</div>';
    try {
        const fresh = await window.db.getStatistics();
        if (Array.isArray(fresh)) statistics = fresh;
    } catch (e) {
        console.error('فشل جلب الإحصائيات الشهرية:', e);
    }
    
    const [year, month] = monthInput.split('-').map(Number);
    const weeks = getWeeksInMonth(year, month);
    
    const types = [
        {name: 'خصوصي', key: 'private_count', color: '#007aff'},
        {name: 'نقل خاص', key: 'special_transfer_count', color: '#5856d6'},
        {name: 'نقل عام', key: 'general_transfer_count', color: '#34c759'},
        {name: 'دراجات نارية', key: 'motorcycles_count', color: '#ff9500'},
        {name: 'تغيير لون', key: 'color_change_count', color: '#af52de'},
        {name: 'يسمح بالجر', key: 'towing_count', color: '#ff3b30'}
    ];
    
    let html = '';
    let grandTotal = 0;
    
    types.forEach(type => {
        let typeTotal = 0;
        let weeksHtml = '';
        
        weeks.forEach((weekDates, idx) => {
            let weekSum = 0;
            weekDates.forEach(date => {
                if (date) {
                    const dayData = statistics.find(s => s.date === date);
                    weekSum += dayData ? (dayData[type.key] || 0) : 0;
                }
            });
            typeTotal += weekSum;
            weeksHtml += `<div class="stat-detail-row">
                <span class="stat-detail-label">أسبوع ${idx + 1}</span>
                <span class="stat-detail-value">${weekSum}</span>
            </div>`;
        });
        
        grandTotal += typeTotal;
        
        html += `<div class="stat-card-expandable">
            <div class="stat-card-header" onclick="this.parentElement.classList.toggle('open')">
                <div class="stat-card-right">
                    <span class="stat-card-icon" style="background:${type.color}15;color:${type.color};"></span>
                    <span class="stat-card-name">${type.name}</span>
                </div>
                <div class="stat-card-header-right">
                    <span class="stat-card-value">${typeTotal}</span>
                    <span class="stat-card-chevron">‹</span>
                </div>
            </div>
            <div class="stat-card-details">${weeksHtml}</div>
        </div>`;
    });
    
    html += `<div class="stat-card-total">
        <span>إجمالي الشهر</span>
        <span class="stat-card-total-value">${grandTotal}</span>
    </div>`;
    
    container.innerHTML = html;
}

function printMonthlyForm() {
    const monthInput = document.getElementById('monthly-form-month').value;
    if (!monthInput) {
        showToast('❌ اختر شهراً أولاً', 'error');
        return;
    }
    
    // جمع البيانات من الجدول الحالي
    const monthlyData = collectMonthlyPrintData(monthInput);
    
    // إرسال البيانات للطباعة عبر IPC
    window.db.printMonthlyForm(monthlyData).then((res) => {
        if(res && res.cancelled) showToast('تم إلغاء الطباعة', 'error');
        else showToast('✅ تم الطباعة بنجاح!', 'success');
    }).catch(err => {
        showToast('❌ حدث خطأ في الطباعة', 'error');
        console.error(err);
    });
}

function collectMonthlyPrintData(monthInput) {
    const [year, month] = monthInput.split('-').map(Number);
    const monthName = new Date(year, month - 1).toLocaleDateString('ar-u-ca-gregory-nu-latn', { month: 'long', year: 'numeric' });
    
    const weeks = getWeeksInMonth(year, month);
    const weeklyData = {};
    
    const typeKeys = [
        {print: 'private', key: 'private_count'},
        {print: 'special', key: 'special_transfer_count'},
        {print: 'general', key: 'general_transfer_count'},
        {print: 'motorcycles', key: 'motorcycles_count'},
        {print: 'color', key: 'color_change_count'},
        {print: 'towing', key: 'towing_count'}
    ];
    
    weeks.forEach((weekDates, idx) => {
        const wKey = `week${idx + 1}`;
        weeklyData[wKey] = {};
        typeKeys.forEach(t => {
            let sum = 0;
            weekDates.forEach(date => {
                if (date) {
                    const dayData = statistics.find(s => s.date === date);
                    sum += dayData ? (dayData[t.key] || 0) : 0;
                }
            });
            weeklyData[wKey][t.print] = sum;
        });
    });
    
    return { monthName, weeklyData };
}

// ═══════════════════════════════════════
// نظام النسخ واللصق المتقدم
// ═══════════════════════════════════════
let clipboardData = null;
let currentContextElement = null;

function initCopyPasteFunctionality() {
    // إضافة حدث الكليك اليمين على جميع عناصر الإدخال
    document.addEventListener('contextmenu', function(e) {
        const inputElements = ['INPUT', 'TEXTAREA', 'SELECT'];
        const td = e.target.closest('#employees-table td, #officers-table td');
        if (inputElements.includes(e.target.tagName)) {
            e.preventDefault();
            currentContextElement = e.target;
            showContextMenu(e.pageX, e.pageY);
        } else if (td) {
            e.preventDefault();
            const text = td.innerText.trim();
            if (text && text !== '-') {
                currentContextElement = {_cellText: text, tagName: 'TD'};
                showContextMenu(e.pageX, e.pageY);
            }
        }
    });
    
    // إغلاق القائمة عند الكليك في أي مكان
    document.addEventListener('click', function(e) {
        if (e.target.id !== 'contextMenu' && !e.target.closest('.context-menu')) {
            hideContextMenu();
        }
    });
    
    // دعم Ctrl+C, Ctrl+X, Ctrl+V
    document.addEventListener('keydown', function(e) {
        const inputElements = ['INPUT', 'TEXTAREA', 'SELECT'];
        if (!inputElements.includes(e.target.tagName)) return;
        
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'c' || e.key === 'C') {
                e.preventDefault();
                handleCopy(e.target);
            } else if (e.key === 'x' || e.key === 'X') {
                e.preventDefault();
                handleCut(e.target);
            } else if (e.key === 'v' || e.key === 'V') {
                e.preventDefault();
                handlePaste(e.target);
            }
        }
    });
}

function showContextMenu(x, y) {
    const menu = document.getElementById('contextMenu');
    menu.classList.add('active');
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    
    // تحديث حالة العناصر
    const cutBtn = menu.querySelector('.context-menu-item:nth-child(1)');
    const copyBtn = menu.querySelector('.context-menu-item:nth-child(2)');
    const pasteBtn = menu.querySelector('.context-menu-item:nth-child(3)');
    const selectAllBtn = menu.querySelector('.context-menu-item:nth-child(5)');
    
    const isCell = currentContextElement && currentContextElement._cellText;
    
    if (isCell) {
        cutBtn.classList.add('disabled');
        copyBtn.classList.remove('disabled');
        pasteBtn.classList.add('disabled');
        selectAllBtn.classList.add('disabled');
    } else {
        cutBtn.classList.remove('disabled');
        selectAllBtn.classList.remove('disabled');
        // تفعيل/تعطيل خيارات حسب حالة العنصر
        if (currentContextElement && currentContextElement.tagName === 'SELECT') {
            copyBtn.classList.add('disabled');
        } else {
            copyBtn.classList.remove('disabled');
        }
        pasteBtn.classList.remove('disabled');
    }
}

function hideContextMenu() {
    const menu = document.getElementById('contextMenu');
    menu.classList.remove('active');
}

function handleCopy(element) {
    let valueToCopy = '';
    if (element._cellText) {
        valueToCopy = element._cellText;
    } else if (element.tagName === 'SELECT') {
        valueToCopy = element.options[element.selectedIndex].text;
    } else {
        valueToCopy = element.value;
    }
    
    clipboardData = valueToCopy;
    
    // نسخ إلى clipboard النظام أيضاً
    navigator.clipboard.writeText(valueToCopy).then(() => {
        showToast(`✅ تم نسخ: ${valueToCopy}`, 'success');
    }).catch(() => {
        showToast(`✅ تم النسخ (محلياً)`, 'success');
    });
    
    hideContextMenu();
}

function handleCut(element) {
    if (element.tagName === 'SELECT') {
        showToast('❌ لا يمكن قص من SELECT', 'error');
        return;
    }
    
    handleCopy(element);
    element.value = '';
    showToast('✂️ تم قص البيانات', 'success');
}

function handlePaste(element) {
    // قراءة من System Clipboard أولاً (من خارج التطبيق)
    navigator.clipboard.readText().then(text => {
        pastelDataToElement(element, text);
    }).catch(() => {
        // إذا فشل النظام، استخدم clipboard المحلي
        if (clipboardData) {
            pastelDataToElement(element, clipboardData);
        } else {
            showToast('❌ لا توجد بيانات للصق', 'error');
        }
    });
}

function pastelDataToElement(element, value) {
    if (element.tagName === 'INPUT' && element.type === 'number') {
        // تحويل القيمة إلى رقم إذا كان الحقل numeric
        const numValue = parseInt(value) || '';
        if (numValue === '' && value) {
            showToast('❌ يجب إدخال رقم في هذا الحقل', 'error');
            return;
        }
        element.value = numValue;
    } else {
        element.value = value;
    }
    
    // تحديث الإجمالي فوراً إذا كان في قسم الإدخال السريع
    if (element.id && element.id.startsWith('quick-')) {
        updateQuickTotal();
    }
    
    showToast(`📄 تم اللصق: ${value}`, 'success');
    hideContextMenu();
}

// دوال Context Menu الداخلية
function contextMenuCut() {
    if (currentContextElement) {
        handleCut(currentContextElement);
    }
}

function contextMenuCopy() {
    if (currentContextElement) {
        handleCopy(currentContextElement);
    }
}

function contextMenuPaste() {
    if (currentContextElement) {
        handlePaste(currentContextElement);
    }
}

function contextMenuSelectAll() {
    if (currentContextElement && currentContextElement.select) {
        currentContextElement.select();
        showToast('⚡ تم تحديد الكل', 'success');
    }
    hideContextMenu();
}

// ═══════════════════════════════════════
// الإجازات
// ═══════════════════════════════════════
function showAddLeaveModal(presetType, presetId){
    const existing=document.getElementById('add-leave-modal');if(existing)existing.remove();
    const headerGrad='linear-gradient(135deg,#065f46 0%,#059669 100%)';
    const modal=document.createElement('div');modal.className='modal-overlay active';modal.id='add-leave-modal';
    modal.innerHTML=`<div class="modal detail-modal">
    <div class="detail-header" style="background:${headerGrad};">
        <button class="detail-close-btn" onclick="closeAddLeaveModal()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar" style="font-size:34px;">🏖️</div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">طلب إجازة</h2>
                <p class="detail-header-sub">تسجيل إجازة لموظف أو ضابط</p>
            </div>
        </div>
    </div>
    <div class="modal-body" style="padding:12px 14px;overflow-y:auto;flex:1;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>النوع *</label>
                <select id="leave-person-type" onchange="loadLeavePersonList()" ${presetId ? 'disabled style="background:#f1f5f9;color:#64748b;pointer-events:none;"' : ''}>
                    <option value="">-- اختر النوع --</option>
                    <option value="employee">موظف</option>
                    <option value="officer">ضابط</option>
                </select>
            </div>
            <div class="form-group"><label>الاسم *</label>
                <select id="leave-person-id" ${presetId ? 'disabled style="background:#f1f5f9;color:#64748b;pointer-events:none;"' : ''}>
                    <option value="">-- اختر النوع أولاً --</option>
                </select>
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>نوع الإجازة *</label>
                <select id="leave-type">
                    <option value="دورية">دورية</option>
                    <option value="إدارية">إدارية</option>
                    <option value="دراسية">دراسية</option>
                    <option value="طارئة">طارئة</option>
                    <option value="حج">حج</option>
                    <option value="مرضية">مرضية</option>
                </select>
            </div>
            <div class="form-group"><label>عدد الأيام</label>
                <input type="number" id="leave-days" readonly style="background:#f8fafc;">
            </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>بداية الإجازة *</label><input type="date" id="leave-start" onchange="calcLeaveDays()"></div>
            <div class="form-group"><label>نهاية الإجازة *</label><input type="date" id="leave-end" onchange="calcLeaveDays()"></div>
            <div class="form-group"><label>تاريخ المباشرة</label><input type="date" id="leave-return" onchange="calcLeaveDays()"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px;">
            <div class="form-group"><label>الحالة</label>
                <select id="leave-status">
                    <option value="قادمة">قادمة</option>
                    <option value="جارية">جارية</option>
                    <option value="منتهية">منتهية</option>
                </select>
            </div>
            <div class="form-group"><label>ملاحظات</label><input type="text" id="leave-notes" placeholder="ملاحظات..."></div>
        </div>
        <div style="margin-bottom:14px;">
            <label style="font-weight:600;color:#065f46;display:block;margin-bottom:6px;font-size:15px;">ملف PDF (اختياري)</label>
            <div id="leave-pdf-drop" style="border:2px dashed #d1d5db;border-radius:12px;padding:20px;text-align:center;cursor:pointer;transition:all 0.3s;background:#f8fafc;" onclick="document.getElementById('leave-pdf-file').click()" ondragover="event.preventDefault();this.style.borderColor='#059669';this.style.background='#ecfdf5'" ondragleave="this.style.borderColor='#d1d5db';this.style.background='#f8fafc'" ondrop="event.preventDefault();this.style.borderColor='#d1d5db';this.style.background='#f8fafc';handleLeavePdfDrop(event)">
                <div id="leave-pdf-label" style="color:#94a3b8;font-size:15px;">اسحب ملف PDF هنا أو اضغط للاختيار</div>
                <input type="file" id="leave-pdf-file" accept=".pdf,application/pdf" style="display:none;" onchange="handleLeavePdfSelect(this)">
            </div>
        </div>
        <div id="leave-preview" style="display:none;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:12px;padding:16px;margin-bottom:14px;">
            <div style="font-weight:600;color:#065f46;font-size:15px;margin-bottom:10px;">معاينة</div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
                <div style="text-align:center;"><div style="color:#94a3b8;font-size:13px;">بداية الإجازة</div><div style="font-weight:700;color:#065f46;" id="preview-start">-</div></div>
                <div style="text-align:center;"><div style="color:#94a3b8;font-size:13px;">نهاية الإجازة</div><div style="font-weight:700;color:#065f46;" id="preview-end">-</div></div>
                <div style="text-align:center;"><div style="color:#94a3b8;font-size:13px;">عدد الأيام</div><div style="font-weight:700;color:#059669;font-size:22px;" id="preview-days">-</div></div>
                <div style="text-align:center;"><div style="color:#94a3b8;font-size:13px;">تاريخ المباشرة</div><div style="font-weight:700;" id="preview-return">-</div></div>
                <div style="text-align:center;"><div style="color:#94a3b8;font-size:13px;">أيام للمباشرة</div><div style="font-weight:700;font-size:22px;" id="preview-remaining">-</div></div>
            </div>
        </div>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#059669;color:white;" onclick="saveLeave()">${(currentUser && (currentUser.role === 'admin' || currentUser.role === 'stats')) ? '💾 حفظ الإجازة' : 'تقديم طلب'}</button>
        <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;" onclick="closeAddLeaveModal()">إلغاء</button>
    </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)closeAddLeaveModal();});
    const leaveTypeEl = document.getElementById('leave-person-type');
    const leaveFilterType = document.getElementById('leave-filter-type')?.value;
    let autoLeaveType = presetType || '';
    if (!autoLeaveType && (leaveFilterType === 'employee' || leaveFilterType === 'officer')) autoLeaveType = leaveFilterType;
    if (!autoLeaveType && currentUser && (currentUser.role === 'employee' || currentUser.role === 'stats')) autoLeaveType = 'employee';
    if (!autoLeaveType) autoLeaveType = 'employee';
    leaveTypeEl.value = autoLeaveType;
    loadLeavePersonList();
    if (presetId) setTimeout(()=>{document.getElementById('leave-person-id').value=presetId;},200);
    window._leavePdfData=null;window._leavePdfName=null;
}

function closeAddLeaveModal(){const m=document.getElementById('add-leave-modal');if(m)m.remove();}

async function initLeaveForm(){
    // تحميل الموظفين والضباط قبل فتح النافذة لضمان تعبئة القوائم
    await ensureDataLoaded();
    showAddLeaveModal();
}

function clearLeaveForm(){
    const el=id=>document.getElementById(id);
    if(el('leave-person-type'))el('leave-person-type').value='';
    if(el('leave-person-id'))el('leave-person-id').innerHTML='<option value="">-- اختر نوع الشخص أولاً --</option>';
    if(el('leave-type'))el('leave-type').value='دورية';
    if(el('leave-status'))el('leave-status').value='قادمة';
    ['leave-start','leave-end','leave-return','leave-notes','leave-days'].forEach(id=>{if(el(id))el(id).value='';});
    if(el('leave-preview'))el('leave-preview').style.display='none';
    if(el('leave-pdf-file'))el('leave-pdf-file').value='';
    if(el('leave-pdf-label'))el('leave-pdf-label').innerHTML='اسحب ملف PDF هنا أو اضغط للاختيار';
    window._leavePdfData=null;window._leavePdfName=null;
}

function loadLeavePersonList(){
    const type=document.getElementById('leave-person-type').value;
    const sel=document.getElementById('leave-person-id');
    sel.innerHTML='';
    if(!type){sel.innerHTML='<option value="">-- اختر نوع الشخص أولاً --</option>';return;}
    if(type==='employee'){
        if(employees.length===0){sel.innerHTML='<option value="">لا يوجد موظفين</option>';showToast('لا يوجد موظفين','error');return;}
        sel.innerHTML='<option value="">-- اختر الموظف --</option>';
        employees.forEach(e=>{const opt=document.createElement('option');opt.value=e.id;opt.textContent=e.name;sel.appendChild(opt);});
    }
    if(type==='officer'){
        if(officers.length===0){sel.innerHTML='<option value="">لا يوجد ضباط</option>';showToast('لا يوجد ضباط','error');return;}
        sel.innerHTML='<option value="">-- اختر الضابط --</option>';
        officers.forEach(o=>{const opt=document.createElement('option');opt.value=o.id;opt.textContent=o.name;sel.appendChild(opt);});
    }
}

function calcLeaveDays(){
    const start=document.getElementById('leave-start').value;
    const end=document.getElementById('leave-end').value;
    const ret=document.getElementById('leave-return').value;
    if(start&&end){
        const startDate=new Date(start),endDate=new Date(end),today=new Date();
        if(endDate<startDate){showToast('تاريخ النهاية قبل البداية!','error');return;}
        const days=Math.ceil((endDate-startDate)/(1000*60*60*24))+1;
        document.getElementById('leave-days').value=days;
        document.getElementById('leave-preview').style.display='block';
        document.getElementById('preview-start').textContent=startDate.toLocaleDateString('ar-u-ca-gregory-nu-latn');
        document.getElementById('preview-end').textContent=endDate.toLocaleDateString('ar-u-ca-gregory-nu-latn');
        document.getElementById('preview-days').textContent=days+' يوم';
        if(ret){
            const retDate=new Date(ret);
            const remaining=Math.ceil((retDate-today)/(1000*60*60*24));
            document.getElementById('preview-return').textContent=retDate.toLocaleDateString('ar-u-ca-gregory-nu-latn');
            const remEl=document.getElementById('preview-remaining');
            remEl.textContent=remaining>0?remaining+' يوم':remaining===0?'اليوم!':Math.abs(remaining)+' يوم (تأخر)';
            remEl.style.color=remaining>=0?'#27ae60':'#e74c3c';
        }
        const statusSel=document.getElementById('leave-status');
        if(today<startDate)statusSel.value='قادمة';
        else if(today<=endDate)statusSel.value='جارية';
        else statusSel.value='منتهية';
    }
}

async function saveLeave(){
    const _saveBtn = (typeof event !== 'undefined' && event && event.currentTarget) ? event.currentTarget : null;
    _btnSetLoading(_saveBtn, true);
    try {
    const personType=document.getElementById('leave-person-type').value;
    const personId=document.getElementById('leave-person-id').value;
    const startDate=document.getElementById('leave-start').value;
    const endDate=document.getElementById('leave-end').value;
    if(!personType||!personId){showModalError('add-leave-modal','يرجى اختيار اسم الشخص');return;}
    if(!startDate||!endDate){showModalError('add-leave-modal','يرجى إدخال تاريخ بداية ونهاية الإجازة');return;}
    const person=personType==='employee'?employees.find(e=>e.id==personId):officers.find(o=>o.id==personId);
    const newLeave = {
        person_id:   parseInt(personId),
        person_type: personType,
        person_name: person?person.name:'غير محدد',
        type:        'leave',
        leave_type:  document.getElementById('leave-type').value,
        start_date:  startDate,
        end_date:    endDate,
        return_date: document.getElementById('leave-return').value,
        days:        parseInt(document.getElementById('leave-days').value)||0,
        status:      (currentUser && currentUser.role === 'admin') ? 'approved' : 'pending',
        notes:       document.getElementById('leave-notes').value,
        pdf_data:    null,
        pdf_name:    null
    };
    const leaveId = await window.db.addLeave(newLeave);
    if (leaveId && leaveId.success === false) {
        showModalError('add-leave-modal', 'فشل حفظ الإجازة: ' + (extractErrorMessage(leaveId) || 'أعد المحاولة'));
        return;
    }
    addLeave(newLeave);
    if(window._leavePdfData && leaveId){
        await window.db.updateLeavePdf(leaveId, window._leavePdfData, window._leavePdfName);
    }
    clearLeaveForm();
    closeAddLeaveModal();
    await loadAllData();
    renderLeaves();
    updateHome();
    const isAdmin = currentUser && currentUser.role === 'admin';
    if (!isAdmin && currentUser && (currentUser.role === 'employee' || currentUser.role === 'stats')) {
        loadEmployeeDashboard();
        addAdminNotification({
            type: 'leave',
            personName: person ? person.name : 'موظف',
            requestType: newLeave.leave_type || 'إجازة',
            date: startDate,
            refId: leaveId
        });
    }
    if (!isAdmin && currentUser && currentUser.role === 'officer') {
        loadOfficerDashboard();
        addAdminNotification({
            type: 'leave',
            personName: person ? person.name : 'ضابط',
            requestType: newLeave.leave_type || 'إجازة',
            date: startDate,
            refId: leaveId
        });
    }
    showToast(isAdmin ? 'تم تسجيل الإجازة بنجاح' : 'تم تقديم الطلب بنجاح','success');
    } catch (err) {
        console.error('saveLeave error:', err);
        showToast('فشل حفظ الإجازة: ' + extractErrorMessage(err), 'error');
    } finally {
        _btnSetLoading(_saveBtn, false);
    }
}

function renderLeaves(list=leaves){
    // استبعاد الإجازات المرفوضة
    list = list.filter(l => normalizeApprovalStatus(l.status) !== 'rejected');
    // تصحيح person_type بناءً على البيانات الفعلية
    list.forEach(l => {
        if (officers.find(o => o.id == l.person_id && o.name === l.person_name)) {
            l.person_type = 'officer';
        } else if (employees.find(e => e.id == l.person_id && e.name === l.person_name)) {
            l.person_type = 'employee';
        }
    });
    document.getElementById('leave-stat-total').textContent=list.length;
    document.getElementById('leave-stat-active').textContent=list.filter(l=>getLeaveStatus(l)==='جارية').length;
    document.getElementById('leave-stat-upcoming').textContent=list.filter(l=>getLeaveStatus(l)==='قادمة').length;
    document.getElementById('leave-stat-ended').textContent=list.filter(l=>getLeaveStatus(l)==='منتهية').length;
    if(list.length===0){
        document.getElementById('leaves-cards').innerHTML=`<div style="color:#999;padding:30px;text-align:center;">لا توجد إجازات</div>`;
        return;
    }
    const officerLeaves=list.filter(l=>l.person_type==='officer');
    const employeeLeaves=list.filter(l=>l.person_type!=='officer');
    const type=document.getElementById('leave-filter-type').value;
    let html='';
    const statusColors={'جارية':'#27ae60','قادمة':'#f39c12','منتهية':'#e74c3c'};
    const statusBg={'جارية':'#f0fff4','قادمة':'#fffdf0','منتهية':'#fef5f5'};
    const buildOfficerCard=(leave)=>{
        const status=getLeaveStatus(leave);
        const approval = getApprovalStatusMeta(leave.status);
        const off=officers.find(o=>o.id==leave.person_id);
        const rank=off?off.rank||'':''  ;
        return`<div class="leave-item-card" onclick="showLeaveDetails(${leave.id})" style="border-right:4px solid ${statusColors[status]||'#ccc'};background:${statusBg[status]||'#fff'};">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div style="flex:1;min-width:0;">
                    ${rank?'<div style="font-size:11px;font-weight:600;color:#2980b9;margin-bottom:2px;">'+rank+'</div>':''}
                    <div style="font-size:14px;font-weight:700;color:#1e293b;margin-bottom:3px;line-height:1.4;">${leave.person_name}</div>
                    <div style="font-size:11px;color:#64748b;">${leave.leave_type}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
                    <span class="badge ${getLeaveStatusBadge(status)}" style="font-size:11px;padding:4px 10px;white-space:nowrap;">${status}</span>
                    <span class="emp-status ${approval.className}" style="font-size:11px;">${approval.label}</span>
                </div>
            </div>
        </div>`;
    };
    const buildEmployeeCard=(leave,nameColor)=>{
        const status=getLeaveStatus(leave);
        const approval = getApprovalStatusMeta(leave.status);
        return`<div class="leave-item-card" onclick="showLeaveDetails(${leave.id})" style="border-right:4px solid ${statusColors[status]||'#ccc'};background:${statusBg[status]||'#fff'};">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div style="flex:1;min-width:0;">
                    <div style="font-size:14px;font-weight:700;color:#1e293b;margin-bottom:3px;line-height:1.4;">${leave.person_name}</div>
                    <div style="font-size:11px;color:#64748b;">${leave.leave_type}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
                    <span class="badge ${getLeaveStatusBadge(status)}" style="font-size:11px;padding:4px 10px;white-space:nowrap;">${status}</span>
                    <span class="emp-status ${approval.className}" style="font-size:11px;">${approval.label}</span>
                </div>
            </div>
        </div>`;
    };
    if(type==='all'){
        if(officerLeaves.length>0){
            html+=`<div style="background:linear-gradient(135deg,#2980b9,#5dade2);color:white;font-weight:bold;text-align:center;padding:10px;font-size:14px;border-radius:8px;letter-spacing:1px;">الضباط</div>`;
            html+=officerLeaves.map(l=>buildOfficerCard(l)).join('');
        }
        if(employeeLeaves.length>0){
            if(officerLeaves.length>0) html+=`<div style="height:12px;"></div>`;
            html+=`<div style="background:linear-gradient(135deg,#6B8E23,#8FBC3B);color:white;font-weight:bold;text-align:center;padding:10px;font-size:14px;border-radius:8px;letter-spacing:1px;">الموظفين</div>`;
            html+=employeeLeaves.map(l=>buildEmployeeCard(l,'#6b8e23')).join('');
        }
    } else if(type==='officer'){
        html+=list.map(l=>buildOfficerCard(l)).join('');
    } else {
        html+=list.map(l=>buildEmployeeCard(l,'#6b8e23')).join('');
    }
    document.getElementById('leaves-cards').innerHTML=html;
}

async function showLeavesFiltered(personType){
    await showPage('leaves');
    document.getElementById('leave-filter-type').value=personType;
    syncFilterPills();
    filterLeaves();
}

// Sync pills UI with hidden select values
function syncFilterPills(){
    document.querySelectorAll('.filter-pills[data-target]').forEach(container=>{
        const sel=document.getElementById(container.dataset.target);
        if(!sel)return;
        container.querySelectorAll('.filter-pill').forEach(p=>{
            p.classList.toggle('active', p.dataset.value===sel.value);
        });
    });
}

// (filter pills handler moved to bindEvents())

function filterLeaves(){
    const type=document.getElementById('leave-filter-type').value;
    const category=document.getElementById('leave-filter-category').value;
    const status=document.getElementById('leave-filter-status').value;
    renderLeaves(leaves.filter(l=>(type==='all'||l.person_type===type)&&(category==='all'||l.leave_type===category)&&(status==='all'||getLeaveStatus(l)===status)));
    // تغيير الألوان حسب نوع الشخص
    const colors = type==='employee' ? {main:'#6b8e23',active:'#90EE90',activeText:'#4CAF50',upcoming:'#f39c12',ended:'#e74c3c'}
                 : type==='officer'  ? {main:'#2980b9',active:'#90EE90',activeText:'#4CAF50',upcoming:'#f39c12',ended:'#e74c3c'}
                 :                     {main:'#3498db',active:'#90EE90',activeText:'#4CAF50',upcoming:'#f39c12',ended:'#e74c3c'};
    document.getElementById('leave-card-total').style.borderTopColor=colors.main;
    document.getElementById('leave-stat-total').style.color=colors.main;
    document.getElementById('leave-card-active').style.borderTopColor=colors.active;
    document.getElementById('leave-stat-active').style.color=colors.activeText;
    document.getElementById('leave-card-upcoming').style.borderTopColor=colors.upcoming;
    document.getElementById('leave-stat-upcoming').style.color=colors.upcoming;
    document.getElementById('leave-card-ended').style.borderTopColor=colors.ended;
    document.getElementById('leave-stat-ended').style.color=colors.ended;
    const addBtn=document.getElementById('leave-add-btn');
    if(addBtn){addBtn.className='filter-pill';}
    const printBtn=document.getElementById('leave-print-btn');
    if(printBtn){printBtn.className='filter-pill';}
}

function printLeaves(){
    const type=document.getElementById('leave-filter-type').value;
    const category=document.getElementById('leave-filter-category').value;
    const status=document.getElementById('leave-filter-status').value;
    const filtered=leaves.filter(l=>(type==='all'||l.person_type===type)&&(category==='all'||l.leave_type===category)&&(status==='all'||getLeaveStatus(l)===status));
    if(filtered.length===0){showToast('لا توجد إجازات للطباعة','error');return;}
    const printData={
        filterType:type,
        filterCategory:category,
        filterStatus:status,
        leaves:filtered.map(l=>{
            let rank='';
            if(l.person_type==='officer'){const off=officers.find(o=>o.id==l.person_id);if(off)rank=off.rank||'';}
            return {person_name:l.person_name,person_type:l.person_type,leave_type:l.leave_type,start_date:l.start_date,end_date:l.end_date,return_date:l.return_date||'',days:l.days,status:getLeaveStatus(l),notes:l.notes||'',rank:rank};
        })
    };
    window.db.printLeavesReport(printData).then((res)=>{
        if(res && res.cancelled) showToast('تم إلغاء الطباعة','error');
        else showToast('تم إرسال النموذج إلى الطابعة','success');
    }).catch(err=>{
        console.error('خطأ في الطباعة:',err);
        showToast('حدث خطأ أثناء الطباعة','error');
    });
}

function showLeaveDetails(id){
    const leave=leaves.find(l=>l.id===id);if(!leave)return;
    const canModify = !isApprovedAndNonAdmin(leave.status);
    const status=getLeaveStatus(leave);
    const startDate=new Date(leave.start_date),endDate=new Date(leave.end_date),today=new Date();
    const retDate=leave.return_date?new Date(leave.return_date):null;
    let progressPct=0;
    if(status==='جارية')progressPct=Math.min(100,Math.round(((today-startDate)/(endDate-startDate))*100));
    else if(status==='منتهية')progressPct=100;

    const isOfficer = leave.person_type==='officer';
    const officerObj = isOfficer ? officers.find(x=>x.id==leave.person_id) : null;
    const rankText = officerObj && officerObj.rank ? officerObj.rank + ' — ' : '';
    const headerGrad = isOfficer ? 'linear-gradient(135deg,#1a365d 0%,#1e40af 100%)' : 'linear-gradient(135deg,#2d3a1a 0%,#556b2f 100%)';
    const accentColor = isOfficer ? '#2563eb' : '#556b2f';

    const remainDays = status==='جارية'?Math.max(0,Math.ceil((endDate-today)/(1000*60*60*24))):status==='قادمة'?Math.ceil((startDate-today)/(1000*60*60*24)):0;
    const remainLabel = status==='جارية'?'متبقي على النهاية':status==='قادمة'?'أيام حتى البدء':'منتهية';
    const returnRemain = retDate?(status==='منتهية'?0:Math.max(0,Math.ceil((retDate-today)/(1000*60*60*24)))):null;

    const modal=document.createElement('div');modal.className='modal-overlay active';modal.id='leave-details-modal';
    modal.innerHTML=`<div class="modal detail-modal">
    <div class="detail-header" style="background:${headerGrad};">
        <button class="detail-close-btn" onclick="closeLeaveDetails()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar" style="font-size:34px;">${getLeaveTypeIcon(leave.leave_type)}</div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">${leave.person_name}</h2>
                <p class="detail-header-sub">${rankText}${isOfficer?'ضابط':'موظف'} — ${leave.leave_type}</p>
                <div class="detail-header-badges">
                    <span class="detail-badge ${status==='جارية'?'success':status==='قادمة'?'warning':''}">${status}</span>
                </div>
            </div>
            <div class="detail-id-card">
                <div class="detail-id-label">عدد الأيام</div>
                <div class="detail-id-value">${leave.days}</div>
            </div>
        </div>
    </div>
    <div class="detail-tabs">
        <button class="detail-tab active" id="btn-ltab-info" onclick="switchLeaveTab('ltab-info')">التفاصيل</button>
        <button class="detail-tab ${canModify?'':'disabled'}" id="btn-ltab-edit" ${canModify?`onclick="switchLeaveTab('ltab-edit');loadEditLeaveData(${leave.id})"`:''}>تعديل</button>
    </div>
    <div class="modal-body" style="padding:12px 14px;overflow-y:auto;flex:1;">
        <div id="ltab-info">
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px;">
                <div class="data-field" style="text-align:center;"><div style="flex:1;"><div class="data-field-label">بداية الإجازة</div><div class="data-field-value" style="color:#16a34a;">${leave.start_date}</div></div></div>
                <div class="data-field" style="text-align:center;"><div style="flex:1;"><div class="data-field-label">نهاية الإجازة</div><div class="data-field-value" style="color:#dc2626;">${leave.end_date}</div></div></div>
                <div class="data-field" style="text-align:center;"><div style="flex:1;"><div class="data-field-label">المباشرة</div><div class="data-field-value" style="color:${accentColor};">${retDate?leave.return_date:'غير محدد'}</div></div></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px;">
                <div style="background:#f8fafc;border:1px solid #e2e8f0;padding:8px 4px;border-radius:8px;text-align:center;">
                    <div style="font-size:18px;font-weight:800;color:${accentColor};">${leave.days}</div>
                    <div style="color:#94a3b8;font-size:10px;margin-top:1px;">إجمالي الأيام</div>
                </div>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;padding:8px 4px;border-radius:8px;text-align:center;">
                    <div style="font-size:18px;font-weight:800;color:${status==='منتهية'?'#94a3b8':'#f59e0b'};">${status==='منتهية'?'✓':remainDays}</div>
                    <div style="color:#94a3b8;font-size:10px;margin-top:1px;">${remainLabel}</div>
                </div>
                <div style="background:#f8fafc;border:1px solid #e2e8f0;padding:8px 4px;border-radius:8px;text-align:center;">
                    <div style="font-size:18px;font-weight:800;color:${status==='منتهية'?'#94a3b8':'#16a34a'};">${retDate?(status==='منتهية'?'✓':returnRemain):'-'}</div>
                    <div style="color:#94a3b8;font-size:10px;margin-top:1px;">متبقي على المباشرة</div>
                </div>
            </div>
            ${status!=='قادمة'?`<div style="background:#f8fafc;border:1px solid #e2e8f0;padding:12px;border-radius:10px;margin-bottom:12px;">
                <div style="display:flex;justify-content:space-between;margin-bottom:6px;"><span style="font-weight:600;color:#334155;">تقدم الإجازة</span><span style="font-weight:700;color:${accentColor};">${progressPct}%</span></div>
                <div style="background:#e2e8f0;border-radius:8px;height:8px;overflow:hidden;"><div style="background:${progressPct>=100?'#16a34a':accentColor};height:100%;border-radius:8px;width:${progressPct}%;transition:width 0.5s;"></div></div>
            </div>`:''}
            ${leave.notes?`<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px;margin-bottom:12px;">
                <div style="font-weight:600;color:#92400e;font-size:13px;margin-bottom:4px;">ملاحظات</div>
                <div style="color:#78350f;line-height:1.5;">${leave.notes}</div>
            </div>`:''}
            <div id="leave-pdf-section">
            ${leave.pdf_name?`<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:10px;display:flex;align-items:center;justify-content:space-between;">
                <div style="flex:1;min-width:0;"><span style="font-weight:600;color:#0369a1;">ملف مرفق:</span> <span style="color:#64748b;">${leave.pdf_name}</span></div>
                <div style="display:flex;gap:6px;flex-shrink:0;">
                    <button class="btn btn-primary" style="font-size:12px;padding:4px 10px;border-radius:8px;background:#2563eb;color:#fff;" onclick="viewLeavePdf(${leave.id})">عرض</button>
                    <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;font-size:12px;padding:4px 10px;border-radius:8px;" onclick="downloadLeavePdf(${leave.id})">تحميل</button>
                </div>
            </div>`:`<div style="background:#f8fafc;border:1px dashed #d1d5db;border-radius:10px;padding:14px;text-align:center;color:#94a3b8;">لا يوجد ملف PDF مرفق</div>`}
            </div>
        </div>
        <div id="ltab-edit" style="display:none;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                <div class="form-group"><label>نوع الإجازة</label><select id="edit-leave-type"><option value="دورية">دورية</option><option value="إدارية">إدارية</option><option value="دراسية">دراسية</option><option value="طارئة">طارئة</option><option value="حج">حج</option><option value="مرضية">مرضية</option></select></div>
                <div class="form-group"><label>عدد الأيام</label><input type="number" id="edit-leave-days" readonly style="background:#f8fafc;"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                <div class="form-group"><label>بداية الإجازة</label><input type="date" id="edit-leave-start" onchange="calcEditLeaveDays()"></div>
                <div class="form-group"><label>نهاية الإجازة</label><input type="date" id="edit-leave-end" onchange="calcEditLeaveDays()"></div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
                <div class="form-group"><label>تاريخ المباشرة</label><input type="date" id="edit-leave-return"></div>
                <div class="form-group"><label>ملاحظات</label><input type="text" id="edit-leave-notes" placeholder="ملاحظات..."></div>
            </div>
            <div style="margin-bottom:8px;">
                <label style="font-weight:600;color:#1a3a6b;display:block;margin-bottom:4px;">ملف PDF</label>
                <div id="edit-leave-pdf-area" style="border:2px dashed #d1d5db;border-radius:10px;padding:14px;text-align:center;cursor:pointer;transition:all 0.3s;background:#f8fafc;" onclick="document.getElementById('edit-leave-pdf-file').click()" ondragover="event.preventDefault();this.style.borderColor='#16a34a';this.style.background='#f0fdf4'" ondragleave="this.style.borderColor='#d1d5db';this.style.background='#f8fafc'" ondrop="event.preventDefault();this.style.borderColor='#d1d5db';this.style.background='#f8fafc';handleEditLeavePdfDrop(event)">
                    <div id="edit-leave-pdf-label" style="color:#94a3b8;">اسحب ملف PDF هنا أو اضغط للاختيار</div>
                    <input type="file" id="edit-leave-pdf-file" accept=".pdf,application/pdf" style="display:none;" onchange="handleEditLeavePdfSelect(this)">
                </div>
                <div id="edit-leave-pdf-current" style="margin-top:6px;"></div>
            </div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                ${canModify ? `<button class="btn btn-primary" style="border-radius:10px;" onclick="saveEditLeave(${leave.id})">حفظ التعديلات</button>` : ''}
                <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;border-radius:10px;" onclick="switchLeaveTab('ltab-info')">إلغاء</button>
            </div>
        </div>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#7c3aed;color:white;" onclick="importLeavePdfDirect(${leave.id})">سحب ملف</button>
        ${canModify ? `<button class="btn btn-danger btn-spacer" style="background:#ff3b30;color:white;" onclick="deleteLeaveFromModal(${leave.id})">حذف</button>` : ''}
        <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;" onclick="closeLeaveDetails()">إغلاق</button>
    </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)closeLeaveDetails();});
}

function switchLeaveTab(tabId){
    ['ltab-info','ltab-edit'].forEach(id=>{
        const el=document.getElementById(id);if(el)el.style.display='none';
        const btn=document.getElementById('btn-'+id);if(btn)btn.className='detail-tab';
    });
    document.getElementById(tabId).style.display='block';
    document.getElementById('btn-'+tabId).className='detail-tab active';
}

function loadEditLeaveData(id){
    const leave=leaves.find(l=>l.id===id);if(!leave)return;
    document.getElementById('edit-leave-type').value=leave.leave_type;
    document.getElementById('edit-leave-start').value=leave.start_date;
    document.getElementById('edit-leave-end').value=leave.end_date;
    document.getElementById('edit-leave-return').value=leave.return_date||'';
    document.getElementById('edit-leave-days').value=leave.days;
    document.getElementById('edit-leave-notes').value=leave.notes||'';
    window._editLeavePdfData=null;window._editLeavePdfName=null;window._editLeavePdfRemove=false;
    document.getElementById('edit-leave-pdf-file').value='';
    document.getElementById('edit-leave-pdf-label').innerHTML='اسحب ملف PDF هنا أو اضغط للاختيار';
    const pdfCur=document.getElementById('edit-leave-pdf-current');
    if(leave.pdf_name){
        pdfCur.innerHTML=`<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px;display:flex;align-items:center;justify-content:space-between;"><span style="font-size:15px;">الملف الحالي: <strong>${leave.pdf_name}</strong></span><button class="btn btn-danger" style="font-size:13px;padding:4px 10px;border-radius:8px;" onclick="markRemoveEditPdf()">حذف الملف</button></div>`;
    } else {
        pdfCur.innerHTML='';
    }
}

function calcEditLeaveDays(){
    const start=document.getElementById('edit-leave-start').value;
    const end=document.getElementById('edit-leave-end').value;
    if(start&&end){
        const days=Math.ceil((new Date(end)-new Date(start))/(1000*60*60*24))+1;
        document.getElementById('edit-leave-days').value=days>0?days:0;
    }
}

async function saveEditLeave(id){
    const leave = leaves.find(l => l.id === id);
    if (leave && isApprovedAndNonAdmin(leave.status)) {
        showModalError('leave-details-modal', 'لا يمكن تعديل الإجازة بعد موافقة الأدمن');
        return;
    }
    const data={
        leave_type: document.getElementById('edit-leave-type').value,
        start_date: document.getElementById('edit-leave-start').value,
        end_date: document.getElementById('edit-leave-end').value,
        return_date: document.getElementById('edit-leave-return').value||null,
        days: parseInt(document.getElementById('edit-leave-days').value)||0,
        notes: document.getElementById('edit-leave-notes').value||null
    };
    if(!data.start_date||!data.end_date){showModalError('leave-details-modal','يرجى تحديد تاريخ البداية والنهاية');return;}
    await window.db.updateLeave(id, data);
    if(window._editLeavePdfRemove){
        await window.db.removeLeavePdf(id);
    }
    if(window._editLeavePdfData){
        await window.db.updateLeavePdf(id, window._editLeavePdfData, window._editLeavePdfName);
    }
    await loadAllData();
    renderLeaves();
    updateHome();
    if (currentUser && (currentUser.role === 'employee' || currentUser.role === 'stats')) {
        loadEmployeeRequests();
        loadEmployeeDashboard();
    }
    closeLeaveDetails();
    showLeaveDetails(id);
    showToast('✅ تم تعديل الإجازة بنجاح','success');
}

async function deleteLeaveFromModal(id){
    const leave = leaves.find(l => l.id === id);
    if (leave && isApprovedAndNonAdmin(leave.status)) {
        showToast('لا يمكن حذف الإجازة بعد موافقة الأدمن', 'error');
        return;
    }
    if(!confirm('هل تريد حذف هذه الإجازة؟')) return;
    await window.db.deleteLeave(id);
    await loadAllData();
    renderLeaves();
    updateHome();
    closeLeaveDetails();
    if (currentUser && (currentUser.role === 'employee' || currentUser.role === 'stats')) {
        loadEmployeeRequests();
        loadEmployeeDashboard();
    }
    showToast('🗑️ تم حذف الإجازة','warning');
}

function closeLeaveDetails(){const m=document.getElementById('leave-details-modal');if(m)m.remove();}

// === PDF Leave Functions ===
function handleLeavePdfSelect(input){
    const file=input.files[0];
    if(!file)return;
    if(file.type!=='application/pdf'){showToast('⚠️ يرجى اختيار ملف PDF فقط','error');input.value='';return;}
    if(file.size>20*1024*1024){showToast('⚠️ حجم الملف يتجاوز 20MB','error');input.value='';return;}
    const reader=new FileReader();
    reader.onload=function(e){
        const base64=e.target.result.split(',')[1];
        window._leavePdfData=base64;
        window._leavePdfName=file.name;
        document.getElementById('leave-pdf-label').innerHTML=`<span style="color:#27ae60;">✅ ${file.name} <span style="color:#999;">(${(file.size/1024).toFixed(1)} KB)</span></span> <button class="btn btn-danger" style="font-size:12px;padding:3px 8px;margin-right:5px;" onclick="event.stopPropagation();clearLeavePdf()">✕</button>`;
    };
    reader.readAsDataURL(file);
}
function handleLeavePdfDrop(e){
    const file=e.dataTransfer.files[0];
    if(!file)return;
    const input=document.getElementById('leave-pdf-file');
    const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;
    handleLeavePdfSelect(input);
}
function clearLeavePdf(){
    window._leavePdfData=null;window._leavePdfName=null;
    document.getElementById('leave-pdf-file').value='';
    document.getElementById('leave-pdf-label').innerHTML='📄 اسحب ملف PDF هنا أو اضغط للاختيار';
}
function handleEditLeavePdfSelect(input){
    const file=input.files[0];
    if(!file)return;
    if(file.type!=='application/pdf'){showToast('⚠️ يرجى اختيار ملف PDF فقط','error');input.value='';return;}
    if(file.size>20*1024*1024){showToast('⚠️ حجم الملف يتجاوز 20MB','error');input.value='';return;}
    const reader=new FileReader();
    reader.onload=function(e){
        const base64=e.target.result.split(',')[1];
        window._editLeavePdfData=base64;
        window._editLeavePdfName=file.name;
        window._editLeavePdfRemove=false;
        document.getElementById('edit-leave-pdf-label').innerHTML=`<span style="color:#27ae60;">✅ ${file.name} <span style="color:#999;">(${(file.size/1024).toFixed(1)} KB)</span></span> <button class="btn btn-danger" style="font-size:12px;padding:3px 8px;margin-right:5px;" onclick="event.stopPropagation();clearEditLeavePdf()">✕</button>`;
        document.getElementById('edit-leave-pdf-current').innerHTML='';
    };
    reader.readAsDataURL(file);
}
function handleEditLeavePdfDrop(e){
    const file=e.dataTransfer.files[0];
    if(!file)return;
    const input=document.getElementById('edit-leave-pdf-file');
    const dt=new DataTransfer();dt.items.add(file);input.files=dt.files;
    handleEditLeavePdfSelect(input);
}
function clearEditLeavePdf(){
    window._editLeavePdfData=null;window._editLeavePdfName=null;
    document.getElementById('edit-leave-pdf-file').value='';
    document.getElementById('edit-leave-pdf-label').innerHTML='📄 اسحب ملف PDF هنا أو اضغط للاختيار';
}
function markRemoveEditPdf(){
    window._editLeavePdfRemove=true;window._editLeavePdfData=null;window._editLeavePdfName=null;
    document.getElementById('edit-leave-pdf-current').innerHTML='<div style="background:#fdedec;border-radius:8px;padding:10px;color:#e74c3c;text-align:center;">🗑️ سيتم حذف الملف عند الحفظ</div>';
}
async function viewLeavePdf(id){
    // open window BEFORE await to avoid popup blocker
    const newWin = window.open('', '_blank');
    const result=await window.db.getLeavePdf(id);
    if(!result||!result.pdf_data){
        if(newWin) newWin.close();
        showToast('⚠️ لا يوجد ملف','error');
        return;
    }
    const blob=new Blob([Uint8Array.from(atob(result.pdf_data),c=>c.charCodeAt(0))],{type:'application/pdf'});
    const url=URL.createObjectURL(blob);
    if(newWin){
        newWin.location.href=url;
    } else {
        const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener';a.click();
    }
    setTimeout(()=>URL.revokeObjectURL(url),30000);
}
function closePdfViewer(){
    const m=document.getElementById('pdf-viewer-modal');
    if(m){if(m._pdfUrl)URL.revokeObjectURL(m._pdfUrl);m.remove();}
}
async function downloadLeavePdf(id){
    const result=await window.db.getLeavePdf(id);
    if(!result||!result.pdf_data){showToast('⚠️ لا يوجد ملف','error');return;}
    const blob=new Blob([Uint8Array.from(atob(result.pdf_data),c=>c.charCodeAt(0))],{type:'application/pdf'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=result.pdf_name||'ملف.pdf';a.click();
    showToast('تم تحميل الملف','success');
}
function importLeavePdfDirect(id){
    const input=document.createElement('input');
    input.type='file';input.accept='.pdf,application/pdf';
    input.onchange=async function(){
        const file=input.files[0];
        if(!file)return;
        if(file.type!=='application/pdf'){showToast('⚠️ يرجى اختيار ملف PDF فقط','error');return;}
        if(file.size>20*1024*1024){showToast('⚠️ حجم الملف يتجاوز 20MB','error');return;}
        const reader=new FileReader();
        reader.onload=async function(e){
            const base64=e.target.result.split(',')[1];
            await window.db.updateLeavePdf(id,base64,file.name);
            leaves = await window.db.getLeaves();
            showToast('✅ تم رفع الملف بنجاح وحفظ نسخة بالأرشيف','success');
            closeLeaveDetails();
            showLeaveDetails(id);
        };
        reader.readAsDataURL(file);
    };
    input.click();
}
async function deleteLeave(id){
    if(confirm('حذف الإجازة؟')){
        await window.db.deleteLeave(id);
        await loadAllData();
        renderLeaves();
        updateHome();
        showToast('🗑️ تم الحذف','warning');
    }
}

function exportLeaves(){
    let csv='رقم,الاسم,النوع,نوع_الإجازة,البداية,النهاية,المباشرة,الأيام,الحالة\n';
    leaves.forEach((l,i)=>csv+=`${i+1},"${l.person_name}","${l.person_type==='officer'?'ضابط':'موظف'}","${l.leave_type}","${l.start_date}","${l.end_date}","${l.return_date||''}","${l.days}","${getLeaveStatus(l)}"\n`);
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8;'}));a.download=`Leaves_${Date.now()}.csv`;a.click();
    showToast('✅ تم التصدير!','success');
}

// ═══════════════════════════════════════
// التقارير
// ═══════════════════════════════════════
function renderReports(){
    const ranks={};
    officers.forEach(o=>{const r=o.rank||'غير محدد';ranks[r]=(ranks[r]||0)+1;});
    document.getElementById('rank-report').innerHTML=Object.entries(ranks).map(([r,c])=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;margin-bottom:6px;background:linear-gradient(145deg,#ececec,#f8f8f8);border-radius:12px;box-shadow:2px 2px 6px rgba(0,0,0,0.08),-2px -2px 6px rgba(255,255,255,0.7);"><span>${getRankBadge(r)}</span><span class="badge badge-purple">${c} ضابط</span></div>`).join('')||'<p style="color:#999;text-align:center;padding:20px;">لا بيانات</p>';
    const depts={};
    employees.forEach(e=>{const d=e.department||'غير محدد';depts[d]=(depts[d]||0)+1;});
    document.getElementById('dept-report').innerHTML=Object.entries(depts).map(([d,c])=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;margin-bottom:6px;background:linear-gradient(145deg,#ececec,#f8f8f8);border-radius:12px;box-shadow:2px 2px 6px rgba(0,0,0,0.08),-2px -2px 6px rgba(255,255,255,0.7);"><span style="font-weight:600;color:#2c3e50;font-size:13px;">${d}</span><span class="badge badge-info">${c} موظف</span></div>`).join('')||'<p style="color:#999;text-align:center;padding:20px;">لا بيانات</p>';
    document.getElementById('leaves-report-table').innerHTML=[...leaves].slice(0,10).map((l,i)=>`<tr><td>${i+1}</td><td>${l.person_name}</td><td>${getLeaveTypeIcon(l.leave_type)} ${l.leave_type}</td><td>${l.start_date}</td><td>${l.end_date}</td><td>${l.return_date||'-'}</td><td><span class="badge ${getLeaveStatusBadge(getLeaveStatus(l))}">${getLeaveStatus(l)}</span></td></tr>`).join('')||'<tr><td colspan="7" style="color:#999;padding:20px;text-align:center;">لا بيانات</td></tr>';
}

// ═══════════════════════════════════════
// النسخ الاحتياطية
// ═══════════════════════════════════════
async function createBackup(){
    showToast('⏳ جاري إنشاء النسخة...','info');
    const result = await window.db.createBackup();
    if(result.success){
        await loadAllData();
        renderBackups();
        showToast('✅ تم إنشاء النسخة الاحتياطية!','success');
    } else {
        showToast('❌ تم إلغاء العملية','error');
    }
}

function importBackup(){
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.txt,*/*';
    input.style.position = 'fixed';
    input.style.top = '-9999px';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.onchange = function() {
        var file = input.files[0];
        document.body.removeChild(input);
        if (!file) { showToast('❌ تم إلغاء العملية','error'); return; }
        showToast('⏳ جاري استيراد النسخة...','info');
        var reader = new FileReader();
        reader.onerror = function() {
            showToast('❌ خطأ في قراءة الملف: ' + (reader.error ? reader.error.message : 'غير معروف'),'error');
        };
        reader.onload = function() {
            try {
                var text = reader.result;
                if (!text || text.length < 2) {
                    showToast('❌ الملف فارغ','error');
                    return;
                }
                var data = JSON.parse(text);
                if (!data || typeof data !== 'object') {
                    showToast('❌ ملف غير صالح','error');
                    return;
                }
                var result = window.db.importBackupData(text);
                if(result && result.success){
                    loadAllData().then(function(){
                        updateHome();
                        showToast('✅ تم استيراد النسخة بنجاح!','success');
                    });
                } else {
                    showToast('❌ ' + (result && result.error ? result.error : 'فشل الاستيراد'),'error');
                }
            } catch(err) {
                console.error('Import parse error:', err);
                showToast('❌ خطأ: ' + err.message,'error');
            }
        };
        reader.readAsText(file);
    };
    setTimeout(function(){ input.click(); }, 100);
}

async function renderBackups(){
    const backups = await window.db.getBackups();
    document.getElementById('backups-table').innerHTML = backups.length===0
        ? '<tr><td colspan="6" style="color:#999;padding:30px;text-align:center;">لا توجد نسخ</td></tr>'
        : backups.map((b,i)=>`<tr><td>${i+1}</td><td>💾 ${b.name}</td><td>${b.created_at}</td><td>${b.size}</td><td><span class="badge badge-success">${b.status}</span></td><td><button class="btn btn-danger" style="font-size:13px;padding:5px 10px;" onclick="deleteBackup(${b.id})">🗑️</button></td></tr>`).join('');
}

async function deleteBackup(id){
    if(confirm('حذف النسخة؟')){
        await window.db.deleteBackup(id);
        renderBackups();
        showToast('🗑️ تم الحذف','warning');
    }
}

// ═══════════════════════════════════════
// دوال عامة
// ═══════════════════════════════════════
function openModal(id){document.getElementById(id).classList.add('active');}
function closeModal(id){document.getElementById(id).classList.remove('active');}

// (modal overlay handler moved to bindEvents())

function showModalError(modalId, msg) {
    const modal = document.getElementById(modalId);
    if (!modal) { showToast(msg, 'error'); return; }
    let box = modal.querySelector('.modal-error-box');
    if (!box) {
        box = document.createElement('div');
        box.className = 'modal-error-box';
        const footer = modal.querySelector('.detail-footer');
        if (footer) footer.parentNode.insertBefore(box, footer);
        else modal.querySelector('.modal-body, [style*="padding"]')?.appendChild(box);
    }
    box.innerHTML = `
        <div style="margin:0 14px 12px;padding:14px 16px;background:#fef2f2;border:2px solid #ef4444;
            border-radius:14px;display:flex;align-items:center;gap:10px;">
            <span style="font-size:26px;flex-shrink:0;">⚠️</span>
            <div>
                <div style="font-weight:700;font-size:14px;color:#b91c1c;">تعذّر الحفظ</div>
                <div style="font-size:13px;color:#dc2626;margin-top:2px;">${msg}</div>
            </div>
        </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showToast(msg, type='info'){
    const old = document.querySelector('.toast'); if(old) old.remove();
    const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
    const colors = { success:'#30d158', error:'#ff453a', warning:'#ffd60a', info:'#0a84ff' };
    // إزالة الـ emoji إذا كان موجوداً في بداية أو نهاية الرسالة
    const allIcons = Object.values(icons);
    let cleanMsg = msg;
    allIcons.forEach(ic => {
        cleanMsg = cleanMsg.replace(new RegExp('^' + ic + '\\s*'), '').replace(new RegExp('\\s*' + ic + '$'), '');
    });
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="toast-icon" style="color:${colors[type]||'#fff'};filter:drop-shadow(0 0 4px ${colors[type]||'#fff'}44);">${icons[type]||'ℹ️'}</span><span class="toast-text">${cleanMsg}</span>`;
    document.body.appendChild(t);
    setTimeout(()=>{
        t.style.animation = 'none';
        t.style.transition = 'opacity 0.3s, transform 0.3s';
        t.style.opacity = '0';
        t.style.transform = 'translateX(-50%) translateY(-20px)';
        setTimeout(()=>t.remove(), 300);
    }, 3000);
}

function showConfirm(msg, isDanger=false){
    return new Promise(resolve=>{
        const old=document.querySelector('.ios-dialog-overlay');if(old)old.remove();
        const ov=document.createElement('div');ov.className='ios-dialog-overlay';
        ov.innerHTML=`<div class="ios-dialog"><div class="ios-dialog-msg">${msg}</div><div class="ios-dialog-buttons"><button class="ios-dialog-btn confirm ${isDanger?'danger':''}" id="_ios_ok">تأكيد</button><button class="ios-dialog-btn cancel" id="_ios_cancel">إلغاء</button></div></div>`;
        document.body.appendChild(ov);
        ov.querySelector('#_ios_ok').onclick=()=>{ov.remove();resolve(true);};
        ov.querySelector('#_ios_cancel').onclick=()=>{ov.remove();resolve(false);};
    });
}

function showAlert(msg){
    return new Promise(resolve=>{
        const old=document.querySelector('.ios-dialog-overlay');if(old)old.remove();
        const ov=document.createElement('div');ov.className='ios-dialog-overlay';
        ov.innerHTML=`<div class="ios-dialog"><div class="ios-dialog-msg">${msg}</div><div class="ios-dialog-buttons"><button class="ios-dialog-btn confirm" id="_ios_ok">حسناً</button></div></div>`;
        document.body.appendChild(ov);
        ov.querySelector('#_ios_ok').onclick=()=>{ov.remove();resolve();};
    });
}

// ═══════════════════════════════════════
// الاستئذانات
// ═══════════════════════════════════════
// ترتيب الرتب العسكرية حسب الأقدمية (الأعلى أولاً)
const RANK_ORDER = ['فريق أول','فريق','لواء','عميد','عقيد','مقدم','رائد','نقيب','ملازم أول','ملازم','وكيل ضابط','مرشح ضابط'];
function getRankIndex(rank) {
    if (!rank) return 999;
    for (let i = 0; i < RANK_ORDER.length; i++) {
        if (rank.includes(RANK_ORDER[i])) return i;
    }
    return 998;
}

async function loadPermissions() {
    const raw = await window.db.getLeavePermissions();
    leavePermissions = raw.map(p => {
        let name = '';
        let rank = '';
        if (p.person_type === 'officer') {
            const o = officers.find(o => o.id == p.employee_id);
            name = o ? (o.rank ? o.rank + ' ' : '') + o.name : '';
            rank = o ? (o.rank || '') : '';
        } else {
            const e = employees.find(e => e.id == p.employee_id);
            name = e ? e.name : '';
        }
        return {
            ...p,
            request_type: p.request_type || 'permission',
            status: normalizeApprovalStatus(p.status),
            person_id: p.employee_id,
            employee_name: name,
            officer_rank: rank
        };
    });
}

function showAddPermissionModal(presetType, presetId){
    const existing=document.getElementById('add-perm-modal');if(existing)existing.remove();
    const modal=document.createElement('div');modal.className='modal-overlay active';modal.id='add-perm-modal';
    modal.innerHTML=`<div class="modal detail-modal">
    <div class="detail-header" style="background:linear-gradient(135deg,#1a365d 0%,#007aff 100%);">
        <button class="detail-close-btn" onclick="closeAddPermModal()">✕</button>
        <div class="detail-header-content">
            <div class="detail-avatar" style="font-size:34px;">🕐</div>
            <div class="detail-header-info">
                <h2 class="detail-header-name">إضافة استئذان جديد</h2>
                <p class="detail-header-sub">تسجيل استئذان لموظف أو ضابط</p>
            </div>
        </div>
    </div>
    <div class="modal-body" style="padding:12px 14px;overflow-y:auto;flex:1;">
        <select id="perm-person-type" onchange="loadPermPersonList()" style="display:none;">
            <option value="employee">موظف</option>
            <option value="officer">ضابط</option>
        </select>
        ${!presetId ? `<div class="form-group" style="margin-bottom:14px;">
            <label style="margin-bottom:6px;display:block;">نوع الشخص</label>
            <div style="display:flex;gap:8px;">
                <button type="button" id="perm-toggle-emp" onclick="setPermPersonType('employee')"
                    style="flex:1;padding:10px 8px;border-radius:10px;border:2px solid #007aff;background:#007aff;color:white;font-weight:700;font-size:14px;cursor:pointer;transition:all 0.18s;">
                    👤 موظف
                </button>
                <button type="button" id="perm-toggle-off" onclick="setPermPersonType('officer')"
                    style="flex:1;padding:10px 8px;border-radius:10px;border:2px solid #e2e8f0;background:white;color:#64748b;font-weight:700;font-size:14px;cursor:pointer;transition:all 0.18s;">
                    🎖️ ضابط
                </button>
            </div>
        </div>` : ''}
        <div class="form-group" style="margin-bottom:12px;"><label>الاسم *</label>
            <select id="perm-employee" ${presetId ? 'disabled style="background:#f1f5f9;color:#64748b;pointer-events:none;"' : ''}>
                <option value="">-- اختر --</option>
            </select>
        </div>
        <div class="form-group" style="margin-bottom:12px;"><label>التاريخ *</label>
            <input type="date" id="perm-date">
        </div>
        <div class="form-group" style="margin-bottom:12px;"><label>نوع الاستئذان *</label>
            <select id="perm-type" onchange="updatePermissionPreview()">
                <option value="start">بداية دوام</option>
                <option value="end">نهاية دوام</option>
            </select>
        </div>
        <div class="form-group" style="margin-bottom:12px;"><label>ملاحظات</label>
            <input type="text" id="perm-notes" placeholder="ملاحظات...">
        </div>
        <div id="perm-preview" style="display:none;background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px;margin-bottom:14px;">
            <div style="font-weight:600;color:#1a365d;font-size:15px;margin-bottom:10px;">معاينة</div>
            <div id="perm-preview-content" style="font-size:15px;line-height:1.7;color:#1c1c1e;"></div>
            <div id="perm-monthly-usage" style="margin-top:10px;padding:10px;background:#f2f2f7;border-radius:8px;font-size:13px;color:#3c3c43;"></div>
        </div>
    </div>
    <div class="detail-footer">
        <button class="btn" style="background:#007aff;color:white;" onclick="savePermission()">${(currentUser && currentUser.role === 'admin') ? '💾 حفظ الاستئذان' : 'تقديم طلب'}</button>
        <button class="btn" style="background:#f1f5f9;color:#475569;border:1px solid #e2e8f0;" onclick="closeAddPermModal()">إلغاء</button>
    </div>
    </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click',e=>{if(e.target===modal)closeAddPermModal();});
    document.getElementById('perm-date').value=new Date().toISOString().split('T')[0];
    const permTypeEl = document.getElementById('perm-person-type');
    let autoPermType = presetType || 'employee';
    permTypeEl.value = autoPermType;
    // إخفاء المعاينة لصفحة الضابط/الموظف، إبقاؤها للأدمن
    const isAdminView = currentUser && (currentUser.role === 'admin' || currentUser.role === 'stats' || !currentUser.role);
    const previewBox = document.getElementById('perm-preview');
    if (previewBox && !isAdminView) previewBox.style.setProperty('display','none','important');
    if (presetId) {
        // لا toggle — فقط حمّل القائمة مباشرة
        loadPermPersonList();
        setTimeout(()=>{document.getElementById('perm-employee').value=presetId;updatePermissionPreview();},200);
    } else {
        // ضبط أزرار Toggle + تحميل القائمة
        setPermPersonType(autoPermType);
    }
}

function closeAddPermModal(){const m=document.getElementById('add-perm-modal');if(m)m.remove();}

async function initPermissionForm() {
    // تحميل الموظفين والضباط قبل فتح النافذة لضمان تعبئة القوائم
    await ensureDataLoaded();
    showAddPermissionModal();
}

function setPermPersonType(type) {
    const sel = document.getElementById('perm-person-type');
    if (sel) sel.value = type;
    const empBtn = document.getElementById('perm-toggle-emp');
    const offBtn = document.getElementById('perm-toggle-off');
    if (empBtn && offBtn) {
        if (type === 'employee') {
            empBtn.style.cssText = 'flex:1;padding:10px 8px;border-radius:10px;border:2px solid #007aff;background:#007aff;color:white;font-weight:700;font-size:14px;cursor:pointer;transition:all 0.18s;';
            offBtn.style.cssText = 'flex:1;padding:10px 8px;border-radius:10px;border:2px solid #e2e8f0;background:white;color:#64748b;font-weight:700;font-size:14px;cursor:pointer;transition:all 0.18s;';
        } else {
            offBtn.style.cssText = 'flex:1;padding:10px 8px;border-radius:10px;border:2px solid #007aff;background:#007aff;color:white;font-weight:700;font-size:14px;cursor:pointer;transition:all 0.18s;';
            empBtn.style.cssText = 'flex:1;padding:10px 8px;border-radius:10px;border:2px solid #e2e8f0;background:white;color:#64748b;font-weight:700;font-size:14px;cursor:pointer;transition:all 0.18s;';
        }
    }
    loadPermPersonList(type);
}

function loadPermPersonList(forcedType) {
    const personType = forcedType || document.getElementById('perm-person-type')?.value || 'employee';
    const sel = document.getElementById('perm-employee');
    if (personType === 'officer') {
        sel.innerHTML = '<option value="">-- اختر الضابط --</option>' +
            officers.map(o => `<option value="${o.id}">${o.rank ? o.rank + ' ' : ''}${o.name}</option>`).join('');
    } else {
        sel.innerHTML = '<option value="">-- اختر الموظف --</option>' +
            employees.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
    }
    // تحديث تسميات نوع الاستئذان
    const permTypeSel = document.getElementById('perm-type');
    if (permTypeSel) {
        if (personType === 'officer') {
            permTypeSel.options[0].text = 'أول الزام';
            permTypeSel.options[1].text = 'باقي الزام';
        } else {
            permTypeSel.options[0].text = 'بداية دوام';
            permTypeSel.options[1].text = 'نهاية دوام';
        }
    }
    const preview=document.getElementById('perm-preview');
    if(preview)preview.style.display = 'none';
}

function getPermPersonName(personType, personId) {
    if (personType === 'officer') {
        const o = officers.find(o => o.id == personId);
        return o ? (o.rank ? o.rank + ' ' : '') + o.name : '';
    }
    const e = employees.find(e => e.id == personId);
    return e ? e.name : '';
}

async function updatePermissionPreview() {
    const personType = document.getElementById('perm-person-type').value;
    const personId = document.getElementById('perm-employee').value;
    const date = document.getElementById('perm-date').value;
    const type = document.getElementById('perm-type').value;
    const preview = document.getElementById('perm-preview');
    
    // لا تُظهر المعاينة لصفحة الموظف/الضابط
    const isAdminView = currentUser && (currentUser.role === 'admin' || currentUser.role === 'stats' || !currentUser.role);
    if (!isAdminView) { if (preview) preview.style.display = 'none'; return; }

    if (!personId || !date) { preview.style.display = 'none'; return; }
    preview.style.display = 'block';
    
    const personName = getPermPersonName(personType, personId);
    const typeLabel = type === 'start' ? 'بداية دوام 🌅' : 'نهاية دوام 🌆';
    const shortLabel = type === 'start' ? 'بداية' : 'نهاية';
    
    document.getElementById('perm-preview-content').innerHTML = `
        <strong>${personName}</strong> — ${typeLabel} — ${date}
        <div style="margin-top:8px;display:inline-block;padding:8px 16px;background:#1a3a6b;color:white;border-radius:8px;font-size:20px;font-weight:bold;">${shortLabel}</div>
    `;
    
    // عرض الاستهلاك الشهري
    const month = date.substring(0, 7);
    const total = await window.db.getMonthlyPermissionTotal(parseInt(personId), month, personType);
    const remaining = 4 - total;
    const color = remaining <= 1 ? '#e74c3c' : remaining <= 2 ? '#f39c12' : '#2ecc71';
    document.getElementById('perm-monthly-usage').innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <span>الاستهلاك الشهري (${month}):</span>
            <span style="font-weight:bold;color:${color};">${total} / 4</span>
        </div>
        <div style="margin-top:8px;background:#ecf0f1;border-radius:6px;height:12px;overflow:hidden;">
            <div style="width:${(total/4)*100}%;height:100%;background:${color};border-radius:6px;transition:width 0.3s;"></div>
        </div>
        <div style="text-align:left;margin-top:5px;font-size:14px;color:${color};">المتبقي: ${remaining}</div>
    `;
}

async function savePermission() {
    const personType = document.getElementById('perm-person-type').value;
    const personId = document.getElementById('perm-employee').value;
    const date = document.getElementById('perm-date').value;
    const type = document.getElementById('perm-type').value;
    const notes = document.getElementById('perm-notes').value.trim();
    
    if (!personId) { showModalError('add-perm-modal','يرجى اختيار اسم الشخص'); return; }
    if (!date) { showModalError('add-perm-modal','يرجى تحديد تاريخ الاستئذان'); return; }
    
    try {
        const isAdmin = currentUser && currentUser.role === 'admin';
        const newPermission = {
            person_id: parseInt(personId),
            employee_id: parseInt(personId),
            person_type: personType,
            request_type: 'permission',
            date,
            type,
            status: isAdmin ? 'approved' : 'pending',
            fraction: 1,
            notes: notes || null,
            ...(isAdmin ? { _adminSave: true } : {})
        };
        const result = await window.db.addLeavePermission(newPermission);
        
        if (result.error) {
            showModalError('add-perm-modal', result.error);
            return;
        }
        addPermission(newPermission);
        
        showToast(isAdmin ? 'تم تسجيل الاستئذان بنجاح' : 'تم تقديم الطلب بنجاح', 'success');
        closeAddPermModal();
        await loadPermissions();
        renderPermissions();
        if (currentUser && (currentUser.role === 'employee' || currentUser.role === 'stats')) {
            loadEmployeeDashboard();
            const empName = employees.find(e => e.id == personId)?.name || 'موظف';
            addAdminNotification({
                type: 'permission',
                personName: empName,
                requestType: type === 'start' ? 'استئذان بداية دوام' : 'استئذان نهاية دوام',
                date,
                refId: result.id
            });
        }
        if (currentUser && currentUser.role === 'officer') {
            loadOfficerDashboard();
            const offName = officers.find(o => o.id == personId)?.name || 'ضابط';
            addAdminNotification({
                type: 'permission',
                personName: offName,
                requestType: type === 'start' ? 'استئذان بداية دوام' : 'استئذان نهاية دوام',
                date,
                refId: result.id
            });
        }
    } catch(e) {
        console.error('خطأ في حفظ الاستئذان:', e);
        showModalError('add-perm-modal', 'حدث خطأ أثناء الحفظ، يرجى المحاولة مجدداً');
    }
}

function clearPermissionForm() {
    const el=id=>document.getElementById(id);
    if(el('perm-person-type'))el('perm-person-type').value='employee';
    loadPermPersonList();
    if(el('perm-date'))el('perm-date').value=new Date().toISOString().split('T')[0];
    if(el('perm-type'))el('perm-type').value='start';
    if(el('perm-notes'))el('perm-notes').value='';
    if(el('perm-preview'))el('perm-preview').style.display='none';
}

async function renderPermissions(filteredData) {
    await loadPermissions();
    
    // تعيين الشهر الحالي كافتراضي
    const monthInput = document.getElementById('perm-filter-month');
    if (!monthInput.value) {
        monthInput.value = new Date().toISOString().substring(0, 7);
    }
    const month = monthInput.value;
    const personTypeFilter = document.getElementById('perm-filter-person-type').value;
    
    // تصفية
    let data = filteredData || leavePermissions;
    if (month) {
        data = data.filter(p => p.date && p.date.startsWith(month));
    }
    if (personTypeFilter !== 'all') {
        data = data.filter(p => (p.person_type || 'employee') === personTypeFilter);
    }
    
    // إحصائيات — المقبولة فقط
    const approvedData = data.filter(p => normalizeApprovalStatus(p.status) === 'approved');
    document.getElementById('perm-stat-total').textContent = approvedData.length;
    document.getElementById('perm-stat-start').textContent = approvedData.filter(p => p.type === 'start').length;
    document.getElementById('perm-stat-end').textContent = approvedData.filter(p => p.type === 'end').length;
    const uniqueEmps = new Set(approvedData.map(p => p.employee_id));
    document.getElementById('perm-stat-employees').textContent = uniqueEmps.size;
    
    // تغيير الألوان حسب نوع الشخص
    const pColors = personTypeFilter==='employee' ? {main:'#6b8e23',start:'#808000',end:'#f39c12',emp:'#556b2f'}
                  : personTypeFilter==='officer'  ? {main:'#2980b9',start:'#3498db',end:'#f39c12',emp:'#1a5276'}
                  :                                 {main:'#3498db',start:'#2ecc71',end:'#f39c12',emp:'#6B8E23'};
    document.getElementById('perm-card-total').style.borderTopColor=pColors.main;
    document.getElementById('perm-stat-total').style.color=pColors.main;
    document.getElementById('perm-card-start').style.borderTopColor=pColors.start;
    document.getElementById('perm-stat-start').style.color=pColors.start;
    document.getElementById('perm-card-end').style.borderTopColor=pColors.end;
    document.getElementById('perm-stat-end').style.color=pColors.end;
    document.getElementById('perm-card-employees').style.borderTopColor=pColors.emp;
    document.getElementById('perm-stat-employees').style.color=pColors.emp;
    
    // إظهار/إخفاء أزرار الطباعة حسب الفلتر
    document.getElementById('perm-btn-print-emp').style.display = personTypeFilter==='officer' ? 'none' : '';
    document.getElementById('perm-btn-print-off').style.display = personTypeFilter==='employee' ? 'none' : '';
    
    // إخفاء البيانات إذا انتهى الشهر
    const currentMonth = new Date().toISOString().substring(0, 7);
    if (month && month < currentMonth) {
        document.getElementById('permissions-report-cards').innerHTML = '<div style="text-align:center;padding:40px;"><div style="font-size:50px;margin-bottom:12px;">📅</div><div style="font-size:20px;font-weight:bold;color:#64748b;">هذا الشهر منتهي</div><div style="color:#94a3b8;font-size:16px;margin-top:8px;">الاستئذانات تظهر فقط للشهر الحالي</div></div>';
        return;
    }
    
    // عرض التقرير الشهري
    renderPermissionsReport(data);
}

async function renderPermissionsList(data) {
    const tbody = document.getElementById('permissions-table');
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="color:#999;padding:20px;text-align:center;">لا توجد استئذانات</td></tr>';
        return;
    }
    
    // حساب المجاميع الشهرية لكل شخص
    const monthlyTotals = {};
    for (const p of data) {
        const key = p.person_type + '_' + p.employee_id + '_' + p.date.substring(0, 7);
        if (!monthlyTotals[key]) {
            monthlyTotals[key] = await window.db.getMonthlyPermissionTotal(p.employee_id, p.date.substring(0, 7), p.person_type);
        }
    }
    
    tbody.innerHTML = data.map((p, i) => {
        const typeLabel = p.type === 'start' ? '<span style="color:#2ecc71;">🌅 ' + (p.person_type !== 'officer' ? 'بداية الدوام' : 'تأخير بداية') + '</span>' : '<span style="color:#e67e22;">🌆 ' + (p.person_type !== 'officer' ? 'نهاية الدوام' : 'باقي الزام') + '</span>';
        const personBadge = p.person_type === 'officer' ? '<span class="badge badge-purple" style="font-size:12px;">👮 ضابط</span>' : '<span class="badge badge-info" style="font-size:12px;">👷 موظف</span>';
        const key = p.person_type + '_' + p.employee_id + '_' + p.date.substring(0, 7);
        const total = monthlyTotals[key] || 0;
        const usageColor = total > 3 ? '#e74c3c' : total > 2 ? '#f39c12' : '#2ecc71';
        const approval = getApprovalStatusMeta(p.status);
        return `<tr>
            <td>${i + 1}</td>
            <td><strong style="color:${p.person_type==='officer'?'#2980b9':'#6b8e23'};">${p.employee_name || '-'}</strong></td>
            <td>${p.date}</td>
            <td>${typeLabel}</td>
            <td><span style="color:${usageColor};font-weight:bold;">${total} / 4</span></td>
            <td>${p.notes || '-'}</td>
            <td>
                <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
                    <span class="emp-status ${approval.className}" style="font-size:11px;">${approval.label}</span>
                    <button class="btn btn-primary" onclick="editPermission(${p.id})" style="padding:5px 8px;font-size:12px;">عرض</button>
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderPermAllList(data) {
    const container = document.getElementById('perm-all-list');
    const countEl   = document.getElementById('perm-all-count');
    if (!container) return;

    // ترتيب من الأحدث للأقدم
    const sorted = [...data].sort((a, b) => {
        const da = a.created_at || a.date || '';
        const db = b.created_at || b.date || '';
        return db.localeCompare(da);
    });

    if (countEl) countEl.textContent = sorted.length + ' استئذان';

    if (sorted.length === 0) {
        container.innerHTML = '<div style="padding:24px;text-align:center;color:#94a3b8;font-size:14px;">لا توجد استئذانات</div>';
        return;
    }

    container.innerHTML = sorted.map((p, i) => {
        const isOfficer   = (p.person_type || 'employee') === 'officer';
        const nameColor   = isOfficer ? '#2980b9' : '#6b8e23';
        const badge       = isOfficer
            ? `<span style="background:#ebf5fb;color:#2980b9;font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;">ضابط</span>`
            : `<span style="background:#f0fff0;color:#6b8e23;font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;">موظف</span>`;
        const typeLabel   = p.type === 'start'
            ? (isOfficer ? 'أول الزام' : 'بداية دوام')
            : (isOfficer ? 'باقي الزام' : 'نهاية دوام');
        const typeColor   = p.type === 'start' ? '#16a34a' : '#d97706';
        const typeBg      = p.type === 'start' ? '#f0fdf4' : '#fffbeb';
        const approval    = getApprovalStatusMeta(p.status);
        const borderBottom = i < sorted.length - 1 ? 'border-bottom:1px solid #f1f5f9;' : '';
        return `<div onclick="editPermission(${p.id})" style="display:flex;align-items:center;gap:12px;padding:13px 16px;cursor:pointer;${borderBottom}transition:background 0.15s;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
            <div style="width:38px;height:38px;border-radius:10px;background:${typeBg};display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">
                ${p.type === 'start' ? '🌅' : '🌆'}
            </div>
            <div style="flex:1;min-width:0;">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <span style="font-weight:700;font-size:14px;color:${nameColor};">${p.employee_name || '-'}</span>
                    ${badge}
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin-top:3px;flex-wrap:wrap;">
                    <span style="font-size:12px;font-weight:600;color:${typeColor};">${typeLabel}</span>
                    <span style="font-size:12px;color:#94a3b8;">•</span>
                    <span style="font-size:12px;color:#64748b;">${p.date}</span>
                    ${p.notes ? `<span style="font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100px;">${p.notes}</span>` : ''}
                </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
                <span class="emp-status ${approval.className}" style="font-size:11px;">${approval.label}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform:scaleX(-1);"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
        </div>`;
    }).join('');
}

function renderPermissionsReport(data) {
    const container = document.getElementById('permissions-report-cards');
    
    const byPerson = {};
    data.forEach(p => {
        const key = (p.person_type || 'employee') + '_' + p.employee_id;
        if (!byPerson[key]) {
            byPerson[key] = { name: p.employee_name, person_type: p.person_type || 'employee', rank: p.officer_rank || '', employee_id: p.employee_id, permissions: [] };
        }
        byPerson[key].permissions.push(p);
    });

    // احسب فقط المقبولة لكل شخص
    Object.values(byPerson).forEach(emp => {
        emp.approvedCount = emp.permissions.filter(p => normalizeApprovalStatus(p.status) === 'approved').length;
    });
    // أخفِ من ليس لديه استئذانات مقبولة
    Object.keys(byPerson).forEach(k => { if (byPerson[k].approvedCount === 0) delete byPerson[k]; });
    
    if (Object.keys(byPerson).length === 0) {
        container.innerHTML = '<div style="color:#999;padding:30px;text-align:center;">لا توجد استئذانات</div>';
        return;
    }
    
    const officerEntries = Object.values(byPerson).filter(p => p.person_type === 'officer')
        .sort((a, b) => getRankIndex(a.rank) - getRankIndex(b.rank));
    const employeeEntries = Object.values(byPerson).filter(p => p.person_type !== 'officer');
    
    // حفظ البيانات للاستخدام في المودال
    window._permReportData = byPerson;
    
    let html = '';
    
    const buildPersonCards = (entries, sectionLabel, sectionGradient, nameColor, accentColor) => {
        if (entries.length === 0) return '';
        let shtml = `<div style="background:${sectionGradient};color:white;font-weight:bold;text-align:center;padding:10px;font-size:14px;border-radius:8px;letter-spacing:1px;">${sectionLabel}</div>`;
        entries.forEach(emp => {
            const total = emp.approvedCount;
            const totalColor = total > 3 ? '#e74c3c' : total > 2 ? '#f39c12' : '#2ecc71';
            const borderColor = total > 3 ? '#e74c3c' : total > 2 ? '#f39c12' : accentColor;
            const key = emp.person_type + '_' + emp.employee_id;
            
            shtml += `<div class="perm-person-card" style="border-right:4px solid ${borderColor};cursor:pointer;" onclick="showPermPersonDetails('${key}')" >
                <div style="display:flex;justify-content:space-between;align-items:center;">
                    <div style="flex:1;min-width:0;">
                        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                            <span style="font-size:15px;font-weight:700;color:#1e293b;">${emp.name}</span>
                            <span style="background:${accentColor};color:white;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;">${total} استئذان</span>
                        </div>
                    </div>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;transform:scaleX(-1);"><polyline points="9 18 15 12 9 6"/></svg>
                </div>
            </div>`;
        });
        return shtml;
    };
    
    html += buildPersonCards(officerEntries, 'الضباط', 'linear-gradient(135deg,#2980b9,#5dade2)', '#2980b9', '#2980b9');
    if (officerEntries.length > 0 && employeeEntries.length > 0) html += '<div style="height:12px;"></div>';
    html += buildPersonCards(employeeEntries, 'الموظفين', 'linear-gradient(135deg,#6B8E23,#8FBC3B)', '#6b8e23', '#6b8e23');
    
    container.innerHTML = html;
}

function showPermPersonDetails(key) {
    const emp = window._permReportData[key];
    if (!emp) return;
    const perms = emp.permissions.filter(p => normalizeApprovalStatus(p.status) === 'approved').sort((a, b) => a.date.localeCompare(b.date));
    const total = perms.length;
    const totalColor = total > 3 ? '#e74c3c' : total > 2 ? '#f39c12' : '#2ecc71';
    const nameColor = emp.person_type === 'officer' ? '#2980b9' : '#6b8e23';
    
    let permItems = perms.map((p, i) => {
        const typeShort = p.type === 'start' ? (emp.person_type !== 'officer' ? 'بداية الدوام' : 'تأخير بداية') : (emp.person_type !== 'officer' ? 'نهاية الدوام' : 'باقي الزام');
        const typeBg = p.type === 'start' ? '#f0fdf4' : '#fffbeb';
        const typeColor = p.type === 'start' ? '#16a34a' : '#d97706';
        const dotColor = p.type === 'start' ? '#22c55e' : '#f59e0b';
        const approval = getApprovalStatusMeta(p.status);
        return `<div onclick="event.stopPropagation();editPermission(${p.id})" class="perm-detail-item" style="display:flex;align-items:center;gap:10px;padding:12px;background:${typeBg};border-radius:10px;cursor:pointer;">
            <div style="width:10px;height:10px;border-radius:50%;background:${dotColor};flex-shrink:0;"></div>
            <div style="flex:1;min-width:0;">
                <div style="font-size:13px;font-weight:600;color:${typeColor};">${typeShort}</div>
                <div style="font-size:12px;color:#64748b;margin-top:2px;">${p.date}</div>
                ${p.notes ? '<div style="font-size:11px;color:#94a3b8;margin-top:2px;">' + p.notes + '</div>' : ''}
                <span class="emp-status ${approval.className}" style="font-size:11px;margin-top:5px;display:inline-block;">${approval.label}</span>
            </div>
        </div>`;
    }).join('');
    
    const old = document.getElementById('perm-person-detail-modal');
    if (old) old.remove();
    
    const modal = document.createElement('div');
    modal.id = 'perm-person-detail-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:flex-end;justify-content:center;-webkit-tap-highlight-color:transparent;overflow:hidden;overscroll-behavior:contain;';
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div style="background:white;border-radius:20px 20px 0 0;padding:20px;width:100%;max-width:500px;max-height:85vh;overflow-y:auto;direction:rtl;animation:slideUpModal 0.3s ease;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;">
            <div style="width:40px;height:4px;background:#e2e8f0;border-radius:2px;margin:0 auto 16px;"></div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                <div>
                    <div style="font-size:18px;font-weight:800;color:#1e293b;">${emp.name}</div>
                    ${emp.rank ? '<div style="font-size:12px;color:' + nameColor + ';font-weight:600;margin-top:2px;">' + emp.rank + '</div>' : ''}
                </div>
                <div style="text-align:center;">
                    <div style="font-size:28px;font-weight:900;color:${totalColor};">${total}</div>
                    <div style="font-size:10px;color:#94a3b8;font-weight:600;">من 4</div>
                </div>
            </div>
            <div style="height:6px;background:#f1f5f9;border-radius:3px;margin-bottom:16px;overflow:hidden;">
                <div style="height:100%;width:${Math.min(total/4*100,100)}%;background:${totalColor};border-radius:3px;transition:width 0.3s;"></div>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;">${permItems}</div>
            <button onclick="document.getElementById('perm-person-detail-modal').remove()" style="width:100%;padding:14px;margin-top:16px;background:#f1f5f9;border:none;border-radius:12px;font-size:15px;font-weight:700;color:#64748b;cursor:pointer;">إغلاق</button>
        </div>
    `;
    document.body.appendChild(modal);
}

async function editPermission(id) {
    const perm = await window.db.getLeavePermissionById(id);
    if (!perm) { showToast('لم يتم العثور على الاستئذان', 'error'); return; }
    const canModify = !isApprovedAndNonAdmin(perm.status);

    const personName = getPermPersonName(perm.person_type || 'employee', perm.employee_id);

    // إزالة مودال سابق إن وجد
    const old = document.getElementById('edit-perm-modal');
    if (old) old.remove();

    const modal = document.createElement('div');
    modal.id = 'edit-perm-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:center;justify-content:center;overflow:hidden;overscroll-behavior:contain;';
    modal.innerHTML = `
        <div style="background:white;border-radius:16px;padding:20px;width:450px;max-width:90%;direction:rtl;font-family:Arial;" onclick="event.stopPropagation();">
            <h2 style="margin-bottom:14px;color:#1a3a6b;font-size:16px;">تعديل الاستئذان</h2>
            <p style="margin-bottom:12px;font-weight:bold;font-size:14px;color:${perm.person_type === 'officer' ? '#2980b9' : '#6b8e23'};">${perm.person_type === 'officer' ? 'ضابط' : 'موظف'}: ${personName}</p>
            <div style="margin-bottom:10px;">
                <div style="display:block;margin-bottom:4px;font-weight:bold;font-size:13px;color:#1a3a6b;">التاريخ</div>
                <input type="date" id="edit-perm-date" value="${perm.date}" ${canModify?'':'disabled'} style="padding:4px 8px;font-size:13px;border:1.5px solid #b8d4ea;border-radius:8px;height:32px;width:100%;">
            </div>
            <div style="margin-bottom:10px;">
                <div style="display:block;margin-bottom:4px;font-weight:bold;font-size:13px;color:#1a3a6b;">النوع</div>
                <select id="edit-perm-type" ${canModify?'':'disabled'} style="padding:6px 8px;border:1.5px solid #e0e0e0;border-radius:8px;width:100%;font-size:13px;">
                    <option value="start" ${perm.type === 'start' ? 'selected' : ''}>بداية دوام</option>
                    <option value="end" ${perm.type === 'end' ? 'selected' : ''}>نهاية دوام</option>
                </select>
            </div>
            <div style="margin-bottom:14px;">
                <div style="display:block;margin-bottom:4px;font-weight:bold;font-size:13px;color:#1a3a6b;">ملاحظات</div>
                <input type="text" id="edit-perm-notes" value="${perm.notes || ''}" ${canModify?'':'disabled'} placeholder="ملاحظات اختيارية..." style="padding:6px 8px;border:1.5px solid #e0e0e0;border-radius:8px;width:100%;font-size:13px;">
            </div>
            <div style="display:flex;gap:8px;">
                ${canModify ? `<button class="btn" onclick="saveEditPermission(${id})" style="flex:1;padding:8px;font-size:13px;border-radius:12px;background:#007aff;color:white;font-weight:700;">حفظ</button>` : ''}
                ${canModify ? `<button class="btn" onclick="deletePermission(${id})" style="flex:1;padding:8px;font-size:13px;border-radius:12px;background:#ff3b30;color:white;font-weight:700;">حذف</button>` : ''}
                <button class="btn" onclick="document.getElementById('edit-perm-modal').remove()" style="flex:1;padding:8px;font-size:13px;border-radius:12px;background:#e5e5ea;color:#1c1c1e;font-weight:700;">إلغاء</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
}

async function saveEditPermission(id) {
    const perm = await window.db.getLeavePermissionById(id);
    if (perm && isApprovedAndNonAdmin(perm.status)) {
        showModalError('edit-perm-modal', 'لا يمكن تعديل الاستئذان بعد موافقة الأدمن');
        return;
    }
    const date = document.getElementById('edit-perm-date').value;
    const type = document.getElementById('edit-perm-type').value;
    const notes = document.getElementById('edit-perm-notes').value.trim();

    if (!date) { showModalError('edit-perm-modal','يرجى تحديد تاريخ الاستئذان'); return; }

    const result = await window.db.updateLeavePermission(id, { date, type, notes: notes || null });
    if (result && result.error) {
        showModalError('edit-perm-modal', result.error);
        return;
    }

    document.getElementById('edit-perm-modal').remove();
    showToast('تم تعديل الاستئذان بنجاح ✅', 'success');
    await loadPermissions();
    await renderPermissions();
    if (currentUser && (currentUser.role === 'employee' || currentUser.role === 'stats')) {
        loadEmployeeRequests();
        loadEmployeeDashboard();
    }
}

async function deletePermission(id) {
    const perm = await window.db.getLeavePermissionById(id);
    if (perm && isApprovedAndNonAdmin(perm.status)) {
        showToast('لا يمكن حذف الاستئذان بعد موافقة الأدمن', 'error');
        return;
    }
    if (!confirm('هل أنت متأكد من حذف هذا الاستئذان؟')) return;
    const result = await window.db.deleteLeavePermission(id);
    if (result && result.error) {
        showToast(result.error, 'error');
        return;
    }
    const modal = document.getElementById('edit-perm-modal');
    if (modal) modal.remove();
    showToast('تم حذف الاستئذان بنجاح 🗑️', 'warning');
    await loadPermissions();
    await renderPermissions();
    if (currentUser && (currentUser.role === 'employee' || currentUser.role === 'stats')) {
        loadEmployeeRequests();
        loadEmployeeDashboard();
    }
}

async function buildPermissionPrintData(month) {
    // تأكد من تحميل بيانات الموظفين والضباط قبل الطباعة
    if (!employees || employees.length === 0) {
        employees = (await window.db.getEmployees()).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ar'));
    }
    if (!officers || officers.length === 0) {
        officers = await window.db.getOfficers();
    }

    const report = await window.db.getMonthlyPermissionReport(month);
    
    const reportWithNames = report.map(p => {
        let name = '';
        let rank = '';
        if (p.person_type === 'officer') {
            const o = officers.find(o => o.id == p.employee_id);
            name = o ? (o.rank ? o.rank + ' ' : '') + o.name : '';
            rank = o ? (o.rank || '') : '';
        } else {
            const e = employees.find(e => e.id == p.employee_id);
            name = e ? e.name : '';
        }
        return { ...p, employee_name: name, officer_rank: rank };
    });
    
    const byPerson = {};
    reportWithNames.forEach(p => {
        const key = (p.person_type || 'employee') + '_' + p.employee_id;
        if (!byPerson[key]) {
            byPerson[key] = { name: p.employee_name, person_type: p.person_type || 'employee', rank: p.officer_rank || '', permissions: [] };
        }
        byPerson[key].permissions.push(p);
    });
    
    // ترتيب الضباط حسب الأقدمية في الطباعة
    const sortedOfficers = Object.values(byPerson).filter(p => p.person_type === 'officer')
        .sort((a, b) => getRankIndex(a.rank) - getRankIndex(b.rank));
    const sortedEmployees = Object.values(byPerson).filter(p => p.person_type !== 'officer');
    
    const buildRows = (entries, isOfficer) => entries.map(emp => {
        const perms = emp.permissions.sort((a, b) => a.date.localeCompare(b.date));
        const cells = [];
        for (let j = 0; j < 4; j++) {
            if (perms[j]) {
                const typeShort = perms[j].type === 'start' ? (isOfficer ? 'تأخير بداية' : 'بداية الدوام') : (isOfficer ? 'باقي الزام' : 'نهاية الدوام');
                cells.push({ label: typeShort, date: perms[j].date });
            } else {
                cells.push(null);
            }
        }
        return { name: emp.name, cells, total: perms.length };
    });
    
    const monthNames = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    const [year, mon] = month.split('-');
    const monthLabel = monthNames[parseInt(mon) - 1] + ' ' + year;
    
    return {
        officerRows: buildRows(sortedOfficers, true),
        employeeRows: buildRows(sortedEmployees, false),
        monthLabel
    };
}

async function printEmployeesMonthlyReport() {
    const month = document.getElementById('perm-filter-month').value;
    if (!month) { showToast('اختر الشهر أولاً', 'error'); return; }
    
    try {
        const { employeeRows, monthLabel } = await buildPermissionPrintData(month);
        const data = { rows: employeeRows, month: monthLabel };
        
        if (window.flutter_inappwebview) {
            try { if (currentUser) window.flutter_inappwebview.callHandler('saveSession', JSON.stringify(currentUser)); } catch(e) {}
            window.flutter_inappwebview.callHandler('navigateToPrint', 'print/print-permissions.html', JSON.stringify(data));
            return;
        }
        
        // متصفح عادي
        const win = window.open('print/print-permissions.html', '_blank', 'width=900,height=700');
        if (!win) { window.location.href = 'print/print-permissions.html'; return; }
        const tryFill = () => {
            try { if (typeof win.fillData === 'function') { win.fillData(data); return true; } } catch(e) {}
            return false;
        };
        if (!tryFill()) {
            let attempts = 0;
            const poll = setInterval(() => { attempts++; if (tryFill() || attempts > 30) clearInterval(poll); }, 200);
        }
        showToast('✅ جاري فتح نافذة الطباعة', 'success');
    } catch(e) {
        console.error('Print employees error:', e);
        showToast('❌ حدث خطأ في الطباعة', 'error');
    }
}

async function printOfficersMonthlyReport() {
    const month = document.getElementById('perm-filter-month').value;
    if (!month) { showToast('اختر الشهر أولاً', 'error'); return; }
    
    try {
        const { officerRows, monthLabel } = await buildPermissionPrintData(month);
        const data = { rows: officerRows, month: monthLabel, title: 'كشف استئذانات الضباط الشهري' };
        
        if (window.flutter_inappwebview) {
            try { if (currentUser) window.flutter_inappwebview.callHandler('saveSession', JSON.stringify(currentUser)); } catch(e) {}
            window.flutter_inappwebview.callHandler('navigateToPrint', 'print/print-permissions-officers.html', JSON.stringify(data));
            return;
        }
        
        // متصفح عادي
        const win = window.open('print/print-permissions-officers.html', '_blank', 'width=900,height=700');
        if (!win) { window.location.href = 'print/print-permissions-officers.html'; return; }
        const tryFill = () => {
            try { if (typeof win.fillData === 'function') { win.fillData(data); return true; } } catch(e) {}
            return false;
        };
        if (!tryFill()) {
            let attempts = 0;
            const poll = setInterval(() => { attempts++; if (tryFill() || attempts > 30) clearInterval(poll); }, 200);
        }
        showToast('✅ جاري فتح نافذة الطباعة', 'success');
    } catch(e) {
        console.error('Print officers error:', e);
        showToast('❌ حدث خطأ في الطباعة', 'error');
    }
}

// ═══════════════════════════════════════
// تشغيل التطبيق
// ═══════════════════════════════════════

// ═══════════════════════════════════════
// ربط الأحداث بعناصر HTML الثابتة
// ═══════════════════════════════════════
function bindEvents() {
    const el = id => document.getElementById(id);

    // Filter pills click delegation (global)
    document.addEventListener('click', function(e) {
        const pill = e.target.closest('.filter-pill');
        if (!pill) return;
        const container = pill.closest('.filter-pills');
        const targetId = container.dataset.target;
        const value = pill.dataset.value;
        container.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const sel = document.getElementById(targetId);
        if (sel) sel.value = value;
        const onchangeFn = container.dataset.onchange;
        if (onchangeFn && typeof window[onchangeFn] === 'function') {
            window[onchangeFn]();
        } else {
            filterLeaves();
        }
    });

    // Modal overlay close on background click
    document.querySelectorAll('.modal-overlay').forEach(o => {
        o.addEventListener('click', function(e) { if (e.target === this) this.classList.remove('active'); });
    });

    // Settings and context menu actions delegation
    document.addEventListener('click', function(e) {
        const item = e.target.closest('[data-action]');
        if (!item) return;
        const action = item.dataset.action;
        const actions = {
            'settings-edit-name':          settingsEditName,
            'settings-edit-role':          settingsEditRole,
            'settings-edit-default-leave': settingsEditDefaultLeave,
            'settings-show-reports':       () => showPage('reports'),
            'settings-show-backups':       () => showPage('backups'),
            'settings-storage-info':       settingsShowStorageInfo,
            'settings-data-count':         settingsShowDataCount,
            'cut':                         contextMenuCut,
            'copy':                        contextMenuCopy,
            'paste':                       contextMenuPaste,
            'select-all':                  contextMenuSelectAll,
        };
        if (actions[action]) actions[action]();
    });

    // Bottom navigation delegation
    const bottomNav = el('bottomNav');
    if (bottomNav) bottomNav.addEventListener('click', function(e) {
        const btn = e.target.closest('[data-page]');
        if (btn) bottomNavGo(btn.dataset.page);
    });

    // Home stat cards
    if (el('stat-card-officers'))           el('stat-card-officers').addEventListener('click', () => showPage('officers'));
    if (el('stat-card-officers-on-leave'))  el('stat-card-officers-on-leave').addEventListener('click', () => showLeavesFiltered('officer'));
    if (el('stat-card-employees'))          el('stat-card-employees').addEventListener('click', () => showPage('employees'));
    if (el('stat-card-employees-on-leave')) el('stat-card-employees-on-leave').addEventListener('click', () => showLeavesFiltered('employee'));

    // Home quick action buttons
    if (el('btn-home-archive'))         el('btn-home-archive').addEventListener('click', showArchiveChoice);
    if (el('btn-home-add-permission'))  el('btn-home-add-permission').addEventListener('click', showAddPermissionModal);
    if (el('btn-home-add-leave'))       el('btn-home-add-leave').addEventListener('click', showAddLeaveModal);
    if (el('btn-home-bell'))            el('btn-home-bell').addEventListener('click', () => showPage('notifications'));

    // Employee app quick actions
    if (el('emp-btn-request-leave'))      el('emp-btn-request-leave').addEventListener('click', openEmployeeLeaveRequest);
    if (el('emp-btn-request-permission')) el('emp-btn-request-permission').addEventListener('click', openEmployeePermissionRequest);
    if (el('emp-btn-request-other'))      el('emp-btn-request-other').addEventListener('click', openOtherRequestModal);

    // Officer app quick actions
    if (el('off-btn-request-leave'))      el('off-btn-request-leave').addEventListener('click', openOfficerLeaveRequest);
    if (el('off-btn-request-permission')) el('off-btn-request-permission').addEventListener('click', openOfficerPermissionRequest);
    if (el('off-btn-request-other'))      el('off-btn-request-other').addEventListener('click', openOfficerOtherRequestModal);

    // Chart period segmented radios
    document.querySelectorAll('input[name="period"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const value = radio.value;

            if (value === 'daily') {
                loadDailyData();
            } else if (value === 'weekly') {
                loadWeeklyData();
            } else if (value === 'monthly') {
                loadMonthlyData();
            }
        });
    });
    if (el('chart-date-input'))  el('chart-date-input').addEventListener('change', () => renderHomeChart(currentChartMode));

    // Quick stats (home page)
    if (el('quick-stats-date')) el('quick-stats-date').addEventListener('change', () => StatsManager.onDateChange('home'));
    ['qs-private','qs-special','qs-general','qs-motorcycles','qs-color','qs-towing','qs-technical','qs-second','qs-third']
        .forEach(id => { if (el(id)) el(id).addEventListener('input', function(){ normalizeInputToEnglish(this); StatsManager.updateAllTotals(); }); });

    // Officers page
    if (el('officers-search-input')) el('officers-search-input').addEventListener('input', function() { searchOfficers(this.value); });
    if (el('btn-add-officer'))       el('btn-add-officer').addEventListener('click', showAddOfficerModal);
    if (el('btn-export-officers'))   el('btn-export-officers').addEventListener('click', exportOfficers);
    if (el('btn-import-officers'))   el('btn-import-officers').addEventListener('click', importOfficersCSV);

    // Employees page
    if (el('employees-search-input')) el('employees-search-input').addEventListener('input', function() { searchEmployees(this.value); });
    if (el('btn-add-employee'))       el('btn-add-employee').addEventListener('click', showAddEmployeeModal);
    if (el('btn-export-employees'))   el('btn-export-employees').addEventListener('click', exportEmployees);
    if (el('btn-import-employees'))   el('btn-import-employees').addEventListener('click', importEmployeesCSV);
    if (el('btn-print-employees'))    el('btn-print-employees').addEventListener('click', printEmployeesList);

    // Archive page
    if (el('btn-archive-scan'))              el('btn-archive-scan').addEventListener('click', archiveScanFolder);
    if (el('btn-archive-upload'))            el('btn-archive-upload').addEventListener('click', archiveUploadFile);
    if (el('arch-tab-dashboard'))            el('arch-tab-dashboard').addEventListener('click', () => switchArchiveTab('dashboard'));
    if (el('arch-tab-employees'))            el('arch-tab-employees').addEventListener('click', () => switchArchiveTab('employees'));
    if (el('arch-tab-all'))                  el('arch-tab-all').addEventListener('click', () => switchArchiveTab('all'));
    if (el('arch-emp-search'))               el('arch-emp-search').addEventListener('input', renderArchiveEmployees);
    if (el('arch-emp-filter'))               el('arch-emp-filter').addEventListener('change', renderArchiveAll);
    if (el('arch-file-search'))              el('arch-file-search').addEventListener('input', renderArchiveAll);
    if (el('btn-arch-back'))                 el('btn-arch-back').addEventListener('click', () => switchArchiveTab('employees'));
    if (el('btn-arch-upload-for-employee'))  el('btn-arch-upload-for-employee').addEventListener('click', archiveUploadForCurrentEmployee);

    // Officer archive page
    if (el('btn-off-archive-upload'))           el('btn-off-archive-upload').addEventListener('click', offArchiveUploadFile);
    if (el('off-arch-tab-dashboard'))           el('off-arch-tab-dashboard').addEventListener('click', () => switchOffArchiveTab('dashboard'));
    if (el('off-arch-tab-officers'))            el('off-arch-tab-officers').addEventListener('click', () => switchOffArchiveTab('officers'));
    if (el('off-arch-tab-all'))                 el('off-arch-tab-all').addEventListener('click', () => switchOffArchiveTab('all'));
    if (el('off-arch-search'))                  el('off-arch-search').addEventListener('input', renderOffArchiveOfficers);
    if (el('off-arch-off-filter'))              el('off-arch-off-filter').addEventListener('change', renderOffArchiveAll);
    if (el('off-arch-file-search'))             el('off-arch-file-search').addEventListener('input', renderOffArchiveAll);
    if (el('btn-off-arch-back'))                el('btn-off-arch-back').addEventListener('click', () => switchOffArchiveTab('officers'));
    if (el('btn-off-arch-upload-for-officer'))  el('btn-off-arch-upload-for-officer').addEventListener('click', offArchiveUploadForCurrentOfficer);

    // Leaves page
    if (el('leave-print-btn')) el('leave-print-btn').addEventListener('click', printLeaves);
    if (el('leave-add-btn'))   el('leave-add-btn').addEventListener('click', showAddLeaveModal);

    // Backups page
    if (el('btn-create-backup')) el('btn-create-backup').addEventListener('click', createBackup);
    if (el('btn-import-backup')) el('btn-import-backup').addEventListener('click', importBackup);

    // Statistics page - quick inputs
    if (el('quick-date')) el('quick-date').addEventListener('change', () => StatsManager.onDateChange('stats'));
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            const statsPage = document.getElementById('page-statistics');
            if (statsPage && statsPage.style.display !== 'none') saveQuickStatistics();
        }
    });
    ['quick-private','quick-special','quick-general','quick-motorcycles','quick-color','quick-towing','quick-technical','quick-second','quick-third']
        .forEach(id => { if (el(id)) el(id).addEventListener('input', function(){ normalizeInputToEnglish(this); StatsManager.updateAllTotals(); }); });

    // Statistics tabs
    if (el('btn-daily-form'))   el('btn-daily-form').addEventListener('click', () => switchStatisticsTab('daily-form'));
    if (el('btn-weekly-form'))  el('btn-weekly-form').addEventListener('click', () => switchStatisticsTab('weekly-form'));
    if (el('btn-monthly-form')) el('btn-monthly-form').addEventListener('click', () => switchStatisticsTab('monthly-form'));

    // Daily form
    if (el('daily-form-date')) el('daily-form-date').addEventListener('change', () => StatsManager.onDateChange('daily'));
    ['daily-technical-committees','daily-second-pass','daily-third-pass']
        .forEach(id => { if (el(id)) el(id).addEventListener('input', function(){ normalizeInputToEnglish(this); StatsManager.updateAllTotals(); }); });
    if (el('btn-print-daily')) el('btn-print-daily').addEventListener('click', printDailyForm);

    // Weekly form
    if (el('weekly-form-start'))     el('weekly-form-start').addEventListener('change', renderWeeklyForm);
    if (el('weekly-form-end'))       el('weekly-form-end').addEventListener('change', renderWeeklyForm);
    if (el('btn-set-current-week'))  el('btn-set-current-week').addEventListener('click', setCurrentWeek);
    if (el('btn-print-weekly'))      el('btn-print-weekly').addEventListener('click', printWeeklyForm);

    // Monthly form
    if (el('monthly-form-month'))    el('monthly-form-month').addEventListener('change', renderMonthlyForm);
    if (el('btn-set-current-month')) el('btn-set-current-month').addEventListener('click', setCurrentMonth);
    if (el('btn-print-monthly'))     el('btn-print-monthly').addEventListener('click', printMonthlyForm);

    // Permissions page
    if (el('perm-filter-month'))       el('perm-filter-month').addEventListener('change', renderPermissions);
    if (el('btn-add-permission-main')) el('btn-add-permission-main').addEventListener('click', showAddPermissionModal);
    if (el('perm-btn-print-off'))      el('perm-btn-print-off').addEventListener('click', printOfficersMonthlyReport);
    if (el('perm-btn-print-emp'))      el('perm-btn-print-emp').addEventListener('click', printEmployeesMonthlyReport);

    // Profile page
    if (el('btn-profile-settings')) el('btn-profile-settings').addEventListener('click', () => showPage('settings'));

    // Settings reset button
    if (el('btn-settings-reset')) el('btn-settings-reset').addEventListener('click', settingsResetAll);

    // Daily stats modal
    if (el('btn-close-daily-stats'))   el('btn-close-daily-stats').addEventListener('click', () => closeModal('add-daily-stats-modal'));
    if (el('btn-close-daily-stats-x')) el('btn-close-daily-stats-x').addEventListener('click', () => closeModal('add-daily-stats-modal'));
    if (el('btn-save-daily-stats'))    el('btn-save-daily-stats').addEventListener('click', saveDailyStatistics);
    ['stats-date','stats-private','stats-special-transfer','stats-general-transfer','stats-motorcycles','stats-color-change','stats-towing','stats-technical-committees','stats-second-pass','stats-third-pass']
        .forEach(id => { if (el(id)) el(id).addEventListener('input', updateStatisticsPreview); });
    if (el('stats-date')) el('stats-date').addEventListener('change', updateStatisticsPreview);
}

document.addEventListener('DOMContentLoaded', async function(){
    bindEvents();
    await loadAllData();
    initCopyPasteFunctionality();

    // ─── استعادة الجلسة بعد الرجوع من صفحة الطباعة ───
    try {
        if (window.flutter_inappwebview) {
            const sessionStr = await window.flutter_inappwebview.callHandler('getSession');
            if (sessionStr) {
                const user = JSON.parse(sessionStr);
                if (user && user.role) {
                    currentUser = user;
                    if (user.role === 'admin') {
                        startAdminApp('home');
                    } else if (user.role === 'officer') {
                        startOfficerApp();
                    } else {
                        startEmployeeApp();
                    }
                    return;
                }
            }
        }
    } catch(e) { console.error('Session restore error:', e); }
    // ──────────────────────────────────────────────────

    showLoginScreen();
    loadRememberMe();

    // ─── Realtime: تحديث تلقائي عند أي تغيير في قاعدة البيانات ───
    window.addEventListener('db-realtime-update', async function(e) {
        const table = e.detail && e.detail.table;
        if (!currentUser) return;

        if (table === 'notifications') {
            const prev = notificationsCache.length;
            notificationsCache = await window.db.getNotifications();
            updateNotificationBadge();
            const unread = notificationsCache.filter(n =>
                (n.person_id == currentUser.employeeId || n.person_id === 'all') &&
                !(n.read_by && n.read_by.includes(String(currentUser.employeeId)))
            );
            if (unread.length > prev) {
                playNotificationSound();
                animateNotificationBell();
            }
            const curPage = document.querySelector('.emp-tab-content.active');
            if (curPage && curPage.id === 'emp-tab-notifications') renderNotificationsPage();
        } else if (table === 'admin_notifications_store') {
            if (currentUser.role === 'admin') {
                const prev = adminNotifications.filter(n => !n.read).length;
                adminNotifications = await window.db.getAdminNotifications();
                const newUnread = adminNotifications.filter(n => !n.read).length;
                updateAdminNotifBadge();
                if (newUnread > prev) {
                    playNotificationSound();
                }
            }
        } else if (table === 'leaves') {
            leaves = await window.db.getLeaves();
            if (currentUser.role === 'admin') {
                const curPage = document.querySelector('.page.active');
                if (curPage && curPage.id === 'page-leaves') renderLeaves();
            } else if (currentUser.role === 'officer') {
                if (typeof loadOfficerRequests === 'function') loadOfficerRequests();
                if (typeof loadOfficerDashboard === 'function') loadOfficerDashboard();
            } else {
                loadEmployeeRequests();
                loadEmployeeDashboard();
            }
        } else if (table === 'leave_permissions') {
            leavePermissions = await window.db.getLeavePermissions();
            if (currentUser.role === 'admin') {
                const curPage = document.querySelector('.page.active');
                if (curPage && curPage.id === 'page-permissions') renderPermissions();
            } else if (currentUser.role === 'officer') {
                if (typeof loadOfficerRequests === 'function') loadOfficerRequests();
                if (typeof loadOfficerDashboard === 'function') loadOfficerDashboard();
            } else {
                loadEmployeeRequests();
                loadEmployeeDashboard();
            }
        } else if (table === 'other_requests') {
            otherRequests = await window.db.getOtherRequests();
            if (currentUser.role === 'officer') {
                if (typeof loadOfficerRequests === 'function') loadOfficerRequests();
            } else if (currentUser.role !== 'admin') {
                loadEmployeeRequests();
            }
        } else if (table === 'employee_files') {
            if (currentUser.role === 'admin') {
                if (typeof renderArchiveAll === 'function') renderArchiveAll();
                if (typeof renderArchiveDashboard === 'function') renderArchiveDashboard();
            } else if (currentUser.role !== 'officer') {
                if (typeof loadEmployeeArchive === 'function') loadEmployeeArchive();
            }
        } else if (table === 'officer_files') {
            if (currentUser.role === 'admin') {
                if (typeof renderArchiveAll === 'function') renderArchiveAll();
                if (typeof renderArchiveDashboard === 'function') renderArchiveDashboard();
            } else if (currentUser.role === 'officer') {
                if (typeof loadOfficerArchive === 'function') loadOfficerArchive();
            }
        }
    });
    // ──────────────────────────────────────────────────────────────

    const loginButton = document.getElementById('login-button');
    const loginPassword = document.getElementById('login-password');
    const loginUsername = document.getElementById('login-username');
    if (loginButton) loginButton.addEventListener('click', login);
    if (loginPassword) {
        loginPassword.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') login();
        });
    }
    if (loginUsername) {
        loginUsername.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') login();
        });
    }

    // حقول الأرقام: مسح الصفر عند الضغط للكتابة مباشرة
    document.addEventListener('focus', function(e) {
        if (e.target.type === 'number' && (e.target.value === '0' || e.target.value === 0)) {
            e.target.value = '';
        }
    }, true);

    // منع سكرول الصفحة خلف النوافذ المنبثقة
    let _savedScrollY = 0;
    const _modalObserver = new MutationObserver(function(){
        const hasModal = document.querySelector('.modal-overlay.active') ||
                         document.getElementById('perm-person-detail-modal') ||
                         document.getElementById('edit-perm-modal') ||
                         document.getElementById('add-perm-modal');
        if(hasModal && !document.body.classList.contains('modal-open')){
            _savedScrollY = window.scrollY;
            document.body.classList.add('modal-open');
            document.body.style.top = -_savedScrollY + 'px';
        } else if(!hasModal && document.body.classList.contains('modal-open')){
            document.body.classList.remove('modal-open');
            document.body.style.top = '';
            window.scrollTo(0, _savedScrollY);
        }
    });
    _modalObserver.observe(document.body, {childList:true, subtree:true, attributes:true, attributeFilter:['class']});

    document.addEventListener('blur', function(e) {
        if (e.target.type === 'number' && e.target.value === '') {
            e.target.value = '0';
            e.target.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }, true);

});
