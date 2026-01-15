const express = require('express');
const line = require('@line/bot-sdk');
const { JWT } = require('google-auth-library');
const https = require('https');

const app = express();

// CONFIG
const lineConfig = {
  channelAccessToken: process.env.LINE_TOKEN,
  channelSecret: process.env.LINE_SECRET
};

const client = new line.Client(lineConfig);
const SHEET_ID = process.env.SHEET_ID;

// STATE
const userStates = new Map();

const CATEGORIES = {
  '🍜': 'Ăn uống',
  '🍽️': 'Ăn ngoài',
  '🎉': 'Vui chơi',
  '🛍️': 'Mua đồ',
  '📦': 'Đồ dùng'
};

// GOOGLE AUTH
let authClient;

async function getAuthClient() {
  if (authClient) return authClient;
  
  authClient = new JWT({
    email: process.env.GOOGLE_SERVICE_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  
  return authClient;
}

// SHEETS OPERATIONS
async function appendToSheet(values) {
  const auth = await getAuthClient();
  const token = await auth.getAccessToken();
  
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A:F:append?valueInputOption=USER_ENTERED`;
  
  const payload = {
    values: [values]
  };
  
  const data = JSON.stringify(payload);
  
  return new Promise((resolve, reject) => {
    const options = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log('Saved successfully');
          resolve(JSON.parse(body));
        } else {
          console.error('Save error:', res.statusCode, body);
          reject(new Error(`Save error: ${res.statusCode}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getSheetData() {
  const auth = await getAuthClient();
  const token = await auth.getAccessToken();
  
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/A:F`;
  
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Authorization': `Bearer ${token.token}`
      }
    };
    
    https.get(url, options, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const data = JSON.parse(body);
          resolve(data.values || []);
        } else {
          console.error('Get data error:', res.statusCode, body);
          reject(new Error(`Get data error: ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

// HEALTH CHECK
app.get('/', (req, res) => {
  res.send('✅ LINE Bot is running!');
});

// WEBHOOK
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(200).json({ error: err.message });
  }
});

// HANDLE EVENT
async function handleEvent(event) {
  if (event.type !== 'message' && event.type !== 'postback') return null;
  
  const userId = event.source.groupId || event.source.userId;
  const replyToken = event.replyToken;
  
  if (!userId || !replyToken) return null;
  
  const state = userStates.get(userId) || { step: 'MENU' };
  
  try {
    if (event.type === 'message' && event.message.type === 'text') {
      await handleTextMessage(userId, event.message.text, state, replyToken);
    } else if (event.type === 'postback') {
      await handlePostback(userId, event.postback.data, state, replyToken);
    }
  } catch (error) {
    console.error('Handle error:', error);
    await showMenu(replyToken);
  }
  
  return null;
}

// TEXT HANDLER
async function handleTextMessage(userId, text, state, replyToken) {
  const cleanText = text.trim();
  
  if (state.step === 'AMOUNT') {
    const cleanAmount = cleanText.replace(/[.,\s]/g, '');
    if (!/^\d+$/.test(cleanAmount)) {
      await replyText(replyToken, '❌ Số tiền không hợp lệ! Vui lòng nhập số.\n\nVí dụ: 50000', [
        { label: '↩️ Menu', data: 'MENU' }
      ]);
      return;
    }
    
    state.amount = parseInt(cleanAmount);
    state.step = 'NOTE';
    userStates.set(userId, state);
    await askNote(replyToken);
    
  } else if (state.step === 'CUSTOM_CAT') {
    state.category = cleanText;
    state.step = 'AMOUNT';
    userStates.set(userId, state);
    await askAmount(replyToken);
    
  } else if (state.step === 'NOTE') {
    state.note = cleanText;
    state.step = 'CONFIRM';
    userStates.set(userId, state);
    await showConfirm(replyToken, state);
    
  } else if (state.step === 'CUSTOM_DATE_START') {
    if (!/^\d{1,2}\/\d{1,2}$/.test(cleanText)) {
      await replyText(replyToken, '❌ Định dạng không đúng! Nhập: DD/MM\n\nVí dụ: 01/01', [
        { label: '↩️ Menu', data: 'MENU' }
      ]);
      return;
    }
    
    state.customStartDate = cleanText;
    state.step = 'CUSTOM_DATE_END';
    userStates.set(userId, state);
    await replyText(replyToken, '📅 Nhập ngày kết thúc (DD/MM):\n\nVí dụ: 15/01', [
      { label: '↩️ Menu', data: 'MENU' }
    ]);
    
  } else if (state.step === 'CUSTOM_DATE_END') {
    if (!/^\d{1,2}\/\d{1,2}$/.test(cleanText)) {
      await replyText(replyToken, '❌ Định dạng không đúng! Nhập: DD/MM\n\nVí dụ: 15/01', [
        { label: '↩️ Menu', data: 'MENU' }
      ]);
      return;
    }
    
    state.customEndDate = cleanText;
    state.step = 'MENU';
    userStates.set(userId, state);
    
    await calculateSumCustom(userId, state.customStartDate, state.customEndDate, replyToken);
    userStates.delete(userId);
    
  } else {
    await showMenu(replyToken);
  }
}

// POSTBACK HANDLER
async function handlePostback(userId, data, state, replyToken) {
  
  if (data === 'NEW_EXPENSE') {
    userStates.set(userId, { step: 'PAYMENT' });
    await askPayment(replyToken);
    
  } else if (data === 'SUM') {
    await askSumPeriod(replyToken);
    
  } else if (data === 'PAY_CASH') {
    state.payment = '💵 Tiền mặt';
    state.step = 'CATEGORY';
    userStates.set(userId, state);
    await askCategory(replyToken);
    
  } else if (data === 'PAY_ONLINE') {
    state.payment = '💳 Online';
    state.step = 'CATEGORY';
    userStates.set(userId, state);
    await askCategory(replyToken);
    
  } else if (data.startsWith('CAT_')) {
    const catKey = data.replace('CAT_', '');
    if (catKey === 'CUSTOM') {
      state.step = 'CUSTOM_CAT';
      userStates.set(userId, state);
      await replyText(replyToken, '✍️ Nhập danh mục của bạn:\n\n(Ví dụ: Xăng xe, Thuốc, Quà tặng...)', [
        { label: '↩️ Menu', data: 'MENU' }
      ]);
    } else {
      state.category = CATEGORIES[catKey] || catKey;
      state.step = 'AMOUNT';
      userStates.set(userId, state);
      await askAmount(replyToken);
    }
    
  } else if (data === 'NOTE_SKIP') {
    state.note = '';
    state.step = 'CONFIRM';
    userStates.set(userId, state);
    await showConfirm(replyToken, state);
    
  } else if (data === 'CONFIRM_SAVE') {
    await saveExpense(userId, state);
    userStates.delete(userId);
    await replyText(replyToken, '✅ Đã lưu thành công!', [
      { label: '➕ Nhập mới', data: 'NEW_EXPENSE' },
      { label: '🧮 Tính tổng', data: 'SUM' }
    ]);
    
  } else if (data === 'CONFIRM_CANCEL' || data === 'MENU') {
    userStates.delete(userId);
    await showMenu(replyToken);
    
  } else if (data === 'SUM_CUSTOM') {
    state.step = 'CUSTOM_DATE_START';
    userStates.set(userId, state);
    await replyText(replyToken, '🧾 Tính tổng tùy chọn\n\n📅 Nhập ngày bắt đầu (DD/MM):\n\nVí dụ: 01/01', [
      { label: '↩️ Menu', data: 'MENU' }
    ]);
    
  } else if (data.startsWith('SUM_')) {
    await calculateSum(userId, data.replace('SUM_', ''), replyToken);
  } else {
    await showMenu(replyToken);
  }
}

// UI FUNCTIONS
async function askPayment(replyToken) {
  await replyText(replyToken, '💰 Chọn loại thanh toán:', [
    { label: '💵 Tiền mặt', data: 'PAY_CASH' },
    { label: '💳 Online', data: 'PAY_ONLINE' },
    { label: '↩️ Menu', data: 'MENU' }
  ]);
}

async function askCategory(replyToken) {
  const items = Object.keys(CATEGORIES).map(key => ({
    label: key + ' ' + CATEGORIES[key],
    data: 'CAT_' + key
  }));
  
  items.push({ label: '✍️ Nhập tay', data: 'CAT_CUSTOM' });
  items.push({ label: '↩️ Menu', data: 'MENU' });
  
  await replyText(replyToken, '📂 Chọn danh mục:', items);
}

async function askAmount(replyToken) {
  await replyText(replyToken, '💵 Nhập số tiền:\n\nVí dụ: 120000', [
    { label: '↩️ Menu', data: 'MENU' }
  ]);
}

async function askNote(replyToken) {
  await replyText(replyToken, '📝 Nhập ghi chú (hoặc bỏ qua):', [
    { label: '⏭️ Bỏ qua', data: 'NOTE_SKIP' },
    { label: '↩️ Menu', data: 'MENU' }
  ]);
}

async function showConfirm(replyToken, data) {
  const text = `📋 Xác nhận:\n\n💰 Thanh toán: ${data.payment}\n📂 Danh mục: ${data.category}\n💵 Số tiền: ${formatMoney(data.amount)}\n📝 Ghi chú: ${data.note || '(không có)'}`;
  
  await replyText(replyToken, text, [
    { label: '✅ Lưu', data: 'CONFIRM_SAVE' },
    { label: '❌ Hủy', data: 'CONFIRM_CANCEL' }
  ]);
}

async function askSumPeriod(replyToken) {
  await replyText(replyToken, '🧮 Tính tổng phạm vi nào?', [
    { label: '📅 Hôm nay', data: 'SUM_TODAY' },
    { label: '📆 7 ngày', data: 'SUM_7DAYS' },
    { label: '🗓️ Tháng này', data: 'SUM_MONTH' },
    { label: '♾️ Tất cả', data: 'SUM_ALL' },
    { label: '🧾 Tùy chọn', data: 'SUM_CUSTOM' },
    { label: '↩️ Menu', data: 'MENU' }
  ]);
}

async function showMenu(replyToken) {
  await replyText(replyToken, '📋 Menu chính:', [
    { label: '➕ Nhập mới', data: 'NEW_EXPENSE' },
    { label: '🧮 Tính tổng', data: 'SUM' }
  ]);
}

// SAVE EXPENSE
async function saveExpense(groupId, data) {
  try {
    const timestamp = new Date().toISOString();
    const row = [
      timestamp,
      groupId,
      data.payment,
      data.category,
      data.amount,
      data.note || ''
    ];
    
    await appendToSheet(row);
    console.log('Saved:', row);
  } catch (error) {
    console.error('Save error:', error);
    throw error;
  }
}

// CALCULATE SUM
async function calculateSum(groupId, period, replyToken) {
  try {
    const rows = await getSheetData();
    
    const now = new Date();
    let startDate = new Date(0);
    let periodLabel = '';
    
    if (period === 'TODAY') {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      periodLabel = `📅 Tổng kết hôm nay (${formatDate(now)})`;
    } else if (period === '7DAYS') {
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      periodLabel = `📆 Tổng kết 7 ngày (${formatDate(startDate)} → ${formatDate(now)})`;
    } else if (period === 'MONTH') {
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      periodLabel = `🗓️ Tổng kết tháng này (${formatDate(startDate)} → ${formatDate(now)})`;
    } else {
      periodLabel = '♾️ Tổng kết tất cả';
    }
    
    const summary = processSummary(rows, groupId, startDate);
    
    await replyText(replyToken, `${periodLabel}\n\n${summary}`, [
      { label: '➕ Nhập mới', data: 'NEW_EXPENSE' },
      { label: '🧮 Tính tổng', data: 'SUM' }
    ]);
    
  } catch (error) {
    console.error('Calculate error:', error);
    await replyText(replyToken, '❌ Lỗi tính tổng!', [
      { label: '↩️ Menu', data: 'MENU' }
    ]);
  }
}

async function calculateSumCustom(groupId, startDateStr, endDateStr, replyToken) {
  try {
    const rows = await getSheetData();
    
    const now = new Date();
    const currentYear = now.getFullYear();
    
    const [startDay, startMonth] = startDateStr.split('/').map(n => parseInt(n));
    const startDate = new Date(currentYear, startMonth - 1, startDay);
    
    const [endDay, endMonth] = endDateStr.split('/').map(n => parseInt(n));
    const endDate = new Date(currentYear, endMonth - 1, endDay, 23, 59, 59);
    
    if (endDate < startDate) {
      endDate.setFullYear(currentYear + 1);
    }
    
    const periodLabel = `🧾 Tổng kết tùy chọn\n(${formatDate(startDate)} → ${formatDate(endDate)})`;
    
    let totalCash = 0;
    let totalOnline = 0;
    const byCategory = {};
    
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.length < 5) continue;
      
      const date = new Date(row[0]);
      const gid = row[1];
      const payment = row[2];
      const category = row[3];
      const amount = parseFloat(row[4]) || 0;
      
      if (gid !== groupId || date < startDate || date > endDate) continue;
      
      if (payment.includes('Tiền mặt')) {
        totalCash += amount;
      } else {
        totalOnline += amount;
      }
      
      if (!byCategory[category]) {
        byCategory[category] = { cash: 0, online: 0 };
      }
      
      if (payment.includes('Tiền mặt')) {
        byCategory[category].cash += amount;
      } else {
        byCategory[category].online += amount;
      }
    }
    
    let result = `${periodLabel}\n\n💰 Tổng quan:\nTổng chi: ${formatMoney(totalCash + totalOnline)}\nTiền mặt: ${formatMoney(totalCash)}\nOnline: ${formatMoney(totalOnline)}`;
    
    if (Object.keys(byCategory).length > 0) {
      result += '\n\n📊 Chi tiết:';
      for (const cat in byCategory) {
        const c = byCategory[cat];
        result += `\n${cat}: ${formatMoney(c.cash + c.online)}`;
      }
    } else {
      result += '\n\n📊 Chưa có dữ liệu.';
    }
    
    await replyText(replyToken, result, [
      { label: '➕ Nhập mới', data: 'NEW_EXPENSE' },
      { label: '🧮 Tính tổng', data: 'SUM' }
    ]);
    
  } catch (error) {
    console.error('Calculate custom error:', error);
    await replyText(replyToken, '❌ Lỗi tính tổng!', [
      { label: '↩️ Menu', data: 'MENU' }
    ]);
  }
}

function processSummary(rows, groupId, startDate) {
  let totalCash = 0;
  let totalOnline = 0;
  const byCategory = {};
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 5) continue;
    
    const date = new Date(row[0]);
    const gid = row[1];
    const payment = row[2];
    const category = row[3];
    const amount = parseFloat(row[4]) || 0;
    
    if (gid !== groupId || date < startDate) continue;
    
    if (payment.includes('Tiền mặt')) {
      totalCash += amount;
    } else {
      totalOnline += amount;
    }
    
    if (!byCategory[category]) {
      byCategory[category] = { cash: 0, online: 0 };
    }
    
    if (payment.includes('Tiền mặt')) {
      byCategory[category].cash += amount;
    } else {
      byCategory[category].online += amount;
    }
  }
  
  let result = `💰 Tổng quan:\nTổng chi: ${formatMoney(totalCash + totalOnline)}\nTiền mặt: ${formatMoney(totalCash)}\nOnline: ${formatMoney(totalOnline)}`;
  
  if (Object.keys(byCategory).length > 0) {
    result += '\n\n📊 Chi tiết:';
    for (const cat in byCategory) {
      const c = byCategory[cat];
      result += `\n${cat}: ${formatMoney(c.cash + c.online)}`;
    }
  } else {
    result += '\n\n📊 Chưa có dữ liệu.';
  }
  
  return result;
}

// REPLY HELPER
async function replyText(replyToken, text, quickReplyItems) {
  const message = { type: 'text', text };
  
  if (quickReplyItems) {
    message.quickReply = {
      items: quickReplyItems.map(item => ({
        type: 'action',
        action: { type: 'postback', label: item.label, data: item.data }
      }))
    };
  }
  
  await client.replyMessage(replyToken, [message]);
}

function formatMoney(amount) {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' đ';
}

function formatDate(date) {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
