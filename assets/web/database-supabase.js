// ═══════════════════════════════════════════════════════════
// database-supabase.js — Pure Supabase data layer v2.0
// Zero localStorage. All functions are async.
// ═══════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ─── ضع هنا بيانات مشروعك في Supabase ───────────────────
    var SUPABASE_URL      = 'https://leyrntrcubvoduqslmua.supabase.co';
    var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxleXJudHJjdWJ2b2R1cXNsbXVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczODk5NTIsImV4cCI6MjA5Mjk2NTk1Mn0.gSMu2G-kSTG2qaC-8t2sDQI4jq-NREeah9Qabcnw0lM';
    // ─────────────────────────────────────────────────────────

    var _sb = null;

    // ═══════════════════════════════════════════════════════════
    // Password hashing (SHA-256 + salt)
    // ═══════════════════════════════════════════════════════════
    function _bytesToHex(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) {
            var h = bytes[i].toString(16);
            s += h.length === 1 ? '0' + h : h;
        }
        return s;
    }

    async function _sha256Hex(str) {
        var enc = new TextEncoder();
        var buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
        return _bytesToHex(new Uint8Array(buf));
    }

    function _randomSalt() {
        var arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        return _bytesToHex(arr);
    }

    // التنسيق: "v1$<salt>$<sha256(salt + password)>"
    async function hashPassword(password) {
        var salt = _randomSalt();
        var hash = await _sha256Hex(salt + ':' + password);
        return 'v1$' + salt + '$' + hash;
    }

    function isHashed(value) {
        return typeof value === 'string' && value.indexOf('v1$') === 0 && value.split('$').length === 3;
    }

    async function verifyPassword(password, stored) {
        if (!stored) return false;
        if (isHashed(stored)) {
            var parts = stored.split('$');
            var salt = parts[1];
            var expected = parts[2];
            var actual = await _sha256Hex(salt + ':' + password);
            return actual === expected;
        }
        // توافق رجعي: كلمات سر قديمة plain-text
        return stored === password;
    }

    // ═══════════════════════════════════════════════════════════
    // تهيئة Supabase
    // ═══════════════════════════════════════════════════════════
    var _rtChannels = [];

    function _init() {
        if (typeof window.supabase === 'undefined' || SUPABASE_URL === 'YOUR_SUPABASE_URL') {
            console.warn('⚠️ Supabase غير مهيأ — يرجى إعداد SUPABASE_URL و SUPABASE_ANON_KEY');
            return;
        }
        try {
            _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
            });
            console.log('✅ Supabase متصل');

            // الـ realtime يحتاج جلسة authenticated (بعد تشديد RLS)
            _sb.auth.getSession().then(function (r) {
                if (r && r.data && r.data.session) _setupRealtime();
            });
            _sb.auth.onAuthStateChange(function (event) {
                if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') _setupRealtime();
                if (event === 'SIGNED_OUT') _teardownRealtime();
            });
        } catch (e) {
            console.error('خطأ في تهيئة Supabase:', e);
        }
    }

    function _require() {
        if (!_sb) throw new Error('Supabase غير متصل — تأكد من إعداد SUPABASE_URL و SUPABASE_ANON_KEY');
        return _sb;
    }

    // ─── مساعد موحد لقراءة البيانات ─────────────────────────
    async function _select(table, query) {
        var sb = _require();
        var q = sb.from(table).select('*');
        if (query) q = query(q);
        var result = await q;
        if (result.error) { console.error('[' + table + '] select error:', result.error.message); return []; }
        return result.data || [];
    }

    // ─── مساعد موحد للكتابة ─────────────────────────────────
    async function _insert(table, row) {
        var sb = _require();
        var result = await sb.from(table).insert(row).select('id').single();
        if (result.error) { console.error('[' + table + '] insert error:', result.error.message); return null; }
        return result.data ? result.data.id : null;
    }

    async function _update(table, id, patch) {
        var sb = _require();
        var result = await sb.from(table).update(patch).eq('id', id);
        if (result.error) { console.error('[' + table + '] update error:', result.error.message); return false; }
        return true;
    }

    async function _delete(table, id) {
        var sb = _require();
        var result = await sb.from(table).delete().eq('id', id);
        if (result.error) { console.error('[' + table + '] delete error:', result.error.message); return false; }
        return true;
    }

    async function _upsert(table, row, conflictCol) {
        var sb = _require();
        var opts = conflictCol ? { onConflict: conflictCol } : {};
        var result = await sb.from(table).upsert(row, opts).select('id').single();
        if (result.error) { console.error('[' + table + '] upsert error:', result.error.message); return null; }
        return result.data ? result.data.id : null;
    }

    // ─── Realtime — إشعارات فورية بين الأجهزة ───────────────
    function _setupRealtime() {
        if (!_sb || _rtChannels.length > 0) return; // تجنّب التكرار
        var tables = ['employees','officers','leaves','notes','statistics',
            'employee_files','officer_files','leave_permissions',
            'custom_archive_types','notifications',
            'other_requests','admin_notifications_store','app_settings'];
        tables.forEach(function (t) {
            var ch = _sb.channel('rt:' + t)
                .on('postgres_changes', { event: '*', schema: 'public', table: t }, function () {
                    window.dispatchEvent(new CustomEvent('db-realtime-update', { detail: { table: t } }));
                })
                .subscribe();
            _rtChannels.push(ch);
        });
    }

    function _teardownRealtime() {
        if (!_sb) return;
        _rtChannels.forEach(function (ch) { try { _sb.removeChannel(ch); } catch (e) {} });
        _rtChannels = [];
    }

    // ═══════════════════════════════════════════════════════════
    // Employees
    // ═══════════════════════════════════════════════════════════
    async function getEmployees() {
        return _select('employees', function (q) { return q.order('name'); });
    }

    async function addEmployee(data) {
        return _insert('employees', {
            name: data.name || '',
            number: data.number || '',
            department: data.department || '',
            shift: data.shift || '',
            position: data.position || '',
            hire_date: data.hire_date || '',
            phone: data.phone || '',
            status: data.status || 'نشط'
        });
    }

    async function updateEmployee(id, data) {
        return _update('employees', id, {
            name: data.name,
            number: data.number,
            department: data.department,
            shift: data.shift || '',
            position: data.position,
            hire_date: data.hire_date,
            phone: data.phone,
            status: data.status || 'نشط',
            updated_at: new Date().toISOString()
        });
    }

    async function deleteEmployee(id) {
        var sb = _require();
        await sb.from('notes').delete().eq('employee_id', id);
        await sb.from('employee_files').delete().eq('employee_id', id);
        await sb.from('leave_permissions').delete().eq('employee_id', id).neq('person_type', 'officer');
        return _delete('employees', id);
    }

    // ═══════════════════════════════════════════════════════════
    // Officers
    // ═══════════════════════════════════════════════════════════
    async function getOfficers() {
        return _select('officers', function (q) { return q.order('military_number'); });
    }

    async function addOfficer(data) {
        return _insert('officers', {
            name: data.name || '',
            rank: data.rank || '',
            position: data.position || '',
            military_number: data.military_number || '',
            civil_number: data.civil_number || '',
            phone: data.phone || '',
            hire_date: data.hire_date || '',
            status: data.status || 'نشط'
        });
    }

    async function updateOfficer(id, data) {
        return _update('officers', id, {
            name: data.name,
            rank: data.rank,
            position: data.position,
            military_number: data.military_number,
            civil_number: data.civil_number,
            phone: data.phone,
            hire_date: data.hire_date,
            status: data.status,
            updated_at: new Date().toISOString()
        });
    }

    async function deleteOfficer(id) {
        var sb = _require();
        await sb.from('officer_files').delete().eq('officer_id', id);
        return _delete('officers', id);
    }

    // ═══════════════════════════════════════════════════════════
    // Leaves
    // ═══════════════════════════════════════════════════════════
    async function getLeaves() {
        var rows = await _select('leaves', function (q) { return q.order('start_date', { ascending: false }); });
        return rows.map(function (l) {
            return {
                id: l.id, person_id: l.person_id, person_type: l.person_type,
                type: l.type || 'leave', person_name: l.person_name,
                leave_type: l.leave_type, start_date: l.start_date, end_date: l.end_date,
                return_date: l.return_date, days: l.days, status: l.status,
                notes: l.notes, pdf_name: l.pdf_name, created_at: l.created_at
            };
        });
    }

    async function addLeave(data) {
        return _insert('leaves', {
            person_id: data.person_id,
            person_type: data.person_type || 'employee',
            type: data.type || 'leave',
            person_name: data.person_name || '',
            leave_type: data.leave_type || '',
            start_date: data.start_date || '',
            end_date: data.end_date || '',
            return_date: data.return_date || '',
            days: data.days || 0,
            status: data.status || 'pending',
            notes: data.notes || '',
            pdf_data: data.pdf_data || null,
            pdf_name: data.pdf_name || null
        });
    }

    async function updateLeave(id, data) {
        return _update('leaves', id, {
            type: data.type || 'leave',
            leave_type: data.leave_type,
            start_date: data.start_date,
            end_date: data.end_date,
            return_date: data.return_date,
            days: data.days,
            status: data.status,
            notes: data.notes
        });
    }

    async function updateLeavePdf(id, pdfData, pdfName) {
        return _update('leaves', id, { pdf_data: pdfData, pdf_name: pdfName });
    }

    async function removeLeavePdf(id) {
        return _update('leaves', id, { pdf_data: null, pdf_name: null });
    }

    async function getLeavePdf(id) {
        var sb = _require();
        var result = await sb.from('leaves').select('pdf_data,pdf_name').eq('id', id).maybeSingle();
        if (result.error || !result.data) return null;
        return { pdf_data: result.data.pdf_data, pdf_name: result.data.pdf_name };
    }

    async function deleteLeave(id) {
        return _delete('leaves', id);
    }

    // ═══════════════════════════════════════════════════════════
    // Notes
    // ═══════════════════════════════════════════════════════════
    async function getNotes(personId) {
        return _select('notes', function (q) { return q.eq('employee_id', personId).order('created_at', { ascending: false }); });
    }

    async function addNote(personId, text) {
        return _insert('notes', { employee_id: personId, text: text });
    }

    async function deleteNote(id) {
        return _delete('notes', id);
    }

    // ═══════════════════════════════════════════════════════════
    // Statistics
    // ═══════════════════════════════════════════════════════════
    async function getStatistics() {
        return _select('statistics', function (q) { return q.order('date', { ascending: false }); });
    }

    async function upsertStatistics(data) {
        var sb = _require();
        var payload = {
            date: data.date,
            private_count: data.private_count || 0,
            special_transfer_count: data.special_transfer_count || 0,
            general_transfer_count: data.general_transfer_count || 0,
            motorcycles_count: data.motorcycles_count || 0,
            color_change_count: data.color_change_count || 0,
            towing_count: data.towing_count || 0,
            technical_committees_count: data.technical_committees_count || 0,
            second_pass_count: data.second_pass_count || 0,
            third_pass_count: data.third_pass_count || 0,
            updated_at: new Date().toISOString()
        };
        var result = await sb.from('statistics').upsert(payload, { onConflict: 'date' });
        if (result.error) console.error('[statistics] upsert error:', result.error.message);
    }

    async function deleteStatistics(date) {
        var sb = _require();
        await sb.from('statistics').delete().eq('date', date);
    }

    async function clearAllStatistics() {
        var sb = _require();
        await sb.from('statistics').delete().neq('id', 0);
    }

    // ═══════════════════════════════════════════════════════════
    // Backup (export/import JSON)
    // ═══════════════════════════════════════════════════════════
    async function getBackups() { return []; } // Backups are now external JSON files

    async function deleteBackup() { return true; }

    function _formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    async function createBackup() {
        try {
            var sb = _require();
            var tables = ['employees','officers','leaves','notes','statistics',
                'employee_files','officer_files','leave_permissions','custom_archive_types'];
            var exportData = { exportDate: new Date().toISOString() };
            for (var i = 0; i < tables.length; i++) {
                var r = await sb.from(tables[i]).select('*');
                exportData[tables[i]] = r.data || [];
            }
            var json = JSON.stringify(exportData, null, 2);
            var blob = new Blob([json], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            var ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            a.href = url; a.download = 'farwaniya-backup-' + ts + '.json';
            document.body.appendChild(a); a.click();
            document.body.removeChild(a); URL.revokeObjectURL(url);
            return { success: true };
        } catch (e) {
            console.error('Backup error:', e);
            return { success: false, error: e.message };
        }
    }

    async function importBackup() {
        return new Promise(function (resolve) {
            var input = document.createElement('input');
            input.type = 'file'; input.accept = '.json';
            input.onchange = function (e) {
                var file = e.target.files[0];
                if (!file) { resolve({ success: false }); return; }
                var reader = new FileReader();
                reader.onload = async function (ev) {
                    var result = await importBackupData(ev.target.result);
                    resolve(result);
                };
                reader.readAsText(file);
            };
            input.addEventListener('cancel', function () { resolve({ success: false }); });
            input.click();
        });
    }

    async function importBackupData(jsonString) {
        try {
            var imported = JSON.parse(jsonString);
            var sb = _require();
            var tables = ['employees','officers','leaves','notes','statistics',
                'employee_files','officer_files','leave_permissions','custom_archive_types'];
            for (var i = 0; i < tables.length; i++) {
                var t = tables[i];
                if (imported[t] && imported[t].length > 0) {
                    // حذف الـ id لأن Supabase يولده تلقائياً
                    var rows = imported[t].map(function (r) {
                        var copy = Object.assign({}, r);
                        delete copy.id;
                        return copy;
                    });
                    // إدراج على دفعات
                    var batchSize = 100;
                    for (var j = 0; j < rows.length; j += batchSize) {
                        await sb.from(t).insert(rows.slice(j, j + batchSize));
                    }
                }
            }
            return { success: true };
        } catch (err) {
            console.error('Import error:', err);
            return { success: false, error: 'ملف غير صالح: ' + err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Employee Archive (Files)
    // ═══════════════════════════════════════════════════════════
    async function archiveGetAll() {
        var rows = await _select('employee_files', function (q) { return q.order('created_at', { ascending: false }); });
        var emps = await getEmployees();
        return rows.map(function (f) {
            var emp = emps.find(function (e) { return e.id === f.employee_id; });
            var copy = Object.assign({}, f); delete copy.file_data;
            copy.employee_name = emp ? emp.name : '';
            return copy;
        });
    }

    async function archiveGetByEmployee(empId) {
        var rows = await _select('employee_files', function (q) {
            return q.eq('employee_id', Number(empId)).order('created_at', { ascending: false });
        });
        return rows.map(function (f) { var c = Object.assign({}, f); delete c.file_data; return c; });
    }

    async function archiveUpload(data) {
        return _insert('employee_files', {
            employee_id: data.employee_id,
            person_id: data.person_id != null ? data.person_id : data.employee_id,
            date: data.date || new Date().toISOString().slice(0, 10),
            status: data.status || 'pending',
            type: data.type || 'document',
            file_name: data.file_name,
            file_path: data.file_name,
            file_data: data.file_data,
            file_size: data.file_size || '',
            file_type: data.file_type || '',
            notes: data.notes || ''
        });
    }

    async function archiveReadFile(id) {
        var sb = _require();
        var result = await sb.from('employee_files').select('*').eq('id', Number(id)).maybeSingle();
        if (result.error || !result.data) return null;
        var f = result.data;
        return { id: f.id, data: f.file_data, file_name: f.file_name, file_type: f.file_type, type: f.type, created_at: f.created_at };
    }

    async function archiveDelete(id) {
        return _delete('employee_files', Number(id));
    }

    function archiveScanFolder() { return []; }

    // ═══════════════════════════════════════════════════════════
    // Officer Archive
    // ═══════════════════════════════════════════════════════════
    async function officerArchiveGetAll() {
        var rows = await _select('officer_files', function (q) { return q.order('created_at', { ascending: false }); });
        var offs = await getOfficers();
        return rows.map(function (f) {
            var off = offs.find(function (o) { return o.id === f.officer_id; });
            var copy = Object.assign({}, f); delete copy.file_data;
            copy.officer_name = off ? off.name : '';
            copy.officer_rank = off ? (off.rank || '') : '';
            return copy;
        });
    }

    async function officerArchiveGetByOfficer(offId) {
        var rows = await _select('officer_files', function (q) {
            return q.eq('officer_id', Number(offId)).order('created_at', { ascending: false });
        });
        return rows.map(function (f) { var c = Object.assign({}, f); delete c.file_data; return c; });
    }

    async function officerArchiveUpload(data) {
        return _insert('officer_files', {
            officer_id: data.officer_id,
            type: data.type || 'document',
            file_name: data.file_name,
            file_path: data.file_name,
            file_data: data.file_data,
            file_size: data.file_size || '',
            file_type: data.file_type || '',
            notes: data.notes || ''
        });
    }

    async function officerArchiveReadFile(id) {
        var sb = _require();
        var result = await sb.from('officer_files').select('*').eq('id', id).maybeSingle();
        if (result.error || !result.data) return null;
        var f = result.data;
        return { data: f.file_data, file_name: f.file_name, file_type: f.file_type };
    }

    async function officerArchiveDelete(id) {
        return _delete('officer_files', id);
    }

    // ═══════════════════════════════════════════════════════════
    // Leave Permissions
    // ═══════════════════════════════════════════════════════════
    async function getLeavePermissions() {
        var rows = await _select('leave_permissions', function (q) { return q.order('date', { ascending: false }); });
        var emps = await getEmployees();
        var offs = await getOfficers();
        return rows.map(function (p) {
            var name = '';
            if (p.person_type === 'officer') {
                var off = offs.find(function (o) { return o.id === p.employee_id; });
                name = off ? off.name : '';
            } else {
                var emp = emps.find(function (e) { return e.id === p.employee_id; });
                name = emp ? emp.name : '';
            }
            return Object.assign({}, p, { employee_name: name });
        });
    }

    async function addLeavePermission(data) {
        var sb = _require();
        var personType = data.person_type || 'employee';
        var isAdminSave = data._adminSave === true;

        if (!isAdminSave) {
            // تحقق من التكرار (مع person_type لتجنب التعارض بين موظف وضابط بنفس الـ id)
            var dup = await sb.from('leave_permissions')
                .select('id')
                .eq('employee_id', data.employee_id)
                .eq('person_type', personType)
                .eq('date', data.date)
                .eq('type', data.type)
                .maybeSingle();
            if (dup.data) return { error: 'يوجد استئذان مسجل لنفس الشخص في نفس اليوم ونفس النوع' };

            // تحقق من الحد الشهري
            var month = data.date.substring(0, 7);
            var monthly = await sb.from('leave_permissions')
                .select('id', { count: 'exact', head: true })
                .eq('employee_id', data.employee_id)
                .eq('person_type', personType)
                .like('date', month + '%')
                .neq('status', 'rejected');
            var count = monthly.count || 0;
            if (count + 1 > 4) return { error: 'تم تجاوز الحد الشهري (4 استئذانات)' };
        }

        var id = await _insert('leave_permissions', {
            employee_id: data.employee_id,
            person_id: data.person_id != null ? data.person_id : data.employee_id,
            request_type: data.request_type || 'permission',
            person_type: personType,
            date: data.date,
            type: data.type,
            status: data.status || 'pending',
            fraction: data.fraction || 1,
            notes: data.notes || ''
        });
        if (!id) return { error: 'فشل في حفظ الاستئذان' };
        return { success: true, id: id };
    }

    async function getMonthlyPermissionTotal(employeeId, month, personType) {
        var sb = _require();
        var q = sb.from('leave_permissions')
            .select('id', { count: 'exact', head: true })
            .eq('employee_id', employeeId)
            .like('date', month + '%')
            .neq('status', 'rejected');
        if (personType) q = q.eq('person_type', personType);
        var result = await q;
        return result.count || 0;
    }

    async function getMonthlyPermissionReport(month) {
        var rows = await _select('leave_permissions', function (q) {
            return q.like('date', month + '%').order('date');
        });
        var emps = await getEmployees();
        var offs = await getOfficers();
        return rows.map(function (p) {
            var name = '';
            if (p.person_type === 'officer') {
                var off = offs.find(function (o) { return o.id === p.employee_id; });
                name = off ? off.name : '';
            } else {
                var emp = emps.find(function (e) { return e.id === p.employee_id; });
                name = emp ? emp.name : '';
            }
            return Object.assign({}, p, { employee_name: name });
        });
    }

    async function getLeavePermissionById(id) {
        var sb = _require();
        var result = await sb.from('leave_permissions').select('*').eq('id', id).maybeSingle();
        if (result.error || !result.data) return null;
        return result.data;
    }

    async function updateLeavePermission(id, data) {
        var ok = await _update('leave_permissions', id, {
            date: data.date,
            type: data.type,
            notes: data.notes,
            status: data.status,
            request_type: data.request_type || 'permission'
        });
        return ok ? { success: true } : { success: false };
    }

    async function deleteLeavePermission(id) {
        var ok = await _delete('leave_permissions', id);
        return ok ? { success: true } : { success: false };
    }

    // ═══════════════════════════════════════════════════════════
    // Custom Archive Types
    // ═══════════════════════════════════════════════════════════
    async function customTypesGetAll() {
        return _select('custom_archive_types', function (q) { return q.order('id'); });
    }

    async function customTypesAdd(data) {
        return _insert('custom_archive_types', { key: data.key, name: data.name, color: data.color || '#6b7280' });
    }

    async function customTypesDelete(id) {
        return _delete('custom_archive_types', id);
    }

    // ═══════════════════════════════════════════════════════════
    // Notifications (لإشعارات الموظفين/الضباط)
    // ═══════════════════════════════════════════════════════════
    async function getNotifications() {
        return _select('notifications', function (q) { return q.order('date', { ascending: false }); });
    }

    async function addNotification(data) {
        return _insert('notifications', {
            person_id: data.person_id || 'all',
            title: data.title || '',
            message: data.message || '',
            type: data.type || 'message',
            status: data.status || 'info',
            date: new Date().toISOString(),
            read_by: []
        });
    }

    async function markNotificationAsRead(id, personId) {
        var sb = _require();
        var r = await sb.from('notifications').select('read_by').eq('id', id).maybeSingle();
        if (r.error || !r.data) return;
        var readBy = r.data.read_by || [];
        var pid = String(personId);
        if (!readBy.includes(pid)) {
            readBy.push(pid);
            await sb.from('notifications').update({ read_by: readBy }).eq('id', id);
        }
    }

    async function markAllNotificationsAsRead(personId) {
        var sb = _require();
        var rows = await sb.from('notifications').select('id,read_by')
            .or('person_id.eq.' + personId + ',person_id.eq.all');
        if (rows.error || !rows.data) return;
        for (var i = 0; i < rows.data.length; i++) {
            var n = rows.data[i];
            var readBy = n.read_by || [];
            var pid = String(personId);
            if (!readBy.includes(pid)) {
                readBy.push(pid);
                await sb.from('notifications').update({ read_by: readBy }).eq('id', n.id);
            }
        }
    }

    async function deleteNotification(id) {
        return _delete('notifications', id);
    }

    // ═══════════════════════════════════════════════════════════
    // Admin Notifications (إشعارات جرس الأدمن)
    // ═══════════════════════════════════════════════════════════
    async function getAdminNotifications() {
        var sb = _require();
        var month = new Date().toISOString().slice(0, 7);
        var result = await sb.from('admin_notifications_store')
            .select('data')
            .eq('month', month)
            .maybeSingle();
        if (result.error || !result.data) return [];
        return result.data.data || [];
    }

    async function saveAdminNotifications(arr) {
        var sb = _require();
        var month = new Date().toISOString().slice(0, 7);
        await sb.from('admin_notifications_store').upsert({ month: month, data: arr }, { onConflict: 'month' });
    }

    // ═══════════════════════════════════════════════════════════
    // FCM Push Notifications
    // ═══════════════════════════════════════════════════════════
    async function saveFCMToken(data) {
        try {
            var sb = _require();
            // احذف أي سجل قديم لنفس الـ role ثم أدرج الجديد
            await sb.from('fcm_tokens').delete().eq('role', data.role);
            await sb.from('fcm_tokens').insert(
                { role: data.role, token: data.token, person_id: data.personId ? String(data.personId) : null, updated_at: new Date().toISOString() }
            );
        } catch(e) { console.warn('saveFCMToken error:', e); }
    }

    async function sendPushNotificationToAdmin({ title, body }) {
        try {
            var sb = _require();
            await sb.functions.invoke('send-push-notification', {
                body: { title, body, role: 'admin' }
            });
        } catch(e) { console.warn('sendPushNotification error:', e); }
    }

    async function sendPushNotificationToPerson({ title, body, personId }) {
        try {
            var sb = _require();
            await sb.functions.invoke('send-push-notification', {
                body: { title, body, person_id: String(personId) }
            });
        } catch(e) { console.warn('sendPushNotificationToPerson error:', e); }
    }

    // ═══════════════════════════════════════════════════════════
    // Other Requests (طلبات أخرى)
    // ═══════════════════════════════════════════════════════════
    async function getOtherRequests() {
        return _select('other_requests', function (q) { return q.order('date', { ascending: false }); });
    }

    async function addOtherRequest(data) {
        return _insert('other_requests', {
            person_id: data.person_id,
            person_name: data.person_name || '',
            person_type: data.person_type || 'employee',
            type: data.type || '',
            description: data.description || '',
            status: data.status || 'pending',
            date: data.date || new Date().toISOString()
        });
    }

    async function updateOtherRequest(id, patch) {
        return _update('other_requests', id, patch);
    }

    async function deleteOtherRequest(id) {
        return _delete('other_requests', id);
    }

    // ═══════════════════════════════════════════════════════════
    // App Settings (إعدادات التطبيق)
    // ═══════════════════════════════════════════════════════════
    async function getAppSettings() {
        var rows = await _select('app_settings', null);
        var settings = {};
        rows.forEach(function (r) {
            try { settings[r.key] = JSON.parse(r.value); } catch (e) { settings[r.key] = r.value; }
        });
        return settings;
    }

    async function saveAppSettings(obj) {
        var sb = _require();
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            await sb.from('app_settings').upsert({ key: k, value: JSON.stringify(obj[k]) }, { onConflict: 'key' });
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Accounts — تستخدم SECURITY DEFINER RPC functions لحماية كلمات المرور
    // (الوصول المباشر لجدول accounts ممنوع لـ anon)
    // ═══════════════════════════════════════════════════════════
    async function getAccounts() {
        var sb = _require();
        var res = await sb.rpc('rpc_list_accounts');
        if (res.error) { console.warn('rpc_list_accounts:', res.error); return []; }
        return res.data || [];
    }

    async function addAccount(data) {
        var sb = _require();
        // 1) أنشئ السطر في public.accounts (بدون كلمة مرور — الكلمة تُدار في auth.users)
        var res = await sb.rpc('rpc_add_account', {
            p_username : data.username,
            p_role     : data.role,
            p_person_id: data.personId || null
        });
        if (res.error) {
            var msg = (res.error.message || '').toLowerCase();
            if (msg.indexOf('exists') !== -1) return { error: 'اسم المستخدم مستخدم مسبقاً' };
            return { error: 'فشل في إنشاء الحساب' };
        }
        var newId = res.data;
        // 2) أنشئ مستخدم Supabase Auth واربطه (يلزم إعطاء كلمة مرور)
        if (data.password && String(data.password).length >= 6) {
            try {
                var fn = await sb.functions.invoke('admin-account-auth', {
                    body: { action: 'set_password', account_id: newId, password: data.password }
                });
                if (fn.error) {
                    console.warn('admin-account-auth set_password:', fn.error);
                    // تراجَع: احذف السطر اليتيم لتجنّب حساب بلا auth
                    try { await sb.rpc('rpc_delete_account', { p_id: newId }); } catch (_) {}
                    return { error: 'فشل في إعداد كلمة المرور' };
                }
            } catch (e) {
                console.warn('admin-account-auth invoke failed:', e);
                try { await sb.rpc('rpc_delete_account', { p_id: newId }); } catch (_) {}
                return { error: 'فشل في إعداد كلمة المرور' };
            }
        }
        return { id: newId };
    }

    async function updateAccount(id, data) {
        var sb = _require();
        // 1) حدّث الحقول غير الحساسة
        var res = await sb.rpc('rpc_update_account', {
            p_id      : id,
            p_username: data.username,
            p_role    : data.role
        });
        if (res.error) {
            var msg = (res.error.message || '').toLowerCase();
            if (msg.indexOf('exists') !== -1) return { error: 'اسم المستخدم مستخدم مسبقاً' };
            return { error: 'فشل في التحديث' };
        }
        // 2) إذا أُعطيت كلمة مرور جديدة plain، حدّثها عبر Edge Function
        if (data.password && !isHashed(data.password) && String(data.password).length >= 6) {
            try {
                var fn = await sb.functions.invoke('admin-account-auth', {
                    body: { action: 'set_password', account_id: id, password: data.password }
                });
                if (fn.error) {
                    console.warn('admin-account-auth set_password:', fn.error);
                    return { error: 'تم تحديث البيانات لكن فشل تحديث كلمة المرور' };
                }
            } catch (e) {
                console.warn('admin-account-auth invoke failed:', e);
                return { error: 'تم تحديث البيانات لكن فشل تحديث كلمة المرور' };
            }
        }
        return { ok: true };
    }

    async function deleteAccount(id) {
        var sb = _require();
        // امسح أولاً مستخدم auth.users (best-effort)، ثم احذف من public.accounts
        try {
            await sb.functions.invoke('admin-account-auth', {
                body: { action: 'delete', account_id: id }
            });
        } catch (e) { console.warn('admin-account-auth delete:', e); }
        var res = await sb.rpc('rpc_delete_account', { p_id: id });
        return !res.error;
    }

    // صياغة الإيميل المستخدمة في auth.users لربط الحساب القديم بمستخدم Supabase Auth.
    // يجب أن تطابق الدالة emailFor() في supabase/functions/provision-auth-user/index.ts
    function _emailFor(username) {
        var safe = String(username || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
        return safe + '@alfarwania.app';
    }

    // تسجيل الدخول مباشرة عبر Supabase Auth (لم تعد rpc_login موجودة).
    async function findAccount(username, password) {
        var sb = _require();
        var email = _emailFor(username);
        var auth = await sb.auth.signInWithPassword({ email: email, password: password });
        if (auth.error || !auth.data || !auth.data.session) {
            if (auth.error) console.warn('signInWithPassword:', auth.error.message);
            return null;
        }
        // اجلب بيانات الحساب (id/role/person_id) من rpc_me عبر JWT الجديد
        var me = await sb.rpc('rpc_me');
        if (me.error) { console.warn('rpc_me:', me.error); return null; }
        var row = Array.isArray(me.data) ? me.data[0] : me.data;
        if (!row) return null;
        return {
            id        : row.id,
            username  : row.username,
            role      : row.role,
            person_id : row.person_id,
            personId  : row.person_id
        };
    }

    async function logout() {
        try { var sb = _require(); await sb.auth.signOut(); } catch (e) {}
    }

    // يستعيد الحساب الحالي من جلسة Supabase المحفوظة في localStorage الخاصة بـ WebView.
    // يُستخدم عند بدء التشغيل البارد (مثلاً عند فتح التطبيق من تنبيه FCM).
    async function restoreSession() {
        var sb = _require();
        try {
            var s = await sb.auth.getSession();
            if (!s || !s.data || !s.data.session) return null;
        } catch (e) { return null; }
        try {
            var me = await sb.rpc('rpc_me');
            if (me.error) { console.warn('rpc_me:', me.error); return null; }
            var row = Array.isArray(me.data) ? me.data[0] : me.data;
            if (!row) return null;
            return {
                id        : row.id,
                username  : row.username,
                role      : row.role,
                person_id : row.person_id,
                personId  : row.person_id
            };
        } catch (e) { return null; }
    }

    async function changePassword(username, oldPassword, newPassword) {
        var sb = _require();
        // تحقق من كلمة المرور القديمة عبر إعادة تسجيل دخول مؤقت
        var email = _emailFor(username);
        var verify = await sb.auth.signInWithPassword({ email: email, password: oldPassword });
        if (verify.error || !verify.data || !verify.data.session) return false;
        var upd = await sb.auth.updateUser({ password: newPassword });
        if (upd.error) { console.warn('updateUser:', upd.error.message); return false; }
        return true;
    }

    // ═══════════════════════════════════════════════════════════
    // Reset All Data
    // ═══════════════════════════════════════════════════════════
    async function resetAllData() {
        var sb = _require();
        var tables = ['employee_files','officer_files','leave_permissions','notes',
            'leaves','statistics','custom_archive_types','notifications',
            'other_requests','admin_notifications_store','officers','employees'];
        for (var i = 0; i < tables.length; i++) {
            await sb.from(tables[i]).delete().neq('id', 0);
        }
        // accounts عبر RPC (الوصول المباشر مقفل)
        try {
            var accs = await getAccounts();
            for (var j = 0; j < (accs || []).length; j++) {
                await deleteAccount(accs[j].id);
            }
        } catch(e) { console.warn('reset accounts:', e); }
        await sb.from('app_settings').delete().neq('key', '__never__');
    }

    // ═══════════════════════════════════════════════════════════
    // Print
    // ═══════════════════════════════════════════════════════════
    function openPrintWindow(templateUrl, data, windowFeatures) {
        return new Promise(function (resolve) {
            // In Flutter WebView, use the native handler to load the print file
            if (window.flutter_inappwebview) {
                // احفظ الجلسة الحالية في Flutter قبل الانتقال لصفحة الطباعة
                try {
                    var _cu = (typeof currentUser !== 'undefined') ? currentUser : null;
                    if (_cu) window.flutter_inappwebview.callHandler('saveSession', JSON.stringify(_cu));
                } catch(e) {}
                window.flutter_inappwebview.callHandler('navigateToPrint', templateUrl, JSON.stringify(data));
                resolve({ success: true });
                return;
            }

            var features = windowFeatures || 'width=900,height=700';
            var win = window.open(templateUrl, '_blank', features);
            if (!win) {
                window.location.href = templateUrl;
                resolve({ success: true });
                return;
            }
            try { win.__printData = data; } catch (e) {}
            var filled = false;
            var tryFill = function () {
                if (filled) return;
                try {
                    if (typeof win.fillData === 'function') {
                        win.fillData(data); filled = true;
                        setTimeout(function () { try { if (!win.__selfPrint) win.print(); } catch (e) {} resolve({ success: true }); }, 300);
                    }
                } catch (e) {}
            };
            try { win.addEventListener('load', tryFill); } catch (e) {}
            var attempts = 0;
            var poll = setInterval(function () {
                attempts++;
                if (filled || attempts > 30) { clearInterval(poll); if (!filled) resolve({ cancelled: true }); return; }
                tryFill();
            }, 200);
        });
    }

    function printDailyForm(data)                  { return openPrintWindow('print/print-daily.html', data); }
    function printWeeklyForm(data)                 { return openPrintWindow('print/print-weekly.html', data); }
    function printMonthlyForm(data)                { return openPrintWindow('print/print-monthly.html', data); }
    function printLeavesReport(data)               { return openPrintWindow('print/print-leaves.html', data, 'width=1200,height=800'); }
    function printPermissionsReport(data)          { return openPrintWindow('print/print-permissions.html', data); }
    function printOfficersPermissionsReport(data)  { return openPrintWindow('print/print-permissions-officers.html', data); }
    function printEmployeesListReport(data)        { return openPrintWindow('print/print-employees.html', data); }

    // ═══════════════════════════════════════════════════════════
    // Deprecated stubs (للتوافق مع الكود القديم)
    // ═══════════════════════════════════════════════════════════
    function getAllData() {
        console.warn('getAllData() مهجور — استخدم الدوال المخصصة لكل جدول');
        return {};
    }
    function saveAllData() {
        console.warn('saveAllData() مهجور — استخدم الدوال المخصصة لكل جدول');
    }
    async function initDB() { return {}; }

    // ═══════════════════════════════════════════════════════════
    // Audit Log
    // ═══════════════════════════════════════════════════════════
    async function auditLog(entry) {
        try {
            if (!_sb) return null;
            const row = {
                actor       : (entry.actor       || '').toString(),
                actor_role  : (entry.actor_role  || '').toString(),
                action      : (entry.action      || '').toString(),
                entity_type : (entry.entity_type || '').toString(),
                entity_id   : entry.entity_id != null ? Number(entry.entity_id) : null,
                person_id   : entry.person_id != null ? Number(entry.person_id) : null,
                person_type : entry.person_type || null,
                details     : entry.details || {}
            };
            const { error } = await _sb.from('audit_log').insert([row]);
            if (error) console.warn('auditLog warning:', error);
            return !error;
        } catch (e) {
            console.warn('auditLog exception:', e);
            return false;
        }
    }

    async function auditLogList(opts) {
        opts = opts || {};
        try {
            if (!_sb) return [];
            let q = _sb.from('audit_log').select('*').order('created_at', { ascending: false });
            if (opts.limit)       q = q.limit(opts.limit);
            if (opts.entity_type) q = q.eq('entity_type', opts.entity_type);
            if (opts.entity_id)   q = q.eq('entity_id', opts.entity_id);
            if (opts.action)      q = q.eq('action', opts.action);
            const { data, error } = await q;
            if (error) { console.warn('auditLogList:', error); return []; }
            return data || [];
        } catch (e) {
            console.warn('auditLogList exception:', e);
            return [];
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Expose window.db
    // ═══════════════════════════════════════════════════════════
    window.db = {
        // Core
        initDB: initDB,
        getAllData: getAllData,
        saveAllData: saveAllData,
        resetAllData: resetAllData,
        createBackup: createBackup,
        importBackup: importBackup,
        importBackupData: importBackupData,
        // Employees
        getEmployees: getEmployees,
        addEmployee: addEmployee,
        updateEmployee: updateEmployee,
        deleteEmployee: deleteEmployee,
        // Officers
        getOfficers: getOfficers,
        addOfficer: addOfficer,
        updateOfficer: updateOfficer,
        deleteOfficer: deleteOfficer,
        // Leaves
        getLeaves: getLeaves,
        addLeave: addLeave,
        updateLeave: updateLeave,
        updateLeavePdf: updateLeavePdf,
        removeLeavePdf: removeLeavePdf,
        getLeavePdf: getLeavePdf,
        deleteLeave: deleteLeave,
        // Notes
        getNotes: getNotes,
        addNote: addNote,
        deleteNote: deleteNote,
        // Statistics
        getStatistics: getStatistics,
        upsertStatistics: upsertStatistics,
        deleteStatistics: deleteStatistics,
        clearAllStatistics: clearAllStatistics,
        // Backups
        getBackups: getBackups,
        deleteBackup: deleteBackup,
        // Employee Archive
        archiveGetAll: archiveGetAll,
        archiveGetByEmployee: archiveGetByEmployee,
        archiveUpload: archiveUpload,
        archiveReadFile: archiveReadFile,
        archiveDelete: archiveDelete,
        archiveScanFolder: archiveScanFolder,
        // Officer Archive
        officerArchiveGetAll: officerArchiveGetAll,
        officerArchiveGetByOfficer: officerArchiveGetByOfficer,
        officerArchiveUpload: officerArchiveUpload,
        officerArchiveReadFile: officerArchiveReadFile,
        officerArchiveDelete: officerArchiveDelete,
        // Leave Permissions
        getLeavePermissions: getLeavePermissions,
        addLeavePermission: addLeavePermission,
        getMonthlyPermissionTotal: getMonthlyPermissionTotal,
        getMonthlyPermissionReport: getMonthlyPermissionReport,
        getLeavePermissionById: getLeavePermissionById,
        updateLeavePermission: updateLeavePermission,
        deleteLeavePermission: deleteLeavePermission,
        // Custom Types
        customTypesGetAll: customTypesGetAll,
        customTypesAdd: customTypesAdd,
        customTypesDelete: customTypesDelete,
        // Notifications
        getNotifications: getNotifications,
        addNotification: addNotification,
        markNotificationAsRead: markNotificationAsRead,
        markAllNotificationsAsRead: markAllNotificationsAsRead,
        deleteNotification: deleteNotification,
        // Admin Notifications
        getAdminNotifications: getAdminNotifications,
        saveAdminNotifications: saveAdminNotifications,
        // FCM Push Notifications
        saveFCMToken: saveFCMToken,
        sendPushNotificationToAdmin: sendPushNotificationToAdmin,
        sendPushNotificationToPerson: sendPushNotificationToPerson,
        // Other Requests
        getOtherRequests: getOtherRequests,
        addOtherRequest: addOtherRequest,
        updateOtherRequest: updateOtherRequest,
        deleteOtherRequest: deleteOtherRequest,
        // App Settings
        getAppSettings: getAppSettings,
        saveAppSettings: saveAppSettings,
        // Accounts
        getAccounts: getAccounts,
        addAccount: addAccount,
        updateAccount: updateAccount,
        deleteAccount: deleteAccount,
        findAccount: findAccount,
        changePassword: changePassword,
        logout: logout,
        restoreSession: restoreSession,
        hashPassword: hashPassword,
        verifyPassword: verifyPassword,
        isHashed: isHashed,
        // Print
        printDailyForm: printDailyForm,
        printWeeklyForm: printWeeklyForm,
        printMonthlyForm: printMonthlyForm,
        printLeavesReport: printLeavesReport,
        printPermissionsReport: printPermissionsReport,
        printOfficersPermissionsReport: printOfficersPermissionsReport,
        printEmployeesListReport: printEmployeesListReport,
        // Audit Log
        auditLog: auditLog,
        auditLogList: auditLogList
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }

})();
