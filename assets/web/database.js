// ═══════════════════════════════════════════════════════════
// database.js — localStorage-based database for Farwaniya app
// Replaces the Electron/SQLite backend with browser storage
// ═══════════════════════════════════════════════════════════

(function () {
    'use strict';

    // ═══════════════════════════════════════
    // تشفير كلمات المرور (SHA-256 + salt)
    // ═══════════════════════════════════════
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

    async function _hashPassword(password) {
        var salt = _randomSalt();
        var hash = await _sha256Hex(salt + ':' + password);
        return 'v1$' + salt + '$' + hash;
    }

    function _isHashed(value) {
        return typeof value === 'string' && value.indexOf('v1$') === 0 && value.split('$').length === 3;
    }

    async function _verifyPassword(password, stored) {
        if (!stored) return false;
        if (_isHashed(stored)) {
            var parts = stored.split('$');
            var salt = parts[1];
            var expected = parts[2];
            var actual = await _sha256Hex(salt + ':' + password);
            return actual === expected;
        }
        // توافق رجعي: كلمات سر قديمة plain-text
        return stored === password;
    }

    const STORAGE_KEY = 'farwaniya_db';

    // ───── Default seed employees ─────
    const DEFAULT_EMPLOYEES = [
        'إبراهيم رجا الديحاني','احمد فرحان العازمي',
        'بدر سليم البطحاني','بدر فارس العصيمي',
        'ثامر جديع الدعمي','جندل محمد الرشيدي',
        'حسين علي البحراني','راشد سيف جاعد',
        'راشد مطلق المطيري','سعد ماطر الحسيني',
        'سلطان ضحوي المطيري','سلطان عبدالله الشلاحي',
        'سلمان عبيد الرشيدي','شداد راشد الرشيدي',
        'صلاح سليمان اخريص','طلال خالد العنزي',
        'عبدالمحسن حسين العجمي','عادل حمدان العنزي',
        'علي راشد المطيري','عقاب فلاح المطيري',
        'عمر محمد الشمري','فراج علي العجمي',
        'محمد بتال الدوسري','محمد جاسم الكندري',
        'محمد غازي الشريف','محمد عبداللطيف الظفيري',
        'محمد علي الدسم','مساعد سلطان المطيري',
        'ميثم احمد','ناجي سعد المطيري',
        'نايف علي الرشيدي','نواف جريد المطيري',
        'نواف خالد الدغر','نيف حسين العدواني',
        'وليد خالد العميرة','يوسف يعقوب القلاف',
        'يوسف عبدالله الصبر'
    ];

    // ───── Helpers ─────
    function now() {
        return new Date().toISOString().replace('T', ' ').substring(0, 19);
    }

    function nextId(arr) {
        if (!arr || arr.length === 0) return 1;
        return Math.max(...arr.map(r => r.id || 0)) + 1;
    }

    // ───── Core persistence ─────
    function getAllData() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) {
            console.error('خطأ في قراءة البيانات:', e);
            return null;
        }
    }

    function saveAllData(data) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        } catch (e) {
            console.error('خطأ في حفظ البيانات:', e);
            throw e;
        }
    }

    function getDB() {
        var data = getAllData();
        if (!data) {
            data = initDB();
        }
        if (data && Array.isArray(data.employees)) {
            var changed = false;
            data.employees = data.employees.map(function(emp) {
                if (typeof emp.shift === 'undefined') {
                    changed = true;
                    emp.shift = '';
                }
                return emp;
            });
            if (changed) saveAllData(data);
        }
        return data;
    }

    // ───── Init / seed ─────
    function initDB() {
        var data = getAllData();
        if (data && data.employees && data.employees.length > 0) {
            data.officers = data.officers || [];
            data.leaves = data.leaves || [];
            data.notes = data.notes || [];
            data.statistics = data.statistics || [];
            data.backups = data.backups || [];
            data.employee_files = data.employee_files || [];
            data.officer_files = data.officer_files || [];
            data.leave_permissions = data.leave_permissions || [];
            data.custom_archive_types = data.custom_archive_types || [];
            data.notifications = data.notifications || [];
            data.employees = data.employees.map(function(emp) {
                if (typeof emp.shift === 'undefined') emp.shift = '';
                return emp;
            });
            saveAllData(data);
            console.log('قاعدة البيانات جاهزة');
            return data;
        }

        data = {
            employees: DEFAULT_EMPLOYEES.map(function(name, i) {
                return {
                    id: i + 1,
                    name: name,
                    number: String(i + 1).padStart(3, '0'),
                    department: 'فحص فني الفروانية',
                    shift: '',
                    position: '',
                    hire_date: '',
                    phone: '',
                    status: 'نشط',
                    created_at: now(),
                    updated_at: null
                };
            }),
            officers: [],
            leaves: [],
            notes: [],
            statistics: [],
            backups: [],
            employee_files: [],
            officer_files: [],
            leave_permissions: [],
            custom_archive_types: [],
            notifications: []
        };
        saveAllData(data);
        console.log('قاعدة البيانات جاهزة (بيانات أولية)');
        return data;
    }

    // ═══════════════════════════════════════
    // Employees
    // ═══════════════════════════════════════
    function getEmployees() {
        var db = getDB();
        return db.employees.slice().sort(function(a, b) {
            return (a.name || '').localeCompare(b.name || '', 'ar');
        });
    }

    function addEmployee(data) {
        var db = getDB();
        var emp = {
            id: nextId(db.employees),
            name: data.name || '',
            number: data.number || '',
            department: data.department || '',
            shift: data.shift || '',
            position: data.position || '',
            hire_date: data.hire_date || '',
            phone: data.phone || '',
            status: data.status || 'نشط',
            created_at: now(),
            updated_at: null
        };
        db.employees.push(emp);
        saveAllData(db);
        return emp.id;
    }

    function updateEmployee(id, data) {
        var db = getDB();
        var idx = db.employees.findIndex(function(e) { return e.id === id; });
        if (idx === -1) return;
        var old = db.employees[idx];
        db.employees[idx] = {
            id: old.id,
            name: data.name,
            number: data.number,
            department: data.department,
            shift: typeof data.shift === 'undefined' ? old.shift || '' : data.shift,
            position: data.position,
            hire_date: data.hire_date,
            phone: data.phone,
            status: data.status || old.status,
            created_at: old.created_at,
            updated_at: now()
        };
        saveAllData(db);
    }

    function deleteEmployee(id) {
        var db = getDB();
        db.employees = db.employees.filter(function(e) { return e.id !== id; });
        db.notes = db.notes.filter(function(n) { return n.employee_id !== id; });
        db.employee_files = db.employee_files.filter(function(f) { return f.employee_id !== id; });
        db.leave_permissions = db.leave_permissions.filter(function(p) {
            return !(p.employee_id === id && p.person_type !== 'officer');
        });
        saveAllData(db);
    }

    // ═══════════════════════════════════════
    // Officers
    // ═══════════════════════════════════════
    function getOfficers() {
        var db = getDB();
        return db.officers.slice().sort(function(a, b) {
            var numA = parseInt(a.military_number) || 0;
            var numB = parseInt(b.military_number) || 0;
            if (numA !== numB) return numA - numB;
            return (a.name || '').localeCompare(b.name || '', 'ar');
        });
    }

    function addOfficer(data) {
        var db = getDB();
        var off = {
            id: nextId(db.officers),
            name: data.name || '',
            rank: data.rank || '',
            position: data.position || '',
            military_number: data.military_number || '',
            civil_number: data.civil_number || '',
            phone: data.phone || '',
            hire_date: data.hire_date || '',
            status: data.status || 'نشط',
            created_at: now(),
            updated_at: null
        };
        db.officers.push(off);
        saveAllData(db);
        return off.id;
    }

    function updateOfficer(id, data) {
        var db = getDB();
        var idx = db.officers.findIndex(function(o) { return o.id === id; });
        if (idx === -1) return;
        var old = db.officers[idx];
        db.officers[idx] = {
            id: old.id,
            name: data.name,
            rank: data.rank,
            position: data.position,
            military_number: data.military_number,
            civil_number: data.civil_number,
            phone: data.phone,
            hire_date: data.hire_date,
            status: data.status,
            created_at: old.created_at,
            updated_at: now()
        };
        saveAllData(db);
    }

    function deleteOfficer(id) {
        var db = getDB();
        db.officers = db.officers.filter(function(o) { return o.id !== id; });
        db.officer_files = db.officer_files.filter(function(f) { return f.officer_id !== id; });
        saveAllData(db);
    }

    // ═══════════════════════════════════════
    // Leaves
    // ═══════════════════════════════════════
    function getLeaves() {
        var db = getDB();
        return db.leaves.map(function(l) {
            return {
                id: l.id, person_id: l.person_id, person_type: l.person_type,
                type: l.type || 'leave',
                person_name: l.person_name, leave_type: l.leave_type,
                start_date: l.start_date, end_date: l.end_date,
                return_date: l.return_date, days: l.days, status: l.status,
                notes: l.notes, pdf_name: l.pdf_name, created_at: l.created_at
            };
        }).sort(function(a, b) {
            return (b.start_date || '').localeCompare(a.start_date || '');
        });
    }

    function addLeave(data) {
        var db = getDB();
        var leave = {
            id: nextId(db.leaves),
            person_id: data.person_id,
            person_type: data.person_type,
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
            pdf_name: data.pdf_name || null,
            created_at: now()
        };
        db.leaves.push(leave);
        saveAllData(db);
        return leave.id;
    }

    function updateLeave(id, data) {
        var db = getDB();
        var idx = db.leaves.findIndex(function(l) { return l.id === id; });
        if (idx === -1) return;
        var old = db.leaves[idx];
        db.leaves[idx] = {
            id: old.id,
            person_id: old.person_id,
            person_type: old.person_type,
            type: data.type || old.type || 'leave',
            person_name: old.person_name,
            leave_type: data.leave_type,
            start_date: data.start_date,
            end_date: data.end_date,
            return_date: data.return_date,
            days: data.days,
            status: data.status != null ? data.status : (old.status || 'pending'),
            notes: data.notes,
            pdf_data: old.pdf_data,
            pdf_name: old.pdf_name,
            created_at: old.created_at
        };
        saveAllData(db);
    }

    function updateLeavePdf(id, pdfData, pdfName) {
        var db = getDB();
        var idx = db.leaves.findIndex(function(l) { return l.id === id; });
        if (idx === -1) return;
        db.leaves[idx].pdf_data = pdfData;
        db.leaves[idx].pdf_name = pdfName;
        saveAllData(db);
    }

    function removeLeavePdf(id) {
        var db = getDB();
        var idx = db.leaves.findIndex(function(l) { return l.id === id; });
        if (idx === -1) return;
        db.leaves[idx].pdf_data = null;
        db.leaves[idx].pdf_name = null;
        saveAllData(db);
    }

    function getLeavePdf(id) {
        var db = getDB();
        var leave = db.leaves.find(function(l) { return l.id === id; });
        if (!leave) return null;
        return { pdf_data: leave.pdf_data, pdf_name: leave.pdf_name };
    }

    function deleteLeave(id) {
        var db = getDB();
        db.leaves = db.leaves.filter(function(l) { return l.id !== id; });
        saveAllData(db);
    }

    // ═══════════════════════════════════════
    // Notes
    // ═══════════════════════════════════════
    function getNotes(personId) {
        var db = getDB();
        return db.notes
            .filter(function(n) { return n.employee_id === personId; })
            .sort(function(a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    }

    function addNote(personId, text) {
        var db = getDB();
        var note = {
            id: nextId(db.notes),
            employee_id: personId,
            text: text,
            created_at: now()
        };
        db.notes.push(note);
        saveAllData(db);
        return note.id;
    }

    function deleteNote(id) {
        var db = getDB();
        db.notes = db.notes.filter(function(n) { return n.id !== id; });
        saveAllData(db);
    }

    // ═══════════════════════════════════════
    // Statistics
    // ═══════════════════════════════════════
    function getStatistics() {
        var db = getDB();
        return db.statistics.slice().sort(function(a, b) {
            return (b.date || '').localeCompare(a.date || '');
        });
    }

    function upsertStatistics(data) {
        var db = getDB();
        var idx = db.statistics.findIndex(function(s) { return s.date === data.date; });
        var record = {
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
            updated_at: now()
        };
        if (idx !== -1) {
            record.id = db.statistics[idx].id;
            record.created_at = db.statistics[idx].created_at;
            db.statistics[idx] = record;
        } else {
            record.id = nextId(db.statistics);
            record.created_at = now();
            db.statistics.push(record);
        }
        saveAllData(db);
    }

    function deleteStatistics(date) {
        var db = getDB();
        db.statistics = db.statistics.filter(function(s) { return s.date !== date; });
        saveAllData(db);
    }

    function clearAllStatistics() {
        var db = getDB();
        db.statistics = [];
        saveAllData(db);
    }

    // ═══════════════════════════════════════
    // Backups
    // ═══════════════════════════════════════
    function getBackups() {
        var db = getDB();
        return db.backups.slice().sort(function(a, b) {
            return (b.created_at || '').localeCompare(a.created_at || '');
        });
    }

    function deleteBackup(id) {
        var db = getDB();
        db.backups = db.backups.filter(function(b) { return b.id !== id; });
        saveAllData(db);
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ───── createBackup: export as JSON file download ─────
    function createBackup() {
        try {
            var db = getDB();
            var exportData = {
                employees: db.employees,
                officers: db.officers,
                leaves: db.leaves,
                notes: db.notes,
                statistics: db.statistics,
                employee_files: db.employee_files,
                officer_files: db.officer_files,
                leave_permissions: db.leave_permissions,
                custom_archive_types: db.custom_archive_types,
                exportDate: new Date().toISOString()
            };
            var json = JSON.stringify(exportData, null, 2);
            var blob = new Blob([json], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            var ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            a.href = url;
            a.download = 'farwaniya-backup-' + ts + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            var backup = {
                id: nextId(db.backups),
                name: a.download,
                size: formatBytes(blob.size),
                status: 'مكتمل',
                created_at: now()
            };
            db.backups.push(backup);
            saveAllData(db);

            return { success: true };
        } catch (e) {
            console.error('Backup error:', e);
            return { success: false, error: e.message };
        }
    }

    // ───── importBackup: read JSON file and merge ─────
    function importBackup() {
        return new Promise(function(resolve) {
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = function(e) {
                var file = e.target.files[0];
                if (!file) { resolve({ success: false }); return; }
                var reader = new FileReader();
                reader.onload = function(ev) {
                    try {
                        var imported = JSON.parse(ev.target.result);
                        var db = getDB();

                        // Merge employees
                        if (imported.employees) {
                            imported.employees.forEach(function(emp) {
                                if (!db.employees.find(function(e) { return e.name === emp.name; })) {
                                    emp.id = nextId(db.employees);
                                    db.employees.push(emp);
                                }
                            });
                        }
                        // Merge officers
                        if (imported.officers) {
                            imported.officers.forEach(function(off) {
                                if (!db.officers.find(function(o) { return o.name === off.name; })) {
                                    off.id = nextId(db.officers);
                                    db.officers.push(off);
                                }
                            });
                        }
                        // Merge leaves
                        if (imported.leaves) {
                            imported.leaves.forEach(function(l) {
                                if (!db.leaves.find(function(x) { return x.person_id === l.person_id && x.person_type === l.person_type && x.start_date === l.start_date && x.end_date === l.end_date; })) {
                                    l.id = nextId(db.leaves);
                                    db.leaves.push(l);
                                }
                            });
                        }
                        // Merge notes
                        if (imported.notes) {
                            imported.notes.forEach(function(n) {
                                if (!db.notes.find(function(x) { return x.employee_id === n.employee_id && x.text === n.text; })) {
                                    n.id = nextId(db.notes);
                                    db.notes.push(n);
                                }
                            });
                        }
                        // Merge statistics
                        if (imported.statistics) {
                            imported.statistics.forEach(function(s) {
                                var idx = db.statistics.findIndex(function(x) { return x.date === s.date; });
                                if (idx !== -1) {
                                    s.id = db.statistics[idx].id;
                                    db.statistics[idx] = s;
                                } else {
                                    s.id = nextId(db.statistics);
                                    db.statistics.push(s);
                                }
                            });
                        }
                        // Merge employee files
                        var archiveFiles = imported.employee_files || imported.archive_files || [];
                        archiveFiles.forEach(function(f) {
                            if (!db.employee_files.find(function(x) { return x.employee_id === f.employee_id && x.file_name === f.file_name; })) {
                                f.id = nextId(db.employee_files);
                                db.employee_files.push(f);
                            }
                        });
                        // Merge officer files
                        var offArchive = imported.officer_files || imported.officer_archive || [];
                        offArchive.forEach(function(f) {
                            if (!db.officer_files.find(function(x) { return x.officer_id === f.officer_id && x.file_name === f.file_name; })) {
                                f.id = nextId(db.officer_files);
                                db.officer_files.push(f);
                            }
                        });
                        // Merge leave permissions
                        if (imported.leave_permissions) {
                            imported.leave_permissions.forEach(function(p) {
                                if (!db.leave_permissions.find(function(x) { return x.employee_id === p.employee_id && x.date === p.date && x.type === p.type; })) {
                                    p.id = nextId(db.leave_permissions);
                                    p.person_type = p.person_type || 'employee';
                                    p.fraction = p.fraction || 1;
                                    db.leave_permissions.push(p);
                                }
                            });
                        }
                        // Merge custom archive types
                        if (imported.custom_archive_types) {
                            imported.custom_archive_types.forEach(function(t) {
                                if (!db.custom_archive_types.find(function(x) { return x.key === t.key; })) {
                                    t.id = nextId(db.custom_archive_types);
                                    db.custom_archive_types.push(t);
                                }
                            });
                        }

                        saveAllData(db);
                        resolve({ success: true });
                    } catch (err) {
                        console.error('Import error:', err);
                        resolve({ success: false, error: 'ملف غير صالح: ' + err.message });
                    }
                };
                reader.readAsText(file);
            };
            input.addEventListener('cancel', function() { resolve({ success: false }); });
            input.click();
        });
    }

    // ───── importBackupData: parse JSON string and merge ─────
    function importBackupData(jsonString) {
        try {
            var imported = JSON.parse(jsonString);
            var db = getDB();
            if (imported.employees) {
                imported.employees.forEach(function(emp) {
                    if (!db.employees.find(function(e) { return e.name === emp.name; })) {
                        emp.id = nextId(db.employees);
                        db.employees.push(emp);
                    }
                });
            }
            if (imported.officers) {
                imported.officers.forEach(function(off) {
                    if (!db.officers.find(function(o) { return o.name === off.name; })) {
                        off.id = nextId(db.officers);
                        db.officers.push(off);
                    }
                });
            }
            if (imported.leaves) {
                imported.leaves.forEach(function(l) {
                    if (!db.leaves.find(function(x) { return x.person_id === l.person_id && x.person_type === l.person_type && x.start_date === l.start_date && x.end_date === l.end_date; })) {
                        l.id = nextId(db.leaves);
                        db.leaves.push(l);
                    }
                });
            }
            if (imported.notes) {
                imported.notes.forEach(function(n) {
                    if (!db.notes.find(function(x) { return x.employee_id === n.employee_id && x.text === n.text; })) {
                        n.id = nextId(db.notes);
                        db.notes.push(n);
                    }
                });
            }
            if (imported.statistics) {
                imported.statistics.forEach(function(s) {
                    var idx = db.statistics.findIndex(function(x) { return x.date === s.date; });
                    if (idx !== -1) { s.id = db.statistics[idx].id; db.statistics[idx] = s; }
                    else { s.id = nextId(db.statistics); db.statistics.push(s); }
                });
            }
            var archiveFiles = imported.employee_files || imported.archive_files || [];
            archiveFiles.forEach(function(f) {
                if (!db.employee_files.find(function(x) { return x.employee_id === f.employee_id && x.file_name === f.file_name; })) {
                    f.id = nextId(db.employee_files);
                    db.employee_files.push(f);
                }
            });
            var offArchive = imported.officer_files || imported.officer_archive || [];
            offArchive.forEach(function(f) {
                if (!db.officer_files.find(function(x) { return x.officer_id === f.officer_id && x.file_name === f.file_name; })) {
                    f.id = nextId(db.officer_files);
                    db.officer_files.push(f);
                }
            });
            if (imported.leave_permissions) {
                imported.leave_permissions.forEach(function(p) {
                    if (!db.leave_permissions.find(function(x) { return x.employee_id === p.employee_id && x.date === p.date && x.type === p.type; })) {
                        p.id = nextId(db.leave_permissions);
                        p.person_type = p.person_type || 'employee';
                        p.fraction = p.fraction || 1;
                        db.leave_permissions.push(p);
                    }
                });
            }
            if (imported.custom_archive_types) {
                imported.custom_archive_types.forEach(function(t) {
                    if (!db.custom_archive_types.find(function(x) { return x.key === t.key; })) {
                        t.id = nextId(db.custom_archive_types);
                        db.custom_archive_types.push(t);
                    }
                });
            }
            saveAllData(db);
            return { success: true };
        } catch (err) {
            console.error('Import error:', err);
            return { success: false, error: 'ملف غير صالح: ' + err.message };
        }
    }

    // ═══════════════════════════════════════
    // Employee Archive
    // ═══════════════════════════════════════
    function _stripFileData(f) {
        var copy = Object.assign({}, f);
        delete copy.file_data;
        return copy;
    }

    function archiveGetAll() {
        var db = getDB();
        return db.employee_files.map(function(f) {
            var emp = db.employees.find(function(e) { return e.id === f.employee_id; });
            var item = _stripFileData(f);
            item.employee_name = emp ? emp.name : '';
            return item;
        }).sort(function(a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    }

    function archiveGetByEmployee(empId) {
        var db = getDB();
        var id = Number(empId);
        return db.employee_files
            .filter(function(f) { return Number(f.employee_id) === id; })
            .map(_stripFileData)
            .sort(function(a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    }

    function archiveUpload(data) {
        var db = getDB();
        var file = {
            id: nextId(db.employee_files),
            employee_id: data.employee_id,
            person_id: data.person_id != null ? data.person_id : data.employee_id,
            date: data.date || now().slice(0, 10),
            status: data.status || 'pending',
            type: data.type || 'document',
            file_name: data.file_name,
            file_path: data.file_name,
            file_data: data.file_data,
            file_size: data.file_size || '',
            file_type: data.file_type || '',
            notes: data.notes || '',
            created_at: now()
        };
        db.employee_files.push(file);
        saveAllData(db);
        return file.id;
    }

    function archiveReadFile(id) {
        var db = getDB();
        var nid = Number(id);
        var file = db.employee_files.find(function(f) { return Number(f.id) === nid; });
        if (!file) return null;
        return { id: file.id, data: file.file_data, file_name: file.file_name, file_type: file.file_type, type: file.type, created_at: file.created_at };
    }

    function archiveDelete(id) {
        var db = getDB();
        var nid = Number(id);
        db.employee_files = db.employee_files.filter(function(f) { return Number(f.id) !== nid; });
        saveAllData(db);
    }

    function archiveScanFolder() {
        return [];
    }

    // ═══════════════════════════════════════
    // Officer Archive
    // ═══════════════════════════════════════
    function officerArchiveGetAll() {
        var db = getDB();
        return db.officer_files.map(function(f) {
            var off = db.officers.find(function(o) { return o.id === f.officer_id; });
            var item = _stripFileData(f);
            item.officer_name = off ? off.name : '';
            item.officer_rank = off ? (off.rank || '') : '';
            return item;
        }).sort(function(a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    }

    function officerArchiveGetByOfficer(offId) {
        var db = getDB();
        var id = Number(offId);
        return db.officer_files
            .filter(function(f) { return Number(f.officer_id) === id; })
            .map(_stripFileData)
            .sort(function(a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    }

    function officerArchiveUpload(data) {
        var db = getDB();
        var file = {
            id: nextId(db.officer_files),
            officer_id: data.officer_id,
            type: data.type || 'document',
            file_name: data.file_name,
            file_path: data.file_name,
            file_data: data.file_data,
            file_size: data.file_size || '',
            file_type: data.file_type || '',
            notes: data.notes || '',
            created_at: now()
        };
        db.officer_files.push(file);
        saveAllData(db);
        return file.id;
    }

    function officerArchiveReadFile(id) {
        var db = getDB();
        var file = db.officer_files.find(function(f) { return f.id === id; });
        if (!file) return null;
        return { data: file.file_data, file_name: file.file_name, file_type: file.file_type };
    }

    function officerArchiveDelete(id) {
        var db = getDB();
        db.officer_files = db.officer_files.filter(function(f) { return f.id !== id; });
        saveAllData(db);
    }

    // ═══════════════════════════════════════
    // Leave Permissions
    // ═══════════════════════════════════════
    function _resolvePermName(db, p) {
        if (p.person_type === 'officer') {
            var off = db.officers.find(function(o) { return o.id === p.employee_id; });
            return off ? off.name : '';
        }
        var emp = db.employees.find(function(e) { return e.id === p.employee_id; });
        return emp ? emp.name : '';
    }

    function getLeavePermissions() {
        var db = getDB();
        return db.leave_permissions.map(function(p) {
            return Object.assign({}, p, { employee_name: _resolvePermName(db, p) });
        }).sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });
    }

    function addLeavePermission(data) {
        var db = getDB();
        var existing = db.leave_permissions.find(function(p) {
            return p.employee_id === data.employee_id && p.date === data.date && p.type === data.type;
        });
        if (existing) {
            return { error: 'يوجد استئذان مسجل لنفس الموظف في نفس اليوم ونفس النوع' };
        }
        var month = data.date.substring(0, 7);
        var monthlyCount = db.leave_permissions.filter(function(p) {
            return p.employee_id === data.employee_id && p.date.substring(0, 7) === month && p.status !== 'rejected';
        }).length;
        if (monthlyCount + 1 > 4) {
            return { error: 'تم تجاوز الحد الشهري (4 استئذانات)' };
        }
        var perm = {
            id: nextId(db.leave_permissions),
            employee_id: data.employee_id,
            person_id: data.person_id != null ? data.person_id : data.employee_id,
            request_type: data.request_type || 'permission',
            person_type: data.person_type || 'employee',
            date: data.date,
            type: data.type,
            status: data.status || 'pending',
            fraction: data.fraction || 1,
            notes: data.notes || '',
            created_at: now()
        };
        db.leave_permissions.push(perm);
        saveAllData(db);
        return { success: true, id: perm.id };
    }

    function getMonthlyPermissionTotal(employeeId, month, personType) {
        var db = getDB();
        return db.leave_permissions.filter(function(p) {
            var matchId = p.employee_id === employeeId;
            var matchMonth = p.date.substring(0, 7) === month;
            var matchType = personType ? p.person_type === personType : true;
            var notRejected = p.status !== 'rejected';
            return matchId && matchMonth && matchType && notRejected;
        }).length;
    }

    function getMonthlyPermissionReport(month) {
        var db = getDB();
        return db.leave_permissions
            .filter(function(p) { return p.date.substring(0, 7) === month; })
            .map(function(p) {
                return Object.assign({}, p, { employee_name: _resolvePermName(db, p) });
            })
            .sort(function(a, b) {
                return (a.employee_name || '').localeCompare(b.employee_name || '', 'ar') || (a.date || '').localeCompare(b.date || '');
            });
    }

    function getLeavePermissionById(id) {
        var db = getDB();
        var p = db.leave_permissions.find(function(x) { return x.id === id; });
        if (!p) return null;
        return Object.assign({}, p, { employee_name: _resolvePermName(db, p) });
    }

    function updateLeavePermission(id, data) {
        var db = getDB();
        var idx = db.leave_permissions.findIndex(function(p) { return p.id === id; });
        if (idx === -1) return { success: false };
        db.leave_permissions[idx] = Object.assign({}, db.leave_permissions[idx], {
            date: data.date,
            type: data.type,
            notes: data.notes,
            status: data.status != null ? data.status : db.leave_permissions[idx].status,
            request_type: data.request_type || db.leave_permissions[idx].request_type || 'permission'
        });
        saveAllData(db);
        return { success: true };
    }

    function deleteLeavePermission(id) {
        var db = getDB();
        db.leave_permissions = db.leave_permissions.filter(function(p) { return p.id !== id; });
        saveAllData(db);
        return { success: true };
    }

    // ═══════════════════════════════════════
    // Custom Archive Types
    // ═══════════════════════════════════════
    function customTypesGetAll() {
        var db = getDB();
        return db.custom_archive_types.slice().sort(function(a, b) { return (a.id || 0) - (b.id || 0); });
    }

    function customTypesAdd(data) {
        var db = getDB();
        var item = {
            id: nextId(db.custom_archive_types),
            key: data.key,
            name: data.name,
            color: data.color || '#6b7280'
        };
        db.custom_archive_types.push(item);
        saveAllData(db);
        return item.id;
    }

    function customTypesDelete(id) {
        var db = getDB();
        db.custom_archive_types = db.custom_archive_types.filter(function(t) { return t.id !== id; });
        saveAllData(db);
    }

    // ═══════════════════════════════════════
    // Print — open templates in new windows
    // ═══════════════════════════════════════
    function openPrintWindow(templateUrl, data, windowFeatures) {
        return new Promise(function(resolve) {
            // Store data in localStorage for the print template to pick up
            try { localStorage.setItem('__printData', JSON.stringify(data)); } catch(e){}

            // In Flutter WebView, use the native Flutter handler to load the print file
            if (window.flutter_inappwebview) {
                window.flutter_inappwebview.callHandler('navigateToPrint', templateUrl);
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
            // Also try direct assignment
            try { win.__printData = data; } catch(e){}
            // Try calling fillData after load
            var filled = false;
            var tryFill = function() {
                if (filled) return;
                try {
                    if (typeof win.fillData === 'function') {
                        win.fillData(data);
                        filled = true;
                    }
                    if (filled) {
                        setTimeout(function(){ try { if(!win.__selfPrint) win.print(); } catch(e){} resolve({ success: true }); }, 300);
                    }
                } catch (e) {
                    console.error('Print fill error:', e);
                }
            };
            try { win.addEventListener('load', tryFill); } catch(e){}
            // Fallback: poll for function availability (iOS Safari)
            var attempts = 0;
            var poll = setInterval(function() {
                attempts++;
                if (filled || attempts > 30) { clearInterval(poll); if (!filled) resolve({ cancelled: true }); return; }
                tryFill();
            }, 200);
        });
    }

    function printDailyForm(data)   { return openPrintWindow('print/print-daily.html', data); }
    function printWeeklyForm(data)  { return openPrintWindow('print/print-weekly.html', data); }
    function printMonthlyForm(data) { return openPrintWindow('print/print-monthly.html', data); }
    function printLeavesReport(data) { return openPrintWindow('print/print-leaves.html', data, 'width=1200,height=800'); }
    function printPermissionsReport(data) { return openPrintWindow('print/print-permissions.html', data); }
    function printOfficersPermissionsReport(data) { return openPrintWindow('print/print-permissions-officers.html', data); }
    function printEmployeesListReport(data) { return openPrintWindow('print/print-employees.html', data); }

    // ═══════════════════════════════════════
    // Notifications
    // ═══════════════════════════════════════
    function getNotifications() {
        var db = getDB();
        return db.notifications.slice().sort(function(a, b) {
            return new Date(b.date) - new Date(a.date);
        });
    }

    function addNotification(data) {
        var db = getDB();
        var notification = {
            id: Date.now(),
            person_id: data.person_id || 'all',
            title: data.title || '',
            message: data.message || '',
            type: data.type || 'message',
            status: data.status || 'info',
            date: new Date().toISOString(),
            readBy: []  // Array of user IDs who have read this notification
        };
        db.notifications.push(notification);
        saveAllData(db);
        return notification.id;
    }

    function markNotificationAsRead(id, personId) {
        var db = getDB();
        var notif = db.notifications.find(function(n) { return n.id === id; });
        if (notif) {
            // Initialize readBy array if it doesn't exist (for backward compatibility)
            if (!notif.readBy) notif.readBy = [];
            // Add personId to readBy array if not already present
            if (!notif.readBy.includes(personId)) {
                notif.readBy.push(personId);
            }
            saveAllData(db);
        }
    }

    function markAllNotificationsAsRead(personId) {
        var db = getDB();
        db.notifications.forEach(function(n) {
            if (n.person_id == personId || n.person_id === 'all') {
                // Initialize readBy array if it doesn't exist
                if (!n.readBy) n.readBy = [];
                // Add personId to readBy array if not already present
                if (!n.readBy.includes(personId)) {
                    n.readBy.push(personId);
                }
            }
        });
        saveAllData(db);
    }

    function deleteNotification(id) {
        var db = getDB();
        db.notifications = db.notifications.filter(function(n) { return n.id !== id; });
        saveAllData(db);
    }

    // ═══════════════════════════════════════
    // Expose window.db
    // ═══════════════════════════════════════
    // ═══════════════════════════════════════
    // Accounts (user accounts for officers & employees)
    // ═══════════════════════════════════════
    function getAccounts() {
        var db = getDB();
        if (!Array.isArray(db.accounts)) db.accounts = [];
        return db.accounts.slice();
    }

    async function addAccount(data) {
        var db = getDB();
        if (!Array.isArray(db.accounts)) db.accounts = [];
        // منع تكرار اسم المستخدم
        if (db.accounts.find(function(a) { return a.username === data.username; })) {
            return { error: 'اسم المستخدم مستخدم مسبقاً' };
        }
        var acc = {
            id: nextId(db.accounts),
            username: data.username,
            password: await _hashPassword(data.password),
            role: data.role,
            personId: data.personId,
            created_at: now()
        };
        db.accounts.push(acc);
        saveAllData(db);
        return { id: acc.id };
    }

    async function updateAccount(id, data) {
        var db = getDB();
        if (!Array.isArray(db.accounts)) db.accounts = [];
        var idx = db.accounts.findIndex(function(a) { return a.id === id; });
        if (idx === -1) return { error: 'الحساب غير موجود' };
        // منع تكرار اسم المستخدم مع حساب آخر
        var dup = db.accounts.find(function(a) { return a.username === data.username && a.id !== id; });
        if (dup) return { error: 'اسم المستخدم مستخدم مسبقاً' };
        db.accounts[idx].username = data.username;
        if (data.password) {
            db.accounts[idx].password = _isHashed(data.password)
                ? data.password
                : await _hashPassword(data.password);
        }
        if (data.role) db.accounts[idx].role = data.role;
        saveAllData(db);
        return { ok: true };
    }

    function deleteAccount(id) {
        var db = getDB();
        if (!Array.isArray(db.accounts)) db.accounts = [];
        db.accounts = db.accounts.filter(function(a) { return a.id !== id; });
        saveAllData(db);
    }

    async function findAccount(username, password) {
        var db = getDB();
        if (!Array.isArray(db.accounts)) db.accounts = [];
        var candidates = db.accounts.filter(function(a) { return a.username === username; });
        for (var i = 0; i < candidates.length; i++) {
            if (await _verifyPassword(password, candidates[i].password)) {
                return candidates[i];
            }
        }
        return null;
    }

    window.db = {
        initDB: initDB,
        getAllData: getAllData,
        saveAllData: saveAllData,
        createBackup: createBackup,
        importBackup: importBackup,
        importBackupData: importBackupData,

        getEmployees: getEmployees,
        addEmployee: addEmployee,
        updateEmployee: updateEmployee,
        deleteEmployee: deleteEmployee,

        getOfficers: getOfficers,
        addOfficer: addOfficer,
        updateOfficer: updateOfficer,
        deleteOfficer: deleteOfficer,

        getLeaves: getLeaves,
        addLeave: addLeave,
        updateLeave: updateLeave,
        updateLeavePdf: updateLeavePdf,
        removeLeavePdf: removeLeavePdf,
        getLeavePdf: getLeavePdf,
        deleteLeave: deleteLeave,

        getNotes: getNotes,
        addNote: addNote,
        deleteNote: deleteNote,

        getStatistics: getStatistics,
        upsertStatistics: upsertStatistics,
        deleteStatistics: deleteStatistics,
        clearAllStatistics: clearAllStatistics,

        getBackups: getBackups,
        deleteBackup: deleteBackup,

        archiveGetAll: archiveGetAll,
        archiveGetByEmployee: archiveGetByEmployee,
        archiveUpload: archiveUpload,
        archiveReadFile: archiveReadFile,
        archiveDelete: archiveDelete,
        archiveScanFolder: archiveScanFolder,

        officerArchiveGetAll: officerArchiveGetAll,
        officerArchiveGetByOfficer: officerArchiveGetByOfficer,
        officerArchiveUpload: officerArchiveUpload,
        officerArchiveReadFile: officerArchiveReadFile,
        officerArchiveDelete: officerArchiveDelete,

        getLeavePermissions: getLeavePermissions,
        addLeavePermission: addLeavePermission,
        getMonthlyPermissionTotal: getMonthlyPermissionTotal,
        getMonthlyPermissionReport: getMonthlyPermissionReport,
        getLeavePermissionById: getLeavePermissionById,
        updateLeavePermission: updateLeavePermission,
        deleteLeavePermission: deleteLeavePermission,

        customTypesGetAll: customTypesGetAll,
        customTypesAdd: customTypesAdd,
        customTypesDelete: customTypesDelete,

        getNotifications: getNotifications,
        addNotification: addNotification,
        markNotificationAsRead: markNotificationAsRead,
        markAllNotificationsAsRead: markAllNotificationsAsRead,
        deleteNotification: deleteNotification,

        printDailyForm: printDailyForm,
        printWeeklyForm: printWeeklyForm,
        printMonthlyForm: printMonthlyForm,
        printLeavesReport: printLeavesReport,
        printPermissionsReport: printPermissionsReport,
        printOfficersPermissionsReport: printOfficersPermissionsReport,
        printEmployeesListReport: printEmployeesListReport,

        getAccounts: getAccounts,
        addAccount: addAccount,
        updateAccount: updateAccount,
        deleteAccount: deleteAccount,
        findAccount: findAccount,
    };

    // Auto-init
    initDB();

})();
