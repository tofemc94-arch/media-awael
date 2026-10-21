const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'data.json');

// Active admin session tokens (persisted in memory)
const activeAdminTokens = new Set();

// List of connected SSE clients
let sseClients = [];

// Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Helper to read data safely
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    parsed.settings = parsed.settings || {};
    parsed.settings.adminPassword = parsed.settings.adminPassword || 'alawael2026';
    return parsed;
  } catch (err) {
    console.error('Error reading data:', err);
    return { settings: { adminPassword: 'alawael2026' }, schools: [], bookings: [], blockedSlots: [] };
  }
}

// Helper to write data safely
function writeData(data) {
  try {
    const tempFile = `${DATA_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, DATA_FILE);
    return true;
  } catch (err) {
    console.error('Error writing data:', err);
    return false;
  }
}

// Admin Authentication Middleware
function requireAdmin(req, res, next) {
  let token = req.headers['x-admin-token'] || req.query.token;
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7).trim();
  }
  if (!token || !activeAdminTokens.has(token)) {
    return res.status(401).json({ error: 'غير مصرح: يرجى تسجيل الدخول كمدير لقسم الإعلام' });
  }
  next();
}

// Broadcast SSE event
function broadcastSSE(eventType, payload) {
  const message = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(message);
    } catch (e) {
      // client disconnected
    }
  });
}

// Dispatch Telegram alert
async function dispatchTelegramAlert(settings, booking) {
  if (!settings.telegramBotToken || !settings.telegramChatId) {
    return { sent: false, reason: 'Telegram token/chat_id not configured' };
  }

  const text = `🔔 <b>حجز تصوير جديد - مدارس الأوائل الأهلية</b>\n\n` +
    `🏫 <b>المدرسة:</b> ${booking.schoolName}\n` +
    `📅 <b>التاريخ:</b> ${booking.date}\n` +
    `⏰ <b>الوقت:</b> ${booking.slot}\n` +
    `🎯 <b>نوع الفعالية:</b> ${booking.eventType}\n` +
    (booking.notes ? `📝 <b>الملاحظات:</b> ${booking.notes}\n` : '') +
    `\n🔒 <i>تم قفل الموعد ومنع أي مدرسة أخرى من حجزه.</i>`;

  try {
    const tgUrl = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
    const resp = await fetch(tgUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: settings.telegramChatId,
        text,
        parse_mode: 'HTML'
      })
    });
    const result = await resp.json();
    return { sent: result.ok, result };
  } catch (err) {
    console.error('Telegram notification failed:', err.message);
    return { sent: false, error: err.message };
  }
}

// Generate slots (09:00 to 13:00)
function generateTimeSlots(settings) {
  const startHour = parseInt((settings.bookingStartTime || '09:00').split(':')[0], 10);
  const endHour = parseInt((settings.bookingEndTime || '13:00').split(':')[0], 10);
  const duration = settings.slotDurationMinutes || 60;

  const slots = [];
  let currentMinutes = startHour * 60;
  const endMinutes = endHour * 60;

  while (currentMinutes + duration <= endMinutes) {
    const startH = Math.floor(currentMinutes / 60);
    const startM = currentMinutes % 60;
    const endH = Math.floor((currentMinutes + duration) / 60);
    const endM = (currentMinutes + duration) % 60;

    const startStr = `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`;
    const endStr = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
    const slotId = `${startStr} - ${endStr}`;

    const formatArabicTime = (h, m) => {
      const period = h >= 12 ? 'م' : 'ص';
      const displayH = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      return `${String(displayH).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
    };

    const arabicLabel = `${formatArabicTime(startH, startM)} - ${formatArabicTime(endH, endM)}`;

    slots.push({
      id: slotId,
      start: startStr,
      end: endStr,
      label: arabicLabel
    });

    currentMinutes += duration;
  }

  return slots;
}

// ------------------- AUTHENTICATION ROUTES -------------------

// Admin Login
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const data = readData();
  const currentPassword = data.settings.adminPassword || 'alawael2026';

  if (!password || password !== currentPassword) {
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة، الدخول مخصص لمدير قسم الإعلام فقط' });
  }

  // Generate secure random session token
  const token = 'adm_' + crypto.randomBytes(24).toString('hex');
  activeAdminTokens.add(token);

  res.json({
    success: true,
    message: 'تم تسجيل الدخول بنجاح',
    token
  });
});

// Admin Verify Token
app.get('/api/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token && activeAdminTokens.has(token)) {
    return res.json({ authenticated: true });
  }
  res.json({ authenticated: false });
});

// Admin Logout
app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) {
    activeAdminTokens.delete(token);
  }
  res.json({ success: true, message: 'تم تسجيل الخروج بنجاح' });
});

// Change Admin Password (requires auth)
app.post('/api/admin/change-password', requireAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن لا تقل عن 4 خانات' });
  }

  const data = readData();
  const actualCurrent = data.settings.adminPassword || 'alawael2026';

  if (currentPassword !== actualCurrent) {
    return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
  }

  data.settings.adminPassword = newPassword;
  writeData(data);

  res.json({ success: true, message: 'تم تغيير كلمة مرور مدير القسم بنجاح' });
});

// ------------------- PUBLIC BOOKING ROUTES -------------------

// 1. Initial bootstrap (safe data only, password is NOT exposed)
app.get('/api/bootstrap', (req, res) => {
  const data = readData();
  const safeSettings = { ...data.settings };
  delete safeSettings.adminPassword; // Never expose password!

  res.json({
    settings: safeSettings,
    schools: data.schools,
    totalBookings: data.bookings.length,
    activeBookings: data.bookings.filter(b => b.status !== 'ملغي').length
  });
});

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  const client = { id: clientId, res };
  sseClients.push(client);

  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to Live Media Alerts' })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// 2. Get slots for a specific date (Public for schools)
app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'التاريخ مطلوب' });
  }

  const data = readData();
  const baseSlots = generateTimeSlots(data.settings);

  const dateBookings = data.bookings.filter(b => b.date === date && b.status !== 'ملغي');
  const dateBlocked = (data.blockedSlots || []).filter(b => b.date === date);

  const slotsWithStatus = baseSlots.map(slot => {
    const booking = dateBookings.find(b => b.slot === slot.id);
    const blocked = dateBlocked.find(b => b.slot === slot.id);

    if (booking) {
      const sch = data.schools.find(s => s.id === booking.schoolId);
      return {
        ...slot,
        isAvailable: false,
        status: 'booked',
        statusText: `محجوز (${booking.schoolName})`,
        schoolName: booking.schoolName,
        schoolColorHex: sch ? sch.colorHex : '#DC2626',
        badgeBg: sch ? sch.badgeBg : '#FEE2E2',
        badgeText: sch ? sch.badgeText : '#991B1B',
        eventType: booking.eventType,
        bookingId: booking.id
      };
    } else if (blocked) {
      return {
        ...slot,
        isAvailable: false,
        status: 'blocked',
        statusText: `محظور: ${blocked.reason}`,
        blockId: blocked.id,
        reason: blocked.reason
      };
    } else {
      return {
        ...slot,
        isAvailable: true,
        status: 'available',
        statusText: 'متاح للحجز'
      };
    }
  });

  res.json({
    date,
    slots: slotsWithStatus,
    totalSlots: slotsWithStatus.length,
    availableCount: slotsWithStatus.filter(s => s.isAvailable).length,
    bookedCount: slotsWithStatus.filter(s => s.status === 'booked').length,
    blockedCount: slotsWithStatus.filter(s => s.status === 'blocked').length
  });
});

// 3. Create a booking (Public for schools)
app.post('/api/book', async (req, res) => {
  const { date, slot, schoolId, eventType, notes } = req.body;

  if (!date || !slot || !schoolId || !eventType) {
    return res.status(400).json({ error: 'يرجى تحديد المدرسة، التاريخ، الفترة، ونوع الفعالية' });
  }

  const data = readData();
  const school = data.schools.find(s => s.id === schoolId);
  if (!school) {
    return res.status(400).json({ error: 'المدرسة المحددة غير موجودة في مدارس الأوائل الأهلية' });
  }

  // Conflict Check 1
  const existingBooking = data.bookings.find(
    b => b.date === date && b.slot === slot && b.status !== 'ملغي'
  );

  if (existingBooking) {
    return res.status(409).json({
      error: `عذراً! هذا الوقت محجوز بالفعل لمدرسة (${existingBooking.schoolName}). الرجاء اختيار وقت آخر متاح.`
    });
  }

  // Conflict Check 2
  const existingBlock = (data.blockedSlots || []).find(
    b => b.date === date && b.slot === slot
  );

  if (existingBlock) {
    return res.status(409).json({
      error: `عذراً! هذا الوقت محظور من قبل قسم الإعلام (${existingBlock.reason}). الرجاء اختيار وقت آخر.`
    });
  }

  const [slotStart, slotEnd] = slot.split(' - ');

  const newBooking = {
    id: `BK-${Date.now().toString().slice(-6)}`,
    date,
    slot,
    slotStart: slotStart.trim(),
    slotEnd: slotEnd.trim(),
    schoolId: school.id,
    schoolName: school.name,
    schoolColorHex: school.colorHex,
    badgeBg: school.badgeBg,
    badgeText: school.badgeText,
    eventType: eventType || 'تغطية إعلامية وتوثيق',
    notes: notes || '',
    status: 'مؤكد',
    photographer: 'سيتم تعيين المصور من قبل القسم',
    createdAt: new Date().toISOString()
  };

  data.bookings.push(newBooking);
  writeData(data);

  // Broadcast SSE
  broadcastSSE('NEW_BOOKING', {
    booking: newBooking,
    message: `حجز جديد من ${newBooking.schoolName} (${newBooking.slot})`
  });

  // Dispatch Telegram alert
  dispatchTelegramAlert(data.settings, newBooking);

  // Format WhatsApp link
  const cleanAdminPhone = (data.settings.adminPhone || '').replace(/[^0-9]/g, '');
  const waText = encodeURIComponent(
    `📸 *حجز تصوير جديد - مدارس الأوائل الأهلية*\n\n` +
    `🏫 المدرسة: ${newBooking.schoolName}\n` +
    `📅 التاريخ: ${newBooking.date}\n` +
    `⏰ الوقت: ${newBooking.slot}\n` +
    `🎯 الفعالية: ${newBooking.eventType}\n` +
    (newBooking.notes ? `📝 الملاحظات: ${newBooking.notes}\n` : '') +
    `\nرقم الحجز: ${newBooking.id}`
  );
  const whatsAppUrl = cleanAdminPhone ? `https://wa.me/964${cleanAdminPhone.replace(/^0/, '')}?text=${waText}` : null;

  res.status(201).json({
    success: true,
    message: 'تم حجز الموعد بنجاح! تم قفل هذا الوقت ولن تتمكن أي مدرسة أخرى من حجزه.',
    booking: newBooking,
    whatsAppUrl
  });
});

// ------------------- PROTECTED ADMIN ROUTES -------------------

// 4. Get bookings (Protected for admin dashboard)
app.get('/api/bookings', requireAdmin, (req, res) => {
  const { date, schoolId, status, search } = req.query;
  const data = readData();

  let results = [...data.bookings];

  if (date) {
    results = results.filter(b => b.date === date);
  }
  if (schoolId) {
    results = results.filter(b => b.schoolId === schoolId);
  }
  if (status) {
    results = results.filter(b => b.status === status);
  }
  if (search) {
    const s = search.toLowerCase();
    results = results.filter(b =>
      b.schoolName.toLowerCase().includes(s) ||
      b.eventType.toLowerCase().includes(s) ||
      (b.notes && b.notes.toLowerCase().includes(s)) ||
      b.id.toLowerCase().includes(s)
    );
  }

  results.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.slot.localeCompare(b.slot);
  });

  res.json({
    bookings: results,
    total: results.length
  });
});

// 5. Update booking (Protected)
app.put('/api/bookings/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const updates = req.body;
  const data = readData();

  const idx = data.bookings.findIndex(b => b.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'الحجز غير موجود' });
  }

  const allowed = ['status', 'photographer', 'notes', 'eventType'];
  allowed.forEach(field => {
    if (updates[field] !== undefined) {
      data.bookings[idx][field] = updates[field];
    }
  });

  writeData(data);
  broadcastSSE('BOOKING_UPDATED', { booking: data.bookings[idx] });
  res.json({ success: true, booking: data.bookings[idx] });
});

// 6. Delete booking (Protected)
app.delete('/api/bookings/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const data = readData();

  const idx = data.bookings.findIndex(b => b.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'الحجز غير موجود' });
  }

  const removed = data.bookings.splice(idx, 1)[0];
  writeData(data);
  broadcastSSE('BOOKING_CANCELLED', { bookingId: id });
  res.json({ success: true, message: 'تم إلغاء الحجز وإتاحة الوقت مجدداً', removed });
});

// 7. Block / Unblock slots (Protected)
app.post('/api/block-slot', requireAdmin, (req, res) => {
  const { date, slot, reason } = req.body;
  if (!date || !slot) {
    return res.status(400).json({ error: 'التاريخ والوقت مطلوبان' });
  }

  const data = readData();
  data.blockedSlots = data.blockedSlots || [];

  const existingBooking = data.bookings.find(b => b.date === date && b.slot === slot && b.status !== 'ملغي');
  if (existingBooking) {
    return res.status(400).json({ error: `لا يمكن حظر هذا الوقت لأنه محجوز مسبقاً لمدرسة (${existingBooking.schoolName}).` });
  }

  const [slotStart, slotEnd] = slot.split(' - ');
  const blockItem = {
    id: `BLK-${Date.now().toString().slice(-6)}`,
    date,
    slot,
    slotStart: slotStart.trim(),
    slotEnd: slotEnd.trim(),
    reason: reason || 'صيانة أو التزام لقسم الإعلام',
    blockedAt: new Date().toISOString()
  };

  data.blockedSlots.push(blockItem);
  writeData(data);
  broadcastSSE('SLOT_BLOCKED', { blocked: blockItem });
  res.status(201).json({ success: true, message: 'تم قفل الوقت بنجاح', blocked: blockItem });
});

app.delete('/api/block-slot/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const data = readData();
  data.blockedSlots = data.blockedSlots || [];

  const idx = data.blockedSlots.findIndex(b => b.id === id);
  if (idx === -1) {
    return res.status(404).json({ error: 'فترة الحظر غير موجودة' });
  }

  data.blockedSlots.splice(idx, 1);
  writeData(data);
  broadcastSSE('SLOT_UNBLOCKED', { blockId: id });
  res.json({ success: true, message: 'تم فك حظر الوقت وإتاحته للمدارس' });
});

// 8. Update schools (Protected)
app.put('/api/schools', requireAdmin, (req, res) => {
  const { schools } = req.body;
  if (!Array.isArray(schools)) {
    return res.status(400).json({ error: 'بيانات المدارس غير صالحة' });
  }

  const data = readData();
  data.schools = schools;
  writeData(data);
  res.json({ success: true, message: 'تم تحديث المدارس بنجاح', schools: data.schools });
});

// 9. Update settings (Protected)
app.put('/api/settings', requireAdmin, (req, res) => {
  const { settings } = req.body;
  if (!settings) {
    return res.status(400).json({ error: 'بيانات الإعدادات غير صالحة' });
  }

  const data = readData();
  // Don't overwrite adminPassword here without old check
  const newSettings = { ...settings };
  delete newSettings.adminPassword;

  data.settings = { ...data.settings, ...newSettings };
  writeData(data);
  res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح', settings: data.settings });
});

// 10. Test Telegram (Protected)
app.post('/api/test-telegram', requireAdmin, async (req, res) => {
  const { botToken, chatId } = req.body;
  if (!botToken || !chatId) {
    return res.status(400).json({ error: 'Token و Chat ID مطلوبان لإجراء الاختبار' });
  }

  try {
    const text = `🔔 <b>تجربة إشعار الهاتف - نظام إعلام مدارس الأوائل</b>\n\nيعمل نظام إشعارات الحجز بنجاح! ستصلك تنبيهات الحجز هنا فور قيام أي مدرسة بحجز موعد تصوير.`;
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const result = await resp.json();
    if (result.ok) {
      res.json({ success: true, message: 'تم إرسال إشعار التجربة بنجاح إلى هاتفك!' });
    } else {
      res.status(400).json({ error: result.description || 'فشل إرسال الإشعار، تأكد من صحة التوكن و Chat ID' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. Export CSV (Protected)
app.get('/api/export/csv', requireAdmin, (req, res) => {
  const data = readData();
  let csv = '\uFEFF';
  csv += 'رقم الحجز,التاريخ,الوقت,المدرسة,نوع الفعالية,المصور,الحالة,الملاحظات\n';

  data.bookings.forEach(b => {
    const clean = str => `"${(str || '').replace(/"/g, '""')}"`;
    csv += [
      clean(b.id),
      clean(b.date),
      clean(b.slot),
      clean(b.schoolName),
      clean(b.eventType),
      clean(b.photographer),
      clean(b.status),
      clean(b.notes)
    ].join(',') + '\n';
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=alawael-media-bookings.csv');
  res.send(csv);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Al-Awael Media Booking Server running on http://0.0.0.0:${PORT}`);
});
